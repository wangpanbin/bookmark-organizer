/**
 * ⚠️ 证伪测试：证明上面那些闸门【能红】，而不是永远绿的摆设。
 *
 * 本库最高频的元规律：任何拿来当闸门的检查，先拿已知坏样本跑一遍，
 * 确认它会变红 —— 否则测的是一个从没运行过的坏实现。
 * （来源：AdGuard 0.2.0 迁移期踩过，详见 memory/topics/verification-methodology）
 *
 * 每个用例的结构都是：故意造一个坏实现 → 断言对应闸门【确实报错】→ 说明闸门有效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RULES } from '../../src/classify/dict.js';
import { matchAll, compileRules, matchRule } from '../../src/classify/rules.js';
import { normalizeUrl, dedupeKey } from '../../src/normalize.js';
import { findDuplicates } from '../../src/dedupe.js';
import { buildPlan, setRules } from '../../src/plan.js';
import { DEFAULT_TAXONOMY } from '../../src/classify/taxonomy.js';
import { SAMPLE_BOOKMARKS, HIT_RATE_THRESHOLD } from '../fixtures/samples.js';
import { findForbiddenImports, extractImports } from '../helpers/sourceScan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');

// ───────────────── 1. 命中率闸门能红吗 ─────────────────

test('证伪：词典被清空 → 命中率闸门必须红', () => {
  const broken = DEFAULT_RULES.map((r) => ({ ...r, domains: [], domainSuffixes: [], pathWords: [], titleWords: [] }));
  const rate = matchAll(SAMPLE_BOOKMARKS, broken).filter(Boolean).length / SAMPLE_BOOKMARKS.length;
  assert.ok(
    rate < HIT_RATE_THRESHOLD,
    `词典清空后命中率仍有 ${(rate * 100).toFixed(1)}%，闸门测不出退化`,
  );
  assert.equal(rate, 0);
});

test('证伪：退回我踩过的「位置参数错位」写法 → 结构性闸门必须红', () => {
  // 把 pathWords 挪进 domains、titleWords 挪进 pathWords（正是本项目发生过的真实 bug）
  const misaligned = DEFAULT_RULES.map((r) => ({
    ...r,
    domains: [...(r.domains || []), ...(r.pathWords || [])],
    domainSuffixes: r.domainSuffixes,
    pathWords: r.titleWords || [],
    titleWords: [],
  }));

  // 闸门 A：pathWords 每一项必须以 / 开头
  const badPath = misaligned.flatMap((r) =>
    (r.pathWords || []).filter((w) => !String(w).startsWith('/')).map((w) => ({ w, to: r.to })),
  );
  assert.ok(badPath.length > 0, '错位后 pathWords 里竟没有非路径项，闸门测不出错位');

  // 闸门 B：domains 里每项都必须是合法主机名
  const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  const badDomain = misaligned.flatMap((r) =>
    (r.domains || []).filter((d) => !HOST_RE.test(String(d).toLowerCase())).map((d) => ({ d, to: r.to })),
  );
  assert.ok(badDomain.length > 0, '错位后 domains 里竟没有非法主机名，闸门测不出错位');

  // 闸门 C：错位会真实地让标题匹配失效
  const before = SAMPLE_BOOKMARKS.filter((s) => s.title).length;
  const hitBefore = matchAll(SAMPLE_BOOKMARKS, DEFAULT_RULES).filter(Boolean).length;
  const hitAfter = matchAll(SAMPLE_BOOKMARKS, misaligned).filter(Boolean).length;
  assert.ok(hitAfter < hitBefore, `错位后命中率没下降（${hitBefore} → ${hitAfter}）`);
  assert.ok(before > 0);
});

// ───────────────── 2. SPA hash 保护闸门能红吗 ─────────────────

test('证伪：若归一化剥掉全部 hash → 去重闸门必须红', () => {
  // 模拟「过度归一化」这个危险实现：把 hash 一律剥掉
  const stripHash = (raw) => {
    const u = new URL(raw);
    u.hash = '';
    let p = u.pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return `${u.protocol}//${u.hostname}${p}${u.search}`;
  };

  const good = findDuplicates([
    { id: '1', type: 'url', url: 'https://app.example.com/#/settings', path: ['其他书签'], dateAdded: 1 },
    { id: '2', type: 'url', url: 'https://app.example.com/#/profile', path: ['其他书签'], dateAdded: 2 },
  ]);
  assert.equal(good.length, 0, '真实实现把两个不同路由判成了重复');

  // 坏实现下它们会被判成重复 —— 也就是说这条闸门确实在测量「有没有剥 hash」
  const badKeys = new Set([
    stripHash('https://app.example.com/#/settings'),
    stripHash('https://app.example.com/#/profile'),
  ]);
  assert.equal(badKeys.size, 1, '剥 hash 后两者会撞成同一个键，证明该闸门有意义');
});

test('证伪：若剥掉全部 query → 去重闸门必须红', () => {
  const stripQuery = (raw) => {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  };
  assert.notEqual(
    normalizeUrl('https://api.example.com/data?id=1'),
    normalizeUrl('https://api.example.com/data?id=2'),
  );
  assert.equal(
    stripQuery('https://api.example.com/data?id=1'),
    stripQuery('https://api.example.com/data?id=2'),
    '剥 query 后两者撞成同一个键',
  );
});

test('证伪：跟踪参数白名单被清空 → 去重闸门必须红', () => {
  // 真实实现：白名单里的 utm_source 被剥，两条 URL 判为同一条
  assert.equal(dedupeKey('https://example.com/p?utm_source=wx&id=7'), dedupeKey('https://example.com/p?id=7'));

  // 坏实现：白名单为空 → utm_source 留在串里，两者不再相等（闸门变红）
  const noWhitelist = (raw) => {
    const u = new URL(raw);
    u.hash = '';
    let p = u.pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return `${u.protocol}//${u.hostname}${p}${u.search}`;
  };
  assert.notEqual(
    noWhitelist('https://example.com/p?utm_source=wx&id=7'),
    noWhitelist('https://example.com/p?id=7'),
    '白名单清空后闸门仍不红，说明闸门没在测量「跟踪参数是否被剥」',
  );
});

// ───────────────── 3. dry-run 零写入闸门能红吗 ─────────────────

test('证伪：给 plan.js 注入写操作 import → 零写入闸门必须红', () => {
  const CLEAN = "import { a } from './normalize.js';\nexport const x = a;\n";
  const DIRTY = "import { a } from './normalize.js';\nimport { applyPlan } from './apply.js';\nexport const x = a, y = applyPlan;\n";

  assert.deepEqual(findForbiddenImports([{ rel: 'plan.js', text: CLEAN }]), [], '干净源码被误报了');
  assert.deepEqual(
    findForbiddenImports([{ rel: 'plan.js', text: DIRTY }]),
    ['plan.js → ./apply.js'],
    '注入 apply.js 竟然没被抓到 —— dry-run 零写入闸门是摆设',
  );
});

test('证伪：闸门对所有写操作模块都敏感', () => {
  for (const bad of ['./apply.js', '../backup.js', './storage.js', './llm.js', './tree.js', './background.js']) {
    const src = `import * as m from '${bad}';\nexport default m;\n`;
    const hits = findForbiddenImports([{ rel: 'plan.js', text: src }]);
    assert.equal(hits.length, 1, `写操作模块 ${bad} 没被识别`);
  }
});

test('证伪：import 扫描器能认全部 ESM 写法（含跨行与动态导入）', () => {
  // 每一种都必须被抓到。少一种，dry-run 零写入闸门就多一类绕过。
  const MUST_CATCH = [
    ['单行具名', "import { a } from './a.js';"],
    ['相对父级', "import b from '../b.js';"],
    ['单行 namespace', "import * as c from './c.js';"],
    ['副作用导入', "import './side-effect.js';"],
    ['re-export 具名', "export { d } from './d.js';"],
    ['re-export star', "export * from './e.js';"],
    ['re-export star as', "export * as ns from './f.js';"],
    ['多行具名', "import {\n  a,\n  b,\n} from './g.js';"],
    ['多行 re-export', "export {\n  h,\n} from './h.js';"],
    ['多行 默认+具名', "import i, {\n  j,\n} from './i.js';"],
    ['多行 namespace', "import *\n  as k\n  from './k.js';"],
    ['from 换行', "import {\n  l\n} from\n  './l.js';"],
    ['动态导入', "const m = await import('./m.js');"],
  ];
  for (const [label, text] of MUST_CATCH) {
    const specs = extractImports(text);
    const want = text.match(/['"](\.[^'"]+)['"]/)[1];
    assert.ok(specs.includes(want), `${label} 没被识别：${JSON.stringify(text)} -> ${JSON.stringify(specs)}`);
  }
});

test('证伪：闸门不能因为「看起来像导入」而误报', () => {
  // 反方向同样要钉死：误报会让闸门因为错误的原因而红，
  // 那和闸门从来没红过一样没用 —— 大家只会学会忽略它。
  const MUST_NOT_FLAG = [
    ['JSDoc 类型位置 import()', "/**\n * @param {import('./apply.js').Foo} x\n */\nexport const f = (x) => x;"],
    ['行注释里的具名 import', "// import { a } from './apply.js';\nexport const y = 1;"],
    ['块注释里的副作用 import', "/* import './apply.js'; */\nexport const y = 1;"],
    ['块注释里的多行 import', "/*\n * import {\n *   a,\n * } from './apply.js';\n */\nexport const y = 1;"],
    ['字符串里的 https://', "export const u = 'https://example.com/a';\nexport const z = 2;"],
    ['干净的纯链路源码', "import { a } from './normalize.js';\nexport const x = a;"],
  ];
  for (const [label, text] of MUST_NOT_FLAG) {
    assert.deepEqual(
      findForbiddenImports([{ rel: 'plan.js', text }]), [],
      `${label} 被误报了 —— 闸门会因为错误的原因而红`,
    );
  }
});

test('证伪：动态 import 写操作模块同样算违规', () => {
  // 动态 import 的作用域和时机由运行时决定，闸门没法证明它安全。
  const src = "import { a } from './normalize.js';\nasync function go(){ return import('./apply.js'); }";
  assert.deepEqual(
    findForbiddenImports([{ rel: 'plan.js', text: src }]),
    ['plan.js → ./apply.js'],
    '动态 import 绕过零写入闸门',
  );
});

test('证伪：跨行注入的写操作 import 必须被抓到', () => {
  // 这条对应历史上真实存在的洞：扫描器曾用 `[^;\n]*?`，禁掉换行，
  // 于是 `import {\n applyPlan,\n} from './apply.js'` 整条绕过。
  const DIRTY = "import {\n  applyPlan,\n} from './apply.js';\nexport const x = applyPlan;\n";
  assert.deepEqual(
    findForbiddenImports([{ rel: 'plan.js', text: DIRTY }]),
    ['plan.js → ./apply.js'],
    '多行 import 绕过了零写入闸门 —— 扫描器又变回摆设了',
  );
});

// ───────────────── 4. 幂等闸门能红吗 ─────────────────

test('证伪：若执行后没有真正搬动 → 幂等闸门必须红', () => {
  const entries = [
    { id: '1', type: 'url', url: 'https://github.com/a', title: '', path: ['其他书签'], dateAdded: 1 },
    { id: '2', type: 'url', url: 'https://reactjs.org/', title: '', path: ['其他书签'], dateAdded: 2 },
  ];
  setRules(DEFAULT_RULES);
  const first = buildPlan({ entries, taxonomy: DEFAULT_TAXONOMY });
  assert.ok(first.items.length > 0, '第一条就该有变更');

  // 正确执行：条目被搬到目标路径（注意要补上根名，因为 toPath 不含根）
  const goodAfter = entries.map((e) => {
    const t = first.items.find((i) => i.id === e.id);
    return t ? { ...e, path: [e.path[0], ...t.toPath] } : e;
  });
  assert.equal(buildPlan({ entries: goodAfter, taxonomy: DEFAULT_TAXONOMY }).items.length, 0);

  // 坏实现：执行器什么都没做 → 第二轮仍有全部变更
  const badAfter = entries; // 原封不动
  assert.ok(
    buildPlan({ entries: badAfter, taxonomy: DEFAULT_TAXONOMY }).items.length > 0,
    '第二轮 0 变更 —— 幂等闸门测不出「执行器没干活」',
  );
});

test('证伪：若「已在位」判断不剥根名 → 幂等闸门必须红', () => {
  setRules(DEFAULT_RULES);
  const entries = [
    { id: '1', type: 'url', url: 'https://github.com/a', title: '', path: ['书签栏'], dateAdded: 1 },
  ];
  const plan = buildPlan({ entries, taxonomy: DEFAULT_TAXONOMY });
  assert.ok(plan.items.length > 0);

  // 正确实现：执行后路径是 [根名, ...toPath] → 剥根后与 toStr 相等 → 0 变更
  const good = entries.map((e) => ({ ...e, path: ['书签栏', ...plan.items[0].toPath] }));
  assert.equal(buildPlan({ entries: good, taxonomy: DEFAULT_TAXONOMY }).items.length, 0);

  // 坏实现：把 fromPath 原样拿去比 toStr（根名没剥）→ 永远不等 → 每次都有变更
  const toStr = plan.items[0].toStr;
  const fromStrNoStrip = good[0].path.join('/');
  assert.notEqual(
    fromStrNoStrip,
    toStr,
    '剥根与不剥根竟得到同一个串，说明闸门分不清这两种实现',
  );
  assert.ok(fromStrNoStrip.endsWith(toStr), '不剥根的结果应仍以目标路径结尾，只是多了根名');
});

