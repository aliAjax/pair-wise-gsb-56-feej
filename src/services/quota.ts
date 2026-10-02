import type {
  ApprovalStep,
  MaterialPackage,
  QuotaReservation,
  RuleQuotaSummary,
  WorkspaceState,
} from '@/types/domain'
import { findApplicableRule } from './rules'

const now = () => new Date().toISOString()

/** 申报内容签名：申报信息或申报额度变化后，旧预占必须失效重算。 */
export function contentSignature(packageItem: MaterialPackage): string {
  return JSON.stringify({
    category: packageItem.category,
    destination: packageItem.destination,
    endUse: packageItem.endUse,
    technologyTags: [...packageItem.technologyTags].sort(),
    personnelScopes: [...packageItem.personnelScopes].sort(),
    declarations: [...packageItem.declarations].sort(),
    quotaRequested: packageItem.quotaRequested,
  })
}

/** 审批路线签名：预占与生成时的审批路线绑定，路线重排即失效。 */
export function routeSignature(route: ApprovalStep[]): string {
  return route.map((step) => `${step.order}:${step.role}:${step.level}`).join('|')
}

export function activeReservation(
  state: WorkspaceState,
  packageId: string,
): QuotaReservation | undefined {
  return state.reservations.find(
    (reservation) => reservation.packageId === packageId && reservation.status === 'active',
  )
}

/** 规则共享额度池：上限 - 全部已扣减 - 全部有效预占 = 可用。 */
export function ruleQuotaSummary(state: WorkspaceState, ruleId: string): RuleQuotaSummary {
  const rule = state.rules.find((item) => item.id === ruleId)
  const limit = rule?.quotaLimit ?? 0
  const consumed = state.packages
    .filter((item) => item.matchedRuleId === ruleId)
    .reduce((total, item) => total + item.quotaUsed, 0)
  const reserved = state.reservations
    .filter((item) => item.ruleId === ruleId && item.status === 'active')
    .reduce((total, item) => total + item.amount, 0)
  return { ruleId, limit, consumed, reserved, available: limit - consumed - reserved }
}

export interface ReserveAttempt {
  ok: boolean
  needed: number
  available: number
  shortfall: number
  reservation?: QuotaReservation
}

/**
 * 为资料包预占额度。预占与当前审批路线、规则版本和申报内容签名绑定。
 * 额度不足时不创建预占，调用方负责把资料包留在原状态并写明缺口。
 */
export function reserveQuota(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  options: { round: number; backfilled?: boolean; note?: string },
): ReserveAttempt {
  const rule = findApplicableRule(packageItem, state.rules)
  const needed = packageItem.quotaRequested
  if (!rule) {
    return { ok: false, needed, available: 0, shortfall: needed }
  }
  const summary = ruleQuotaSummary(state, rule.id)
  // 本资料包自己的有效预占不参与占用计算，避免重复计账。
  const own = activeReservation(state, packageItem.id)
  const available = summary.available + (own && own.ruleId === rule.id ? own.amount : 0)
  if (needed > available) {
    return { ok: false, needed, available, shortfall: needed - available }
  }
  const reservation: QuotaReservation = {
    id: `rsv-${crypto.randomUUID()}`,
    packageId: packageItem.id,
    ruleId: rule.id,
    ruleVersion: rule.version,
    routeSignature: routeSignature(packageItem.approvalRoute),
    contentSignature: contentSignature(packageItem),
    amount: needed,
    round: options.round,
    status: 'active',
    backfilled: options.backfilled,
    note: options.note,
    createdAt: now(),
    updatedAt: now(),
  }
  state.reservations.push(reservation)
  // 成功预占视为人工核对缺口的解除条件。
  packageItem.quotaReviewRequired = false
  return { ok: true, needed, available, shortfall: 0, reservation }
}

/** 释放资料包当前的有效预占（例如审批退回），只释放该资料包自己的占用。 */
export function releaseActiveReservation(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  reason: string,
): QuotaReservation | undefined {
  const reservation = activeReservation(state, packageItem.id)
  if (!reservation) return undefined
  reservation.status = 'released'
  reservation.note = reason
  reservation.releasedAt = now()
  reservation.updatedAt = now()
  return reservation
}

/**
 * 校验资料包的有效预占是否仍与审批路线、规则版本和申报内容一致。
 * 不一致时旧预占立即失效；资料包仍在审批流程中时按当前规则重算预占。
 * 返回是否发生了状态变更。
 */
export function syncPackageReservation(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  onAudit?: (detail: string) => void,
): boolean {
  const reservation = activeReservation(state, packageItem.id)
  if (!reservation) return false
  const rule = findApplicableRule(packageItem, state.rules)
  const mismatched =
    !rule ||
    rule.id !== reservation.ruleId ||
    rule.version !== reservation.ruleVersion ||
    contentSignature(packageItem) !== reservation.contentSignature ||
    routeSignature(packageItem.approvalRoute) !== reservation.routeSignature
  if (!mismatched) return false

  reservation.status = 'stale'
  reservation.note = '申报内容、审批路线或规则版本变化，旧预占失效。'
  reservation.updatedAt = now()
  onAudit?.(`预占 ${reservation.amount} 失效：申报内容、审批路线或规则版本已变化。`)

  if (packageItem.status !== 'reviewing' && packageItem.status !== 'approved') return true
  const attempt = reserveQuota(state, packageItem, {
    round: packageItem.currentRound,
    note: '旧预占失效后按当前规则重算。',
  })
  if (attempt.ok) {
    onAudit?.(`按当前规则重算预占 ${attempt.reservation!.amount}（规则版本 ${attempt.reservation!.ruleVersion}）。`)
  } else {
    onAudit?.(
      `预占重算失败：需要 ${attempt.needed}，可用 ${attempt.available}，缺口 ${attempt.shortfall}。`,
    )
  }
  return true
}

/** 全量同步所有资料包的预占绑定，用于工作区加载和规则集变化后的一致性兜底。 */
export function syncAllReservations(
  state: WorkspaceState,
  onAudit?: (packageItem: MaterialPackage, detail: string) => void,
): boolean {
  let changed = false
  for (const packageItem of state.packages) {
    const packageChanged = syncPackageReservation(state, packageItem, (detail) =>
      onAudit?.(packageItem, detail),
    )
    changed = changed || packageChanged
  }
  return changed
}
