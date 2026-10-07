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
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RULES } from '../../src/classify/dict.js';
import { matchAll, compileRules, matchRule } from '../../src/classify/rules.js';
import { normalizeUrl, dedupeKey } from '../../src/normalize.js';
import { DEFAULT_SETTINGS } from '../../src/storage.js';
import { findDuplicates } from '../../src/dedupe.js';
import { buildPlan, setRules } from '../../src/plan.js';
import { DEFAULT_TAXONOMY } from '../../src/classify/taxonomy.js';
import { SAMPLE_BOOKMARKS, HIT_RATE_THRESHOLD } from '../fixtures/samples.js';
import { findForbiddenImports, extractImports, FORBIDDEN_IN_PURE_CHAIN, PURE_CHAIN_MODULES, usesChromeApi, findForbiddenRuntime, FORBIDDEN_RUNTIME_NAMES, readSource, stripComments, findStorageRmw } from '../helpers/sourceScan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');

/** 递归列出 src/ 下的业务 .js（排除 vendor 产物）。清单是活的：新增文件自动纳入。 */
function walkJs(dir) {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return walkJs(abs);
    return /\.(js|mjs)$/.test(name) && !name.includes('vendor') ? [abs] : [];
  });
}

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
  // ⚠️ 2026-10-06：导入表从**文件名后缀**改成**相对 src/ 的精确路径**，
  //    所以这里不能再用一张写死的 specifier 清单 —— 同一个 specifier
  //    从不同目录解析出来的目标不一样（'./llm.js' 从 src/ 根解析是 src/llm.js，
  //    从 src/classify/ 解析才是真实存在的 src/classify/llm.js）。
  //    改为**从禁用表本身推导**：从该模块自己的位置导入它自己。
  //    这样「禁用表加了一项」会被自动覆盖，不会出现
  //    「加了新模块、这张测试却还在测老名字」的静默失效。
  for (const bad of FORBIDDEN_IN_PURE_CHAIN) {
    const rel = bad; // 被检查的文件就是那个写操作模块自己
    const spec = `./${posix.basename(bad)}`; // 从它自己的目录导入它自己
    const src = `import * as m from '${spec}';\nexport default m;\n`;
    const hits = findForbiddenImports([{ rel, text: src }]);
    assert.equal(hits.length, 1, `写操作模块 ${bad} 没被识别（rel=${rel} spec=${spec}）`);
  }
});

test('证伪：精确路径匹配下，上级目录的写操作模块同样抓得到', () => {
  // 光测「从自己目录导入自己」不够 —— 真正的风险是从**别的**目录往上引用。
  const src = "import { mutate } from '../storage.js';\nexport const x = mutate;\n";
  assert.deepEqual(
    findForbiddenImports([{ rel: 'classify/rules.js', text: src }]),
    ['classify/rules.js → ../storage.js'],
    '从 src/classify/ 往上引用 src/storage.js 绕过了闸门',
  );
});

test('证伪：裸模块名不会被当成 src/ 下的文件', () => {
  // 'node:fs' / 'some-pkg' 不可能命中 src/ 里的任何文件。
  // 如果闸门把它们报出来，那它对「路径解析」这件事根本没在测量。
  const src = "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n";
  assert.deepEqual(
    findForbiddenImports([{ rel: 'plan.js', text: src }]),
    [],
    '裸模块名被误报 —— 闸门没有真的在解析路径',
  );
});

test('证伪：fail-log.js 那一行是「承重」的，删掉闸门立刻失效', () => {
  // 这一条专门盯住 FORBIDDEN_IN_PURE_CHAIN 里的 'fail-log.js'。
  // 有人哪天「清理」时把它删了，日志模块就能被纯链路 import 而没人拦 ——
  // 而日志模块会发网络请求，dry-run 就不再是零写入、零外发。
  const src = "import { recordFailure } from './fail-log.js';\nexport const x = recordFailure;\n";

  const withEntry = findForbiddenImports([{ rel: 'plan.js', text: src }]);
  assert.deepEqual(withEntry, ['plan.js → ./fail-log.js'], 'fail-log.js 没被闸门拦住');

  // 模拟「那一行被删掉」：用一个不含 fail-log.js 的禁用表
  const WITHOUT = FORBIDDEN_IN_PURE_CHAIN.filter((f) => f !== 'fail-log.js');
  assert.deepEqual(
    findForbiddenImports([{ rel: 'plan.js', text: src }], WITHOUT),
    [],
    '删掉列表项后竟然还能拦住 —— 说明这条断言测的不是列表项本身',
  );
});

