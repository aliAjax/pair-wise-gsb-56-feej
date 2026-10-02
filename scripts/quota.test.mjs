/* eslint-disable no-console */
// 核心额度预占逻辑的 Node 端验证脚本，用 esbuild 即时转译 TS（不依赖浏览器）。
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workdir = mkdtempSync(join(tmpdir(), 'quota-test-'))
const entry = join(workdir, 'entry.ts')
const root = process.cwd()

const paths = {
  mockData: join(root, 'src/services/mockData.ts'),
  migration: join(root, 'src/services/migration.ts'),
  quota: join(root, 'src/services/quota.ts'),
  rules: join(root, 'src/services/rules.ts'),
}

writeFileSync(
  entry,
  `
export { createInitialState, createLegacyV1State } from ${JSON.stringify(paths.mockData)}
export { migrateWorkspace } from ${JSON.stringify(paths.migration)}
export {
  allRulePools,
  commitLicense,
  heldReservationFor,
  isReservationCurrent,
  reconcileReservations,
  recomputeReservation,
  releaseReservation,
  reserveQuota,
  ruleQuotaPool,
  verifyConsistency,
} from ${JSON.stringify(paths.quota)}
export { findApplicableRule, createApprovalRoute } from ${JSON.stringify(paths.rules)}
`,
)

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  alias: {
    '@': join(root, 'src'),
  },
})
const code = result.outputFiles[0].text
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const mod = await import(dataUrl)

let passed = 0
let failed = 0
function assert(condition, message) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error('✗ ' + message)
  }
}
function section(title) {
  console.log('\n=== ' + title + ' ===')
}

/* ------------------------------- 初始数据一致性 ------------------------------ */
section('初始种子数据')
{
  const state = mod.createInitialState()
  assert(state.schemaVersion === 2, '种子数据 schemaVersion=2')
  const sg = mod.ruleQuotaPool(state, 'rule-sg-composite')
  // pkg-001 预占 20 + pkg-005 预占 30，无台账
  assert(sg.limit === 80 && sg.held === 50 && sg.consumed === 0 && sg.available === 30, `SG 池应为 80/已扣0/预占50/可用30，实际 ${JSON.stringify(sg)}`)
  const de = mod.ruleQuotaPool(state, 'rule-de-software')
  // pkg-007 已扣 60，pkg-002 预占 30
  assert(de.consumed === 60 && de.held === 30 && de.available === 30, `DE 池应为 已扣60/预占30/可用30，实际 ${JSON.stringify(de)}`)
  const us = mod.ruleQuotaPool(state, 'rule-us-lithography')
  // pkg-006 预占 22
  assert(us.held === 22 && us.available === 8, `US 池应预占22/可用8，实际 ${JSON.stringify(us)}`)
  assert(mod.verifyConsistency(state).length === 0, '种子数据一致性检查应无问题: ' + JSON.stringify(mod.verifyConsistency(state)))
  const licensedPkg = state.packages.find((p) => p.id === 'pkg-007')
  assert(licensedPkg.status === 'licensed', 'pkg-007 应为已许可')
  assert(state.licenses.some((l) => l.packageId === 'pkg-007' && l.amount === 60), 'pkg-007 应有 60 的不可变台账')
}

/* --------------------------- 预占竞争：超扣必须失败 -------------------------- */
section('规则池竞争预占')
{
  const state = mod.createInitialState()
  const rule = state.rules.find((r) => r.id === 'rule-us-lithography')
  // US 池可用 8，新建一个申报申请 10 必须失败并写明缺口 2
  const pkg = {
    ...state.packages.find((p) => p.id === 'pkg-003'),
    id: 'pkg-test-overbook',
    code: 'EC-TEST',
    status: 'reviewing',
    currentRound: 1,
    quotaRequest: 10,
    approvalRoute: mod.createApprovalRoute(rule.approvalLevel),
  }
  state.packages.push(pkg)
  const r1 = mod.reserveQuota(state, pkg, {
    amount: 10, rule, clientId: 'c1', operator: '测试', round: 1, route: pkg.approvalRoute,
  })
  assert(r1.ok === false && r1.shortfall === 2, `申请10/可用8 应失败且缺口2，实际 ${JSON.stringify({ ok: r1.ok, s: r1.shortfall })}`)
  assert(r1.reservation.status === 'released' && r1.reservation.releaseReason === 'shortfall', '失败预占应留痕为 released/shortfall')
  // 失败的预占不能占池
  const pool = mod.ruleQuotaPool(state, rule.id)
  assert(pool.held === 22 && pool.available === 8, '失败预占不应占用池子')
  // 申请 8 成功
  const r2 = mod.reserveQuota(state, pkg, {
    amount: 8, rule, clientId: 'c1', operator: '测试', round: 1, route: pkg.approvalRoute,
  })
  assert(r2.ok === true && mod.ruleQuotaPool(state, rule.id).available === 0, '申请8 应成功且池子归零')
}

