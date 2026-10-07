/**
 * 测试辅助：源码静态扫描。
 * 抽出来是为了让 plan.test.js 和 falsification.test.js 用【同一份】扫描逻辑 ——
 * 证伪测试要证明的就是这份扫描器本身能发现违规。
 */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * 写操作模块：出现在计划/去重/归一化链路里就意味着 dry-run 不再零写入。
 *
 * ⚠️ 2026-10-06：从**文件名后缀匹配**改成**相对 src/ 的精确路径**。
 *
 * 原来这里是 `spec.endsWith(bad)`，意味着新模块名只要**以**其中任何一项结尾
 * 就会被当成写操作模块 —— 把日志缓冲叫 `fail-log-storage.js` 会被 'storage.js' 命中，
 * 而它其实不是。误报是闸门失去可信度的最快方式，而一个必然误报的地雷
 * 只会让人学会忽略它，于是真违规也一并被忽略。
 *
 * 现在按「解析后的相对路径」精确比对：
 *   src/plan.js 里 import './apply.js'      → 解析成 'apply.js'          → 命中
 *   src/classify/rules.js 里 import './llm.js' → 解析成 'classify/llm.js' → 命中
 *   src/scan/probe.js 里 import './fetch-queue.js' → 'fetch-queue.js'   → 不命中
 *
 * 路径相对于 `src/`，与 `plan.test.js` 里 `rel` 的写法一致。
 */
export const FORBIDDEN_IN_PURE_CHAIN = [
  'apply.js',
  'backup.js',
  'fail-log.js',
  'storage.js',
  'tree.js',
  'background.js',
  'classify/llm.js',
  // 2026-10-06 新增：它 import vendor 产物，pull 它进来等于把 600KB
  // 拖进 Node 的单测，红灯的含义会从「逻辑坏了」变成「产物坏了」。
  'ai/runtime.js',
  // ── link-scan / 归档 / 语义去重（2026-10-06）──
  // ⚠️ 这一批曾经**一个都没进列表**。9 个碰 storage / fetch / indexedDB /
  //    alarms / permissions 的模块全部处于「闸门照不到」的状态 ——
  //    而闸门照不到的地方，就是退化不会被发现的地方。
  'scan/permission.js',
  'scan/probe.js',
  'scan/runner.js',
  'scan/scheduler.js',
  'scan/alternatives.js',
  'archive/client.js',
  'dedupe/embedding-client.js',
  'dedupe/semantic-runner.js',
  // 2026-10-06 补：内容归档的标记表与切片循环。
  // 两者都 import 了 storage.js / probe.js / client.js，
  // 任何纯链路 import 它们都等于把写操作拖进 dry-run。
  'archive/important.js',
  'archive/run.js',
];

/**
 * 纯链路模块清单。
 *
 * ⚠️ 2026-10-06：原来这份清单散落在 `plan.test.js` 与
 *    `falsification.test.js` 两处、硬编码着同一组 6 个老文件。
 *    两份硬编码清单必然漂移 —— 新增纯模块时漏改一处，
 *    那个模块就悄悄处于「没人验」的状态。
 *    现在收敛到这一处，两个测试文件都从这里取。
 */
export const PURE_CHAIN_MODULES = Object.freeze([
  'plan.js',
  'dedupe.js',
  'normalize.js',
  'classify/rules.js',
  'classify/dict.js',
  'classify/taxonomy.js',
  // ── link-scan / 语义去重的纯函数层（2026-10-06）──
  'scan/verdict.js',
  'scan/dead-threshold.js',
  'scan/extract-meta.js',
  'scan/soft404.js',
  'scan/classify-site.js',
  'dedupe/semantic.js',
  'ai/errors.js',
  'ai/context.js',
  'ai/provider-registry.js',
]);

/**
 * 扫描前先去掉注释。
 *
 * ⚠️ 不去注释会误报：本项目在 JSDoc 里会写类型位置的花括号导入
 *    （`@param {import('../classify/taxonomy.js').isKnownPath} x`），
 *    那不是真导入，被当成真导入就会让闸门「因为错误的原因而红」。
 *    行注释的 `//` 用前置字符排除 `:` `/` `'` `"`，否则会把
 *    `'https://…'` 里的 `//` 当成注释起点，把后面整行（含真导入）吃掉。
 *
 * ⚠️ 另一类误报：写给后来人看的「这里以前踩过什么坑」的注释里，
 *    经常**故意引用出错的旧代码**（比如 `.catch(() => ({}))`）。
 *    不去注释的话，那些说明性文字会被当成活代码，
 *    闸门就会对着注释里写着的旧 bug 报红 —— 而实现其实是对的。
 *    本函数已导出给其他闸门复用，别再各写一份。
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:/'"])\/\/[^\n]*/g, '$1');
}

