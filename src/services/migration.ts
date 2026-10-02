import type {
  LicenseRecord,
  MaterialPackage,
  WorkspaceState,
} from '@/types/domain'
import { createApprovalRoute, findApplicableRule, validatePackage } from './rules'
import {
  pushAudit,
  releaseReservation,
  reserveQuota,
  ruleQuotaPool,
} from './quota'

const MIGRATION_OPERATOR = '系统升级'
const IN_FLIGHT = ['validating', 'reviewing', 'approved', 'returned'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * v1 → v2：
 * - 规则补版本号、资料包补申请额度；
 * - 已许可资料包按已用额度回填不可变扣减台账；
 * - 在途资料包按当前规则和已用额度回填预占，无法回填的标成待人工核对并阻止扣减。
 */
export function migrateWorkspace(raw: unknown): WorkspaceState {
  const source = (isRecord(raw) ? raw : {}) as Partial<WorkspaceState>
  const timestamp = new Date().toISOString()

  const rules = (source.rules ?? []).map((rule) => ({ ...rule, version: rule.version ?? 1 }))
  const packages: MaterialPackage[] = (source.packages ?? []).map((pkg) => ({
    ...pkg,
    quotaRequest: pkg.quotaRequest ?? Math.max(pkg.quotaUsed ?? 0, 10),
  }))
  const files = source.files ?? []

  const state: WorkspaceState = {
    schemaVersion: 2,
    packages,
    files,
    rules,
    findings: source.findings ?? [],
    comments: source.comments ?? [],
    audit: source.audit ?? [],
    reservations: [],
    licenses: [],
  }

  // 1. 已完成许可：按已用额度补登不可变台账（规则池从此以台账为准）。
  packages
    .filter((pkg) => pkg.status === 'licensed' || pkg.status === 'locked')
    .forEach((pkg) => {
      const rule = rules.find((item) => item.id === pkg.matchedRuleId)
      if (!rule || pkg.quotaUsed <= 0) return
      const record: LicenseRecord = {
        id: `license-backfill-${pkg.id}`,
        packageId: pkg.id,
        packageCode: pkg.code,
        ruleId: rule.id,
        ruleVersion: rule.version,
        reservationId: 'pre-migration',
        amount: pkg.quotaUsed,
        balanceAfter: 0,
        backfilled: true,
        operator: MIGRATION_OPERATOR,
        licensedAt: pkg.updatedAt,
      }
      state.licenses.push(record)
      record.balanceAfter = ruleQuotaPool(state, rule.id).available
    })

  // 2. 在途资料包按创建顺序回填预占，模拟历史审批的额度竞争。
  const inFlight = packages
    .filter((pkg) => IN_FLIGHT.includes(pkg.status as (typeof IN_FLIGHT)[number]))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  inFlight.forEach((pkg) => {
    const rule =
      rules.find((item) => item.id === pkg.matchedRuleId) ?? findApplicableRule(pkg, rules)
    if (!rule) {
      pkg.matchedRuleId = undefined
      pkg.manualReviewRequired = true
      pushAudit(state, {
        packageId: pkg.id,
        action: '升级回填待人工核对',
        target: pkg.code,
        operator: MIGRATION_OPERATOR,
        createdAt: timestamp,
        detail: '旧数据升级时无法匹配当前许可规则，未能回填额度预占，已阻止扣减。',
      })
      return
    }
    pkg.matchedRuleId = rule.id
    const route = pkg.approvalRoute.length ? pkg.approvalRoute : createApprovalRoute(rule.approvalLevel)
    if (!pkg.approvalRoute.length) pkg.approvalRoute = route

    const amount = Math.max(0, Math.round(pkg.quotaRequest))
    if (pkg.status === 'returned') {
      // 历史退回资料包：预占在退回时即应释放，留痕但不占池。
      const result = reserveQuota(state, pkg, {
        amount,
        rule,
        clientId: 'migration-backfill',
        operator: MIGRATION_OPERATOR,
        round: pkg.currentRound,
        route,
        backfilled: true,
        note: '旧数据升级回填的历史审批预占。',
      })
      if (result.ok) {
        releaseReservation(
          result.reservation,
          'returned',
          '升级回填：资料包处于已退回状态，预占不占用额度，重新提交时再占。',
          timestamp,
        )
      }
      pkg.lastReservationId = result.reservation.id
      pushAudit(state, {
        packageId: pkg.id,
        action: '升级回填预占',
        target: pkg.code,
        operator: MIGRATION_OPERATOR,
        createdAt: timestamp,
        detail: `已退回资料包按规则「${rule.name}」回填 ${amount} 个额度的历史预占并标记释放，不阻止补正后重新提交。`,
      })
      return
    }

    const result = reserveQuota(state, pkg, {
      amount,
      rule,
      clientId: 'migration-backfill',
      operator: MIGRATION_OPERATOR,
      round: pkg.currentRound,
      route,
      backfilled: true,
      note: '旧数据升级回填。',
    })
    pkg.lastReservationId = result.reservation.id
    if (result.ok) {
      pushAudit(state, {
        packageId: pkg.id,
        action: '升级回填预占',
        target: pkg.code,
        operator: MIGRATION_OPERATOR,
        createdAt: timestamp,
        detail: `按当前规则「${rule.name}」版本 ${rule.version} 回填预占 ${amount} 个额度（${pkg.currentRound ? `第 ${pkg.currentRound} 轮` : '未提交'}）。`,
      })
    } else {
      pkg.manualReviewRequired = true
      pushAudit(state, {
        packageId: pkg.id,
        action: '升级回填待人工核对',
        target: pkg.code,
        operator: MIGRATION_OPERATOR,
        createdAt: timestamp,
        detail: `规则「${rule.name}」当前可用额度不足，申请 ${amount} 个、缺口 ${result.shortfall} 个，已标成待人工核对并阻止扣减。`,
      })
    }
  })

  // 3. 按规则池重新生成核对结论，保证额度视图一致。
  state.findings = packages.flatMap((pkg) => {
    const ruleId = pkg.matchedRuleId
    const pool = ruleId ? ruleQuotaPool(state, ruleId) : undefined
    return validatePackage(pkg, files, rules, pool)
  })

  pushAudit(state, {
    action: '工作区数据升级',
    target: `schema v1 → v2`,
    operator: MIGRATION_OPERATOR,
    createdAt: timestamp,
    detail: `回填 ${state.reservations.length} 条预占、${state.licenses.length} 条扣减台账，${packages.filter((pkg) => pkg.manualReviewRequired).length} 个资料包待人工核对。`,
  })

  return state
}

export function needsMigration(state: unknown): boolean {
  return !isRecord(state) || state.schemaVersion !== 2
}
