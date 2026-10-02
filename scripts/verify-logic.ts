/* 逻辑验证脚本：额度预占、迁移回填、失效重算 */
import { createInitialState } from '@/services/mockData'
import { migrateWorkspace } from '@/services/migrate'
import { refreshFindings, validatePackage, quotaContextOf } from '@/services/rules'
import {
  activeReservation,
  contentSignature,
  releaseActiveReservation,
  reserveQuota,
  ruleQuotaSummary,
  syncPackageReservation,
} from '@/services/quota'
import type { WorkspaceState } from '@/types/domain'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name}`, extra ?? '')
  }
}

// ---------- 1. 初始状态 ----------
console.log('1. 初始演示数据')
const state = createInitialState()
check('pkg-001 有有效预占 10', activeReservation(state, 'pkg-001')?.amount === 10)
check('pkg-002 有有效预占 5', activeReservation(state, 'pkg-002')?.amount === 5)
check('pkg-003 预占已释放', state.reservations.find((r) => r.packageId === 'pkg-003')?.status === 'released')
const sgPool = ruleQuotaSummary(state, 'rule-sg-composite')
check('新加坡池: 80-36-10=34', sgPool.available === 34 && sgPool.consumed === 36 && sgPool.reserved === 10, sgPool)
const usPool = ruleQuotaSummary(state, 'rule-us-lithography')
check('美国池: 30-27=3', usPool.available === 3, usPool)
const pkg3Findings = state.findings.filter((f) => f.packageId === 'pkg-003' && f.type === 'quota')
check('pkg-003 有额度缺口结论(需8 可用3 缺口5)', pkg3Findings.some((f) => f.message.includes('缺口 5')), pkg3Findings.map((f) => f.message))

// ---------- 2. 提交预占（模拟 /approval/submit 核心） ----------
console.log('2. 草稿提交预占')
const pkg4 = state.packages.find((p) => p.id === 'pkg-004')!
// 与 /approval/submit 一致：先按匹配函数同步规则，再预占
const pkg4Rule = state.rules.find((r) => r.id === 'rule-global-default')!
pkg4.matchedRuleId = pkg4Rule.id
const attempt = reserveQuota(state, pkg4, { round: 1 })
check('pkg-004 预占成功 5，绑定兜底规则', attempt.ok && attempt.reservation?.amount === 5 && attempt.reservation.ruleId === 'rule-global-default')
check('兜底规则池 20-8-5=7', ruleQuotaSummary(state, 'rule-global-default').available === 7, ruleQuotaSummary(state, 'rule-global-default'))

// 额度不足：pkg-003 重新提交需 8，可用 3
const pkg3 = state.packages.find((p) => p.id === 'pkg-003')!
const failAttempt = reserveQuota(state, pkg3, { round: 3 })
check('pkg-003 预占失败，缺口 5', !failAttempt.ok && failAttempt.shortfall === 5, failAttempt)

// ---------- 3. 退回释放 ----------
console.log('3. 审批退回释放')
const released = releaseActiveReservation(state, state.packages.find((p) => p.id === 'pkg-001')!, '审批退回，释放对应占用。')
check('pkg-001 预占被释放', released?.status === 'released')
check('新加坡池释放后 80-36-0=44', ruleQuotaSummary(state, 'rule-sg-composite').available === 44)
check('pkg-002 预占不受影响', activeReservation(state, 'pkg-002')?.amount === 5)

// ---------- 4. 申报内容变化 -> 失效重算 ----------
console.log('4. 申报内容变化，旧预占失效重算')
const pkg2 = state.packages.find((p) => p.id === 'pkg-002')!
pkg2.quotaRequested = 20 // 申报额度变化
const audits: string[] = []
const changed = syncPackageReservation(state, pkg2, (d) => audits.push(d))
check('预占已重算', changed)
check('旧预占失效', state.reservations.find((r) => r.packageId === 'pkg-002' && r.status === 'stale') !== undefined)
check('新预占 20 生效', activeReservation(state, 'pkg-002')?.amount === 20, audits)
check('内容签名一致', activeReservation(state, 'pkg-002')?.contentSignature === contentSignature(pkg2))

// 规则版本变化 -> 失效重算
const rule = state.rules.find((r) => r.id === 'rule-de-software')!
rule.version = '2026.4'
syncPackageReservation(state, pkg2, (d) => audits.push(d))
check('规则版本变化后重算绑定新版本', activeReservation(state, 'pkg-002')?.ruleVersion === '2026.4')

// ---------- 5. 旧数据迁移 ----------
console.log('5. 旧数据升级回填')
const legacy = createInitialState() as unknown as Record<string, unknown>
// 构造旧格式：无 reservations、无 quotaRequested、规则无 version
delete legacy.reservations
;(legacy.packages as Array<Record<string, unknown>>).forEach((p) => {
  delete p.quotaRequested
  delete p.quotaReviewRequired
})
;(legacy.rules as Array<Record<string, unknown>>).forEach((r) => delete r.version)
const legacyState = legacy as unknown as WorkspaceState
const migrated = migrateWorkspace(legacyState)
check('迁移发生', migrated)
check('pkg-001 回填预占 5（默认申报额度）', activeReservation(legacyState, 'pkg-001')?.amount === 5)
check('pkg-001 回填标记', activeReservation(legacyState, 'pkg-001')?.backfilled === true)
check('pkg-002 回填预占 5', activeReservation(legacyState, 'pkg-002')?.amount === 5)
const pkg3Legacy = legacyState.packages.find((p) => p.id === 'pkg-003')!
check('pkg-003 无法回填（需5 可用3）-> 待人工核对', pkg3Legacy.quotaReviewRequired === true)
check('pkg-003 无有效预占', activeReservation(legacyState, 'pkg-003') === undefined)
check('pkg-004 草稿不回填', activeReservation(legacyState, 'pkg-004') === undefined)
check('规则版本补齐', legacyState.rules.every((r) => typeof r.version === 'string'))
const migrationAudits = legacyState.audit.filter((a) => a.operator === '系统迁移')
check('迁移审计完整（回填2+待核对1+升级1）', migrationAudits.length >= 4, migrationAudits.map((a) => a.action))
const pkg3FindingsAfter = legacyState.findings.filter((f) => f.packageId === 'pkg-003' && f.type === 'quota' && f.level === 'high')
check('pkg-003 有待人工核对高风险结论', pkg3FindingsAfter.some((f) => f.message.includes('待人工核对')))
// 幂等：再次迁移无变化
check('迁移幂等', !migrateWorkspace(legacyState))

// ---------- 6. 扣减口径（validatePackage 对 licensed 不再报缺口） ----------
console.log('6. 许可完成后记录稳定')
const s2 = createInitialState()
const p2 = s2.packages.find((p) => p.id === 'pkg-002')!
p2.status = 'licensed'
p2.quotaUsed += 5
const r2 = activeReservation(s2, 'pkg-002')!
r2.status = 'consumed'
r2.consumedAmount = 5
refreshFindings(s2)
check('licensed 后无额度缺口结论', !s2.findings.some((f) => f.packageId === 'pkg-002' && f.type === 'quota'))
check('德国池 120-47-0=73', ruleQuotaSummary(s2, 'rule-de-software').available === 73)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
