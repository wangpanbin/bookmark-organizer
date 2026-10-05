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
];

/**
 * 扫描前先去掉注释。
 *
 * ⚠️ 不去注释会误报：本项目在 JSDoc 里会写类型位置的花括号导入
 *    （`@param {import('../classify/taxonomy.js').isKnownPath} x`），
 *    那不是真导入，被当成真导入就会让闸门「因为错误的原因而红」。
 *    行注释的 `//` 用前置字符排除 `:` `/` `'` `"`，否则会把
 *    `'https://…'` 里的 `//` 当成注释起点，把后面整行（含真导入）吃掉。
 */
function stripComments(text) {
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

export function readSource(absPath) {
  return readFileSync(absPath, 'utf8');
}
