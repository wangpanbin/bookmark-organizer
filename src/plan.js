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
  /** 用户显式点了「就放待归类」—— 与 UNCLASSIFIED 不同，它已被处置过 */
  UNCLASSIFIED_ACCEPTED: 'unclassified-accepted',
  EXCLUDED: 'excluded',
  LOCKED: 'locked',
  READONLY: 'readonly',
  IN_PLACE: 'already-in-place',
};

/**
 * 清单条目上「用户对未归类条目的显式处置」的唯一合法取值。
 * 刻意用字面量而不是导入 scope-list.js：本模块必须不 import 任何写操作模块，
 * 而两侧共用一个字符串常量是比多一条 import 依赖更小的耦合。
 */
export const RESOLUTION_ACCEPT_UNCLASSIFIED = 'accept-unclassified';

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
 * @param {Object<string,string>} [opts.resolution]
 *        归一化 URL → 'accept-unclassified'。用户显式说「这条就放待归类」。
 *        ⚠️ 刻意**不**复用 manualAssignments：那个是全局的、会沉淀下来影响以后的整理，
 *        而这一份是**本次清单内的一次性处置**（见 ui/options.js 不把它落进 K.MANUAL_ASSIGNMENTS）。
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
    resolution = {},
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
      // 移动设备书签进计划表（但只读、不会被执行器碰：apply.js 只挑 pending）。
      // 不 push 的后果是清单里永远查不到它的裁决，于是「标记了却没动静」。
      if (e.type === 'url') items.push(base);
      continue;
    }
    if (e.type !== 'url') continue;

    // 排除项：浏览器内部页 / 本机地址 / 畸形 URL
    if (isExcludedUrl(e.url)) {
      base.reason = REASON.EXCLUDED;
      base.status = 'skipped';
      byReason[REASON.EXCLUDED] = (byReason[REASON.EXCLUDED] || 0) + 1;
      items.push(base);
      continue;
    }

    const key = dedupeKey(e.url);

    // 人工锁定（按 URL，不按 id —— id 在文件夹删除重建后会变）
    if (key && lockKeys.has(key)) {
      base.reason = REASON.LOCKED;
      base.status = 'skipped';
      base.locked = true;
      byReason[REASON.LOCKED] = (byReason[REASON.LOCKED] || 0) + 1;
      items.push(base);
      continue;
    }

    // 分类优先级：面板手改 > learned > 预置规则 > LLM 兜底 > 未分类
    let hit = null;
    let fromFallback = false;
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
      // ⚠️ 这条标记**必须**跟着 hit 一起走：下面要靠它区分
      //    「规则判它该待在兜底桶」与「压根没人判过它，只能进兜底桶」。
      //    后者才是「还没分类」，前者是「有人明确判过，就该在那儿」。
      fromFallback = true;
    }

    // 收敛到类目树里真实存在的路径
    const toArr = coercePath(taxonomy, hit.to);
    const toStr = pathString(toArr);

    base.toPath = toArr;
    base.toStr = toStr;
    base.reason = hit.reason;
    base.confidence = hit.confidence;

    // ⚠️⚠️ 幂等：已经在目标位置 → 不产生任何变更。
    //
    //    但**兜底桶不算「已在原位」**。这是 2026-10-07 修掉的一个静默失效：
    //
    //      「其他/待归类」是**占位符**，不是分类 —— README 自己写着
    //      「第一轮跑完若有几十条落在这里……重跑即可」。
    //      早先的判据拿兜底目标参与比较，于是**正躺在待归类里的书签**
    //      在第一遍纯规则计划中就被判成 IN_PLACE 而 `continue` 剔除；
    //      又因为 selectForLlm 的候选池是从 plan.items 反推的
    //      （见本文件 selectForLlm），它**永远不会被送给 AI** ——
    //      不是 AI 拒绝了它们，是 AI 从来没见过它们。
    //      不进计划表 → 不被移动 → 无裁决 → 清单里永远停在「待整理」，
    //      而界面一个错都不报。用户视角就是「AI 把它过滤了」。
    //
    //    所以：目标落在兜底桶时，「位置相同」只是「还没分类」，必须继续往下走。
    //
    // ⚠️ 路径模型（上面那句比较成立的前提，改动前务必读）：
    //    fromPath 的第 0 段是**根文件夹名**（书签栏 / 其他书签），
    //    toPath 则**不含根**（就是 taxonomy 里的 '大类/子类'）。
    //    根归到哪是「写到哪儿」的问题，交给 apply.js 按 settings.targetRoot 决定，
    //    本模块保持纯函数、不依赖任何设置。
    //    所以比较「是否已在位」时必须把 fromPath 的根名剥掉再比，
    //    否则两边永远不等，幂等直接失效。
    const fromRel = base.fromPath.slice(1).join('/');

    if (toStr === fromRel) {
      // 已经在目标位置 —— 但「已在兜底桶」要拆成两件完全不同的事：
      //
      //  ① 规则/手改判它该在这儿 → IN_PLACE，「不需要动」。
      //  ② 压根没人判过它（fromFallback），只是它恰好躺在兜底桶里 →
      //     这是**「还没分类」**，不是「已经整理好」。
      //     仍然标 skipped（没有东西要搬，搬过去是空操作），
      //     但 reason **保持 UNCLASSIFIED**，于是：
      //       · selectForLlm 按 reason 挑候选 → 它**能被送去问 AI** ★根因修复生效点
      //       · 面板可以把它单独列成「未归类」，而不是混进「已在原位」
      //
      // 早先这里是无条件 IN_PLACE + continue，于是 ② 这类条目从 plan.items
      // 里消失 → 永远进不了 LLM 候选池 → AI 从没见过它们 → 清单里永远停在
    // 「待整理」而界面不报错。用户视角就是「AI 把它过滤了」。
    if (fromFallback) {
      base.status = 'skipped';
      base.reason = (key && resolution[key] === RESOLUTION_ACCEPT_UNCLASSIFIED)
        ? REASON.UNCLASSIFIED_ACCEPTED
        : REASON.UNCLASSIFIED;
      byReason[base.reason] = (byReason[base.reason] || 0) + 1;
    } else {
      base.status = 'skipped';
      base.reason = REASON.IN_PLACE;
      byReason[REASON.IN_PLACE] = (byReason[REASON.IN_PLACE] || 0) + 1;
    }
    items.push(base);   // 结论可见 ≠ 什么都不发生：清单侧要靠它拿裁决
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
    stats: buildStats(entries, items, byReason),
  };
}