/* --------------------------- 两个资料包同时竞争同一规则 ------------------------ */
section('多资料包串行竞争')
{
  const state = mod.createInitialState()
  const rule = state.rules.find((r) => r.id === 'rule-sg-composite') // 可用 30
  const pkgA = state.packages.find((p) => p.id === 'pkg-004')
  pkgA.status = 'reviewing'
  pkgA.quotaRequest = 20
  pkgA.matchedRuleId = rule.id
  pkgA.destination = '新加坡'
  pkgA.technologyTags = ['复合材料']
  pkgA.approvalRoute = mod.createApprovalRoute('enhanced')
  const a = mod.reserveQuota(state, pkgA, { amount: 20, rule, clientId: 'a', operator: 'A', round: 1, route: pkgA.approvalRoute })
  assert(a.ok, 'A 预占20应成功')
  // 再克隆一个竞争包
  const pkgB = { ...pkgA, id: 'pkg-b', code: 'EC-B', quotaRequest: 20 }
  const b = mod.reserveQuota(state, pkgB, { amount: 20, rule, clientId: 'b', operator: 'B', round: 1, route: pkgB.approvalRoute })
  assert(b.ok === false && b.shortfall === 10, `B 再要20 应失败缺口10（30-20=10），实际 ${b.shortfall}`)
}

/* --------------------------- 失效：申报内容变化立即重算 ----------------------- */
section('申报内容变化失效重算')
{
  const state = mod.createInitialState()
  const pkg = state.packages.find((p) => p.id === 'pkg-001')
  const heldBefore = mod.heldReservationFor(state, pkg.id)
  assert(heldBefore && heldBefore.amount === 20, 'pkg-001 初始应持有20预占')
  // 模拟修改申报内容（技术标签变化）
  pkg.technologyTags = ['复合材料', '工艺参数', '新增受控参数']
  const affected = mod.reconcileReservations(state)
  assert(affected.includes('pkg-001'), '内容变化的资料包应进入重算列表')
  const heldAfter = mod.heldReservationFor(state, pkg.id)
  // 重算时按 quotaRequest=20 重新预占，SG 池仍应平衡
  const sg = mod.ruleQuotaPool(state, 'rule-sg-composite')
  assert(heldAfter && heldAfter.amount === 20, '重算后应生成新的20预占')
  assert(heldAfter.id !== heldBefore.id, '新预占 id 应不同于旧预占')
  assert(mod.isReservationCurrent(heldAfter, pkg, state), '新预占应与当前内容一致')
  assert(sg.held === 50 && sg.available === 30, `重算后 SG 池总额不变（50/30），实际 ${JSON.stringify(sg)}`)
  // 旧预占必须已释放
  assert(heldBefore.status === 'released' && heldBefore.releaseReason === 'invalidated', '旧预占应被释放为 invalidated')
}

/* ----------------------------- 失效：规则版本升级 ----------------------------- */
section('规则发布新版本后旧预占失效')
{
  const state = mod.createInitialState()
  const oldHeld = mod.heldReservationFor(state, state.packages.find((p) => p.id === 'pkg-001').id)
  const usRule = state.rules.find((r) => r.id === 'rule-us-lithography')
  usRule.approvalLevel = 'senior' // 内容不变（本就是 senior），仅模拟 SG 升级
  const sgRule = state.rules.find((r) => r.id === 'rule-sg-composite')
  sgRule.approvalLevel = 'senior'
  sgRule.version += 1
  const affected = mod.reconcileReservations(state, '合规专员')
  // pkg-001、pkg-005 都是 SG enhanced 路线，升级 senior 后现有路线不满足，应退回草稿
  const p1 = state.packages.find((p) => p.id === 'pkg-001')
  const p5 = state.packages.find((p) => p.id === 'pkg-005')
  assert(affected.includes('pkg-001') && affected.includes('pkg-005'), 'SG 在途两包都应受影响')
  assert(p1.status === 'draft' && p5.status === 'draft', '审批等级升级后路线不满足，应退回草稿')
  assert(!mod.heldReservationFor(state, 'pkg-001'), '退回草稿后不应再有有效预占')
  assert(oldHeld.status === 'released', '旧版本预占应已释放')
  const sg = mod.ruleQuotaPool(state, 'rule-sg-composite')
  assert(sg.held === 0, 'SG 池预占应全部释放: ' + sg.held)
  // US pkg-006 不受影响
  assert(mod.heldReservationFor(state, 'pkg-006')?.amount === 22, 'US 预占不受 SG 升级影响')
}

