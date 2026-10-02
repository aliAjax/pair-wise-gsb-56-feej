import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  SubmitApprovalResult,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import {
  createApprovalRoute,
  findApplicableRule,
  quotaContextOf,
  refreshFindings,
  validatePackage,
} from '@/services/rules'
import {
  activeReservation,
  contentSignature,
  releaseActiveReservation,
  reserveQuota,
  routeSignature,
  ruleQuotaSummary,
  syncPackageReservation,
} from '@/services/quota'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

interface LockManagerLike {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>
}

/**
 * 跨标签页互斥锁，模拟服务端写事务。
 * 两个标签页同时提交同一资料包时串行执行，后进入者能读到先提交者写入的预占。
 */
function runExclusive<T>(callback: () => T): Promise<T> {
  const locks =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as unknown as { locks?: LockManagerLike }).locks
  if (!locks) return Promise.resolve().then(callback)
  return locks.request('export-control-workspace-write', callback)
}

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({
  url,
  method,
  body,
}) => {
  await wait()
  if (method === 'GET') {
    return { data: loadWorkspace() }
  }
  return runExclusive(() => {
    let state = loadWorkspace()
    const payload = (body ?? {}) as Record<string, unknown>
    const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
      state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
    }

    try {
      if (url === '/package/save') {
        const packageId = String(payload.packageId)
        const patch = payload.patch as Partial<MaterialPackage>
        const current = state.packages.find((item) => item.id === packageId)
        if (!current) throw new Error('资料包不存在')
        if (current.status === 'licensed' || current.status === 'locked') {
          throw new Error('许可记录已完成，不能改动')
        }
        Object.assign(current, patch, { updatedAt: now() })
        const matchedRule = findApplicableRule(current, state.rules)
        current.matchedRuleId = matchedRule?.id
        if (matchedRule) current.quotaLimit = matchedRule.quotaLimit
        // 申报内容或匹配规则变化后，旧预占立即失效并按当前审批路线和规则版本重算。
        syncPackageReservation(state, current, (detail) =>
          audit({
            packageId,
            action: '预占失效重算',
            target: current.code,
            operator: '系统',
            detail,
          }),
        )
        refreshFindings(state)
        audit({
          packageId,
          action: '更新资料包',
          target: current.code,
          operator: '当前用户',
          detail: '更新收件方、最终用途、声明或技术参数。',
        })
      } else if (url === '/package/create') {
        const draft = payload.package as Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
        const rule = findApplicableRule(
          { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, createdAt: '', updatedAt: '' },
          state.rules,
        )
        const packageItem: MaterialPackage = {
          ...draft,
          id: `pkg-${crypto.randomUUID()}`,
          matchedRuleId: rule?.id,
          approvalRoute: [],
          currentRound: 0,
          createdAt: now(),
          updatedAt: now(),
          versions: [],
        }
        packageItem.versions.push({
          id: `version-${crypto.randomUUID()}`,
          label: 'V1.0',
          createdAt: now(),
          createdBy: packageItem.applicant,
          summary: '创建资料包初始版本。',
          snapshot: {
            title: packageItem.title,
            category: packageItem.category,
            destination: packageItem.destination,
            endUse: packageItem.endUse,
            technologyTags: [...packageItem.technologyTags],
            personnelScopes: [...packageItem.personnelScopes],
            declarations: [...packageItem.declarations],
            activeFileVersions: {},
          },
        })
        state.packages.unshift(packageItem)
        refreshFindings(state)
        audit({
          packageId: packageItem.id,
          action: '创建资料包',
          target: packageItem.code,
          operator: packageItem.applicant,
          detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}。`,
        })
      } else if (url === '/file/save') {
        const file = payload.file as MaterialFile
        const index = state.files.findIndex((item) => item.id === file.id)
        if (index >= 0) state.files[index] = file
        else state.files.push(file)
      } else if (url === '/file/version/add') {
        const packageId = String(payload.packageId)
        const fileId = String(payload.fileId)
        const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
        if (!file) throw new Error('文件不存在')
        const pageCount = Number(payload.pageCount)
        const label = String(payload.label)
        const summary = String(payload.summary)
        const newVersion = {
          id: `file-version-${crypto.randomUUID()}`,
          label,
          uploadedAt: now(),
          hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
          sizeKb: pageCount * 96 + 720,
          pages: Array.from({ length: pageCount }, (_, index) => ({
            id: `page-${crypto.randomUUID()}`,
            page: index + 1,
            category: file.kind,
            controlled: false,
            desensitized: false,
            note: '',
            reviewer: '',
          })),
          changeSummary: summary,
        }
        file.versions.push(newVersion)
        file.activeVersionId = newVersion.id
        audit({
          packageId,
          action: '上传文件版本',
          target: `${file.name} ${label}`,
          operator: '当前用户',
          detail: summary,
        })
      } else if (url === '/file/reference') {
        const fileId = String(payload.fileId)
        const versionId = String(payload.versionId)
        const file = state.files.find((item) => item.id === fileId)
        if (!file) throw new Error('文件不存在')
        file.referencedVersionId = versionId
        audit({
          packageId: file.packageId,
          action: '选择引用版本',
          target: file.name,
          operator: '当前用户',
          detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
        })
      } else if (url === '/page/save') {
        const file = state.files.find((item) => item.id === String(payload.fileId))
        const version = file?.versions.find((item) => item.id === String(payload.versionId))
        if (!file || !version) throw new Error('文件版本不存在')
        const page = payload.page as PageReview
        const index = version.pages.findIndex((item) => item.id === page.id)
        if (index >= 0) version.pages[index] = page
        else version.pages.push(page)
        audit({
          packageId: file.packageId,
          action: '逐页分类核对',
          target: `${file.name} 第 ${page.page} 页`,
          operator: page.reviewer || '当前用户',
          detail: page.controlled ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}` : '标记为一般资料',
        })
      } else if (url === '/package/validate') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        // 额度池跨资料包共享，校验时全量重算，保证各资料包缺口结论一致。
        refreshFindings(state)
        audit({
          packageId,
          action: '执行许可校验',
          target: packageItem.code,
          operator: '当前用户',
          detail: `生成 ${state.findings.filter((item) => item.packageId === packageId).length} 条核对结果。`,
        })
      } else if (url === '/package/version') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const summary = String(payload.summary)
        const label = String(payload.label)
        packageItem.versions.push({
          id: `package-version-${crypto.randomUUID()}`,
          label,
          createdAt: now(),
          createdBy: '当前用户',
          summary,
          snapshot: {
            title: packageItem.title,
            category: packageItem.category,
            destination: packageItem.destination,
            endUse: packageItem.endUse,
            technologyTags: [...packageItem.technologyTags],
            personnelScopes: [...packageItem.personnelScopes],
            declarations: [...packageItem.declarations],
            activeFileVersions: Object.fromEntries(
              state.files
                .filter((file) => file.packageId === packageId)
                .map((file) => [file.id, file.activeVersionId]),
            ),
          },
        })
        audit({
          packageId,
          action: '创建资料包版本',
          target: `${packageItem.code} ${label}`,
          operator: '当前用户',
          detail: summary,
        })
      } else if (url === '/approval/submit') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        if (packageItem.status === 'licensed' || packageItem.status === 'locked') {
          throw new Error('许可记录已完成，不能改动')
        }
        const rule = findApplicableRule(packageItem, state.rules)
        if (!rule) throw new Error('未匹配到许可规则')
        const blocking = validatePackage(
          packageItem,
          state.files,
          state.rules,
          quotaContextOf(state),
        ).filter((finding) => finding.level === 'high' && finding.type !== 'quota')
        if (blocking.length) throw new Error(`存在高风险核对项：${blocking[0].message}`)

        const nextRoute = createApprovalRoute(rule.approvalLevel)
        const nextRouteSignature = routeSignature(nextRoute)
        const signature = contentSignature(packageItem)
        const existing = activeReservation(state, packageId)
        // 同一轮次、同一申报内容和规则版本下的重复提交（例如两个标签页同时提交）：
        // 只接受先到的预占，后提交者看到现有占用并保留审计。
        if (
          packageItem.status === 'reviewing' &&
          existing &&
          existing.round === packageItem.currentRound &&
          existing.ruleId === rule.id &&
          existing.ruleVersion === rule.version &&
          existing.routeSignature === nextRouteSignature &&
          existing.contentSignature === signature
        ) {
          audit({
            packageId,
            action: '重复提交合并',
            target: packageItem.code,
            operator: '当前用户',
            detail: `已存在第 ${existing.round} 轮有效预占 ${existing.amount}，本次未重复占用。`,
          })
          saveWorkspace(state)
          return { data: { state, deduplicated: true, reservation: existing } }
        }

        if (existing) {
          existing.status = 'stale'
          existing.note = '重新提交审批，旧预占失效。'
          existing.updatedAt = now()
        }
        const nextRound = packageItem.currentRound + 1
        const previousRoute = packageItem.approvalRoute
        packageItem.approvalRoute = nextRoute
        packageItem.matchedRuleId = rule.id
        packageItem.quotaLimit = rule.quotaLimit
        const attempt = reserveQuota(state, packageItem, { round: nextRound })
        if (!attempt.ok) {
          // 额度不足：资料包留在原状态，校验结论中写明缺口。
          packageItem.approvalRoute = previousRoute
          refreshFindings(state)
          audit({
            packageId,
            action: '额度预占失败',
            target: packageItem.code,
            operator: '当前用户',
            detail: `申报需要 ${attempt.needed}，规则池可用 ${attempt.available}，缺口 ${attempt.shortfall}，资料包保留在当前状态。`,
          })
          saveWorkspace(state)
          return {
            error: {
              status: 400,
              error: `许可额度不足：申报需要 ${attempt.needed}，规则池可用 ${attempt.available}，缺口 ${attempt.shortfall}。资料包已保留并写明缺口。`,
            },
          }
        }
        packageItem.currentRound = nextRound
        packageItem.status = 'reviewing'
        packageItem.updatedAt = now()
        refreshFindings(state)
        audit({
          packageId,
          action: '提交审批',
          target: packageItem.code,
          operator: '当前用户',
          detail: `按 ${rule.name} 生成审批路线并预占额度 ${attempt.reservation!.amount}，第 ${packageItem.currentRound} 轮。`,
        })
        saveWorkspace(state)
        return { data: { state, deduplicated: false, reservation: attempt.reservation } }
      } else if (url === '/approval/decide') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
        if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
        const decision = String(payload.decision)
        step.comment = String(payload.comment ?? '')
        step.decidedAt = now()
        if (decision === 'return') {
          step.status = 'returned'
          packageItem.status = 'returned'
          // 审批退回只释放该资料包自己的预占，其他资料包的占用不受影响。
          const released = releaseActiveReservation(state, packageItem, '审批退回，释放对应占用。')
          if (released) {
            audit({
              packageId,
              action: '释放额度预占',
              target: packageItem.code,
              operator: step.assignee,
              detail: `审批退回，释放第 ${released.round} 轮预占 ${released.amount}。`,
            })
          }
        } else {
          step.status = 'approved'
          const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
          if (next) next.status = 'active'
          else packageItem.status = 'approved'
        }
        packageItem.updatedAt = now()
        refreshFindings(state)
        audit({
          packageId,
          action: decision === 'return' ? '审批退回' : '审批通过',
          target: `${packageItem.code} / ${step.role}`,
          operator: step.assignee,
          detail: step.comment || '无补充意见。',
        })
      } else if (url === '/license/deduct') {
        const packageId = String(payload.packageId)
        const amount = Number(payload.amount)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        if (packageItem.status === 'licensed' || packageItem.status === 'locked') {
          throw new Error('许可记录已完成，不能改动')
        }
        if (packageItem.status !== 'approved') throw new Error('审批未完成，不能扣减额度')
        if (packageItem.quotaReviewRequired) {
          throw new Error('该资料包额度待人工核对，已阻止扣减')
        }
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('扣减数量无效')
        const rule = findApplicableRule(packageItem, state.rules)
        if (!rule) throw new Error('未匹配到许可规则')
        const highFindings = validatePackage(
          packageItem,
          state.files,
          state.rules,
          quotaContextOf(state),
        ).filter((finding) => finding.level === 'high')
        if (highFindings.length) throw new Error(`存在高风险核对项：${highFindings[0].message}`)
        const reservation = activeReservation(state, packageId)
        if (!reservation) throw new Error('缺少有效额度预占，请重新提交审批')
        if (
          reservation.ruleId !== rule.id ||
          reservation.ruleVersion !== rule.version ||
          reservation.contentSignature !== contentSignature(packageItem)
        ) {
          throw new Error('额度预占已失效，请重新校验并预占')
        }
        if (amount > reservation.amount) {
          throw new Error(`扣减 ${amount} 超过预占额度 ${reservation.amount}`)
        }
        const summary = ruleQuotaSummary(state, rule.id)
        if (summary.consumed + amount > summary.limit) throw new Error('许可额度不足')
        packageItem.quotaUsed += amount
        packageItem.status = 'licensed'
        packageItem.updatedAt = now()
        // 预占核销：扣减部分转为已用，剩余量释放回规则池。
        reservation.status = 'consumed'
        reservation.consumedAmount = amount
        reservation.releasedAmount = reservation.amount - amount
        reservation.updatedAt = now()
        refreshFindings(state)
        audit({
          packageId,
          action: '扣减许可额度',
          target: packageItem.code,
          operator: '当前用户',
          detail: `扣减 ${amount}（预占 ${reservation.amount}，释放余量 ${reservation.releasedAmount}），规则池剩余 ${summary.limit - summary.consumed - amount}。`,
        })
      } else if (url === '/comment/add') {
        state.comments.unshift({
          ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
          id: `comment-${crypto.randomUUID()}`,
          createdAt: now(),
        })
      } else if (url === '/audit/add') {
        audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
      } else if (url === '/workspace/reset') {
        state = resetWorkspace()
        return { data: state }
      } else {
        throw new Error(`未实现的本地接口：${url}`)
      }

      saveWorkspace(state)
      return { data: state }
    } catch (error) {
      return {
        error: {
          status: 400,
          error: error instanceof Error ? error.message : '本地操作失败',
        },
      }
    }
  })
}

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceState, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceState,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceState,
      {
        package: Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
      }
    >({
      query: (body) => ({ url: '/package/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    saveFile: builder.mutation<WorkspaceState, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<SubmitApprovalResult, { packageId: string }>({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductQuota: builder.mutation<WorkspaceState, { packageId: string; amount: number }>({
      query: (body) => ({ url: '/license/deduct', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceState,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceState,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

export const {
  useGetWorkspaceQuery,
  useSavePackageMutation,
  useCreatePackageMutation,
  useSaveFileMutation,
  useAddFileVersionMutation,
  useSetReferenceVersionMutation,
  useSavePageReviewMutation,
  useValidatePackageMutation,
  useCreatePackageVersionMutation,
  useSubmitApprovalMutation,
  useDecideApprovalMutation,
  useDeductQuotaMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi
