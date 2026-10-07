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

test('⚠️ runnableIds 只含 pending 与 failed，且是全仓库唯一一份判据', () => {
  // 预览裁子集、执行器拿范围、芯片显示条数三处都走它。
  // 各自复述一遍的话一旦漂移，预览用的 entries 与执行器的 scopeIds 就对不上，
  // 多余条目会被记成「不在清单里」，而它们其实在清单里。
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

test('summarize：四种状态各计各的', () => {
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

test('prepareScope：所有派生数来自同一次对账（分开算会出现「列表 5 条、统计 6 条」的自相矛盾）', () => {
  const list = addEntries(EMPTY_LIST, [B1, B2, B3]);
  const p = prepareScope(list, [BAR, DEV, FRONT, NEWS, B3]);  // 101 / 102 都没了
  assert.equal(p.staleIds.length, 2);
  assert.deepEqual(p.entries.map((e) => e.id), ['201']);
  assert.equal(p.runnable, 1);
  assert.equal(p.stats.pending + p.stats.done + p.stats.failed + p.stats.stale, p.stats.total);
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