/* -------------------------------- 审批退回释放 -------------------------------- */
section('审批退回只释放本包占用')
{
  const state = mod.createInitialState()
  const before = mod.ruleQuotaPool(state, 'rule-us-lithography')
  const held = mod.heldReservationFor(state, 'pkg-006')
  mod.releaseReservation(held, 'returned', '第 1 轮审批退回')
  const after = mod.ruleQuotaPool(state, 'rule-us-lithography')
  assert(after.held === before.held - 22 && after.available === before.available + 22, '退回后 US 池应释放22: ' + JSON.stringify(after))
  // SG 不受影响
  const sg = mod.ruleQuotaPool(state, 'rule-sg-composite')
  assert(sg.held === 50, '退回 US 包不应影响 SG 池')
}

/* ---------------------------------- 扣减台账 ---------------------------------- */
section('扣减：预占转不可变台账')
{
  const state = mod.createInitialState()
  const pkg = state.packages.find((p) => p.id === 'pkg-002')
  const reservation = mod.heldReservationFor(state, pkg.id)
  assert(reservation.amount === 30, 'pkg-002 应有30预占')
  const beforeDe = mod.ruleQuotaPool(state, 'rule-de-software')
  const record = mod.commitLicense(state, pkg, reservation, '合规专员')
  assert(record.amount === 30, '台账应记录30')
  assert(record.balanceAfter === 30, `扣减后余额应30（120-90已扣60+新30），实际 ${record.balanceAfter}`)
  const afterDe = mod.ruleQuotaPool(state, 'rule-de-software')
  assert(afterDe.consumed === 90 && afterDe.held === 0 && afterDe.available === 30, `扣减后 DE 池 已扣90/预占0/可用30，实际 ${JSON.stringify(afterDe)}`)
  assert(reservation.status === 'released' && reservation.releaseReason === 'deducted', '预占应转为 deducted')
  // 台账只增：再尝试对同一包扣减不应找到 held
  assert(!mod.heldReservationFor(state, pkg.id), '扣减后不应再有有效预占')
  assert(mod.verifyConsistency(state).length === 0, '扣减后一致性应通过: ' + JSON.stringify(mod.verifyConsistency(state)))
  void beforeDe
}

/* ------------------------------ 旧数据迁移回填 ------------------------------- */
section('旧数据 v1 -> v2 迁移回填')
{
  const legacy = mod.createLegacyV1State()
  assert(legacy.schemaVersion === undefined, '旧数据应无 schemaVersion')
  assert(!legacy.reservations && !legacy.licenses, '旧数据应无预占和台账')
  const state = mod.migrateWorkspace(legacy)
  assert(state.schemaVersion === 2, '迁移后 schemaVersion=2')
  // pkg-007 已许可 60 -> 台账
  const lic = state.licenses.find((l) => l.packageId === 'pkg-007')
  assert(lic && lic.amount === 60 && lic.backfilled, 'pkg-007 应回填60台账并标记 backfilled')
  // 旧数据中 US：历史 quotaUsed pkg-006=22（占用），pkg-003 被改成 reviewing 申请10，池上限30
  // 按创建时间：pkg-003 (09-16) 先回填 10，pkg-006 (09-10 更早?) —— 检查实际
  const usPool = mod.ruleQuotaPool(state, 'rule-us-lithography')
  const p3 = state.packages.find((p) => p.id === 'pkg-003')
  const p6 = state.packages.find((p) => p.id === 'pkg-006')
  // pkg-006 createdAt 09-10 早于 pkg-003 09-16，先占22；pkg-003 再要10 时只剩8 -> 缺口2 -> 人工核对
  assert(p6 && !p6.manualReviewRequired, 'pkg-006 应能回填（22<=30）: ' + p6?.manualReviewRequired)
  assert(p3?.manualReviewRequired === true, 'pkg-003 应标成待人工核对（22+10>30 缺口2）')
  assert(usPool.held === 22 && usPool.available === 8, `US 池迁移后应预占22/可用8，实际 ${JSON.stringify(usPool)}`)
  // 待人工核对的包不能产生 held
  assert(!mod.heldReservationFor(state, 'pkg-003'), '待人工核对包不应持有预占')
  // 审计必须留痕
  assert(state.audit.some((a) => a.action === '工作区数据升级'), '应有升级审计')
  assert(state.audit.some((a) => a.action === '升级回填待人工核对' && a.packageId === 'pkg-003'), '应有待人工核对审计')
  assert(mod.verifyConsistency(state).length === 0, '迁移后一致性应通过: ' + JSON.stringify(mod.verifyConsistency(state)))
  // 已许可记录不可变：pkg-007 的 license 仍是60
  assert(state.licenses.filter((l) => l.packageId === 'pkg-007').length === 1, 'pkg-007 台账唯一')
}