/**
 * 导入子句里出现这些关键字，说明匹配已经跨过了 statement 边界，这条是假的。
 * 典型触发场景是 ASI 代码：副作用导入后面紧跟一条带 from 的语句，
 * `[^;]*?` 会从 `import` 一路吃到那条语句的 from。
 */
const CLAUSE_STOPWORDS =
  /\b(?:const|let|var|function|class|return|await|new|if|for|while|switch|try|catch|throw|delete|typeof|void|yield)\b/;

/**
 * 静态 import / re-export 中带 `from` 子句的写法：
 *   import d from 'x' / import * as ns from 'x' / import { a, b } from 'x'
 *   import d, { a } from 'x' / export * from 'x' / export * as ns from 'x'
 *   export { a, b } from 'x'
 *
 * ⚠️ 导入子句**允许换行**（`import {\n  a,\n} from './apply.js'` 是完全合法的），
 *    所以字符类是 `[^;]*?` 而不是 `[^;\n]*?`。
 *    早先用了 `[^;\n]*?`，禁掉换行等于给闸门留了一整类绕过 ——
 *    而这份扫描器是 dry-run 零写入的**唯一**依据，漏一种写法就整条失效。
 *    `;` 继续挡着，配合 CLAUSE_STOPWORDS 双保险，避免把相邻语句连起来误判。
 */
const FROM_RE = /\b(?:import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g;

/**
 * 副作用导入：无 from 子句。
 * 漏掉它，`import './apply.js'` 能整条绕过零写入闸门。
 */
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;

/**
 * 动态导入 `import('./apply.js')`。
 * 同样是写操作入口，静态扫描不能放过 —— 它的作用域和时机由运行时决定，
 * 闸门没法证明它是安全的，所以按违规处理。
 */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 提取源码里所有静态 import 的模块说明符 */
export function extractImports(sourceText) {
  const src = stripComments(sourceText);
  const from = [];
  for (const m of src.matchAll(FROM_RE)) {
    if (CLAUSE_STOPWORDS.test(m[1])) continue;
    from.push(m[2]);
  }
  const bare = [...src.matchAll(BARE_IMPORT_RE)].map((m) => m[1]);
  const dynamic = [...src.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1]);
  return [...new Set([...from, ...bare, ...dynamic])];
}

/**
 * 找出「纯链路模块」里对写操作模块的引用。
 * @param {Array<{rel:string, text:string}>} sources rel 形如 'plan.js' / 'classify/rules.js'，相对于 src/
 * @param {string[]} [forbidden] 相对 src/ 的精确路径
 * @returns {string[]} 形如 'plan.js → apply.js'
 */
