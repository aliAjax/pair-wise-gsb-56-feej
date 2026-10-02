import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceMutationResult,
  WorkspaceState,
} from '@/types/domain'
import {
  acquireMutationLock,
  getClientId,
  loadWorkspace,
  releaseMutationLock,
  resetWorkspace,
  saveWorkspace,
  simulateLegacyUpgrade,
} from '@/services/storage'
import {
  createApprovalRoute,
  findApplicableRule,
  validatePackage,
} from '@/services/rules'
import {
  assertNotLicensed,
  commitLicense,
  heldReservationFor,
  isReservationCurrent,
  pushAudit,
  reconcileReservations,
  recomputeReservation,
  releaseReservation,
  reserveQuota,
  ruleFingerprint,
  ruleQuotaPool,
  ruleQuotaPoolExcludingPackage,
} from '@/services/quota'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()
const CLIENT_ID = getClientId()

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({ url, body }) => {
  await wait()
  const lockRequired = LOCKED_URLS.has(url)
  if (lockRequired && !acquireMutationLock(CLIENT_ID)) {
    return {
      error: {
        status: 409,
        error: '另一个标签页正在占用或扣减额度，请稍后重试（已保留现有预占和审计记录）。',
      },
    }
  }
  let state = loadWorkspace()
  // 每次操作前先让规则版本、申报内容或审批路线变化导致的旧预占失效重算。
  if (lockRequired) reconcileReservations(state)
  const payload = (body ?? {}) as Record<string, unknown>
  let notice: WorkspaceMutationResult['notice']

  try {
    if (url === '/workspace') return { data: state }

    if (url === '/package/save') {
      const packageId = String(payload.packageId)
      const patch = payload.patch as Partial<MaterialPackage>
      const current = state.packages.find((item) => item.id === packageId)
      if (!current) throw new Error('资料包不存在')
      assertNotLicensed(state, packageId)
      Object.assign(current, patch, { updatedAt: now() })
      current.matchedRuleId = findApplicableRule(current, state.rules)?.id
      pushAudit(state, {
        packageId,
        action: '更新资料包',
        target: current.code,
        operator: '当前用户',
        detail: '更新收件方、最终用途、声明、技术参数或申请额度。',
      })
      // 申报内容变化后旧预占立即失效并按当前规则与额度重算。
      const recompute = recomputeReservation(state, current, '当前用户')
      if (recompute.recomputed && recompute.reason === 'shortfall') {
        notice = {
          type: 'warning',
          message: `额度不足，资料包留在草稿，当前缺口 ${recompute.shortfall} 个额度。`,
        }
      } else if (recompute.recomputed && recompute.reason === 'route') {
        notice = {
          type: 'warning',
          message: '规则要求的审批等级已变化，资料包退回草稿，请重新提交审批以生成新路线。',
        }
      }
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
      packageItem.quotaLimit = rule?.quotaLimit ?? packageItem.quotaLimit
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
      pushAudit(state, {
        packageId: packageItem.id,
        action: '创建资料包',
        target: packageItem.code,
        operator: packageItem.applicant,
        detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}，申请额度 ${packageItem.quotaRequest}。`,
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
      assertNotLicensed(state, packageId)
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
      pushAudit(state, {
        packageId,
        action: '上传文件版本',
        target: `${file.name} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
      invalidatePackageReservation(state, packageId, '上传了新文件版本，申报资料范围变化。')
    } else if (url === '/file/reference') {
      const fileId = String(payload.fileId)
      const versionId = String(payload.versionId)
      const file = state.files.find((item) => item.id === fileId)
      if (!file) throw new Error('文件不存在')
      assertNotLicensed(state, file.packageId)
      file.referencedVersionId = versionId
      pushAudit(state, {
        packageId: file.packageId,
        action: '选择引用版本',
        target: file.name,
        operator: '当前用户',
        detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
      })
      invalidatePackageReservation(state, file.packageId, '引用文件版本发生变化，预占按新内容重算。')
    } else if (url === '/page/save') {
      const file = state.files.find((item) => item.id === String(payload.fileId))
      const version = file?.versions.find((item) => item.id === String(payload.versionId))
      if (!file || !version) throw new Error('文件版本不存在')
      assertNotLicensed(state, file.packageId)
      const page = payload.page as PageReview
      const index = version.pages.findIndex((item) => item.id === page.id)
      if (index >= 0) version.pages[index] = page
      else version.pages.push(page)
      pushAudit(state, {
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
      const pool = packageItem.matchedRuleId
        ? ruleQuotaPoolExcludingPackage(state, packageItem.matchedRuleId, packageId)
        : undefined
      state.findings = [
        ...state.findings.filter((item) => item.packageId !== packageId),
        ...validatePackage(packageItem, state.files, state.rules, pool),
      ]
      pushAudit(state, {
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
      pushAudit(state, {
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
      assertNotLicensed(state, packageId)
      if (packageItem.manualReviewRequired) {
        throw new Error('该资料包为旧数据升级待人工核对状态，须由合规专员核对并解除后才能提交审批。')
      }

      // 同一资料包已有与当前路线、规则版本和内容一致的有效预占：
      // 两个标签页同时提交只接受第一份，后者沿用现有占用并写审计。
      const existing = heldReservationFor(state, packageId)
      if (
        existing &&
        isReservationCurrent(existing, packageItem, state) &&
        ['reviewing', 'approved'].includes(packageItem.status)
      ) {
        pushAudit(state, {
          packageId,
          action: '重复提交已合并',
          target: packageItem.code,
          operator: '当前用户',
          detail: `检测到对同一资料包的重复提交，沿用现有预占 ${existing.id.slice(-8)}（${existing.amount} 个额度），未重复占用。`,
        })
        notice = {
          type: 'info',
          message: `该资料包已存在有效预占（${existing.amount} 个额度，预占号 ${existing.id.slice(-8)}），已沿用现有占用，未重复扣占。`,
        }
      } else {
        const rule = findApplicableRule(packageItem, state.rules)
        if (!rule) throw new Error('未匹配到许可规则')
        // 新轮次提交前，若仍有上一轮的有效预占（如已批准后重新发起），先按 superseded 释放。
        if (existing) {
          releaseReservation(
            existing,
            'superseded',
            `第 ${existing.round} 轮预占被新提交（第 ${packageItem.currentRound + 1} 轮）取代。`,
          )
          pushAudit(state, {
            packageId,
            action: '预占取代',
            target: packageItem.code,
            operator: '当前用户',
            detail: `重新提交审批，上一轮预占 ${existing.amount} 个额度先释放，再按新审批路线占用。`,
          })
        }
        const route = createApprovalRoute(rule.approvalLevel)
        packageItem.approvalRoute = route
        packageItem.matchedRuleId = rule.id
        packageItem.status = 'reviewing'
        packageItem.currentRound += 1

        const amount = Math.max(0, Math.round(packageItem.quotaRequest))
        const result = reserveQuota(state, packageItem, {
          amount,
          rule,
          clientId: CLIENT_ID,
          operator: '当前用户',
          round: packageItem.currentRound,
          route,
        })
        if (result.ok) {
          pushAudit(state, {
            packageId,
            action: '提交审批',
            target: packageItem.code,
            operator: '当前用户',
            detail: `按 ${rule.name}（版本 ${rule.version}）生成审批路线，第 ${packageItem.currentRound} 轮，预占 ${amount} 个额度。`,
          })
          notice = {
            type: 'info',
            message: `审批路线已生成，并预占 ${amount} 个额度（规则池剩余 ${ruleQuotaPool(state, rule.id).available}）。`,
          }
        } else {
          packageItem.status = 'draft'
          pushAudit(state, {
            packageId,
            action: '提交审批额度不足',
            target: packageItem.code,
            operator: '当前用户',
            detail: `规则 ${rule.name} 可用额度不足：申请 ${amount} 个，缺口 ${result.shortfall} 个，资料包留在草稿，预占号 ${result.reservation.id.slice(-8)}。`,
          })
          notice = {
            type: 'error',
            message: `额度不足，资料包留在草稿：申请 ${amount} 个，缺口 ${result.shortfall} 个（已写审计）。`,
          }
        }
      }
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
        // 审批退回只释放该资料包自己的占用，不影响其他资料包。
        const held = heldReservationFor(state, packageId)
        if (held) {
          releaseReservation(held, 'returned', `第 ${held.round} 轮审批退回：${step.comment || '无补充意见。'}`)
          pushAudit(state, {
            packageId,
            action: '预占释放',
            target: packageItem.code,
            operator: step.assignee,
            detail: `审批退回，释放本资料包预占 ${held.amount} 个额度（规则池剩余 ${ruleQuotaPool(state, held.ruleId).available}）。`,
          })
        }
      } else {
        step.status = 'approved'
        const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
        if (next) next.status = 'active'
        else packageItem.status = 'approved'
      }
      pushAudit(state, {
        packageId,
        action: decision === 'return' ? '审批退回' : '审批通过',
        target: `${packageItem.code} / ${step.role}`,
        operator: step.assignee,
        detail: step.comment || '无补充意见。',
      })
    } else if (url === '/license/deduct') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      if (packageItem.status === 'licensed' || packageItem.status === 'locked') {
        throw new Error('该资料包已完成许可，扣减记录不能改动')
      }
      if (packageItem.manualReviewRequired) {
        throw new Error('资料包待人工核对，系统已阻止扣减；请先由合规专员核对历史额度占用。')
      }
      if (packageItem.status !== 'approved') throw new Error('只有全部审批步骤完成后才允许扣减额度')
      const reservation = heldReservationFor(state, packageId)
      if (!reservation || !isReservationCurrent(reservation, packageItem, state)) {
        throw new Error('没有与当前审批路线和规则版本绑定的有效预占，不能扣减；请重新提交审批。')
      }
      const record = commitLicense(state, packageItem, reservation, '当前用户')
      packageItem.status = 'licensed'
      packageItem.quotaUsed = record.amount
      packageItem.quotaLimit = state.rules.find((rule) => rule.id === record.ruleId)?.quotaLimit ?? packageItem.quotaLimit
      packageItem.updatedAt = now()
      pushAudit(state, {
        packageId,
        action: '扣减许可额度',
        target: packageItem.code,
        operator: '当前用户',
        detail: `预占 ${reservation.id.slice(-8)} 转为正式扣减 ${record.amount} 个额度，台账记录 ${record.id.slice(-8)}，规则池剩余 ${record.balanceAfter}。`,
      })
      notice = { type: 'info', message: `已按预占扣减 ${record.amount} 个额度并写入不可变许可台账。` }
    } else if (url === '/rule/publish') {
      const ruleId = String(payload.ruleId)
      const rule = state.rules.find((item) => item.id === ruleId)
      if (!rule) throw new Error('规则不存在')
      const patch = payload.patch as Partial<LicenseRule>
      const beforeFingerprint = ruleFingerprint(rule)
      Object.assign(rule, patch)
      const changed =
        ruleFingerprint(rule) !== beforeFingerprint ||
        Number(payload.quotaLimitChanged) === 1
      if (!changed) throw new Error('规则内容没有变化，无需发布新版本')
      rule.version += 1
      pushAudit(state, {
        action: '发布规则新版本',
        target: rule.name,
        operator: '合规专员',
        detail: `规则升级为版本 ${rule.version}，额度上限 ${rule.quotaLimit}，等级 ${rule.approvalLevel}；所有旧版本预占立即失效重算。`,
      })
      // 版本提升后，统一失效扫描并按新规则重算。
      reconcileReservations(state, '合规专员')
      notice = { type: 'info', message: `规则「${rule.name}」已发布版本 ${rule.version}，相关在途预占已全部重算。` }
    } else if (url === '/quota/resolve-manual') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      if (!packageItem.manualReviewRequired) throw new Error('该资料包不在待人工核对状态')
      const rule = findApplicableRule(packageItem, state.rules)
      if (!rule) throw new Error('当前仍无法匹配许可规则，不能解除人工核对')
      packageItem.matchedRuleId = rule.id
      if (!packageItem.approvalRoute.length) {
        packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
      }
      const result = reserveQuota(state, packageItem, {
        amount: Math.max(0, Math.round(packageItem.quotaRequest)),
        rule,
        clientId: CLIENT_ID,
        operator: '合规专员',
        round: packageItem.currentRound,
        route: packageItem.approvalRoute,
      })
      if (!result.ok) {
        throw new Error(`规则池仍缺 ${result.shortfall} 个额度，无法解除人工核对，请调减申请或申请规则额度。`)
      }
      packageItem.manualReviewRequired = false
      if (packageItem.status === 'draft') packageItem.status = 'reviewing'
      pushAudit(state, {
        packageId,
        action: '解除人工核对',
        target: packageItem.code,
        operator: '合规专员',
        detail: `人工核对历史占用无误，按规则「${rule.name}」版本 ${rule.version} 补建预占 ${result.reservation.amount} 个额度。`,
      })
      notice = { type: 'info', message: '人工核对完成，已补建预占并解除扣减阻断。' }
    } else if (url === '/comment/add') {
      state.comments.unshift({
        ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
        id: `comment-${crypto.randomUUID()}`,
        createdAt: now(),
      })
    } else if (url === '/audit/add') {
      pushAudit(state, payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
    } else if (url === '/workspace/reset') {
      state = resetWorkspace()
      const result: WorkspaceMutationResult = { state }
      return { data: result }
    } else if (url === '/workspace/simulate-legacy') {
      state = simulateLegacyUpgrade()
      const migrated = state.packages.filter((item) => item.manualReviewRequired)
      const result: WorkspaceMutationResult = {
        state,
        notice: {
          type: migrated.length ? 'warning' : 'info',
          message: `旧数据已按当前规则升级回填，${migrated.length} 个在途资料包无法回填，已标成待人工核对并阻止扣减。`,
        },
      }
      return { data: result }
    } else {
      throw new Error(`未实现的本地接口：${url}`)
    }

    saveWorkspace(state)
    if (lockRequired) releaseMutationLock(CLIENT_ID)
    return { data: { state, notice } satisfies WorkspaceMutationResult }
  } catch (error) {
    if (lockRequired) releaseMutationLock(CLIENT_ID)
    return {
      error: {
        status: 400,
        error: error instanceof Error ? error.message : '本地操作失败',
      },
    }
  }
}

const LOCKED_URLS = new Set([
  '/package/save',
  '/file/version/add',
  '/file/reference',
  '/approval/submit',
  '/approval/decide',
  '/license/deduct',
  '/rule/publish',
  '/quota/resolve-manual',
  '/workspace/reset',
  '/workspace/simulate-legacy',
])

/** 申报资料变化后释放旧预占并按当前规则重算（额度不足则留草稿并写明缺口）。 */
function invalidatePackageReservation(
  state: WorkspaceState,
  packageId: string,
  reason: string,
): void {
  const packageItem = state.packages.find((item) => item.id === packageId)
  const held = packageItem ? heldReservationFor(state, packageId) : undefined
  if (!packageItem || !held) return
  releaseReservation(held, 'invalidated', reason)
  pushAudit(state, {
    packageId,
    action: '预占失效',
    target: packageItem.code,
    operator: '当前用户',
    detail: `${reason} 旧预占 ${held.amount} 个额度立即释放。`,
  })
  recomputeReservation(state, packageItem, '当前用户')
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
      WorkspaceMutationResult,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceMutationResult,
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
    saveFile: builder.mutation<WorkspaceMutationResult, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceMutationResult,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceMutationResult,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceMutationResult,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceMutationResult, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceMutationResult,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<WorkspaceMutationResult, { packageId: string }>({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceMutationResult,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductQuota: builder.mutation<WorkspaceMutationResult, { packageId: string; amount?: number }>({
      query: (body) => ({ url: '/license/deduct', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    publishRule: builder.mutation<
      WorkspaceMutationResult,
      { ruleId: string; patch: Partial<LicenseRule>; quotaLimitChanged: boolean }
    >({
      query: (body) => ({ url: '/rule/publish', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resolveManualReview: builder.mutation<WorkspaceMutationResult, { packageId: string }>({
      query: (body) => ({ url: '/quota/resolve-manual', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    simulateLegacyUpgrade: builder.mutation<WorkspaceMutationResult, void>({
      query: () => ({ url: '/workspace/simulate-legacy', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceMutationResult,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceMutationResult,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceMutationResult, void>({
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
  usePublishRuleMutation,
  useResolveManualReviewMutation,
  useSimulateLegacyUpgradeMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi
