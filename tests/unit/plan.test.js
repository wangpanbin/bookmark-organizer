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
import { findForbiddenImports, usesChromeApi } from '../helpers/sourceScan.js';

setRules(DEFAULT_RULES);

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');

// ───────────────────── 静态断言：dry-run 零写入 ─────────────────────

test('⚠️ plan.js 不得 import 任何写操作模块', () => {
  const PURE_CHAIN = [
    'plan.js', 'dedupe.js', 'normalize.js',
    'classify/rules.js', 'classify/dict.js', 'classify/taxonomy.js',
  ];
  const sources = PURE_CHAIN.map((rel) => ({ rel, text: readFileSync(join(SRC, rel), 'utf8') }));
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
  assert.equal(p.items.length, 0, '已在位的条目被判成了待移动');
  assert.equal(p.stats.byReason[REASON.IN_PLACE], 1);

  // 其他根下同样算在位（只比相对路径，不跨根搬，避免反复横跳）
  const p2 = buildPlan({
    entries: [B('1', 'https://github.com/a', { path: ['其他书签', '开发与技术', '代码托管'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p2.items.length, 0, '换到另一个根下的同一路径被判成了待移动');
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
  assert.equal(p.items.length, 0, '已在位的条目不该产生计划项');
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
  assert.equal(second.items.length, 0, '第二轮仍有变更，幂等被破坏');
});

test('人工锁定 → skipped 且不进计划', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a'), B('2', 'https://reactjs.org/')],
    taxonomy: DEFAULT_TAXONOMY,
    locks: ['https://github.com/a'],
  });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].id, '2');
  assert.equal(p.stats.byReason[REASON.LOCKED], 1);
});

test('锁定按 URL 生效，带 www / 跟踪参数也能锁上', () => {
  const p = buildPlan({
    entries: [B('1', 'https://www.github.com/a?utm_source=wx')],
    taxonomy: DEFAULT_TAXONOMY,
    locks: ['https://github.com/a'],
  });
  assert.equal(p.items.length, 0, '同一条书签的不同写法没被锁住');
});

test('排除项（chrome:// 等）→ skipped 且不进计划', () => {
  const p = buildPlan({
    entries: [B('1', 'chrome://extensions'), B('2', 'http://localhost:3000/'), B('3', 'file:///c:/a.html')],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 0);
  assert.equal(p.stats.byReason[REASON.EXCLUDED], 3);
});

test('只读根（移动设备书签）→ skipped', () => {
  const p = buildPlan({
    entries: [B('1', 'https://github.com/a', { readOnly: true, path: ['移动设备书签'] })],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 0);
  assert.equal(p.stats.byReason[REASON.READONLY], 1);
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
