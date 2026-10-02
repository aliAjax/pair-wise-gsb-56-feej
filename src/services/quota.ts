import type {
  AuditEntry,
  LicenseRecord,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  QuotaReservation,
  ReservationReleaseReason,
  WorkspaceState,
} from '@/types/domain'
import { approvalLevelRank, findApplicableRule } from './rules'

export interface RuleQuotaPool {
  ruleId: string
  limit: number
  /** 已完成扣减台账合计（不可变） */
  consumed: number
  /** 当前有效预占合计 */
  held: number
  /** 可用额度 = 上限 - 已扣 - 预占 */
  available: number
}

export function now(): string {
  return new Date().toISOString()
}

export function pushAudit(
  state: WorkspaceState,
  entry: Omit<AuditEntry, 'id' | 'createdAt'> & { createdAt?: string },
): void {
  state.audit.unshift({
    ...entry,
    id: `audit-${crypto.randomUUID()}`,
    createdAt: entry.createdAt ?? now(),
  })
}

/* -------------------------------- 指纹绑定 -------------------------------- */

/** 申报内容指纹：影响规则匹配与额度的申报字段 + 文件引用版本 + 申请额度 */
export function contentSignature(pkg: MaterialPackage, files: MaterialFile[]): string {
  const referencedFiles = files
    .filter((file) => file.packageId === pkg.id)
    .map((file) => [file.id, file.referencedVersionId || file.activeVersionId])
    .sort(([a], [b]) => a.localeCompare(b))
  return stableHash([
    pkg.title,
    pkg.category,
    pkg.destination,
    pkg.endUse,
    [...pkg.technologyTags].sort(),
    [...pkg.personnelScopes].sort(),
    [...pkg.declarations].sort(),
    pkg.quotaRequest,
    referencedFiles,
  ])
}

/** 规则内容指纹：决定审批路线和申报义务的规则要素（不含版本号与额度上限） */
export function ruleFingerprint(rule: LicenseRule): string {
  return stableHash([
    [...rule.categories].sort(),
    [...rule.destinations].sort(),
    [...rule.technologyTags].sort(),
    [...rule.personnelScopes].sort(),
    [...rule.requiredDeclarations].sort(),
    rule.approvalLevel,
  ])
}

/** 审批路线指纹：顺序、角色、处理人与审批等级（不含状态/意见/时间） */
export function routeSignature(route: MaterialPackage['approvalRoute']): string {
  return stableHash(
    route
      .map((step) => [step.order, step.role, step.assignee, step.level])
      .sort(([a], [b]) => Number(a) - Number(b)),
  )
}