/**
 * 计划统计。
 *
 * ⚠️⚠️ 刻意**穷举**四类终态，不留 `else` 兜底。
 *    早先这里写的是 `else out.pending += 1`，于是**任何新增状态都会被静默
 *    计入「待整理」**，而「七档之和 === total」那条求和闭包**照样成立** ——
 *    闸门全绿，失效无从发现。宁可 default 记一个 unknown，也不要吞掉它。
 *
 * @param {Array} entries 输入的全部条目
 * @param {Array} items   plan.items
 * @param {object} byReason
 */
function buildStats(entries, items, byReason) {
  const total = (entries || []).filter((e) => e && e.type === 'url').length;
  // ⚠️ 刻意**不**提供 skipped 这个总数：它等于 total - planned，
  //    而 planned 现在只数「真的要搬的」，于是 skipped 会把「已在原位」
  //    「无法处理」「未归类」三件完全不同的事糊成一个数。
  //    那三件事各自有独立计数（下面），要总数的人自己加。
  const s = {
    total,
    planned: 0,
    inPlace: 0,
    unclassified: 0,
    blocked: 0,
    unknown: 0,
    byReason,
  };

  for (const it of items || []) {
    if (it.status === 'pending') { s.planned += 1; continue; }
    switch (it.reason) {
      case REASON.IN_PLACE: s.inPlace += 1; break;
      // 「还躺在兜底桶里、没人判过它」：不是已完成，是一条待办
      case REASON.UNCLASSIFIED:
      case REASON.UNCLASSIFIED_ACCEPTED: s.unclassified += 1; break;
      case REASON.EXCLUDED:
      case REASON.LOCKED:
      case REASON.READONLY: s.blocked += 1; break;
      default: s.unknown += 1; break;    // 新终态忘了归类 —— 让它显形
    }
  }
  return s;
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
 * ⚠️⚠️ 候选池来自 `plan.items`，这个耦合是真实存在的，**改 buildPlan 时必须一起想**：
 *    plan.items 里少一条，这里就少一条送问 AI。2026-10-07 那个静默失效正是这么来的 ——
 *    buildPlan 把「正躺在 其他/待归类 里」的条目按 IN_PLACE 剔掉了，
 *    它们进不了 plan.items，于是**AI 从来没见过它们**（不是 AI 拒绝了它们）。
 *    对应的长期回归在 tests/unit/plan.test.js 的
 *    「落在兜底桶里的条目会被送去问 LLM」一条，**改那段剔除逻辑前先看它**。
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
