/**
 * 测试辅助：源码静态扫描。
 * 抽出来是为了让 plan.test.js 和 falsification.test.js 用【同一份】扫描逻辑 ——
 * 证伪测试要证明的就是这份扫描器本身能发现违规。
 */
import { readFileSync } from 'node:fs';

/** 写操作模块：出现在计划/去重/归一化链路里就意味着 dry-run 不再零写入 */
export const FORBIDDEN_IN_PURE_CHAIN = [
  'backup.js',
  'apply.js',
  'storage.js',
  'llm.js',
  'tree.js',
  'background.js',
  'fail-log.js',
];

/**
 * ⚠️ 上面这个列表是**文件名后缀匹配**（spec.endsWith(bad)），不是全名匹配。
 *    所以新模块名只要**以**其中任何一项结尾，就会因为名字被当成写操作模块 ——
 *    典型地雷：把日志缓冲叫 fail-log-storage.js，会被 'storage.js' 命中。
 *    加新模块时先 `rg 'endsWith\(bad\)'` 想一下名字，别等闸门报红才发现。
 */

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
 * @param {Array<{rel:string, text:string}>} sources
 * @param {string[]} [forbidden]
 * @returns {string[]} 形如 'plan.js → apply.js'
 */
export function findForbiddenImports(sources, forbidden = FORBIDDEN_IN_PURE_CHAIN) {
  const violations = [];
  for (const { rel, text } of sources) {
    for (const spec of extractImports(text)) {
      for (const bad of forbidden) {
        if (spec.endsWith(bad)) violations.push(`${rel} → ${spec}`);
      }
    }
  }
  return violations;
}

/** 源码里是否直接调用 chrome.bookmarks / chrome.storage */
export function usesChromeApi(sourceText) {
  return /chrome\.(bookmarks|storage)\b/.test(stripComments(sourceText));
}

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
