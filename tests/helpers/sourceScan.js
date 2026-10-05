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
 * 静态 import/re-export 的模块说明符。
 *
 * ⚠️ 必须覆盖三种写法，缺一种闸门就有洞：
 *   1. import ... from 'x'   —— 具名 / 默认 / namespace
 *   2. import 'x'           —— 副作用导入（无 from 子句），
 *                              若漏掉它，`import './apply.js'` 能整条绕过零写入闸门
 *   3. export ... from 'x'  —— re-export
 *
 * `[^;\n]*?` 限制不跨语句，避免把两个 statement 连起来误判。
 */
const FROM_RE = /(?:\bimport\b|\bexport\b)[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;

/** 提取源码里所有静态 import 的模块说明符 */
export function extractImports(sourceText) {
  const from = [...sourceText.matchAll(FROM_RE)].map((m) => m[1]);
  const bare = [...sourceText.matchAll(BARE_IMPORT_RE)].map((m) => m[1]);
  return [...new Set([...from, ...bare])];
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

/** 源码里是否直接调用了 chrome.bookmarks / chrome.storage */
export function usesChromeApi(sourceText) {
  return /chrome\.(bookmarks|storage)\b/.test(sourceText);
}

export function readSource(absPath) {
  return readFileSync(absPath, 'utf8');
}