function stableHash(value: unknown): string {
  const json = JSON.stringify(value)
  let hash = 5381
  for (let index = 0; index < json.length; index += 1) {
    hash = (hash * 33) ^ json.charCodeAt(index)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/* -------------------------------- 规则额度池 ------------------------------- */

export function ruleQuotaPool(state: WorkspaceState, ruleId: string): RuleQuotaPool {
  const rule = state.rules.find((item) => item.id === ruleId)
  const limit = rule?.quotaLimit ?? 0
  const consumed = state.licenses
    .filter((item) => item.ruleId === ruleId)
    .reduce((sum, item) => sum + item.amount, 0)
  const held = state.reservations
    .filter((item) => item.ruleId === ruleId && item.status === 'held')
    .reduce((sum, item) => sum + item.amount, 0)
  return { ruleId, limit, consumed, held, available: limit - consumed - held }
}

export function allRulePools(state: WorkspaceState): RuleQuotaPool[] {
  return state.rules.map((rule) => ruleQuotaPool(state, rule.id))
}

/** 校验单个资料包时，额度池需排除其自身的有效预占，避免把自己占用误报为缺口。 */
export function ruleQuotaPoolExcludingPackage(
  state: WorkspaceState,
  ruleId: string,
  packageId: string,
): RuleQuotaPool {
  const pool = ruleQuotaPool(state, ruleId)
  const ownHeld = state.reservations
    .filter(
      (item) => item.ruleId === ruleId && item.packageId === packageId && item.status === 'held',
    )
    .reduce((sum, item) => sum + item.amount, 0)
  return { ...pool, held: pool.held - ownHeld, available: pool.available + ownHeld }
}

export function heldReservationFor(
  state: WorkspaceState,
  packageId: string,
): QuotaReservation | undefined {
  return state.reservations.find(
    (item) => item.packageId === packageId && item.status === 'held',
  )
}

export function lastReservationFor(
  state: WorkspaceState,
  packageId: string,
): QuotaReservation | undefined {
  return state.reservations.find((item) => item.packageId === packageId && item.id)
}

/* -------------------------------- 预占有效性 ------------------------------- */

/**
 * 预占必须与当前规则版本、规则内容、申报内容和审批路线全部一致，
 * 任一变化立即判定为失效。
 */
export function isReservationCurrent(
  reservation: QuotaReservation,
  pkg: MaterialPackage,
  state: WorkspaceState,
): boolean {
  if (reservation.status !== 'held') return false
  if (pkg.matchedRuleId !== reservation.ruleId) return false
  const rule = state.rules.find((item) => item.id === reservation.ruleId)
  if (!rule) return false
  if (rule.version !== reservation.ruleVersion) return false
  if (ruleFingerprint(rule) !== reservation.ruleFingerprint) return false
  if (pkg.currentRound !== reservation.round) return false
  if (routeSignature(pkg.approvalRoute) !== reservation.routeSignature) return false
  if (contentSignature(pkg, state.files) !== reservation.contentSignature) return false
  return true
}

/* -------------------------------- 预占生命周期 ------------------------------ */

interface ReservationRequest {
  amount: number
  rule: LicenseRule
  clientId: string
  operator: string
  round: number
  route: MaterialPackage['approvalRoute']
  backfilled?: boolean
  note?: string
}

export function releaseReservation(
  reservation: QuotaReservation,
  reason: ReservationReleaseReason,
  note?: string,
  timestamp = now(),
): void {
  if (reservation.status === 'released') return
  reservation.status = 'released'
  reservation.releaseReason = reason
  reservation.releasedAt = timestamp
  if (note) reservation.note = note
}

/** 尝试为资料包预占额度；额度不足时生成留痕的缺口预占（released/shortfall） */
export function reserveQuota(
  state: WorkspaceState,
  pkg: MaterialPackage,
  request: ReservationRequest,
): { ok: boolean; reservation: QuotaReservation; shortfall: number } {
  const { rule, amount } = request
  const pool = ruleQuotaPool(state, rule.id)
  const timestamp = now()
  const base = {
    id: `reservation-${crypto.randomUUID()}`,
    packageId: pkg.id,
    ruleId: rule.id,
    ruleVersion: rule.version,
    round: request.round,
    amount,
    routeSignature: routeSignature(request.route),
    contentSignature: contentSignature(pkg, state.files),
    ruleFingerprint: ruleFingerprint(rule),
    createdBy: request.operator,
    clientId: request.clientId,
    backfilled: request.backfilled,
    note: request.note,
    createdAt: timestamp,
  }
  if (amount <= pool.available) {
    const reservation: QuotaReservation = { ...base, status: 'held' }
    state.reservations.unshift(reservation)
    pkg.lastReservationId = reservation.id
    return { ok: true, reservation, shortfall: 0 }
  }
  const reservation: QuotaReservation = {
    ...base,
    status: 'released',
    releaseReason: 'shortfall',
    shortfall: amount - pool.available,
    releasedAt: timestamp,
  }
  state.reservations.unshift(reservation)
  pkg.lastReservationId = reservation.id
  return { ok: false, reservation, shortfall: amount - pool.available }
}

/* --------------------------- 失效扫描与自动重算 ----------------------------- */

const IN_FLIGHT_STATUSES = ['validating', 'reviewing', 'approved'] as const

/**
 * 扫描所有有效预占：规则版本/规则内容/申报内容/审批路线任一变化即释放旧预占，
 * 并按当前规则与额度池立即重算。返回受影响的资料包 id。
 */
export function reconcileReservations(
  state: WorkspaceState,
  operator = '系统',
): MaterialPackage['id'][] {
  const affected = new Set<string>()
  state.reservations
    .filter((reservation) => reservation.status === 'held')
    .forEach((reservation) => {
      const pkg = state.packages.find((item) => item.id === reservation.packageId)
      if (!pkg || !isReservationCurrent(reservation, pkg, state)) {
        releaseReservation(reservation, 'invalidated', '绑定的规则版本、申报内容或审批路线已变化。')
        pushAudit(state, {
          packageId: reservation.packageId,
          action: '预占失效',
          target: pkg?.code ?? reservation.packageId,
          operator,
          detail: `旧预占 ${reservation.amount} 个额度因规则或申报变化立即释放，按当前规则重算。`,
        })
        if (pkg) affected.add(pkg.id)
      }
    })
  affected.forEach((packageId) => {
    const pkg = state.packages.find((item) => item.id === packageId)
    if (pkg) recomputeReservation(state, pkg, operator)
  })
  return [...affected]
}

/**
 * 失效后重算：仅对在途资料包自动重新预占。
 * 规则升级导致现有路线不满足时退回草稿；额度不足时留草稿并写明缺口。
 * 返回是否真正重算以及（失败时的）缺口数额。
 */
export function recomputeReservation(
  state: WorkspaceState,
  pkg: MaterialPackage,
  operator = '系统',
): { recomputed: boolean; shortfall: number; reason?: 'no-rule' | 'route' | 'shortfall' } {
  if (pkg.status === 'licensed' || pkg.status === 'locked') return { recomputed: false, shortfall: 0 }
  if (!IN_FLIGHT_STATUSES.includes(pkg.status as (typeof IN_FLIGHT_STATUSES)[number])) {
    return { recomputed: false, shortfall: 0 }
  }

  // 已持有与当前规则版本、申报内容、审批路线全部一致的预占：无变化不重算，避免重复占用。
  const currentHeld = heldReservationFor(state, pkg.id)
  if (currentHeld && isReservationCurrent(currentHeld, pkg, state)) {
    return { recomputed: false, shortfall: 0 }
  }

  // 旧预占已失效：重算前先释放，避免同一资料包双重占用。
  if (currentHeld) {
    releaseReservation(currentHeld, 'invalidated', '申报内容或规则版本变化，旧预占在重算前释放。')
    pushAudit(state, {
      packageId: pkg.id,
      action: '预占失效',
      target: pkg.code,
      operator,
      detail: `旧预占 ${currentHeld.amount} 个额度在重算前释放。`,
    })
  }

  const rule = findApplicableRule(pkg, state.rules)
  pkg.matchedRuleId = rule?.id
  if (!rule) {
    pkg.status = 'draft'
    pushAudit(state, {
      packageId: pkg.id,
      action: '预占重算失败',
      target: pkg.code,
      operator,
      detail: '申报变化后未匹配到适用许可规则，资料包退回草稿等待补正。',
    })
    return { recomputed: true, shortfall: 0, reason: 'no-rule' }
  }

  const currentMaxLevel = pkg.approvalRoute.reduce(
    (max, step) => Math.max(max, approvalLevelRank[step.level]),
    0,
  )
  if (!pkg.approvalRoute.length || currentMaxLevel < approvalLevelRank[rule.approvalLevel]) {
    pkg.status = 'draft'
    pushAudit(state, {
      packageId: pkg.id,
      action: '预占重算退回',
      target: pkg.code,
      operator,
      detail: `规则 ${rule.name} 要求${currentMaxLevel < approvalLevelRank[rule.approvalLevel] ? '升级' : '重新生成'}审批路线，需重新提交审批。`,
    })
    return { recomputed: true, shortfall: 0, reason: 'route' }
  }

  const result = reserveQuota(state, pkg, {
    amount: Math.max(0, Math.round(pkg.quotaRequest)),
    rule,
    clientId: 'system-recompute',
    operator,
    round: pkg.currentRound,
    route: pkg.approvalRoute,
  })
  if (result.ok) {
    pushAudit(state, {
      packageId: pkg.id,
      action: '预占重算成功',
      target: pkg.code,
      operator,
      detail: `按规则 ${rule.name}（版本 ${rule.version}）重新预占 ${result.reservation.amount} 个额度。`,
    })
    return { recomputed: true, shortfall: 0 }
  }
  pkg.status = 'draft'
  pushAudit(state, {
    packageId: pkg.id,
    action: '预占重算失败',
    target: pkg.code,
    operator,
    detail: `规则 ${rule.name} 可用额度不足，缺口 ${result.shortfall} 个，资料包留在草稿。`,
  })
  return { recomputed: true, shortfall: result.shortfall, reason: 'shortfall' }
}

/* -------------------------------- 扣减台账 -------------------------------- */

/**
 * 把有效预占转成不可变的许可扣减记录：预占释放、台账新增，占用与扣减一进一出。
 */
export function commitLicense(
  state: WorkspaceState,
  pkg: MaterialPackage,
  reservation: QuotaReservation,
  operator: string,
): LicenseRecord {
  const rule = state.rules.find((item) => item.id === reservation.ruleId)
  if (!rule) throw new Error('预占绑定的规则不存在')
  const timestamp = now()
  releaseReservation(reservation, 'deducted', '审批完成，预占转为正式扣减。', timestamp)
  const record: LicenseRecord = {
    id: `license-${crypto.randomUUID()}`,
    packageId: pkg.id,
    packageCode: pkg.code,
    ruleId: reservation.ruleId,
    ruleVersion: reservation.ruleVersion,
    reservationId: reservation.id,
    amount: reservation.amount,
    balanceAfter: 0,
    operator,
    licensedAt: timestamp,
  }
  state.licenses.unshift(record)
  // 台账入账后再计算余额：可用 = 上限 - 全部已扣（含本笔）- 其他有效预占。
  record.balanceAfter = ruleQuotaPool(state, rule.id).available
  return record
}

export function licenseForPackage(
  state: WorkspaceState,
  packageId: string,
): LicenseRecord | undefined {
  return state.licenses.find((item) => item.packageId === packageId)
}

/** 已完成许可（licensed）的资料包任何字段都不允许改动 */
export function assertNotLicensed(state: WorkspaceState, packageId: string): void {
  const pkg = state.packages.find((item) => item.id === packageId)
  if (pkg?.status === 'licensed' || pkg?.status === 'locked') {
    throw new Error('该资料包已完成许可，记录不可改动')
  }
}

/* -------------------------------- 一致性自检 ------------------------------- */

export interface ConsistencyIssue {
  scope: string
  message: string
}

/** 额度、审批状态、预占与台账的交叉一致性检查，供追溯导出使用 */
export function verifyConsistency(state: WorkspaceState): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = []
  state.rules.forEach((rule) => {
    const pool = ruleQuotaPool(state, rule.id)
    if (pool.consumed > rule.quotaLimit) {
      issues.push({
        scope: rule.name,
        message: `已扣减 ${pool.consumed} 超过规则上限 ${rule.quotaLimit}`,
      })
    }
    if (pool.consumed + pool.held > rule.quotaLimit) {
      issues.push({
        scope: rule.name,
        message: `已扣减加预占 ${pool.consumed + pool.held} 超过规则上限 ${rule.quotaLimit}`,
      })
    }
  })
  state.reservations
    .filter((item) => item.status === 'held')
    .forEach((reservation) => {
      const pkg = state.packages.find((item) => item.id === reservation.packageId)
      if (!pkg) {
        issues.push({ scope: reservation.id, message: '预占对应的资料包不存在' })
        return
      }
      if (!isReservationCurrent(reservation, pkg, state)) {
        issues.push({ scope: pkg.code, message: '存在已失效但仍占用额度的预占，应先执行重算' })
      }
      if (pkg.status === 'returned' || pkg.status === 'draft') {
        issues.push({ scope: pkg.code, message: `状态为${pkg.status}却仍持有额度预占` })
      }
    })
  state.packages.forEach((pkg) => {
    if (pkg.status === 'licensed' && !licenseForPackage(state, pkg.id)) {
      issues.push({ scope: pkg.code, message: '已许可资料包缺少扣减台账记录' })
    }
    if (pkg.manualReviewRequired && licenseForPackage(state, pkg.id)) {
      issues.push({ scope: pkg.code, message: '待人工核对资料包不应存在扣减记录' })
    }
  })
  return issues
}
