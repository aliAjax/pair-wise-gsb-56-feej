/* API 层验证：并发提交去重、退回释放、扣减核销、不可变性 */
const localStore = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => void localStore.set(k, v),
    removeItem: (k: string) => void localStore.delete(k),
  },
  setTimeout,
}

const { configureStore } = await import('@reduxjs/toolkit')
const { workspaceApi } = await import('@/app/api')
const { resetWorkspace } = await import('@/services/storage')

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name}`, extra ?? '')
  }
}

const store = configureStore({
  reducer: { [workspaceApi.reducerPath]: workspaceApi.reducer },
  middleware: (gDM) => gDM().concat(workspaceApi.middleware),
})
const run = (endpoint: any, arg?: any) =>
  store.dispatch((workspaceApi.endpoints as any)[endpoint].initiate(arg)).unwrap()
const ws = () =>
  store
    .dispatch((workspaceApi.endpoints as any).getWorkspace.initiate(undefined, { forceRefetch: true }))
    .unwrap()

resetWorkspace()

console.log('1. 提交审批并预占')
const r1 = await run('submitApproval', { packageId: 'pkg-004' })
check('首次提交成功，预占 5', r1.deduplicated === false && r1.reservation?.amount === 5)
check('状态进入审批中', (await ws()).packages.find((p: any) => p.id === 'pkg-004').status === 'reviewing')

console.log('2. 两个标签页同时提交同一资料包')
// 先重置为草稿再并发提交
localStore.clear()
resetWorkspace()
const [ra, rb] = await Promise.all([
  run('submitApproval', { packageId: 'pkg-004' }),
  run('submitApproval', { packageId: 'pkg-004' }),
])
const results = [ra, rb]
const dedupCount = results.filter((r: any) => r.deduplicated).length
const createCount = results.filter((r: any) => !r.deduplicated).length
check('一份创建预占，一份合并去重', dedupCount === 1 && createCount === 1, results.map((r: any) => r.deduplicated))
const active = (await ws()).reservations.filter((r: any) => r.packageId === 'pkg-004' && r.status === 'active')
check('只存在一份有效预占', active.length === 1, active)
check('合并审计已保留', (await ws()).audit.some((a: any) => a.action === '重复提交合并'))

console.log('3. 审批退回只释放对应占用')
const pkg1 = (await ws()).packages.find((p: any) => p.id === 'pkg-001')
const step1 = pkg1.approvalRoute.find((s: any) => s.status === 'active')
await run('decideApproval', { packageId: 'pkg-001', stepId: step1.id, decision: 'return', comment: '补充材料' })
const after1 = await ws()
check('pkg-001 已退回', after1.packages.find((p: any) => p.id === 'pkg-001').status === 'returned')
check('pkg-001 预占已释放', after1.reservations.find((r: any) => r.packageId === 'pkg-001' && r.id.startsWith('rsv-')).status === 'released')
check('pkg-002 预占不受影响', after1.reservations.some((r: any) => r.packageId === 'pkg-002' && r.status === 'active'))
check('释放审计已写入', after1.audit.some((a: any) => a.action === '释放额度预占'))

console.log('4. 扣减核销与许可记录不可改')
const r4 = await run('deductQuota', { packageId: 'pkg-002', amount: 5 })
const pkg2 = r4.packages.find((p: any) => p.id === 'pkg-002')
check('扣减后已许可', pkg2.status === 'licensed' && pkg2.quotaUsed === 47)
const consumed = r4.reservations.find((r: any) => r.packageId === 'pkg-002' && r.status === 'consumed')
check('预占已核销', consumed?.consumedAmount === 5 && consumed?.releasedAmount === 0)
let err: any
try { await run('deductQuota', { packageId: 'pkg-002', amount: 1 }) } catch (e) { err = e }
check('重复扣减被拒绝（记录不可改）', String(err?.error ?? err).includes('不能改动'), err)
try { await run('savePackage', { packageId: 'pkg-002', patch: { title: '改名' } }) ; err = undefined } catch (e) { err = e }
check('已许可资料包禁止修改', String(err?.error ?? err).includes('不能改动'), err)

console.log('5. 额度不足留在草稿并写明缺口')
// pkg-003 先补声明（消除非额度高风险），再提交 -> 额度不足
await run('savePackage', { packageId: 'pkg-003', patch: { declarations: ['最终用户声明', '最终用途声明', '人员接触清单', '技术转移声明'] } })
try { await run('submitApproval', { packageId: 'pkg-003' }); err = undefined } catch (e) { err = e }
check('提交被拒绝并写明缺口', String(err?.error ?? '').includes('缺口'), err)
const after5 = await ws()
check('pkg-003 保持退回状态（未进入审批）', after5.packages.find((p: any) => p.id === 'pkg-003').status === 'returned')
check('pkg-003 无有效预占', !after5.reservations.some((r: any) => r.packageId === 'pkg-003' && r.status === 'active'))
check('缺口结论已写入 findings', after5.findings.some((f: any) => f.packageId === 'pkg-003' && f.type === 'quota' && f.message.includes('缺口')))
check('预占失败审计已写入', after5.audit.some((a: any) => a.action === '额度预占失败'))

console.log('6. 申报内容变化使预占失效重算')
// pkg-001 缺少不扩散声明且文件版本错配，提交应被高风险拦截
try { await run('submitApproval', { packageId: 'pkg-001' }); err = undefined } catch (e) { err = e }
check('高风险项拦截提交', String(err?.error ?? '').includes('高风险'), err)
// 修复缺陷：补声明 + 对齐文件引用版本
await run('savePackage', { packageId: 'pkg-001', patch: { declarations: ['最终用户声明', '最终用途声明', '不扩散声明'] } })
const file1a = (await ws()).files.find((f: any) => f.id === 'file-001-a')
await run('setReferenceVersion', { fileId: 'file-001-a', versionId: file1a.activeVersionId })
await run('submitApproval', { packageId: 'pkg-001' })
const before = (await ws()).reservations.find((r: any) => r.packageId === 'pkg-001' && r.status === 'active')
check('修复后重新提交成功，预占 10', before?.amount === 10, before)
await run('savePackage', { packageId: 'pkg-001', patch: { quotaRequested: 12 } })
const after6 = await ws()
const stale = after6.reservations.find((r: any) => r.id === before.id)
const renewed = after6.reservations.find((r: any) => r.packageId === 'pkg-001' && r.status === 'active')
check('旧预占已失效', stale?.status === 'stale')
check('按新申报重算预占 12', renewed?.amount === 12, renewed)
check('失效重算审计已写入', after6.audit.some((a: any) => a.action === '预占失效重算'))

console.log('7. 待人工核对阻止扣减')
// 构造迁移场景：清存储，写入旧格式数据
localStore.clear()
const { createInitialState } = await import('@/services/mockData')
const legacy = createInitialState() as any
delete legacy.reservations
legacy.packages.forEach((p: any) => { delete p.quotaRequested; delete p.quotaReviewRequired })
legacy.rules.forEach((r: any) => delete r.version)
localStore.set('export-control-review-v1', JSON.stringify(legacy))
// 把 pkg-003 改成 approved 以测试扣减拦截
const raw = JSON.parse(localStore.get('export-control-review-v1')!)
raw.packages.find((p: any) => p.id === 'pkg-003').status = 'approved'
localStore.set('export-control-review-v1', JSON.stringify(raw))
const migratedState = await ws()
const pkg3m = migratedState.packages.find((p: any) => p.id === 'pkg-003')
check('pkg-003 迁移后待人工核对', pkg3m.quotaReviewRequired === true)
try { await run('deductQuota', { packageId: 'pkg-003', amount: 1 }); err = undefined } catch (e) { err = e }
check('待人工核对阻止扣减', String(err?.error ?? '').includes('待人工核对'), err)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