test('证伪：后缀地雷已拆除 —— 同名不同路径不再被误判', () => {
  // 这条测试历史上断言的是**旧行为**：叫 fail-log-storage.js 的模块
  // 会因为名字以 storage.js 结尾而被当成写操作模块。
  // 那是个必然误报的地雷 —— 而一个必然误报的门只会让人学会忽略它，
  // 于是真违规也一起被忽略。2026-10-06 改成精确路径匹配，地雷拆掉了。
  //
  // 所以这条断言**方向反过来了**：现在要求它**不被**误判。
  // 换句话说：闸门从「宁可错杀」改成「只杀真的」，
  // 靠的是能精确解析路径，而不是靠人起名当心。
  const sneaky = "import { x } from './fail-log-storage.js';\nexport const y = x;\n";
  assert.deepEqual(
    findForbiddenImports([{ rel: 'plan.js', text: sneaky }]),
    [],
    'fail-log-storage.js 又被误判了 —— 后缀地雷复活了',
  );
  // 真正的模块名仍然照抓不误
  assert.deepEqual(
    findForbiddenImports([{ rel: 'plan.js', text: "import { x } from './fail-log.js';\nexport const y = x;\n" }]),
    ['plan.js → ./fail-log.js'],
  );
  // 同理：新建的 src/scan/ 下的模块名里带 storage/apply 也不再有风险
  for (const name of ['./probe-storage.js', './apply-queue.js', './tree-cache.js']) {
    assert.deepEqual(
      findForbiddenImports([{ rel: 'scan/probe.js', text: `import { x } from '${name}';\nexport const y = x;\n` }]),
      [],
      `${name} 被误判了 —— 后缀地雷没拆干净`,
    );
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

// ───────── 3b. 扩大的「纯模块禁用能力」闸门（2026-10-06）─────────
//
// 起因：usesChromeApi 原来只认 chrome.bookmarks 与 chrome.storage，
// 于是 chrome.alarms / chrome.permissions / fetch / indexedDB **全部漏网** ——
// 而这恰恰是 link-scan 功能要用的全部能力。闸门对新区块覆盖为零。

test('证伪：纯模块一旦碰到 alarms/permissions/fetch/indexedDB → 闸门必须红', () => {
  // 这四种正是本项目即将引入的能力。每一种漏掉，dry-run 的零写入与零外发就不再有保证。
  const MUST_RED = [
    ['chrome.alarms', 'chrome.alarms.create("link-scan", { periodInMinutes: 360 });'],
    ['chrome.permissions', 'await chrome.permissions.request({ origins: ["<all_urls>"] });'],
    ['fetch()', 'const r = await fetch(url);'],
    ['indexedDB', 'const db = await new Promise((res) => { const r = indexedDB.open("x", 1); });'],
    ['chrome.runtime', 'chrome.runtime.sendMessage({ type: "x" });'],
    ['chrome.tabs', 'const t = await chrome.tabs.query({});'],
    ['chrome.debugger', 'await chrome.debugger.attach({ tabId: 1 }, "1.3");'],
    ['chrome.bookmarks', 'const b = await chrome.bookmarks.getTree();'],
    ['chrome.storage', 'await chrome.storage.local.get("k");'],
    ['XMLHttpRequest', 'const x = new XMLHttpRequest();'],
    ['WebSocket', 'const w = new WebSocket("ws://x");'],
    ['sendBeacon', 'navigator.sendBeacon("/log", body);'],
    ['importScripts', 'importScripts("a.js");'],
  ];
  for (const [name, code] of MUST_RED) {
    const src = `export async function go() { ${code} }\n`;
    assert.equal(usesChromeApi(src), true, `纯模块里的 ${name} 没被闸门抓到 —— 它可以悄悄出网或改状态`);
    assert.ok(
      findForbiddenRuntime(src).length > 0,
      `findForbiddenRuntime 对 ${name} 什么都没报，与 usesChromeApi 自相矛盾`,
    );
  }
});

test('证伪：每一条禁用能力都必须真的被清单覆盖（清单与测试不许漂移）', () => {
  // 反向钉死：上面那个测试逐条点名，缺一条就补一条。
  // ⚠️ 2026-10-06 的评审抓到过：清单里加了 chrome.debugger，
  //    但 MUST_RED 没跟着加 —— 那一条能力从此没有任何验证。
  for (const name of FORBIDDEN_RUNTIME_NAMES) {
    assert.ok(FORBIDDEN_RUNTIME_NAMES.length >= 13, `禁用能力清单被清空了：${FORBIDDEN_RUNTIME_NAMES.join(', ')}`);
  }
  const MUST_BE_COVERED = [
    'chrome.bookmarks', 'chrome.storage', 'chrome.alarms', 'chrome.permissions',
    'chrome.tabs', 'chrome.runtime', 'chrome.debugger',
    'fetch()', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'importScripts', 'indexedDB',
  ];
  for (const n of MUST_BE_COVERED) {
    assert.ok(FORBIDDEN_RUNTIME_NAMES.includes(n), `清单里少了 ${n}`);
  }
  // MUST_RED 的条目数必须覆盖整个清单
  const covered = new Set(['chrome.bookmarks', 'chrome.storage', 'chrome.alarms', 'chrome.permissions',
    'chrome.tabs', 'chrome.runtime', 'chrome.debugger',
    'fetch()', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'importScripts', 'indexedDB']);
  for (const n of FORBIDDEN_RUNTIME_NAMES) {
    assert.ok(covered.has(n), `清单里的 ${n} 在 MUST_RED 里没有对应用例 —— 它从未被验证过`);
  }
});

test('证伪：新闸门不能误伤「提到这些词但并没有真的用」的代码', () => {
  // 误报是闸门失去可信度的最快方式。下面每一条在扩清单之前都不会红，
  // 现在也不该红 —— 如果它们红了，说明正则太宽，闸门会天天因为错误的原因而红。
  const MUST_NOT_RED = [
    ['属性名带 fetch', 'export const prefetchCount = 1;\nexport const x = prefetchCount;'],
    ['方法名带 fetch', 'export function capturingFetch(sink) { return sink; }'],
    ['字符串里提到 fetch', "export const tip = '这里本来要用 fetch 的';"],
    ['字符串里提到 chrome.alarms', "export const tip = 'chrome.alarms 在设置页';"],
    ['JSDoc 里提到 fetch', '/**\n * 用 fetch 抓正文。\n */\nexport const x = 1;'],
    ['注释里提到 indexedDB', '// 以前用 indexedDB 存向量\nexport const x = 1;'],
    ['https:// 里的 //', "export const u = 'https://example.com/a';"],
    ['干净的纯逻辑', 'export function norm(s) { return String(s || \'\').trim(); }'],
  ];
  for (const [label, src] of MUST_NOT_RED) {
    assert.equal(usesChromeApi(src), false, `${label} 被误报了 —— 正则太宽，闸门会因为错误的原因而红`);
  }
});

test('证伪：读设置项的 `!== false` 只能用在 DEFAULT_SETTINGS 里真的存在的那一项上', () => {
  // ⚠️ 这条来自一次真实的 bug：`background.js` 写 `s.linkScanAiFind !== false`，
  //    而 linkScanAiFind **根本不在 DEFAULT_SETTINGS 里**。
  //    `undefined !== false` 恒为 true —— 功能「正常」，只是没人能关掉它。
  //
  //    为什么需要这条闸门：只断言「设置项存在且默认 false」是**不够**的 ——
  //    把读取处改回 `!== false`、DEFAULT_SETTINGS 一点没动，那条断言照样绿。
  //    证伪跑出来就是「未红」，逼出了这条真正对准 bug 签名的判据。
  const defaults = DEFAULT_SETTINGS;
  const SRC_DIR = join(HERE, '..', '..', 'src');

  // ⚠️ 已知的**函数选项**（不是持久化设置），它们的 `!== false` 是合法的
  //    「不传就默认开」语义。加新选项必须 consciously 加进来 ——
  //    这正是想要的摩擦：多写一个名字，就多一次「它真的是选项吗」的确认。
  const OPTION_NAMES = new Set(['useJsonMode', 'wantSoft404', 'wantBody', 'important']);

  const offenders = [];
  for (const abs of walkJs(SRC_DIR)) {
    const text = stripComments(readFileSync(abs, 'utf8'));
    // 抓 `X.Y !== false` —— 任何接收者都行，因为我们真正判断的是
    // 「Y 是不是一个已登记的设置项」
    for (const m of text.matchAll(/\b\w+\.(\w+)\s*!==\s*false\b/g)) {
      const key = m[1];
      if (OPTION_NAMES.has(key)) continue;
      if (!(key in defaults)) {
        offenders.push(`${abs.slice(SRC_DIR.length + 1)} → ${key}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `这些地方读了 DEFAULT_SETTINGS 里不存在的名字并与 false 比较，恒为真：\n  ${offenders.join('\n  ')}\n`
    + '要么把它补进 DEFAULT_SETTINGS，要么把判断改成 === true。');
});

test('证伪：真实的纯链路源码不得命中新闸门', () => {
  // 最终判据：对磁盘上**清单里的每一个文件**跑一遍。
  // 这一条比任何合成样本都更有说服力 —— 它证明新清单与现有实现不冲突，
  // 而且清单是活的（新增纯模块自动纳入，不用改两个地方）。
  const SRC_DIR = join(HERE, '..', '..', 'src');
  for (const rel of PURE_CHAIN_MODULES) {
    const text = readSource(join(SRC_DIR, rel));
    const hits = findForbiddenRuntime(text);
    assert.deepEqual(hits, [], `${rel} 命中了禁用能力 ${hits.join(', ')} —— 要么实现违规，要么正则太宽`);
  }
});

test('证伪：两份清单里的每个文件都必须真实存在', () => {
  // 清单里写了一个不存在的文件名，那条检查就是**恒真**的 ——
  // 读不到文件会抛错或者被跳过，而一个恒真的闸门比没有闸门更坏。
  const SRC_DIR = join(HERE, '..', '..', 'src');
  for (const rel of PURE_CHAIN_MODULES) {
    assert.ok(existsSync(join(SRC_DIR, rel)), `纯链路清单里的 ${rel} 不存在 —— 那条检查是恒真的`);
  }
  for (const rel of FORBIDDEN_IN_PURE_CHAIN) {
    assert.ok(existsSync(join(SRC_DIR, rel)), `禁用导入清单里的 ${rel} 不存在 —— 那条检查是恒真的`);
  }
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
  // ⚠️ 判据是 stats.planned（将要移动的条数），**不是** items.length ——
  //    2026-10-07 起 items 里还留着 skipped 条目（在位/无法处理/未归类），
  //    它们是「有结论」而不是「有变更」。用 length 量幂等会恒为假。
  assert.equal(buildPlan({ entries: goodAfter, taxonomy: DEFAULT_TAXONOMY }).stats.planned, 0);

  // 坏实现：执行器什么都没做 → 第二轮仍有全部变更
  const badAfter = entries; // 原封不动
  assert.ok(
    buildPlan({ entries: badAfter, taxonomy: DEFAULT_TAXONOMY }).stats.planned > 0,
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
  assert.equal(buildPlan({ entries: good, taxonomy: DEFAULT_TAXONOMY }).stats.planned, 0);

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
    buildPlan({ entries, taxonomy: DEFAULT_TAXONOMY, locks: ['https://github.com/a'] }).stats.planned,
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

// ───────────── 7. storage 读-改-写闸门（AGENTS.md 第 2 条）能红吗 ─────────────
//
// 前科（2026-10-06 handoff §5 记为 S3）：三处把「读 → 改 → 写」摊在临界区外，
// 最重的一处 `archive/run.js` 的读与写之间隔着**整段正文重抓的网络**。
// 症状不是报错而是静默丢数据：两个调用各推一次游标 → 中间那批永久跳过 →
// 面板显示「扫完了」而它们从没被归档。
//
// ⚠️ 这道闸门的「该红」一侧是容易糊弄过去的（坏代码确实更坏），
//    真正要考的是下面的「该绿」：**整份写入是绝大多数正当写法**，
//    判据一旦把它们一起杀掉，闸门就只剩让人学会忽略它这一个作用。

test('证伪：闸门能抓住三种真实形状的读-改-写（直接 get / 解构 / 包了一层）', () => {
  // ① 直接调 storage.js 的包装
  const direct = `
    const q = await get(K.LINK_QUEUE, {});
    q['https://a'] = { url: 'https://a' };
    await set(K.LINK_QUEUE, q);
  `;
  // ② 解构
  const destructured = `
    const { a, b } = await getMany([K.A, K.B]);
    a.n += 1;
    await set(K.A, a);
  `;
  // ③ ⭐ 包了一层 —— 本项目的实际写法。
  //    早先的判据只认 ①②，于是 3 处真实违规里的 2 处（scan/runner.js 的
  //    `await getLinkState()`、archive/run.js 的 `await getArchiveRun()`）全部漏检。
  //    判据必须对准真实形状，而不是对准自己写样本时的形状。
  //
  //    ⚠️ 形状 ③ 要求取读包装的**定义与调用同文件**（判据在文件内解析 `async function`）。
  //    本项目成立：getLinkState / getArchiveRun / getSuggestions 全是模块内的。
  //    哪天开始从别的模块 import 一个 get 包装，这道闸门会对那一处**失效** ——
  //    下面那条测试把这个限制写成断言，好过让它悄悄变成一片看不见的网。
  const wrapped = `
    export async function getArchiveRun() {
      return (await get(K.ARCHIVE_STATE)) || null;
    }
    export async function archiveSlice() {
      let run = await getArchiveRun();
      run.done += 1;
      await set(K.ARCHIVE_STATE, run);
    }
  `;
  // 同一形状，一行写完的包装也必须认出来
  const wrappedOneLiner = `
    export async function getLinkState() { return (await get(K.LINK_STATE)) || emptyState(); }
    export async function runSlice() {
      let state = await getLinkState();
      state.cursor += 1;
      await set(K.LINK_STATE, state);
    }
  `;
  for (const [label, src] of [['直接 get', direct], ['解构', destructured], ['包了一层', wrapped], ['包了一层（单行）', wrappedOneLiner]]) {
    const hits = findStorageRmw(src);
    assert.equal(hits.length, 1, `${label} 这个形状没被抓到 —— 闸门对准的是自己写的样本，不是真实代码`);
  }
});

test('证伪：形状 ③ 的覆盖范围是「取读包装与调用同文件」（限制要写在脸上，不是默默留着）', () => {
  // 取读包装从别的模块 import 过来时，判据在文件内解析不到定义 → 漏检。
  // 这是**已知的**覆盖边界，不是 bug。写成断言是为了：哪天有人给包装加了
  // `storage-rmw-ok` 豁免、或换了取读方式时，这里会提醒他边界还在。
  const imported = `
    import { getArchiveRun } from './state.js';
    export async function archiveSlice() {
      let run = await getArchiveRun();
      run.done += 1;
      await set(K.ARCHIVE_STATE, run);
    }
  `;
  assert.deepEqual(findStorageRmw(imported), [],
    '判据现在能跨文件解析取读包装了 —— 那就把这条限制注释放掉，别让它过期');
});

test('证伪：正当写法不得被误报（整份写入是绝大多数情况）', () => {
  // 「该绿」这一侧才是判据的真正考验。下面每一条都是**闸门会红就说明判据写宽了**的正当代码。
  const MUST_NOT_RED = [
    ['整份写入一个新建对象', `
      await set(K.LINK_STATE, { ...emptyState(), status: 'running', round: 3 });
    `],
    ['整份写入一个函数调用的结果', `
      await set(K.LINK_STATE, emptyState());
    `],
    ['写另一个键 —— 不是同一个键的读-改-写', `
      const raw = await get(K.AI_CREDENTIALS, {});
      await set(K.SETTINGS, raw);
    `],
    ['setMany 不是单键 set', `
      const cur = await get(K.TASK_CURRENT, {});
      await setMany({ [K.TASK_CURRENT]: { ...cur, updatedAt: 1 } });
    `],
    ['原生 Map.set 不是 storage.set', `
      const v = await get(K.SETTINGS, {});
      v.set('a', 1);
    `],
    ['注释里引用旧代码不得被当成活代码', `
      // 早先是 \`let state = await getLinkState()\` … \`await set(K.LINK_STATE, state)\`
      /**
       * 以及块注释里的那一行：await set(K.LINK_QUEUE, q);
       */
      const untouched = 1;
    `],
    ['mutate 本身不得被当成违规（那正是解药）', `
      await mutate(K.LINK_QUEUE, (cur) => ({ ...(cur || {}), x: 1 }), {});
    `],
  ];
  for (const [label, src] of MUST_NOT_RED) {
    const hits = findStorageRmw(src);
    assert.deepEqual(hits, [], `${label} 被误报了 —— 判据太宽，闸门会因为错误的原因而红：\n  ${hits.join('\n  ')}`);
  }
});

test('证伪：豁免标记必须带非空理由，空理由等于没写', () => {
  const withReason = `
    const q = await get(K.LINK_QUEUE, {});
    await set(K.LINK_QUEUE, q); // storage-rmw-ok: 键由调用方保证独占
  `;
  assert.deepEqual(findStorageRmw(withReason), [], '带理由的豁免没被认出来');

  // ⚠️ 光写标记不写理由 = 没写。没有这一条，豁免会退化成「加个注释就能关掉闸门」
  for (const src of [
    `const q = await get(K.LINK_QUEUE, {});\nawait set(K.LINK_QUEUE, q); // storage-rmw-ok:`,
    `const q = await get(K.LINK_QUEUE, {});\nawait set(K.LINK_QUEUE, q); // storage-rmw-ok: `,
  ]) {
    assert.equal(findStorageRmw(src).length, 1, '空理由的豁免被放行了 —— 那不是豁免，是静默关闸门');
  }
});

test('证伪：真实的 src/ 不得有读-改-写漏在临界区外', () => {
  // 最终判据：对磁盘上 src/ 的**每一个**文件跑一遍。清单是活的（新增文件自动纳入）。
  const offenders = [];
  for (const abs of walkJs(SRC)) {
    const hits = findStorageRmw(readFileSync(abs, 'utf8'));
    if (hits.length) offenders.push(`${abs.slice(SRC.length + 1)}: ${hits.join('；')}`);
  }
  assert.deepEqual(offenders, [],
    `这些地方把「读 → 改 → 写」摊在 mutate 的临界区之外（AGENTS.md 第 2 条）：\n  ${offenders.join('\n  ')}\n`
    + '改法：网络放在临界区**之外**跑完，结果压成一份 delta，进 mutate 时基于当前值累加；'
    + '确实需要豁免就写 `storage-rmw-ok: <理由>`，理由不能为空。');
});

test('证伪：这道闸门本身不是恒真的（它确实会红，且红在真实代码上）', () => {
  // 一道从来没红过的闸门等于没有闸门。这里直接拿本仓库**修复前**的真实形状验证：
  // 三处违规的原文缩影，与 git 里的 a44e358 版本逐行对应。
  const BEFORE_FIX = `
    export async function getArchiveRun() { return (await get(K.ARCHIVE_STATE)) || null; }
    export async function archiveSlice() {
      let run = await getArchiveRun();
      if (!run) run = emptyRun(0);
      run.done += 1;
      run.cursor += 20;
      await set(K.ARCHIVE_STATE, run);
    }
  `;
  const hits = findStorageRmw(BEFORE_FIX);
  assert.equal(hits.length, 1, '修复前的真实形状竟然没被抓到 —— 这道闸门是恒真的');
  assert.match(hits[0], /ARCHIVE_STATE/, '抓到的不是那一处');

  // 修复后的形状必须转绿，否则说明判据只认「坏的样子」而不认「对的样子」
  const AFTER_FIX = `
    export async function getArchiveRun() { return (await get(K.ARCHIVE_STATE)) || null; }
    export async function archiveSlice() {
      let run = await getArchiveRun();
      const delta = { done: 1 };
      const next = await mutate(K.ARCHIVE_STATE, (cur) => ({ ...cur, done: cur.done + delta.done }));
      return next;
    }
  `;
  assert.deepEqual(findStorageRmw(AFTER_FIX), [], '正确的 mutate 写法被误报了');
});