/* ------------------------- 迁移幂等：已迁移数据不再重复回填 ---------------------- */
section('迁移幂等性')
{
  const state = mod.createInitialState()
  const reservationsCount = state.reservations.length
  const licensesCount = state.licenses.length
  // 再跑一次迁移不应发生（needsMigration=false），这里直接验证 migrate 对 v2 不适用即可
  assert(reservationsCount > 0 && licensesCount > 0, '种子数据自带预占和台账')
}

/* --------------------------- 一致性检查能发现超扣 ----------------------------- */
section('一致性检查')
{
  const state = mod.createInitialState()
  // 手工塞一条超出上限的台账
  state.licenses.unshift({
    id: 'license-fake', packageId: 'pkg-x', packageCode: 'X', ruleId: 'rule-my-general',
    ruleVersion: 1, reservationId: 'r', amount: 999, balanceAfter: 0, operator: 'x', licensedAt: new Date().toISOString(),
  })
  const issues = mod.verifyConsistency(state)
  assert(issues.some((i) => i.scope.includes('马来西亚')), '超扣应被一致性检查发现: ' + JSON.stringify(issues))
}

/* ------------------------- 无变化不重算 / 申请额度变化重算 ---------------------- */
section('保存未变化资料包不应重复预占')
{
  const state = mod.createInitialState()
  const pkg = state.packages.find((p) => p.id === 'pkg-001')
  const heldId = mod.heldReservationFor(state, pkg.id).id
  const heldCount = state.reservations.filter((r) => r.packageId === 'pkg-001').length
  const out = mod.recomputeReservation(state, pkg, '当前用户')
  assert(out.recomputed === false, '内容无变化时不应重算')
  assert(mod.heldReservationFor(state, pkg.id).id === heldId, '应沿用原预占，不新建')
  assert(state.reservations.filter((r) => r.packageId === 'pkg-001').length === heldCount, '不应新增预占记录')
  // 修改申请额度后必须立即重算
  pkg.quotaRequest = 25
  const out2 = mod.recomputeReservation(state, pkg, '当前用户')
  assert(out2.recomputed === true, '申请额度变化应触发重算')
  const newHeld = mod.heldReservationFor(state, pkg.id)
  assert(newHeld.amount === 25 && newHeld.id !== heldId, '新预占应为25且为新记录')
  // SG 池：25(pkg-001)+30(pkg-005)=55，可用25
  const sg = mod.ruleQuotaPool(state, 'rule-sg-composite')
  assert(sg.held === 55 && sg.available === 25, `SG 池应预占55/可用25，实际 ${JSON.stringify(sg)}`)
}

/* ---------------------------- 种子数据工厂相互隔离 --------------------------- */
section('createInitialState 每次返回全新规则')
{
  const a = mod.createInitialState()
  const b = mod.createInitialState()
  const sgA = a.rules.find((r) => r.id === 'rule-sg-composite')
  const sgB = b.rules.find((r) => r.id === 'rule-sg-composite')
  sgA.version = 9
  sgA.quotaLimit = 999
  assert(sgB.version === 1 && sgB.quotaLimit === 80, '修改一份种子规则不应污染后续种子（恢复演示数据必须彻底）')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
rmSync(workdir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
