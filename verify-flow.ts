// 端到端逻辑验证：双窗口 OCC、签署-快照绑定、崩溃恢复、原子发布
// 用法：esbuild 打包后 node 运行
import { createPinia } from 'pinia';

function memStorage(): Storage & { dump(): Record<string, string>; clear(): void } {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map)
  } as unknown as Storage & { dump(): Record<string, string>; clear(): void };
}

(globalThis as any).localStorage = memStorage();
(globalThis as any).sessionStorage = memStorage();

const { useLiftStore } = await import('./src/store');
const storage = await import('./src/storage');
const snap = await import('./src/snapshot');

let passed = 0;
let failed = 0;
function assert(cond: boolean, message: string) {
  if (cond) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
}
function assertEq<T>(actual: T, expected: T, message: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) console.error(`    expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  assert(ok, message);
}

// ---------- 1. 纯存储层：CAS + 双写备份恢复 ----------
console.log('\n[1] 存储层：CAS 与崩溃恢复');
{
  const seed = snap.seedDoc();
  assertEq(seed.revision, 4, '种子文档初始 revision=4');

  const stale = storage.commitDoc(3, { ...structuredClone(seed), revision: 4 });
  assert(stale.ok === false, '基于过期 revision 的提交被拒绝');

  const ok = storage.commitDoc(4, { ...structuredClone(seed), revision: 5, updatedAt: new Date().toISOString() });
  assert(ok.ok, '基于正确 revision 的提交成功');

  // 模拟主 key 写坏（崩溃半截写入）
  const raw = (globalThis as any).localStorage.getItem('yy58-lift-plan-doc-v2-backup');
  (globalThis as any).localStorage.setItem('yy58-lift-plan-doc-v2', raw.slice(0, 40));
  const recovered = storage.loadDoc();
  assertEq(recovered.revision, 5, '主快照损坏时从备份恢复完整快照');

  // 双 key 都坏 → 回退种子
  (globalThis as any).localStorage.setItem('yy58-lift-plan-doc-v2-backup', '{bad');
  assertEq(storage.loadDoc().revision, 4, '双份损坏回退种子文档');

  // 窗口草稿
  storage.saveWindowDraft('WIN-A', { stepId: 'S-03', patch: { wind: 9.1 }, order: null, commentDraft: '注意风速' });
  const draft = storage.loadWindowDraft('WIN-A');
  assert(draft?.patch.wind === 9.1 && draft?.commentDraft === '注意风速', '窗口级未提交编辑可读取');
  const orphans = storage.pruneStaleDrafts('WIN-SELF');
  assert(orphans.some((d) => d.windowId === 'WIN-A'), '重开窗口时发现崩溃残留草稿');
}

// 重置存储，开始双窗口演练
(globalThis as any).localStorage.clear();

// ---------- 2. 双窗口并发：后提交不覆盖先到结果 ----------
console.log('\n[2] 双窗口并发修改：后提交留存复核');
const piniaA = createPinia();
const piniaB = createPinia();
const A = useLiftStore(piniaA);
const B = useLiftStore(piniaB);
assertEq(A.doc.revision, 4, '窗口 A 读到 V4');
assertEq(B.doc.revision, 4, '窗口 B 读到 V4');

// A 先提交：设备角色改 S-01 半径
const rA = A.updateStep('S-01', { radius: 12 }, 'equipment');
assert(rA.ok && A.doc.revision === 5, 'A 先提交成功 → V5');
assertEq(A.doc.steps.find((s) => s.id === 'S-01')?.radius, 12, 'V5 含 A 的修改（半径=12）');

// B 基于过期 V4 提交：安全角色改 S-03 净空
const rB = B.updateStep('S-03', { clearance: 3.0 }, 'safety');
assert(rB.ok === false && rB.kind === 'conflict-queued', 'B 后提交未覆盖 A，进入待复核队列');
const afterB = storage.loadDoc();
assertEq(afterB.revision, 6, '登记冲突本身产生 V6（先到结果 V5 完整保留）');
assertEq(afterB.steps.find((s) => s.id === 'S-01')?.radius, 12, '先到结果（半径=12）仍在，未被覆盖');
assertEq(afterB.steps.find((s) => s.id === 'S-03')?.clearance, 2.8, 'B 的修改未落盘，等待复核');
assertEq(afterB.conflicts.filter((c) => c.status === 'pending').length, 1, '存在 1 份待复核并发冲突');

// A 通过 storage 事件同步到 V6
A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
assertEq(A.doc.revision, 6, '窗口 A 收到跨窗口事件后同步到 V6');

// 复核 B 的修改：基于最新快照重新套用
const conflictId = afterB.conflicts[0].id;
const rRe = B.reapplyConflict(conflictId, 'safety');
assert(rRe.ok, '复核通过后重新套用成功');
const merged = storage.loadDoc();
assertEq(merged.steps.find((s) => s.id === 'S-01')?.radius, 12, '合并后保留 A 的修改');
assertEq(merged.steps.find((s) => s.id === 'S-03')?.clearance, 3.0, '合并后包含 B 复核过的修改');
assertEq(merged.conflicts[0].status, 'reapplied', '冲突标记为已套用');

// 过期路径补充：裸存储层模拟第三窗口基于旧版本提交
{
  const latest = storage.loadDoc();
  const fork = structuredClone(latest);
  const step = fork.steps.find((s) => s.id === 'S-04')!;
  step.wind = 5.5;
  fork.revision = latest.revision + 1;
  fork.updatedAt = new Date().toISOString();
  const staleCommit = storage.commitDoc(latest.revision - 1, fork);
  assert(staleCommit.ok === false, '第三窗口裸提交过期版本同样被拒，先到结果不变');
  assertEq(storage.loadDoc().revision, latest.revision, '被拒提交未改变当前 revision');
}

// ---------- 3. 签署绑定快照：职责域外修改不连带作废 ----------
console.log('\n[3] 签署与参数快照绑定');
// 先清干净规则冲突（此时还没人签署，修改不影响任何签署）
for (const step of A.doc.steps) {
  A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
  const r = A.updateStep(step.id, { loadRate: 60, clearance: 2.0, wind: 6.0, radius: 10, boom: 60, siteHandover: true, status: 'passed' }, 'general');
  if (!r.ok) throw new Error('清理规则冲突失败: ' + JSON.stringify(r));
}
A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
assertEq(snap.ruleConflictsOf(A.doc.steps).length, 0, '规则冲突清零');

// 关闭全部评论
for (const c of [...A.doc.comments.filter((x) => x.status === 'open')]) {
  const r = A.resolveComment(c.id, 'general');
  if (!r.ok) throw new Error('关闭评论失败');
}
A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
assertEq(A.doc.comments.filter((c) => c.status === 'open').length, 0, '评论清零');

// 四个角色分别在同一快照上签署
for (const role of ['general', 'equipment', 'safety', 'planner'] as const) {
  const r = A.sign(role);
  assert(r.ok, `${snap.ROLE_MAP[role].name} 签署成功`);
}
A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
let gate = snap.evaluateGate(A.doc);
assertEq(gate.signedRoles.length, 4, '四份签署对当前快照全部有效');

// 安全角色自己的职责字段变化 → 仅安全签署失效
{
  const r = A.updateStep('S-02', { clearance: 1.8 }, 'safety');
  assert(r.ok, '安全修改净空提交成功');
  const g = snap.evaluateGate(A.doc);
  assertEq(g.invalidSignatures.map((x) => x.role), ['safety'], '仅安全监督签署失效');
  assertEq(g.signedRoles.sort(), ['equipment', 'general', 'planner'], '总包/设备/方案签署不受别人修改牵连');
  const reasons = g.invalidSignatures[0].reasons.join('；');
  assert(reasons.includes('最小净空') && reasons.includes('2 → 1.8'), `失效原因精确到字段值：${reasons}`);
  // 改回，重新签署
  A.updateStep('S-02', { clearance: 2.0 }, 'safety');
  A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
  const re = A.sign('safety');
  assert(re.ok, '安全在新快照重新签署');
}

// 步骤顺序变化 → 四角色全部失效
{
  const r = A.moveStep('S-01', 1);
  assert(r.ok, '步骤顺序调整成功');
  const g = snap.evaluateGate(A.doc);
  assertEq(g.invalidSignatures.length, 4, '顺序变化导致四个角色签署全部失效');
  assert(g.invalidSignatures.every((x) => x.reasons.some((m) => m.includes('顺序'))), '失效原因均含顺序调整');
  // 恢复顺序并全员重签
  A.moveStep('S-02', -1);
  A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
  for (const role of ['general', 'equipment', 'safety', 'planner'] as const) A.sign(role);
  A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
}

// 跨窗口签署竞争：B 在旧 V 上签署 → 队列，复核后在最新快照补签
{
  const r = B.sign('planner');
  assert(r.ok === false && r.kind === 'conflict-queued', 'B 在过期版本上签署被拦截并留待复核');
  const latest = storage.loadDoc();
  const signConflict = latest.conflicts.find((c) => c.kind === 'sign' && c.status === 'pending');
  assert(!!signConflict, '会签竞争进入复核队列');
  const re = B.reapplyConflict(signConflict!.id, 'planner');
  assert(re.ok, '会签冲突复核后基于最新快照重新套用');
}
A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
B.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);

// ---------- 4. 原子发布 ----------
console.log('\n[4] 发布门禁与原子版本');
// 若仍有待复核冲突，发布应被阻止
{
  const g = snap.evaluateGate(A.doc);
  if (g.pendingConflictCount > 0) {
    for (const c of A.doc.conflicts.filter((x) => x.status === 'pending')) A.abandonConflict(c.id);
    A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
  }
}
gate = snap.evaluateGate(A.doc);
assertEq(gate.canPublish, true, '门禁全绿：签署有效、规则/并发/评论清零、快照未发布');
const revBefore = A.doc.revision;
const pub = A.publish('general');
assert(pub.ok && pub.revision === revBefore + 1, `原子发布成功 → V${revBefore + 1}`);
A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
const published = storage.loadDoc();
assertEq(published.versions.length, 1, '生成 1 个不可变版本');
const v1 = published.versions[0];
assert(v1.snapshotId === snap.snapshotOf(published.steps), '版本绑定参数快照 ID');
assertEq(v1.signatures.length, 4, '版本内嵌四份签署记录');
assert(v1.steps.length === 6 && v1.comments.length >= 3, '版本内嵌完整步骤与评论快照');

// 无改动重复发布 → 阻止
{
  const r = A.publish('general');
  assert(!r.ok && r.message.includes('已发布'), '同一快照不能重复发布');
}

// 发布后改别人职责字段：只有对应角色失效，重签后可发新版本
{
  A.updateStep('S-05', { loadRate: 61 }, 'planner');
  A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
  const g = snap.evaluateGate(A.doc);
  assertEq(g.invalidSignatures.map((x) => x.role), ['planner'], '发布后方案改荷载率，仅方案签署失效');
  assert(!g.canPublish, '失效签署未重签前不能发布');
  A.sign('planner');
  A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
  const r = A.publish('planner');
  assert(r.ok, '方案重签后原子发布 V2');
  A.onStorage({ key: 'yy58-lift-plan-doc-v2' } as StorageEvent);
  assertEq(storage.loadDoc().versions.length, 2, '当前共 2 个发布版本');
}

// 发布与其他窗口提交竞争：B 基于过期 rev 发布 → 被 CAS 阻止，不产生版本
{
  const before = storage.loadDoc().versions.length;
  const r = B.publish('general');
  assert(!r.ok && r.message.includes('先提交'), '过期发布被 CAS 阻止');
  assertEq(storage.loadDoc().versions.length, before, '失败的发布不产生任何版本（原子回滚）');
}

// 草稿双写校验：当前主 key 可被校验通过
{
  const doc = storage.loadDoc();
  assert(doc.format === 2 && Array.isArray(doc.steps) && Array.isArray(doc.versions), '重开后恢复完整快照（步骤/评论/签署/版本/冲突）');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
