/**
 * 手动指定书签范围（F4）—— 清单纯逻辑的回归闸门。
 *
 * ═══ 这道闸门守的是什么 ═══
 * 这个功能存在的**全部理由**是「我圈定范围之外的东西一条都不能动」。
 * 一旦它悄悄动了没选的书签，用户从界面上完全看不出来 ——
 * 面板会显示「整理完成 100%」，而书签已经被搬到别处了。
 *
 * 所以下面几组断言刻意分成两类：
 *   ① 该拦住的必须拦住（决策 13：失效条目不许按 URL 认领）
 *   ② 不该误伤的必须不误伤（子集里已在位的条目照常跳过，不是失败）
 * 只写 ① 不写 ② 的闸门，一个「什么都别做」的实现也能全绿 ——
 * docs/testing.md 说过：误报的闸门会被学会忽略。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey } from '../../src/normalize.js';
import {
  SCOPE_STATUS, EMPTY_LIST, normalizeList, isEmptyList,
  annotateSelectable, blockedReason, expandFolderSelection,
  addEntries, removeEntries, clearDone,
  reconcileList, buildScopeEntries, summarize, applyRunResult, prepareScope, runnableIds,
  derivePlanView, unresolvedIds, isTerminal, reasonLabel,
} from '../../src/scope-list.js';

// ───────────────────────── 夹具 ─────────────────────────
//
// 形状照抄 flattenTree 的真实输出（见 src/tree.js）：
//   path 从**根名**开始，顶层根自己是 depth 0 / path []
//   parentId 对顶层根来说是 '0'（同步根）或 '-1'

const E = (id, type, extra = {}) => ({
  id: String(id),
  type,
  title: extra.title || `标题${id}`,
  url: type === 'url' ? (extra.url || `https://example.com/p${id}`) : null,
  parentId: String(extra.parentId ?? '-1'),
  path: extra.path || [],
  depth: extra.depth ?? 0,
  dateAdded: 0, dateLastUsed: 0, index: 0,
  readOnly: !!extra.readOnly,
});

const BAR = E('279', 'folder', { title: '书签栏', parentId: '0', path: [] });
const DEV = E('10', 'folder', { title: '开发', parentId: '279', path: ['书签栏'], depth: 1 });
const FRONT = E('11', 'folder', { title: '前端', parentId: '10', path: ['书签栏', '开发'], depth: 2 });
const NEWS = E('20', 'folder', { title: '新闻', parentId: '279', path: ['书签栏'], depth: 1 });
const B1 = E('101', 'url', { title: 'React', parentId: '11', path: ['书签栏', '开发', '前端'], depth: 3, url: 'https://react.dev/' });
const B2 = E('102', 'url', { title: 'Vue', parentId: '11', path: ['书签栏', '开发', '前端'], depth: 3, url: 'https://vuejs.org/' });
const B3 = E('201', 'url', { title: '科技新闻', parentId: '20', path: ['书签栏', '新闻'], depth: 2, url: 'https://news.example.com/' });
const MOBILE = E('281', 'folder', { title: '移动设备书签', parentId: '0', path: [], readOnly: true });
const M1 = E('301', 'url', { title: '手机书签', parentId: '281', path: ['移动设备书签'], depth: 1, readOnly: true });
const LOCAL = E('401', 'url', { title: '本机', parentId: '20', path: ['书签栏', '新闻'], depth: 2, url: 'http://127.0.0.1:8826/' });

const TREE = [BAR, DEV, FRONT, NEWS, B1, B2, B3, MOBILE, M1, LOCAL];

// ───────────────────────── 存储形状的收敛 ─────────────────────────

test('normalizeList：垃圾输入必须收敛成合法清单，而不是让面板崩在 forEach 上', () => {
  assert.deepEqual(normalizeList(null), { v: 1, updatedAt: 0, items: [] });
  assert.deepEqual(normalizeList('nope'), { v: 1, updatedAt: 0, items: [] });
  assert.deepEqual(normalizeList({ items: 'x' }).items, []);
  // 缺 id 的条目直接丢：没有 id 就没法执行，也没法对账
  assert.deepEqual(normalizeList({ items: [{ url: 'https://a.com/' }] }).items, []);
  // 未知 status 回落 pending，绝不原样带进状态机
  const [it] = normalizeList({ items: [{ id: 5, status: '???', path: 'no' }] }).items;
  assert.equal(it.id, '5');
  assert.equal(it.status, SCOPE_STATUS.PENDING);
  assert.deepEqual(it.path, []);
  assert.ok(isEmptyList(null));
});

// ───────────────────────── 可动性 ─────────────────────────

test('blockedReason：四类不可动项各自给出人话原因', () => {
  // ⚠️ 锁的匹配必须走 dedupeKey，与 src/plan.js 同一口径。
  //    这里自己拼字符串的话，生产代码改了归一化规则而闸门仍然绿，
  //    于是「勾选区说可动、plan 阶段却跳过」这类不一致就没人拦了。
  const locks = ['https://react.dev/'];
  const lockKeys = new Set(locks.map(dedupeKey).filter(Boolean));

  assert.equal(blockedReason(M1, lockKeys), '移动设备书签是只读的，移不动');
  assert.equal(blockedReason(LOCAL, lockKeys), '浏览器内部页或本机地址，不处理');
  assert.equal(blockedReason(B1, lockKeys), '已锁定，整理时不移动');
  // 可动的：返回空串，而不是 truthy 之类
  assert.equal(blockedReason(B2, lockKeys), '');
  // 文件夹本身不算不可动 —— 它不能被 move，但它可以被展开
  assert.equal(blockedReason(FRONT, lockKeys), '');
});

test('annotateSelectable：不改原对象（entries 同时喂给 plan.js，污染它等于污染计划）', () => {
  const before = JSON.stringify(TREE);
  const rows = annotateSelectable(TREE, ['https://react.dev/']);
  assert.equal(JSON.stringify(TREE), before);
  const b1 = rows.find((r) => r.entry.id === '101');
  assert.equal(b1.blocked, '已锁定，整理时不移动');
  const b2 = rows.find((r) => r.entry.id === '102');
  assert.equal(b2.blocked, '');
});

// ───────────────────────── 文件夹展开成快照 ─────────────────────────

test('expandFolderSelection：递归展开成书签条目，文件夹自身不进来', () => {
  const got = expandFolderSelection(TREE, '10').map((e) => e.id).sort();
  // 开发 > 前端 > {101,102}；不含新闻下的 201
  assert.deepEqual(got, ['101', '102']);
  assert.ok(!got.includes('10'));
  assert.ok(!got.includes('11'));
});

test('expandFolderSelection：只读根整个展开不出来', () => {
  assert.deepEqual(expandFolderSelection(TREE, '281'), []);
});

test('expandFolderSelection：剔除已锁定与本机地址，只留真正能动的', () => {
  const got = expandFolderSelection(TREE, '279', ['https://react.dev/']).map((e) => e.id).sort();
  // 101 被锁、401 是本机地址，两者都进不来
  assert.deepEqual(got, ['102', '201']);
});

test('expandFolderSelection：未知 id 与不存在的 id 都返回空，不抛', () => {
  assert.deepEqual(expandFolderSelection(TREE, '9999'), []);
  assert.deepEqual(expandFolderSelection(null, '10'), []);
});

test('expandFolderSelection：单条书签也可以直接勾（走的就是起点自身那条判断）', () => {
  const got = expandFolderSelection(TREE, '101');
  assert.equal(got.length, 1);
  assert.equal(got[0].id, '101');
});

// ───────────────────────── 增删 ─────────────────────────

test('addEntries：重复添加同一 id 不产生第二条', () => {
  let list = addEntries(EMPTY_LIST, [B1, B2]);
  assert.equal(list.items.length, 2);
  list = addEntries(list, [B1, B2]);
  assert.equal(list.items.length, 2);
});

test('addEntries：非书签条目（folder）进不来 —— 它移不动', () => {
  const list = addEntries(EMPTY_LIST, [FRONT, B1]);
  assert.deepEqual(list.items.map((i) => i.id), ['101']);
});

test('addEntries：保留 path 快照（失效时用户要靠它判断这条原本在哪）', () => {
  const [it] = addEntries(EMPTY_LIST, [B1]).items;
  assert.deepEqual(it.path, ['书签栏', '开发', '前端']);
});

test('removeEntries / clearDone', () => {
  let list = addEntries(EMPTY_LIST, [B1, B2, B3]);
  list = applyRunResult(list, [{ id: '101', status: 'done', reason: 'rule:domain' }]);
  assert.equal(summarize(list).done, 1);

  const cleared = clearDone(list);
  assert.deepEqual(cleared.items.map((i) => i.id).sort(), ['102', '201']);

  const dropped = removeEntries(list, ['102']);
  assert.deepEqual(dropped.items.map((i) => i.id).sort(), ['101', '201']);

  list = applyRunResult(list, [{ id: '102', status: 'failed' }], [{ id: '102', error: '目标根解析失败' }]);
  assert.equal(summarize(list).failed, 1);
});

test('⚠️ runnableIds 是全仓库唯一一份「本轮要处理」判据', () => {
  // 预览裁子集、执行器拿范围、芯片显示条数三处都走它。
  // 各自复述一遍的话一旦漂移，预览用的 entries 与执行器的 scopeIds 就对不上，
  // 多余条目会被记成「不在清单里」，而它们其实在清单里。
  //
  // ⚠️ 2026-10-07 起它不再只是 pending + failed：
  //    blocked（被范围挡住 / 内部页）与 unclassified（没归类）也**要能重跑**，
  //    否则这两类条目一次处理不成，就永远钉死在清单里、用户也没法重试。
  //    唯一被排除的是三个终态：done / in-place / stale。
  let list = addEntries(EMPTY_LIST, [B1, B2, B3]);
  list = applyRunResult(list, [{ id: '101', status: 'done' }]);
  list = applyRunResult(list, [{ id: '102', status: 'failed' }]);
  // 存活树里保留 B1(101) 与 B2(102)，只把 B3(201) 去掉。
  // ⚠️ 少写一个元素就会把本该保持 failed 的那条也变成 stale，
  //    然后断言失败的原因看起来像「runnableIds 算错了」—— 量具没对准。
  list = reconcileList(list, [BAR, DEV, FRONT, NEWS, B1, B2]).list;   // 201 变 stale

  assert.equal(summarize(list).failed, 1, '102 应该仍是 failed，而不是被对账清掉');
  assert.deepEqual(runnableIds(list).sort(), ['102'], 'done 与 stale 都不该再跑');
  assert.deepEqual(runnableIds(EMPTY_LIST), []);
  assert.deepEqual(runnableIds(null), []);

  // 三个终态一律不再跑
  assert.equal(isTerminal(SCOPE_STATUS.DONE), true);
  assert.equal(isTerminal(SCOPE_STATUS.IN_PLACE), true);
  assert.equal(isTerminal(SCOPE_STATUS.STALE), true);
  // 这三个必须能重跑
  assert.equal(isTerminal(SCOPE_STATUS.PENDING), false);
  assert.equal(isTerminal(SCOPE_STATUS.FAILED), false);
  assert.equal(isTerminal(SCOPE_STATUS.BLOCKED), false);
  assert.equal(isTerminal(SCOPE_STATUS.UNCLASSIFIED), false);
});

// ───────────────────────── 对账：决策 13 的核心 ─────────────────────────

test('⚠️ 失效条目标 stale，且绝不按 URL 认领（同一 URL 的另一条不许顶替）', () => {
  const list = addEntries(EMPTY_LIST, [B1]);   // 清单里是 101
  // 101 没了，但树上还有另一条**同 URL** 的书签（用户在不同文件夹各存了一份）
  const sameUrlElsewhere = E('999', 'url', {
    title: 'React（另一处存的）',
    parentId: '20',
    path: ['书签栏', '新闻'],
    depth: 2,
    url: 'https://react.dev/',
  });

  const rec = reconcileList(list, [BAR, DEV, FRONT, NEWS, B3, sameUrlElsewhere]);
  assert.deepEqual(rec.stale, ['101']);
  assert.equal(rec.list.items[0].status, SCOPE_STATUS.STALE);

  // ⚠️ 这条是本闸门存在的理由：绝不能把 999 认回来当成 101。
  //    999 是用户**没勾**的书签，认回来就等于整理了范围外的东西。
  const scoped = buildScopeEntries([BAR, DEV, FRONT, NEWS, B3, sameUrlElsewhere], rec.list);
  assert.deepEqual(scoped.map((e) => e.id), []);
});

test('reconcileList：id 还活着就保持原状态（failed 不被无理由冲掉）', () => {
  let list = addEntries(EMPTY_LIST, [B1]);
  list = applyRunResult(list, [{ id: '101', status: 'failed' }], [{ id: '101', error: 'boom' }]);
  const rec = reconcileList(list, TREE);
  assert.equal(rec.list.items[0].status, SCOPE_STATUS.FAILED);
  assert.equal(rec.list.items[0].lastError, 'boom');
  assert.deepEqual(rec.stale, []);
});

test('reconcileList：done 是终态，书签事后被删也不翻回 stale（那会抹掉「这批整理过」的事实）', () => {
  let list = addEntries(EMPTY_LIST, [B1, B2]);
  list = applyRunResult(list, [{ id: '101', status: 'done' }]);
  const rec = reconcileList(list, [BAR, DEV, FRONT, NEWS, B3]);  // 101 和 102 都不在了
  assert.equal(rec.list.items.find((i) => i.id === '101').status, SCOPE_STATUS.DONE);
  assert.equal(rec.list.items.find((i) => i.id === '102').status, SCOPE_STATUS.STALE);
});

// ───────────────────────── 裁出子集 ─────────────────────────

test('buildScopeEntries：只含清单内且待跑（pending/failed）的条目', () => {
  let list = addEntries(EMPTY_LIST, [B1, B2, B3]);
  list = applyRunResult(list, [{ id: '102', status: 'done' }]);   // 102 已整理
  const got = buildScopeEntries(TREE, list).map((e) => e.id).sort();
  assert.deepEqual(got, ['101', '201']);
});

test('buildScopeEntries：⚠️ path 必须原样保留 —— plan.js 的幂等判定靠它', () => {
  // 丢了 path → fromPath 变空 → 「已在目标位置」的条目会被重新 move 一次
  const got = buildScopeEntries(TREE, addEntries(EMPTY_LIST, [B1]));
  assert.deepEqual(got[0].path, ['书签栏', '开发', '前端']);
  assert.ok(got[0].readOnly !== undefined);
});

test('buildScopeEntries：清单为空时返回空数组而不是全树', () => {
  assert.deepEqual(buildScopeEntries(TREE, EMPTY_LIST), []);
  assert.deepEqual(buildScopeEntries(TREE, null), []);
});

// ───────────────────────── 执行结果回写 ─────────────────────────

test('applyRunResult：done / failed / bookmark-missing 三种终态各归各位', () => {
  const list = addEntries(EMPTY_LIST, [B1, B2, B3]);
  const next = applyRunResult(
    list,
    [
      { id: '101', status: 'done', reason: 'manual' },
      { id: '102', status: 'failed' },
      { id: '201', status: 'skipped', reason: 'bookmark-missing' },
    ],
    [{ id: '102', error: '移动后回读：改动没有留住' }],
  );
  const by = new Map(next.items.map((i) => [i.id, i]));
  assert.equal(by.get('101').status, SCOPE_STATUS.DONE);
  assert.equal(by.get('101').lastReason, 'manual');
  assert.equal(by.get('102').status, SCOPE_STATUS.FAILED);
  assert.equal(by.get('102').lastError, '移动后回读：改动没有留住');
  assert.equal(by.get('201').status, SCOPE_STATUS.STALE);
});

test('applyRunResult：这一轮没轮到的条目保持原状，不被清成 pending', () => {
  const list = addEntries(EMPTY_LIST, [B1, B2]);
  const next = applyRunResult(list, [{ id: '101', status: 'done' }]);
  assert.equal(next.items.find((i) => i.id === '102').status, SCOPE_STATUS.PENDING);
});

test('applyRunResult：done 不会被后一轮改写', () => {
  let list = addEntries(EMPTY_LIST, [B1]);
  list = applyRunResult(list, [{ id: '101', status: 'done' }]);
  const again = applyRunResult(list, [{ id: '101', status: 'failed' }], [{ id: '101', error: 'x' }]);
  assert.equal(again.items[0].status, SCOPE_STATUS.DONE);
});

// ───────────────────────── 统计与聚合 ─────────────────────────

test('summarize：七种状态各计各的', () => {
  let list = addEntries(EMPTY_LIST, [B1, B2, B3, LOCAL]);
  list = applyRunResult(list, [
    { id: '101', status: 'done' },
    { id: '102', status: 'failed' },
  ], [{ id: '102', error: 'e' }]);
  list = reconcileList(list, [BAR, DEV, FRONT, NEWS, B1, B2]).list;
  const s = summarize(list);
  assert.equal(s.total, 4);
  assert.equal(s.done, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.stale, 2);
  assert.equal(s.pending, 0);
});

test('⚠️ summarize 必须覆盖全部七档，且求和闭包成立', () => {
  // ⚠️⚠️ 这是本闸门最容易被静默绕过的地方。
  //    summarize 早先是 `if DONE … else if FAILED … else pending += 1`，
  //    于是**任何新增状态都被吞进「待整理」**，而求和闭包**照样成立** ——
  //    夹具里没有新状态时，下面的求和断言恒为真，闸门等于没写。
  //    所以这里必须**真的把七档都造出来**再断言，而不只是检查键存在。
  let list = addEntries(EMPTY_LIST, [
    B1, B2, B3, LOCAL,
    E('301', 'url', { title: 'e' }), E('302', 'url', { title: 'f' }),
    E('303', 'url', { title: 'g' }),
  ]);
  list = applyRunResult(list, [
    { id: '101', status: 'done' },                                              // done
    { id: '102', status: 'failed' },                                            // failed
    { id: '201', status: 'skipped', reason: 'already-in-place' },               // in-place
    { id: '301', status: 'skipped', reason: 'out-of-scope' },                   // blocked
    { id: '302', status: 'skipped', reason: 'unclassified-accepted' },          // unclassified
  ], [{ id: '102', error: 'e' }]);

  const s = summarize(list);
  assert.equal(s.done, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.inPlace, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.unclassified, 1);
  assert.equal(s.pending, 2);            // LOCAL 与 303 还没动
  assert.equal(s.unknown, 0, '不该有状态掉进兜底桶');
  assert.equal(
    s.pending + s.done + s.failed + s.inPlace + s.stale + s.blocked + s.unclassified + s.unknown,
    s.total,
    '七档之和必须等于 total',
  );
  assert.equal(s.total, 7);
});

test('⚠️ applyRunResult：七种 (status, reason) 组合各落各位', () => {
  // 这张表早先是内联 if-else 链，只有三条分支。
  // 漏掉的那条（out-of-scope）症状与「AI 过滤」一模一样：条目永远停在待整理、
  // 界面不解释 —— 但根因完全无关。少一条分支没有任何提示，所以整张表都要钉住。
  const list = addEntries(EMPTY_LIST, [
    E('1', 'url', { title: 'a' }), E('2', 'url', { title: 'b' }),
    E('3', 'url', { title: 'c' }), E('4', 'url', { title: 'd' }),
    E('5', 'url', { title: 'e' }), E('6', 'url', { title: 'f' }),
    E('7', 'url', { title: 'g' }),
  ]);
  const next = applyRunResult(list, [
    { id: '1', status: 'done', reason: 'rule:domain' },
    { id: '2', status: 'failed' },
    { id: '3', status: 'skipped', reason: 'already-in-place' },
    { id: '4', status: 'skipped', reason: 'unclassified-accepted' },
    { id: '5', status: 'skipped', reason: 'bookmark-missing' },
    { id: '6', status: 'skipped', reason: 'out-of-scope' },
    { id: '7', status: 'skipped', reason: 'excluded' },
  ], [{ id: '2', error: '回读没过' }]);

  const by = new Map(next.items.map((i) => [i.id, i]));
  assert.equal(by.get('1').status, SCOPE_STATUS.DONE);
  assert.equal(by.get('1').lastReason, 'rule:domain');
  assert.equal(by.get('2').status, SCOPE_STATUS.FAILED);
  assert.equal(by.get('2').lastError, '回读没过');
  assert.equal(by.get('3').status, SCOPE_STATUS.IN_PLACE);
  assert.equal(by.get('4').status, SCOPE_STATUS.UNCLASSIFIED);
  assert.equal(by.get('4').resolution, 'accept-unclassified', '已接受这一事实要记下来');
  assert.equal(by.get('5').status, SCOPE_STATUS.STALE);
  assert.equal(by.get('6').status, SCOPE_STATUS.BLOCKED, 'out-of-scope 不该再永久停在待整理');
  assert.equal(by.get('7').status, SCOPE_STATUS.BLOCKED);
});

test('applyRunResult：判据表查不到的组合保持原状（宁可让用户看见，不给错终态）', () => {
  const list = addEntries(EMPTY_LIST, [E('1', 'url', { title: 'a' })]);
  const next = applyRunResult(list, [{ id: '1', status: 'skipped', reason: '某个还没登记的原因' }]);
  assert.equal(next.items[0].status, SCOPE_STATUS.PENDING,
    '未知原因被归到了某个终态 —— 那是在骗用户「这条有交代了」');
});

test('applyRunResult：终态不被后续运行改写（done / in-place / stale）', () => {
  for (const st of [SCOPE_STATUS.DONE, SCOPE_STATUS.IN_PLACE, SCOPE_STATUS.STALE]) {
    let list = { v: 1, updatedAt: 0, items: [{ id: '1', status: st }] };
    list = applyRunResult(list, [{ id: '1', status: 'failed' }], [{ id: '1', error: 'x' }]);
    assert.equal(list.items[0].status, st, `${st} 被后续运行改写了`);
  }
});

test('prepareScope：所有派生数来自同一次对账（分开算会出现「列表 5 条、统计 6 条」的自相矛盾）', () => {
  const list = addEntries(EMPTY_LIST, [B1, B2, B3]);
  const p = prepareScope(list, [BAR, DEV, FRONT, NEWS, B3]);  // 101 / 102 都没了
  assert.equal(p.staleIds.length, 2);
  assert.deepEqual(p.entries.map((e) => e.id), ['201']);
  assert.equal(p.runnable, 1);
  assert.equal(
    p.stats.pending + p.stats.done + p.stats.failed + p.stats.inPlace
    + p.stats.stale + p.stats.blocked + p.stats.unclassified + p.stats.unknown,
    p.stats.total,
    '求和必须覆盖全部七档 —— 只写四档的话，新状态会被静默吞掉而闸门照样全绿',
  );
});

// ─────────────────── 计划投影与执行闸门 ───────────────────

test('derivePlanView：把 plan.items 投影成每行的显示判据', () => {
  const view = derivePlanView([
    { id: '1', status: 'pending', toPath: ['开发', '前端'], toStr: '开发/前端', reason: 'rule:domain' },
    { id: '2', status: 'skipped', toPath: ['其他', '待归类'], toStr: '其他/待归类', reason: 'unclassified' },
    { id: '3', status: 'skipped', toPath: ['开发', '前端'], toStr: '开发/前端', reason: 'already-in-place' },
  ], '其他/待归类');

  assert.equal(view.get('1').willMove, true);
  assert.equal(view.get('1').inFallback, false);

  assert.equal(view.get('2').willMove, false);
  assert.equal(view.get('2').inFallback, true, '在兜底桶里且没归类，执行闸门要靠它拦下来');

  assert.equal(view.get('3').willMove, false);
  assert.equal(view.get('3').inFallback, false);
  assert.equal(view.get('3').blockedLabel, '已在原位',
    '面板对终态条目要显示「为什么不动」—— 这个字段必须真的被产出');
  assert.equal(view.get('2').blockedLabel, '未归类');
});

test('derivePlanView：每个非 pending 的 reason 都要有人话标签', () => {
  // ⚠️ 面板不许自己复述这张表（会与 scope-list.js 漂移），
  //    而这张表漏一条的症状是界面显示 `undefined` —— 不会报错，只是难看。
  for (const r of ['already-in-place', 'unclassified', 'unclassified-accepted',
    'bookmark-missing', 'out-of-scope', 'excluded', 'locked', 'readonly']) {
    assert.ok(reasonLabel(r), `reason「${r}」没有标签，界面会显示 undefined`);
  }
});

test('⚠️ 闸门必须拦住「正要被搬进待归类」的条目（这才是用户报的静默塞入）', () => {
  // ⚠️⚠️ 这条是第一版实现漏掉的，方向刚好反了。
  //    第一版写的是 `if (v.willMove) continue`，于是：
  //      · 已经躺在待归类里、没有东西要搬的 → 拦住（其实拦不拦都无所谓）
  //      · **正要被搬进待归类的** → 放行 ← 这才是用户最初报的那件事
  //    闸门看上去是好的，实际把唯一该拦的那种漏了过去。
  //    判据只能是「目标落在兜底桶」，与 willMove 无关。
  const list = { v: 1, updatedAt: 0, items: [{ id: 'A', status: 'pending' }] };
  const view = new Map([
    ['A', {
      toStr: '其他/待归类', toPath: ['其他', '待归类'],
      willMove: true,          // ← 会被搬进去
      inFallback: true,        // ← 目标就是兜底桶
      blockedLabel: '', reason: 'unclassified',
    }],
  ]);
  assert.deepEqual(unresolvedIds(list, view), ['A'],
    '一条正要被静默塞进「其他/待归类」的条目畅通无阻 —— 就是用户报的那个症状');

  // 反过来：有真实目标的条目不该被拦
  const okList = { v: 1, updatedAt: 0, items: [{ id: 'B', status: 'pending' }] };
  const okView = new Map([
    ['B', {
      toStr: '开发/前端', toPath: ['开发', '前端'],
      willMove: true, inFallback: false, blockedLabel: '', reason: 'rule:domain',
    }],
  ]);
  assert.deepEqual(unresolvedIds(okList, okView), []);
});

test('applyRunResult：skipped:unclassified 必须有落点（缺了就是「永远停在待整理」）', () => {
  // ⚠️ 这一条曾经**不在** PLAN_VERDICT 里，症状与本功能最初报的完全一样：
  //    查不到落点 → 保持原状态 → 「永远停在待整理」，界面不解释。
  const list = { v: 1, updatedAt: 0, items: [{ id: '1', status: 'pending', resolution: '' }] };
  const next = applyRunResult(list, [{ id: '1', status: 'skipped', reason: 'unclassified' }]);
  assert.equal(next.items[0].status, SCOPE_STATUS.UNCLASSIFIED);
  assert.equal(next.items[0].resolution, '',
    '还没判出来的那条不能被倒写成「已确认」，否则下一轮它会从闸门里漏过去');

  const done = applyRunResult(list, [{ id: '1', status: 'skipped', reason: 'unclassified-accepted' }]);
  assert.equal(done.items[0].status, SCOPE_STATUS.UNCLASSIFIED);
  assert.equal(done.items[0].resolution, 'accept-unclassified',
    '用户明确接受的那条要记成已处置，下一轮不再拦');
});

test('runnableIds：blocked 不可重试（重判一次结果不会变，白花 LLM 的钱）', () => {
  const list = { v: 1, updatedAt: 0, items: [{ id: '1', status: 'blocked' }] };
  assert.deepEqual(runnableIds(list), [],
    '被范围挡住 / 浏览器内部页重跑没有意义 —— 语义上就是「不可重试」');
});

test('unresolvedIds：只有「没归类且你还没说就放待归类」的才拦执行', () => {
  const items = [
    { id: '1', status: 'pending' },                                        // 有真实目标
    { id: '2', status: 'pending' },                                        // 未归类
    { id: '3', status: 'pending', resolution: 'accept-unclassified' },     // 你已接受
    { id: '4', status: 'failed' },                                         // 失败，重试即可
    { id: '5', status: 'blocked' },                                        // 动不了
    { id: '6', status: 'done' },                                           // 终态
  ];
  const list = { v: 1, updatedAt: 0, items };
  const view = new Map([
    ['1', { toStr: '开发/前端', toPath: ['开发', '前端'], willMove: true, inFallback: false, blocked: '', reason: 'rule:domain' }],
    ['2', { toStr: '其他/待归类', toPath: ['其他', '待归类'], willMove: false, inFallback: true, blocked: 'unclassified', reason: 'unclassified' }],
    ['3', { toStr: '其他/待归类', toPath: ['其他', '待归类'], willMove: false, inFallback: true, blocked: 'unclassified', reason: 'unclassified' }],
    ['4', { toStr: '开发/前端', toPath: ['开发', '前端'], willMove: true, inFallback: false, blocked: '', reason: 'llm' }],
    ['5', { toStr: '', toPath: [], willMove: false, inFallback: false, blocked: 'out-of-scope', reason: 'out-of-scope' }],
    ['6', { toStr: '开发/前端', toPath: ['开发', '前端'], willMove: false, inFallback: false, blocked: 'done', reason: 'rule:domain' }],
  ]);

  assert.deepEqual(unresolvedIds(list, view), ['2'],
    '只有真正「没归类、又没被你接受」的那条该拦执行');
});

test('unresolvedIds：还没预览时一条都不拦（不能把「还没算」当成「没归类」）', () => {
  const list = addEntries(EMPTY_LIST, [B1, B2]);
  assert.deepEqual(unresolvedIds(list, new Map()), []);
  assert.deepEqual(unresolvedIds(list, null), []);
});

// ───────────────────────── 不许回退的实现 ─────────────────────────

test('⚠️ 闸门自检：空清单时什么都跑不了（防「什么都别做」的实现蒙混过关）', () => {
  // 下面几组是「该动的动了」。只断言拦住而不断言放行的话，
  // 一个永远返回空数组的实现能全绿。
  const list = addEntries(EMPTY_LIST, [B1, B2]);
  const p = prepareScope(list, TREE);
  assert.equal(p.entries.length, 2, '勾了两条就必须有两条进入计划');
  assert.equal(p.runnable, 2);

  const one = prepareScope(addEntries(EMPTY_LIST, [B1]), TREE);
  assert.deepEqual(one.entries.map((e) => e.id), ['101']);
});