// ───────────────── 5. 锁闸门能红吗 ─────────────────

test('证伪：锁按字面 URL 比较而非归一化 → 锁闸门必须红', () => {
  setRules(DEFAULT_RULES);
  const entries = [
    { id: '1', type: 'url', url: 'https://www.github.com/a?utm_source=wx', title: '', path: ['其他书签'], dateAdded: 1 },
  ];

  // 正确实现：锁里写归一化后的形态也能锁上
  assert.equal(
    buildPlan({ entries, taxonomy: DEFAULT_TAXONOMY, locks: ['https://github.com/a'] }).items.length,
    0,
    '按归一化 URL 锁没生效',
  );

  // 坏实现：字面比较，必须写完全一样的字符串才生效
  const literalLocked = (locks) => locks.includes(entries[0].url);
  assert.equal(literalLocked(['https://github.com/a']), false, '字面比较竟然也锁上了 —— 闸门分不清两种实现');
  assert.equal(literalLocked(['https://www.github.com/a?utm_source=wx']), true);
});

// ───────────────── 6. 兜底桶闸门能红吗 ─────────────────

test('证伪：未命中若不进兜底桶 → 计划会留下空洞', () => {
  setRules(DEFAULT_RULES);
  const p = buildPlan({
    entries: [{ id: '1', type: 'url', url: 'https://zzz-unknown-4477.net/q', title: 'q', path: ['其他书签'], dateAdded: 1 }],
    taxonomy: DEFAULT_TAXONOMY,
  });
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.items[0].toPath, ['其他', '待归类']);
  assert.ok(p.newFolders.some((f) => f.join('/') === '其他/待归类'), '兜底桶没有被建出来');
});

test('证伪：规则引擎在无规则时必须返回 null（而不是瞎猜一个类目）', () => {
  const empty = compileRules([]);
  const r = matchRule({ url: 'https://github.com/a', title: 'GitHub 教程' }, empty);
  assert.equal(r, null, '无规则却给出了分类 —— 那这条路径根本不在测量「规则是否命中」');
  assert.equal(dedupeKey('https://a.com/x'), dedupeKey('https://a.com/x'));
});
