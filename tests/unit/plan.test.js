/**
 * 计划生成：dry-run 的全部保证建立在这个文件上。
 * 最重要的一条是「静态断言：本模块不得 import 任何写操作模块」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildPlan, setRules, selectForLlm, REASON } from '../../src/plan.js';
import { DEFAULT_RULES } from '../../src/classify/dict.js';
import { DEFAULT_TAXONOMY } from '../../src/classify/taxonomy.js';
import { dedupeKey } from '../../src/normalize.js';
import { findForbiddenImports, usesChromeApi, PURE_CHAIN_MODULES } from '../helpers/sourceScan.js';

setRules(DEFAULT_RULES);

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');

// ───────────────────── 静态断言：dry-run 零写入 ─────────────────────

test('⚠️ plan.js 不得 import 任何写操作模块', () => {
  // ⚠️ 清单来自 sourceScan 的 PURE_CHAIN_MODULES，不再在两处各硬编码一份。
  //    两份清单必然漂移，而漂移的表现是新模块「没人验」——
  //    2026-10-06 那次就是这么漏掉了 9 个新写操作模块与 9 个新纯模块。
  const sources = PURE_CHAIN_MODULES.map((rel) => ({ rel, text: readFileSync(join(SRC, rel), 'utf8') }));
  const violations = findForbiddenImports(sources);
  assert.deepEqual(violations, [], '计划/去重/归一化链路混入了写操作模块，dry-run 不再零写入');
});

test('plan.js 也不得出现 chrome. 直接调用', () => {
  const text = readFileSync(join(SRC, 'plan.js'), 'utf8');
  assert.ok(!usesChromeApi(text), 'plan.js 直接调了 chrome API');
});

// ───────────────────── 计划内容 ─────────────────────

const B = (id, url, extra = {}) => ({
  id,
  type: 'url',
  url,
  title: extra.title ?? '',
  path: extra.path ?? ['其他书签'],
  dateAdded: extra.dateAdded ?? 1000,
  readOnly: extra.readOnly ?? false,
});

test('⚠️ 路径模型：toPath 不含根名，fromPath 含 —— 已在位判断必须剥掉根名', () => {
  // toPath 来自 taxonomy（'大类/子类'），不含根；fromPath 第 0 段是根文件夹名。
  // 若直接比 fromStr，两边永远不等，幂等会彻底失效。
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a', { path: ['书签栏', '开发与技术', '代码托管'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 1, '已在位的条目必须仍然出现在计划表里（结论≠消失）');
  assert.equal(p.items[0].status, 'skipped', '已在位的条目不该被判成待移动');
  assert.equal(p.items[0].reason, REASON.IN_PLACE);
  assert.equal(p.stats.planned, 0, '「将要移动」数必须只数 pending');
  assert.equal(p.stats.inPlace, 1);
  assert.equal(p.stats.byReason[REASON.IN_PLACE], 1);

  // 其他根下同样算在位（只比相对路径，不跨根搬，避免反复横跳）
  const p2 = buildPlan({
    entries: [B('1', 'https://github.com/a', { path: ['其他书签', '开发与技术', '代码托管'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.items[0].status, 'skipped');
  assert.equal(p2.stats.planned, 0, '换到另一个根下的同一路径不该被判成待移动');
});

test('toPath 只输出 taxonomy 路径，不含根名', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a', { path: ['书签栏'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.deepEqual(p.items[0].toPath, ['开发与技术', '代码托管']);
  assert.equal(p.items[0].toStr, '开发与技术/代码托管');
  // 根名只出现在 fromPath 里
  assert.deepEqual(p.items[0].fromPath, ['书签栏']);
});

test('规则命中生成 pending 计划项', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a', { title: 'repo' })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 1);
  const it = p.items[0];
  assert.equal(it.toStr, '开发与技术/代码托管');
  assert.equal(it.fromStr, '其他书签');
  assert.equal(it.status, 'pending');
  assert.deepEqual(it.toPath, ['开发与技术', '代码托管']);
});

test('已在目标位置 → skipped（幂等的核心）', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a', { path: ['书签栏', '开发与技术', '代码托管'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  // ⚠️ 断言的是「status」而不是「items 为空」：条目必须留在计划表里，
  //    否则它在清单侧永远拿不到裁决，就又变成「标记了却没动静」。
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].status, 'skipped');
  assert.equal(p.items[0].reason, REASON.IN_PLACE);
  assert.equal(p.stats.byReason[REASON.IN_PLACE], 1);
});

test('重复运行产生 0 变更（幂等）', () => {
  const entries = [B('1', 'https://github.com/a'), B('2', 'https://reactjs.org/')];
  const first = buildPlan({ entries, taxonomy: DEFAULT_TAXONOMY });

  // 模拟执行完成：所有条目已经在目标路径（注意要补上根名）
  const after = entries.map((e) => {
    const target = first.items.find((i) => i.id === e.id);
    return target ? { ...e, path: [e.path[0], ...target.toPath] } : e;
  });
  const second = buildPlan({ entries: after, taxonomy: DEFAULT_TAXONOMY });
  // 幂等量的判据是「还有几条要动」，不是「计划表里还有几条」——
  // 后者现在恒等于条目总数（在位的条目也留在表里，见上一条测试）。
  assert.equal(second.stats.planned, 0, '第二轮仍有待移动条目，幂等被破坏');
  assert.ok(second.items.every((i) => i.status === 'skipped'));
});

test('人工锁定 → skipped，不动它但要在计划表里给出结论', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a'), B('2', 'https://reactjs.org/')],
    taxonomy: DEFAULT_TAXONOMY,
    locks: ['https://github.com/a'],
  });
  // 锁定的条目留在计划表里（status skipped），执行器只挑 pending，不会碰它。
  const locked = p.items.find((i) => i.id === '1');
  assert.ok(locked, '锁定的条目不该从计划表里消失');
  assert.equal(locked.status, 'skipped');
  assert.equal(locked.reason, REASON.LOCKED);
  assert.equal(locked.locked, true);

  const movable = p.items.filter((i) => i.status === 'pending');
  assert.deepEqual(movable.map((i) => i.id), ['2'], '只有没锁的那条会动');
  assert.equal(p.stats.planned, 1);
  assert.equal(p.stats.blocked, 1);
  assert.equal(p.stats.byReason[REASON.LOCKED], 1);
});

test('锁定按 URL 生效，带 www / 跟踪参数也能锁上', () => {
  const p = buildPlan({
    entries: [B('1', 'https://www.github.com/a?utm_source=wx')],
    taxonomy: DEFAULT_TAXONOMY,
    locks: ['https://github.com/a'],
  });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].status, 'skipped', '同一条书签的不同写法没被锁住');
  assert.equal(p.items[0].reason, REASON.LOCKED);
  assert.equal(p.stats.planned, 0);
});

test('排除项（chrome:// 等）→ skipped，记入「无法处理」档', () => {
  const p = buildPlan({
    entries: [B('1', 'chrome://extensions'), B('2', 'http://localhost:3000/'), B('3', 'file:///c:/a.html')],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 3, '排除项也要给出结论，否则清单侧永远拿不到裁决');
  assert.ok(p.items.every((i) => i.status === 'skipped' && i.reason === REASON.EXCLUDED));
  assert.equal(p.stats.planned, 0);
  assert.equal(p.stats.blocked, 3);
  assert.equal(p.stats.byReason[REASON.EXCLUDED], 3);
});

test('只读根（移动设备书签）→ skipped，记入「无法处理」档', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a', { readOnly: true, path: ['移动设备书签'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].status, 'skipped');
  assert.equal(p.items[0].reason, REASON.READONLY);
  assert.equal(p.stats.planned, 0);
  assert.equal(p.stats.blocked, 1);
  assert.equal(p.stats.byReason[REASON.READONLY], 1);
});

test('只读的文件夹节点不进计划（只有书签条目进表）', () => {
  const p = buildPlan({
    entries: [{ id: 'f1', type: 'folder', title: '移动设备书签', path: ['移动设备书签'], readOnly: true }],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 0);
  // 计数仍保留旧语义：它确实被 readOnly 分支数到了
  assert.equal(p.stats.byReason[REASON.READONLY], 1);
  assert.equal(p.stats.total, 0, 'total 只数 url 条目');
});

test('文件夹节点不进计划', () => {
  const p = buildPlan({
    entries: [{ id: '1', type: 'folder', title: '开发', path: ['书签栏'] }],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 0);
});

test('未命中 → 兜底桶且 confidence 为 low', () => {
  const p = buildPlan({
    entries: [B('1', 'https://totally-unknown-xyz-9988.net/q', { title: 'zzz' })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].toStr, '其他/待归类');
  assert.equal(p.items[0].reason, REASON.UNCLASSIFIED);
  assert.equal(p.items[0].confidence, 'low');
});

test('LLM 兜底只在规则未命中时生效', () => {
  const entries = [B('1', 'https://github.com/a'), B('2', 'https://unknown-xyz-8877.net/q')];
  const p = buildPlan({
    entries,
    taxonomy: DEFAULT_TAXONOMY,
    llmAssignments: {
      'https://github.com/a': '影音娱乐/游戏', // 试图覆盖规则 —— 必须无效
      'https://unknown-xyz-8877.net/q': '工作办公/行业资讯', // 兜底应当生效
    },
  });
  const byId = Object.fromEntries(p.items.map((i) => [i.id, i]));
  assert.equal(byId['1'].toStr, '开发与技术/代码托管', 'LLM 结果覆盖了规则');
  assert.equal(byId['2'].toStr, '工作办公/行业资讯');
  assert.equal(byId['2'].reason, REASON.LLM);
});

test('面板手改优先级最高', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a')],
    taxonomy: DEFAULT_TAXONOMY,
    llmAssignments: { 'https://github.com/a': '影音娱乐/游戏' },
    manualAssignments: { 'https://github.com/a': '学习资料/电子书' },
  });
  assert.equal(p.items[0].toStr, '学习资料/电子书');
  assert.equal(p.items[0].reason, REASON.MANUAL);
});

test('learned 规则优先于预置规则', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a')],
    taxonomy: DEFAULT_TAXONOMY,
    learnedRules: [{ to: '其他/待归类', domains: ['github.com'] }],
  });
  assert.equal(p.items[0].toStr, '其他/待归类');
  assert.equal(p.items[0].reason, REASON.LEARNED);
});

test('非法类目路径被 coerce 到合法路径', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a')],
    taxonomy: DEFAULT_TAXONOMY,
    llmAssignments: { 'https://github.com/a': '瞎写的类目/瞎写的子类' },
  });
  // github.com 走规则，不受 llm 影响；换一个未命中的 URL 验证 coerce
  const p2 = buildPlan({
    entries: [B('2', 'https://unknown-xyz-7766.net/q')],
    taxonomy: DEFAULT_TAXONOMY,
    llmAssignments: { 'https://unknown-xyz-7766.net/q': '瞎写的类目/瞎写的子类' },
  });
  assert.equal(p2.items[0].toStr, '其他/待归类');
  assert.ok(p.items.length === 1);
});

test('newFolders 按深度升序（父先子后）', () => {
  const p = buildPlan({
    entries: [
      B('1', 'https://github.com/a'),
      B('2', 'https://reactjs.org/'),
      B('3', 'https://vitejs.dev/'),
    ],
    taxonomy: DEFAULT_TAXONOMY,
  });
  const depths = p.newFolders.map((f) => f.length);
  for (let i = 1; i < depths.length; i++) {
    assert.ok(depths[i] >= depths[i - 1], 'newFolders 没有按深度排序，建目录会失败');
  }
});

test('newFolders 只包含本次真正要建的路径', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a', { path: ['开发与技术'] })], // 父目录已存在
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.deepEqual(p.newFolders, [['开发与技术', '代码托管']]);
});

test('空输入不炸', () => {
  const p = buildPlan({});
  assert.deepEqual(p.items, []);
  assert.deepEqual(p.newFolders, []);
  assert.equal(p.stats.total, 0);
});

test('用户自建类目树也能工作', () => {
  const custom = [{ name: '我的', children: ['甲', '乙'] }];
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a')],
    taxonomy: custom,
  });
  // github.com 的规则指向的类目在自定义树里不存在 → 被 coerce 到自定义树的第一个节点
  assert.deepEqual(p.items[0].toPath, ['我的', '甲']);
});

// ───────────────────── LLM 选择 ─────────────────────

test('selectForLlm 只挑未命中且未锁定的条目', () => {
  const entries = [
    B('1', 'https://github.com/a'),            // 规则命中 → 不问
    B('2', 'https://unknown-aa-9911.net/q'),   // 未命中 → 要问
    B('3', 'https://unknown-bb-9922.net/q'),   // 未命中但被锁 → 不问
    B('4', 'chrome://extensions'),             // 排除项 → 不问
  ];
  const plan = buildPlan({
    entries,
    taxonomy: DEFAULT_TAXONOMY,
    locks: ['https://unknown-bb-9922.net/q'],
  });
  const sel = selectForLlm(plan, entries, ['https://unknown-bb-9922.net/q']);
  assert.deepEqual(sel.map((s) => s.id), ['2']);
});

// ═══════════════════════════════════════════════════════════════
// ⚠️⚠️ 2026-10-07 静默失效的长期回归。
//     现象：用户手工圈定的书签里，有一部分**永远不会被送给 AI**。
//     根因：buildPlan 的幂等判定抢在 AI 之前跑，且把兜底桶「其他/待归类」
//           当成了合法目标位置 —— 于是「正躺在待归类里」的书签被判成已在位、
//           从 plan.items 里剔除；而 selectForLlm 的候选池正是从 plan.items 反推的。
//           它不是 AI 拒绝了这些条目，是 AI 从来没见过它们。
//           不进计划表 → 不被移动 → 无裁决 → 清单里永远停在「待整理」，且界面不报错。
//     这三条是那道闸门。**改 buildPlan 里任何一条剔除分支之前，先看它们。**
// ═══════════════════════════════════════════════════════════════

test('★ 落在「其他/待归类」里的条目不会被判成「已在原位」', () => {
  // 这条书签**当前就在兜底桶里**，而且没有任何规则/手改/LLM 判过它。
  // 它是「还没分类」，不是「已经整理好」。
  //
  // 注意 status 是 skipped 而不是 pending：搬过去是空操作，没有东西要搬，
  // 标成 pending 会让「将要移动」永远非零、把幂等直接打破。
  // 真正的判据在 reason —— 它必须保持 UNCLASSIFIED，selectForLlm 才挑得到它。
  const p = buildPlan({
    entries: [B('1', 'https://unknown-cc-9933.net/q', { path: ['书签栏', '其他', '待归类'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });

  assert.equal(p.items.length, 1, '兜底桶里的条目被从计划表里剔掉了');
  assert.equal(p.items[0].status, 'skipped', '没有东西要搬，不该算「将要移动」');
  assert.equal(p.items[0].reason, REASON.UNCLASSIFIED, 'reason 必须是未归类，而不是已在原位');
  assert.equal(p.stats.planned, 0, '空操作不该进「将要移动」，否则幂等永远破不了');
  assert.equal(p.stats.inPlace, 0, '兜底桶不构成「已在原位」');
  assert.equal(p.stats.unclassified, 1, '它有自己的计数，界面上要能单独列出来');
  assert.equal(p.stats.byReason[REASON.IN_PLACE], undefined);
});

test('★ 落在「其他/待归类」里的条目会被送去问 LLM', () => {
  // 上一条的必然推论，也是用户真正看见的那一半：
  // selectForLlm 的候选池来自 plan.items，条目不在 items 里就永远问不到它。
  const entries = [B('1', 'https://unknown-cc-9933.net/q', { path: ['书签栏', '其他', '待归类'] })];
  const plan = buildPlan({ entries, taxonomy: DEFAULT_TAXONOMY });
  const sel = selectForLlm(plan, entries, []);

  assert.deepEqual(sel.map((s) => s.id), ['1'],
    'AI 从来没见过这条书签 —— 用户视角就是「AI 把它过滤了」');
});

test('★ 真·在位（非兜底桶）仍然判为已在原位，但留在计划表里', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a', { path: ['书签栏', '开发与技术', '代码托管'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });

  assert.equal(p.items.length, 1, '「判定无需移动」是结论，不是「什么都没发生」');
  assert.equal(p.items[0].status, 'skipped');
  assert.equal(p.items[0].reason, REASON.IN_PLACE);
  assert.equal(p.stats.planned, 0);
  assert.equal(p.stats.inPlace, 1);
});

test('用户显式接受「就放待归类」→ 独立终态，不算已整理', () => {
  const entries = [B('1', 'https://unknown-cc-9933.net/q', { path: ['书签栏', '其他', '待归类'] })];
  const key = dedupeKey('https://unknown-cc-9933.net/q');
  const p = buildPlan({ entries, taxonomy: DEFAULT_TAXONOMY, resolution: { [key]: 'accept-unclassified' } });

  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].status, 'skipped');
  assert.equal(p.items[0].reason, REASON.UNCLASSIFIED_ACCEPTED);
  assert.equal(p.stats.unclassified, 1, '它有自己的计数，不能混进 blocked 或 inPlace');
  assert.equal(p.stats.planned, 0);
});

test('已接受的条目不再送去问 LLM（省一次钱，也避免又被猜一遍）', () => {
  const entries = [B('1', 'https://unknown-cc-9933.net/q', { path: ['书签栏', '其他', '待归类'] })];
  const key = dedupeKey('https://unknown-cc-9933.net/q');
  const plan = buildPlan({ entries, taxonomy: DEFAULT_TAXONOMY, resolution: { [key]: 'accept-unclassified' } });
  assert.deepEqual(selectForLlm(plan, entries, []), []);
});

test('stats 穷举四类终态，不留 else 兜底（新增状态忘了归类时要显形）', () => {
  const p = buildPlan({
    entries: [
      B('1', 'https://github.com/a'),                                    // pending
      B('2', 'https://github.com/a', { path: ['书签栏', '开发与技术', '代码托管'] }), // in-place
      B('3', 'chrome://extensions'),                                     // excluded → blocked
    ],
    taxonomy: DEFAULT_TAXONOMY,
  });
  const s = p.stats;

  assert.equal(s.total, 3);
  assert.equal(s.planned + s.inPlace + s.unclassified + s.blocked + s.unknown, s.total,
    '求和必须闭；unknown 是刻意留的显形口子，不许靠 else 把它吞成 pending');
  assert.equal(s.unknown, 0);
  assert.equal(s.planned, 1);
  assert.equal(s.inPlace, 1);
  assert.equal(s.blocked, 1);
});
