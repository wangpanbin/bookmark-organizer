/**
 * 规则匹配器。
 * ⚠️ 纯函数模块：不得 import chrome API。
 *
 * 匹配优先级（首个命中即返回），与实施计划一致：
 *   0. learned rules —— 人工反馈沉淀，优先级最高
 *   1. domain 精确匹配  → high
 *   2. domain 后缀匹配  → medium（必须按点边界匹配，`notgithub.com` 不能命中 `github.com`）
 *   3. path 关键词     → medium
 *   4. title 关键词    → low（最弱，UI 必须标黄待确认）
 *
 * 规则表是纯数据、独立文件，不写进任何提示词：确定性、可审计、可单测、零延迟零成本。
 */

import { hostOf, pathQueryOf, isExcludedUrl } from '../normalize.js';

/**
 * @typedef {Object} Rule
 * @property {string} to            目标路径，'开发与技术/前端'
 * @property {string[]} [domains]   精确域名
 * @property {string[]} [domainSuffixes] 域名后缀（按点边界匹配）
 * @property {string[]} [pathWords] pathname+search 上的子串
 * @property {string[]} [titleWords] title 上的子串
 */

/**
 * 编译规则表：把线性扫描换成 map 查表。
 * @param {Rule[]} rules
 */
export function compileRules(rules) {
  const domainMap = new Map();
  const suffixRules = [];
  const pathRules = [];
  const titleRules = [];

  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || typeof rule.to !== 'string' || rule.to === '') continue;
    for (const d of rule.domains || []) {
      const key = String(d).toLowerCase();
      if (!domainMap.has(key)) domainMap.set(key, rule);
    }
    if (Array.isArray(rule.domainSuffixes) && rule.domainSuffixes.length > 0) {
      suffixRules.push(rule);
    }
    if (Array.isArray(rule.pathWords) && rule.pathWords.length > 0) {
      pathRules.push(rule);
    }
    if (Array.isArray(rule.titleWords) && rule.titleWords.length > 0) {
      titleRules.push(rule);
    }
  }

  // 后缀长的优先：`a.b.com` 应先于 `b.com` 被试到
  suffixRules.sort(
    (a, b) => (b.domainSuffixes[0] || '').length - (a.domainSuffixes[0] || '').length,
  );
  // 关键词多的优先：更具体的规则先试
  pathRules.sort((a, b) => (b.pathWords || []).length - (a.pathWords || []).length);
  titleRules.sort((a, b) => (b.titleWords || []).length - (a.titleWords || []).length);

  return { domainMap, suffixRules, pathRules, titleRules };
}

/**
 * 单条规则对单个书签是否命中。
 * @param {Rule} rule
 * @param {{host: string, pathQuery: string, title: string}} facts
 * @returns {'domain'|'suffix'|'path'|'title'|null}
 */
function hitLevel(rule, facts) {
  for (const d of rule.domains || []) {
    if (facts.host === String(d).toLowerCase()) return 'domain';
  }
  for (const s of rule.domainSuffixes || []) {
    const needle = String(s).toLowerCase();
    // 按点边界：host === s 或 host.endsWith('.' + s)
    if (facts.host === needle || facts.host.endsWith('.' + needle)) return 'suffix';
  }
  for (const w of rule.pathWords || []) {
    if (facts.pathQuery.includes(String(w).toLowerCase())) return 'path';
  }
  for (const w of rule.titleWords || []) {
    if (facts.title.includes(String(w).toLowerCase())) return 'title';
  }
  return null;
}

const REASON_BY_LEVEL = {
  domain: 'rule:domain',
  suffix: 'rule:domain',
  path: 'rule:path',
  title: 'rule:title',
};

const CONFIDENCE_BY_LEVEL = {
  domain: 'high',
  suffix: 'medium',
  path: 'medium',
  title: 'low',
};

/**
 * 对单条书签跑规则匹配。
 *
 * @param {{url: string, title?: string}} entry
 * @param {ReturnType<typeof compileRules>} compiled  预置规则（已 compile）
 * @param {Rule[]} [learned]  人工反馈沉淀的规则（每次调用现编译，数量少，代价可忽略）
 * @returns {{to: string, reason: string, confidence: string}|null} 未命中返回 null
 */
export function matchRule(entry, compiled, learned = []) {
  if (!entry || !entry.url) return null;
  if (isExcludedUrl(entry.url)) return null;

  const facts = {
    host: hostOf(entry.url),
    pathQuery: pathQueryOf(entry.url),
    title: typeof entry.title === 'string' ? entry.title.toLowerCase() : '',
  };
  if (facts.host === '') return null;

  // 0. learned —— 人工反馈优先级最高。数量少（只来自用户改判），线性扫描代价可忽略。
  for (const rule of learned) {
    if (hitLevel(rule, facts)) {
      return { to: rule.to, reason: 'learned', confidence: 'high' };
    }
  }

  // 1. domain 精确
  const exact = compiled.domainMap.get(facts.host);
  if (exact) return { to: exact.to, reason: 'rule:domain', confidence: 'high' };

  // 2. domain 后缀（按点边界）
  for (const rule of compiled.suffixRules) {
    if (hitLevel(rule, facts) === 'suffix') {
      return { to: rule.to, reason: REASON_BY_LEVEL.suffix, confidence: CONFIDENCE_BY_LEVEL.suffix };
    }
  }

  // 3. path 关键词
  for (const rule of compiled.pathRules) {
    if (hitLevel(rule, facts) === 'path') {
      return { to: rule.to, reason: REASON_BY_LEVEL.path, confidence: CONFIDENCE_BY_LEVEL.path };
    }
  }

  // 4. title 关键词
  for (const rule of compiled.titleRules) {
    if (hitLevel(rule, facts) === 'title') {
      return { to: rule.to, reason: REASON_BY_LEVEL.title, confidence: CONFIDENCE_BY_LEVEL.title };
    }
  }

  return null;
}

/**
 * 批量匹配。逐条独立，不互相影响（分类是纯函数，方便用户批量改判后重算）。
 * @param {Array<{url: string, title?: string}>} entries
 * @param {Rule[]} rules
 * @param {Rule[]} [learned]
 * @returns {Array<{to: string, reason: string, confidence: string}|null>}
 */
export function matchAll(entries, rules, learned = []) {
  const compiled = compileRules(rules);
  return entries.map((e) => matchRule(e, compiled, learned));
}
