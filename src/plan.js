/**
 * 计划生成 —— 纯计算，零写入。
 *
 * ⚠️ dry-run 的全部保证都建立在这个文件上：它**不得** import 任何
 *    写操作模块（backup.js / apply.js / storage.js / llm.js / tree.js）。
 *    tests/unit/plan.test.js 有一条静态断言在守这条线。
 *
 * 输入是已经读好的扁平书签列表 + 类目树 + learned rules + 锁 + LLM 兜底结果，
 * 输出是一份「哪条从哪搬到哪」的清单。UI 展示它、执行器消费它，两者共用同一份结构。
 */

import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';
import { compileRules, matchRule } from './classify/rules.js';
import { coercePath, fallbackPath, pathArray, pathString } from './classify/taxonomy.js';

/** reason 取值表（与计划一致） */
export const REASON = {
  LEARNED: 'learned',
  RULE_DOMAIN: 'rule:domain',
  RULE_PATH: 'rule:path',
  RULE_TITLE: 'rule:title',
  LLM: 'llm',
  MANUAL: 'manual',
  UNCLASSIFIED: 'unclassified',
  EXCLUDED: 'excluded',
  LOCKED: 'locked',
  READONLY: 'readonly',
  IN_PLACE: 'already-in-place',
};

/**
 * 构建分类计划。
 *
 * @param {object} opts
 * @param {Array<{id:string,type:string,title?:string,url?:string,path:string[],dateAdded?:number,readOnly?:boolean}>} opts.entries
 *        已扁平化的书签节点。path 从根文件夹名开始，例：['其他书签'] 或 ['书签栏','开发','前端']
 * @param {Array} opts.taxonomy              生效类目树
 * @param {Array} [opts.learnedRules]        人工反馈沉淀的规则，优先级最高
 * @param {string[]} [opts.locks]            被锁定的 URL（按原始 URL 字符串，匹配时走归一化）
 * @param {Object<string,string>} [opts.llmAssignments]  兜底结果：归一化 URL → 类目路径
 * @param {Object<string,string>} [opts.manualAssignments] 面板上手改的结果：归一化 URL → 类目路径
 * @returns {{items:Array, newFolders:string[][], stats:object}}
 */
