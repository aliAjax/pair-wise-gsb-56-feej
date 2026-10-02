import type { MaterialPackage, WorkspaceState } from '@/types/domain'
import { refreshFindings } from './rules'
import { reserveQuota, syncAllReservations } from './quota'

const now = () => new Date().toISOString()

/** 旧版本没有预占机制的进行中状态，升级时需要回填额度占用。 */
const IN_FLIGHT_STATUSES: MaterialPackage['status'][] = ['reviewing', 'approved', 'returned']

function needsMigration(state: WorkspaceState): boolean {
  return (
    !Array.isArray(state.reservations) ||
    state.packages.some((item) => typeof item.quotaRequested !== 'number') ||
    state.rules.some((item) => typeof item.version !== 'string')
  )
}

/**
 * 旧数据升级：
 * 1. 补齐规则版本、申报额度等新字段；
 * 2. 对没有预占记录的进行中资料包，按当前规则和已用额度回填预占；
 * 3. 无法回填的标记为待人工核对并阻止扣减；
 * 4. 全量重算校验结论，保证额度、审批状态和追溯导出一致。
 * 返回是否发生了变更。
 */
export function migrateWorkspace(state: WorkspaceState): boolean {
  if (!needsMigration(state)) return false

  state.rules.forEach((rule) => {
    if (typeof rule.version !== 'string') rule.version = '2026.1'
  })
  state.packages.forEach((packageItem) => {
    if (typeof packageItem.quotaRequested !== 'number') {
      packageItem.quotaRequested =
        packageItem.status === 'licensed' && packageItem.quotaUsed > 0
          ? packageItem.quotaUsed
          : 5
    }
    if (typeof packageItem.quotaReviewRequired !== 'boolean') {
      packageItem.quotaReviewRequired = false
    }
  })
  if (!Array.isArray(state.reservations)) state.reservations = []

  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }

  // 先提交先得的顺序回填：按创建时间升序，早进入流程的资料包优先占用额度。
  const inFlight = state.packages
    .filter((item) => IN_FLIGHT_STATUSES.includes(item.status))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  let backfilled = 0
  let manualReview = 0
  for (const packageItem of inFlight) {
    const hasReservation = state.reservations.some(
      (reservation) => reservation.packageId === packageItem.id && reservation.status === 'active',
    )
    if (hasReservation) continue
    const attempt = reserveQuota(state, packageItem, {
      round: packageItem.currentRound,
      backfilled: true,
      note: '旧数据升级回填。',
    })
    if (attempt.ok) {
      backfilled += 1
      audit({
        packageId: packageItem.id,
        action: '迁移回填预占',
        target: packageItem.code,
        operator: '系统迁移',
        detail: `按当前规则回填额度预占 ${attempt.reservation!.amount}（规则版本 ${attempt.reservation!.ruleVersion}）。`,
      })
    } else {
      manualReview += 1
      packageItem.quotaReviewRequired = true
      audit({
        packageId: packageItem.id,
        action: '迁移待人工核对',
        target: packageItem.code,
        operator: '系统迁移',
        detail: `无法回填额度预占：需要 ${attempt.needed}，规则池可用 ${attempt.available}，缺口 ${attempt.shortfall}。已标记待人工核对并阻止扣减。`,
      })
    }
  }

  // 规则版本补齐后再过一遍绑定校验，让与现行规则不一致的旧预占立即失效重算。
  syncAllReservations(state, (packageItem, detail) =>
    audit({
      packageId: packageItem.id,
      action: '预占失效重算',
      target: packageItem.code,
      operator: '系统迁移',
      detail,
    }),
  )

  refreshFindings(state)
  audit({
    action: '工作区数据升级',
    target: '额度预占机制',
    operator: '系统迁移',
    detail: `升级完成：回填预占 ${backfilled} 笔，待人工核对 ${manualReview} 个资料包。`,
  })
  return true
}