export function findForbiddenImports(sources, forbidden = FORBIDDEN_IN_PURE_CHAIN) {
  const bad = new Set(forbidden.map((p) => p.replace(/^\.\//, '')));
  const violations = [];
  for (const { rel, text } of sources) {
    const dir = posix.dirname(String(rel || '').replace(/\\/g, '/'));
    for (const spec of extractImports(text)) {
      // 按 ESM 规则把 specifier 解析成相对 src/ 的路径再比。
      // 只处理相对路径：裸模块名（'node:fs' 之类）不可能命中 src/ 里的文件。
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const resolved = posix.normalize(posix.join(dir, spec)).replace(/^\.\//, '');
      // ⚠️ 报出的是**开发者写的 specifier**而不是解析后的路径：
      //    既有 5 处测试钉死了这个格式，而「红灯长什么样」不因为这次修复而变。
      //    解析结果只用于比对。
      if (bad.has(resolved)) violations.push(`${rel} → ${spec}`);
    }
  }
  return violations;
}

/**
 * ═══ 纯模块不得直接触碰的能力 ═══
 *
 * 2026-10-06 扩大的原因：`usesChromeApi` 原来只认 `chrome.bookmarks` 与 `chrome.storage`，
 * 于是 `chrome.alarms` / `chrome.permissions` / `fetch` / `indexedDB` **全部漏网**。
 * 而这恰恰是 link-scan 功能要用的全部能力 ——
 * 也就是说，闸门对新区块的覆盖是零。一道看不见的网不如没有网。
 *
 * 每一条都配了**为什么**。后来人删任何一条之前，先读那行理由。
 */
const FORBIDDEN_RUNTIME = [
  // chrome API：全部能改变扩展的外部状态
  { name: 'chrome.bookmarks', re: /chrome\.\s*bookmarks\b/ },
  { name: 'chrome.storage', re: /chrome\.\s*storage\b/ },
  { name: 'chrome.alarms', re: /chrome\.\s*alarms\b/ },
  { name: 'chrome.permissions', re: /chrome\.\s*permissions\b/ },
  { name: 'chrome.tabs', re: /chrome\.\s*tabs\b/ },
  { name: 'chrome.runtime', re: /chrome\.\s*runtime\b/ },
  { name: 'chrome.debugger', re: /chrome\.\s*debugger\b/ },
  // 网络：纯函数必须是确定性的、可在 Node 下直接测的
  { name: 'fetch()', re: /(?<![.\w$])fetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /(?<![.\w$])new\s+XMLHttpRequest\b/ },
  { name: 'WebSocket', re: /(?<![.\w$])new\s+WebSocket\b/ },
  { name: 'sendBeacon', re: /sendBeacon\s*\(/ },
  { name: 'importScripts', re: /(?<![.\w$])importScripts\s*\(/ },
  // 存储：IndexedDB 同样是有状态的、异步的、Node 下不存在的
  { name: 'indexedDB', re: /(?<![.\w$])indexedDB\b/ },
];

/**
 * 去掉字符串字面量。
 *
 * ⚠️ 为什么需要：只去注释不够。
 *    本项目的文案里到处**提到**这些 API ——「chrome.alarms 在设置页」
 *    这类提示语是字符串，不是调用。2026-10-06 扩禁用能力清单时，
 *    自测当场抓到了这条误报。
 *    误报是闸门失去可信度的最快方式：它会因为错误的原因而红，
 *    而大家只会学会忽略它，于是真违规也一起被忽略。
 *
 *    代价：字面量里**动态拼出来的**违规代码（`eval('chrome.' + 'alarms')`）看不见。
 *    那种写法本项目没出现，且刻意这么写的人本来就不打算被抓到。
 *
 *    ⚠️ 只在「能力闸门」里用。**不要**用在 import 扫描上 ——
 *    import 的模块说明符本身就是字符串字面量，剥掉就什么都扫不到了。
 *
 * @param {string} text 必须已经去过注释
 * @returns {string}
 */
export function stripStrings(text) {
  return String(text).replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
}

/**
 * 源码里是否直接调用了纯模块不得触碰的能力。
 * ⚠️ 扫描前**必须**去注释**并去字符串**：本项目在 JSDoc 里写类型位置的导入，
 *    面板文案里也会提到这些 API 名（见 stripStrings 的注释）。
 * @param {string} sourceText
 * @returns {boolean}
 */
export function usesChromeApi(sourceText) {
  const src = stripStrings(stripComments(sourceText));
  return FORBIDDEN_RUNTIME.some((p) => p.re.test(src));
}

/**
 * 逐条报出命中了哪些能力（诊断用）。
 * 只回名字，不回位置 —— 位置噪声大，而「命中了什么」才是排查时真正要看的。
 * @param {string} sourceText
 * @returns {string[]}
 */
export function findForbiddenRuntime(sourceText) {
  const src = stripStrings(stripComments(sourceText));
  return FORBIDDEN_RUNTIME.filter((p) => p.re.test(src)).map((p) => p.name);
}

/** 能力清单本身，导出供文档与证伪用例引用 */
export const FORBIDDEN_RUNTIME_NAMES = FORBIDDEN_RUNTIME.map((p) => p.name);

/**
 * 去掉 HTML 注释。JS 那份 stripComments 不认 `<!-- -->`。
 */
export function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * ═══ 「归入位置」不许存根 id ═══
 *
 * 事故（2026-10-05）：`targetRoot` 被当成常量写死成 `'1'`，写在三个文件里
 * （storage.js 默认值、options.html 的 `<option value="1">`、apply.js 的兜底）。
 * 而**根 id 根本不是常量** —— Chrome 154 的账号书签模型实测是
 * 书签栏=279 / 其他书签=280 / 移动设备=281。于是那一次 45 条书签全军覆没，
 * 17 个分类文件夹一个都没建成。
 *
 * 规则本身：设置里只存**语义键**（bar / other），真实 id 每次由
 * src/roots.js 从活着的书签树按位置解析。旧值 '1'/'2' 只有 roots.js
 * 的 pickRootKey 认，其余任何地方出现数字就是 bug。
 *
 * ⚠️ 为什么只判「数字字面量」而不做更宽的白名单：
 *    判据要窄而准。写成 `targetRoot: SOME_CONST` 时值不是字面量，
 *    而那条路径一定会过 pickRootKey；把非字面量也拦下只会制造误报，
 *    而误报是闸门失去可信度的最快方式。
 *
 * ⚠️ HTML 必须一起扫：事故里三处有一处是 `<option value="1">`，
 *    纯 JS 的闸门天然看不见它。
 */

/** `targetRoot` 被赋成数字（带引号或不带） */
const TARGET_ROOT_NUMERIC_JS = /\btargetRoot\s*:\s*(['"`]?)(\d+)\1/g;

/** `<select id="targetRoot"> … </select>` 整块 */
const TARGET_ROOT_SELECT = /<select[^>]*\bid\s*=\s*["']targetRoot["'][^>]*>([\s\S]*?)<\/select>/gi;

/** 块内每个 `<option value="…">` */
const OPTION_VALUE = /<option[^>]*\bvalue\s*=\s*["']([^"']*)["']/gi;

/**
 * 找出所有把「归入位置」写成根 id 的地方。
 *
 * @param {Array<{rel:string, text:string}>} sources
 * @returns {string[]} 形如 `src/storage.js → targetRoot: '1'`
 */
export function findNonSemanticTargetRoot(sources) {
  const bad = [];
  for (const { rel, text } of sources || []) {
    if (/\.html$/i.test(rel)) {
      const html = stripHtmlComments(text);
      for (const sel of html.matchAll(TARGET_ROOT_SELECT)) {
        for (const opt of sel[1].matchAll(OPTION_VALUE)) {
          if (/^\d+$/.test(opt[1].trim())) {
            bad.push(`${rel} → <select id="targetRoot"> 里有 <option value="${opt[1]}">`);
          }
        }
      }
      continue;
    }
    const src = stripComments(text);
    for (const m of src.matchAll(TARGET_ROOT_NUMERIC_JS)) {
      bad.push(`${rel} → targetRoot: '${m[2]}'`);
    }
  }
  return bad;
}

export function readSource(absPath) {
  return readFileSync(absPath, 'utf8');
}

// ───────────── 根 id 字面量扫描（backup.js 那次事故的回归闸门）─────────────

/** `ROOT_ID` 这个标识符。早先 backup.js 定义过它，现在整个仓库不许再有 */
const ROOT_ID_IDENT = /\bROOT_ID\b/g;

/** 把 parentId 指到数字字面量上：`{ parentId: '2' }` / `parentId: 2` */
const PARENT_ID_NUMERIC = /\bparentId\s*[:=]\s*(['"`])(\d)\1/g;

/** 路径退化成一个数字数组：`|| ['2']` —— 经典的「根 id 当根名用」 */
const PATH_FALLBACK_NUMERIC = /\|\|\s*\[\s*(['"`])[123]\1\s*\]/g;

/**
 * 找出所有把根 id 当成常量写死的地方。
 *
 * ═══ 为什么这道闸门独立于 findNonSemanticTargetRoot ═══
 * 后者只盯 `targetRoot` 这一个设置项，而 backup.js 那次根本不是从设置来的：
 * 它自己定义了 `ROOT_ID = { BAR:'1', OTHER:'2', MOBILE:'3' }`，
 * 注释还言之凿凿说「根 id 是固定契约，只有标题随语言变」。
 * 于是 findNonSemanticTargetRoot 全绿，2026-10-05 的 45 条照样全军覆没 ——
 * 这道闸门当时量的是一个**没有覆盖到出问题的那条路径**的指标。
 *
 * 判定口径刻意很窄，只抓三种「拿数字当根 id」的具体写法：
 *   ① `ROOT_ID` 这个标识符
 *   ② `parentId: '1'|'2'|'3'`
 *   ③ `|| ['1']` / `|| ['2']` 这种把路径退化成根 id 数组的写法
 *
 * ⚠️ 刻意**不**抓 `v === '1'` 这种比较：roots.js 的 pickRootKey 里
 *    有一段刻意的迁移映射（旧版本存下来的 '1' 翻译成语义键），
 *    那是**读用户旧设置**，不是**写死一个根 id 给 API 用**。
 *    把两者混在一起，这道闸门第一次跑就会对正确的代码报红。
 *
 * @param {Array<{rel:string, text:string}>} sources
 * @returns {string[]} 形如 `src/backup.js:31 → parentId: '2'`
 */
export function findHardcodedRootIds(sources) {
  const bad = [];
  const add = (rel, kind, detail) => bad.push(`${rel} → ${kind} ${detail}`);

  for (const { rel, text } of sources || []) {
    const src = stripComments(String(text || ''));

    for (const m of src.matchAll(ROOT_ID_IDENT)) {
      add(rel, 'ROOT_ID 标识符', `第 ${lineOf(src, m.index)} 行`);
    }
    for (const m of src.matchAll(PARENT_ID_NUMERIC)) {
      add(rel, 'parentId 写死成根 id', `'${m[2]}'（第 ${lineOf(src, m.index)} 行）`);
    }
    for (const m of src.matchAll(PATH_FALLBACK_NUMERIC)) {
      add(rel, '路径退化成根 id 数组', `'${m[1]}'（第 ${lineOf(src, m.index)} 行）`);
    }
  }
  return bad;
}

/** 报行号用：把偏移换算成 1 起的行号 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

// ───────────────── storage 读-改-写（AGENTS.md 第 2 条） ─────────────────

/**
 * 去掉注释但**保留每一个换行**，使处理后的行号与原文一一对应。
 *
 * ⚠️ 为什么不能直接用 stripComments：它把 `/* … *\/` 整块换成**一个**空格，
 *    一个跨 10 行的块注释会让后面所有行号前移 ——
 *    于是「这一行有没有写豁免说明」这种按行查的判据全部错位，
 *    而且错位不会报错，只会让闸门**因为错误的原因而红或绿**。
 *
 * @param {string} text
 * @returns {string}
 */
function blankCommentsKeepLines(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:/'"])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

/** 键表达式归一：只认「点号链」或「一次调用」，其余（动态拼接等）一律放弃比较 */
const KEY_EXPR = /^[\w$]+(?:\.[\w$]+)*(?:\((?:[^()]|\([^()]*\))*\))?$/;

function normKey(raw) {
  const k = String(raw || '').trim().replace(/\s+/g, '');
  return KEY_EXPR.test(k) ? k : null;
}

/** 本文件里「包了一层 get 的 async 函数」：函数名 → 它读的键 */
function collectGetWrappers(text) {
  const out = new Map();
  // 近似：函数体取到第一个 `}`。只认**体里没有嵌套花括号**的取读函数
  // （本项目的 `getXxx()` 全是这个形状），所以一行写完 `=> { return … }`
  // 与多行写完都能认出来。
  // 认不出的只是漏检（不误报），所以这个近似是安全的方向 ——
  // 但漏检也是漏网，**每加一个 `getXxx()` 取读包装都要确认它能被认出来**。
  for (const m of text.matchAll(/(?:^|\n)\s*(?:export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{([^{}]*)/g)) {
    const g = m[2].match(/await\s+get\s*\(\s*([^,)]+)/);
    const key = normKey(g && g[1]);
    if (key) out.set(m[1], key);
  }
  return out;
}

/**
 * 解构赋值里「哪个变量对应哪个键」。
 *
 * ⚠️ `getMany([K.A, K.B])` 的对应关系是**按位置**的，不是按名字 ——
 *    早先的判据用「一个正则抓第一个实参」，于是 `getMany([K.A, K.B])`
 *    只记下 `[K.A` 这个非法键表达式、整条读被放弃，解构形状 100% 漏检。
 *    漏检和恒真在后果上是一回事：闸门看起来在，其实在这一整类上是空的。
 */
function collectDestructured(text) {
  const out = [];
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?get(?:Many)?\s*\(\s*([\s\S]*?)\)\s*;/g)) {
    const names = m[1]
      .split(',')
      .map((part) => part.split(':').pop().trim().replace(/^\.\.\./, ''))
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    if (!names.length) continue;
    const arg = m[2].trim();
    if (arg.startsWith('[')) {
      // 按位置配对。数量对不上就整体放弃（不猜）
      const keys = arg.slice(1, arg.lastIndexOf(']')).split(',').map(normKey);
      if (keys.length !== names.length || keys.some((k) => !k)) continue;
      names.forEach((n, i) => out.push([n, keys[i]]));
    } else {
      const key = normKey(arg);
      if (key) for (const n of names) out.push([n, key]);
    }
  }
  return out;
}

/**
 * 找出「读进一个变量、又把这个变量原样 set 回去」的读-改-写（AGENTS.md 第 2 条）。
 *
 * ═══ 判据为什么长这样 ═══
 * 违规的**签名**不是「用了 set」，而是「同一个键：先 get 进变量，改，再 set 回同一个变量」。
 * 只禁 `set` 会把整份写入（`set(K.LINK_STATE, {...})`，新建一轮状态）一起误杀，
 * 而那正是绝大多数正当写入。禁得越宽，闸门越快被学会忽略。
 *
 * 三种「读」都算，因为真实代码三种都出现过：
 *   ① `const x = await get(K.A)`               直接调 storage.js 的包装
 *   ② `const { a } = await getMany([...])`     解构
 *   ③ `const s = await getLinkState()`          **包了一层**（本项目的实际写法）
 * 漏掉 ③ 就等于放过本次三个真实违规里的两个 —— 判据必须对准真实形状。
 *
 * ═══ 逃生舱 ═══
 * 同一行（或前两行）写 `storage-rmw-ok: <理由>` 可放行，理由不能为空。
 * 「需要豁免」本身就是一次 consciously 的确认，这正是想要的摩擦。
 * 标记从**原文**读（注释剥离会把它抹掉），所以行号必须保真 → 用 blankCommentsKeepLines。
 *
 * @param {string} sourceText 原始源码（不用预先去注释）
 * @returns {string[]} 形如 `第 42 行 set(K.LINK_STATE, state) —— 变量 state 来自 await getLinkState()`
 */
export function findStorageRmw(sourceText) {
  const raw = String(sourceText);
  const text = blankCommentsKeepLines(raw);
  const rawLines = raw.split('\n');
  const lineOf = (index) => raw.slice(0, index).split('\n').length - 1;

  /** @type {Map<string, string>} 变量名 → 它是从哪个键读出来的 */
  const fromGet = new Map();

  // ① 直接 get
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?get\s*\(\s*([^,)]+)/g)) {
    const key = normKey(m[2]);
    if (key) fromGet.set(m[1], key);
  }
  // ② 解构 get / getMany（按位置配对，见 collectDestructured）
  for (const [name, key] of collectDestructured(text)) fromGet.set(name, key);
  // ③ 包了一层 get 的本地 async 函数
  for (const [fn, key] of collectGetWrappers(text)) {
    const re = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+${fn}\\s*\\(`, 'g');
    for (const m of text.matchAll(re)) fromGet.set(m[1], key);
  }

  const bad = [];
  // 写入。`(?<![\w.$])` 排除 `store.set(` / `area().set(` 这类原生调用
  for (const m of text.matchAll(/(?<![\w.$])(?:await\s+)?\bset\s*\(\s*([^,]+),\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const key = normKey(m[1]);
    const name = m[2];
    if (!key || !fromGet.has(name)) continue;
    if (fromGet.get(name) !== key) continue;

    const at = m.index ?? 0;
    const line = lineOf(at);
    const window = rawLines.slice(Math.max(0, line - 2), line + 1).join('\n');
    const excuse = window.match(/storage-rmw-ok\s*[:：]\s*(\S[^\n]*)/);
    if (excuse && excuse[1].trim()) continue;

    bad.push(`第 ${line + 1} 行 set(${m[1].trim()}, ${name}) —— ${name} 来自对这个键的 get`);
  }
  return bad;
}