export function buildPlan(opts) {
  const {
    entries = [],
    taxonomy = [],
    learnedRules = [],
    locks = [],
    llmAssignments = {},
    manualAssignments = {},
  } = opts || {};

  const fb = fallbackPath(taxonomy);
  const fbStr = pathString(fb);

  // 锁：外部按原始 URL 传入，这里归一化成 set，避免调用方各自实现归一化导致口径不一致
  const lockKeys = new Set();
  for (const l of locks) {
    const k = dedupeKey(l);
    if (k) lockKeys.add(k);
  }

  const items = [];
  const targetPaths = new Set();
  const byReason = {};

  for (const e of entries) {
    const base = {
      id: e.id,
      url: e.url ?? null,
      title: e.title ?? '',
      fromPath: Array.isArray(e.path) ? e.path.slice() : [],
      fromStr: pathString(e.path),
      toPath: null,
      toStr: null,
      reason: REASON.UNCLASSIFIED,
      confidence: 'low',
      locked: false,
      status: 'pending',
    };

    if (e.readOnly) {
      base.reason = REASON.READONLY;
      base.status = 'skipped';
      byReason[REASON.READONLY] = (byReason[REASON.READONLY] || 0) + 1;
      continue;
    }
    if (e.type !== 'url') continue;

    // 排除项：浏览器内部页 / 本机地址 / 畸形 URL
    if (isExcludedUrl(e.url)) {
      base.reason = REASON.EXCLUDED;
      base.status = 'skipped';
      byReason[REASON.EXCLUDED] = (byReason[REASON.EXCLUDED] || 0) + 1;
      continue;
    }

    const key = dedupeKey(e.url);

    // 人工锁定（按 URL，不按 id —— id 在文件夹删除重建后会变）
    if (key && lockKeys.has(key)) {
      base.reason = REASON.LOCKED;
      base.status = 'skipped';
      base.locked = true;
      byReason[REASON.LOCKED] = (byReason[REASON.LOCKED] || 0) + 1;
      continue;
    }

    // 分类优先级：面板手改 > learned > 预置规则 > LLM 兜底 > 未分类
    let hit = null;
    if (key && manualAssignments[key]) {
      hit = { to: manualAssignments[key], reason: REASON.MANUAL, confidence: 'high' };
    }
    if (!hit) {
      hit = matchRule({ url: e.url, title: e.title }, compileRules(RULES_CACHE.value), learnedRules);
    }
    if (!hit && key && llmAssignments[key]) {
      hit = { to: llmAssignments[key], reason: REASON.LLM, confidence: 'medium' };
    }
    if (!hit) {
      hit = { to: fbStr, reason: REASON.UNCLASSIFIED, confidence: 'low' };
    }

    // 收敛到类目树里真实存在的路径
    const toArr = coercePath(taxonomy, hit.to);
    const toStr = pathString(toArr);

    base.toPath = toArr;
    base.toStr = toStr;
    base.reason = hit.reason;
    base.confidence = hit.confidence;

    // 幂等：已经在目标位置 → 跳过，不产生任何变更
    if (toStr === base.fromStr) {
      base.status = 'skipped';
      base.reason = REASON.IN_PLACE;
      byReason[REASON.IN_PLACE] = (byReason[REASON.IN_PLACE] || 0) + 1;
      continue;
    }

    base.status = 'pending';
    targetPaths.add(toStr);
    byReason[hit.reason] = (byReason[hit.reason] || 0) + 1;
    items.push(base);
  }

  // 需新建的文件夹，按深度升序（父先子后），保证执行时 create() 顺序正确
  const newFolders = [...targetPaths]
    .map(pathArray)
    .sort((a, b) => a.length - b.length || (pathString(a) < pathString(b) ? -1 : 1));

  return {
    items,
    newFolders,
    stats: {
      total: entries.filter((e) => e && e.type === 'url').length,
      planned: items.length,
      skipped: entries.filter((e) => e && e.type === 'url').length - items.length,
      byReason,
    },
  };
}

/**
 * 规则表缓存。buildPlan 会被反复调用（用户每改一次判就重算一次），
 * 每次重新 compile 809 个域名是纯浪费。
 * 由 setRules() 显式注入 —— 保持本模块不 import dict.js，理由见文件头。
 */
export const RULES_CACHE = { value: [] };

/** @param {Array} rules */
export function setRules(rules) {
  RULES_CACHE.value = Array.isArray(rules) ? rules : [];
}

/**
 * 找出需要 LLM 兜底的条目（规则未命中、未锁定、非排除项）。
 * LLM 只对这一批发请求 —— URL 不整体外发。
 *
 * @param {ReturnType<typeof buildPlan>} plan
 * @param {Array} entries
 * @param {string[]} [locks]
 * @returns {Array<{id:string,url:string,title:string,key:string}>}
 */
export function selectForLlm(plan, entries, locks = []) {
  const lockKeys = new Set();
  for (const l of locks) {
    const k = dedupeKey(l);
    if (k) lockKeys.add(k);
  }
  // 只挑「规则未命中、且已落进兜底桶」的条目。
  // 注意不能按「不在 plan.items 里」筛 —— 兜底条目同样在 plan.items 里，
  // 否则规则全没命中的那一批永远不会被送去问 LLM。
  const unclassified = new Map(
    plan.items.filter((i) => i.reason === REASON.UNCLASSIFIED).map((i) => [i.id, true]),
  );
  const out = [];
  for (const e of entries) {
    if (!e || e.type !== 'url') continue;
    if (isExcludedUrl(e.url)) continue;
    if (e.readOnly) continue;
    if (!unclassified.has(e.id)) continue;
    const key = dedupeKey(e.url);
    if (!key || lockKeys.has(key)) continue;
    out.push({ id: e.id, url: e.url, title: e.title || '', key, pathQuery: pathQueryOf(e.url) });
  }
  return out;
}
