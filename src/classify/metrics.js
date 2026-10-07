/**
 * 分类准确率度量。
 * ⚠️ 纯函数模块：不得 import chrome API，不得直接碰 storage。
 *
 * ═══ 为什么需要它 ═══
 *
 * 现有的「命中率 ≥70%」测的是「规则有没有命中」，**不是**「分得对不对」。
 * 样本集（tests/fixtures/samples.js）也是手写的，词典也是手写的，
 * 所以高命中率只说明「词典能背出自己的考卷」。
 *
 * 真正能回答「这次分得准不准」的信号只有一个：**用户回头改了多少**。
 * 这条链路上没有任何记录，于是「下一轮会更准」这个假设
 * 在代码里既不能证实也不能证伪。
 *
 * ═══ 为什么计算是纯函数、写入在调用方 ═══
 *
 * 一来这类算式最容易写成「读 storage → 算 → 写 storage」的读-改-写，
 * 那会丢更新（AGENTS.md 约束 2）。二来纯函数能被直接单测 ——
 * 而一个直接读 storage 的度量函数，测它就得起一套 chrome mock。
 */

/**
 * 🔴 **未校准** —— 样本量低于此值时**不报红**，只展示。
 *
 * 为什么需要它：改判率的分母是用户自己的书签量，而真实改判行为
 * 可能一个月才积出几条。在 5 条样本上卡 10% 的阈值，
 * 改一条就 20%，报红；改回去又绿。这种闸门会被学会忽略，
 * 而一个被忽略的闸门比没有闸门更糟。
 *
 * 参照 docs/semantic-calibration.md 的同一处理：小样本只展示不判定。
 */
export const MIN_SAMPLE = 30;

/**
 * 🔴 **未校准** —— 改判率阈值（0.1 = 10%）。
 *
 * 这个数字没有任何真实数据支撑，只是「大多数分类应该一次对」的直觉。
 * 按 docs/acceptance-thresholds.md 的惯例，未校准的阈值不接进提交闸门，
 * 只在面板上展示 —— 等真实数据跑够再决定是否卡门。
 */
export const REASSIGN_THRESHOLD = 0.10;

/**
 * 由一轮计划 + 该轮的改判条数，算出这份快照。
 *
 * ⚠️ 「改判率」的分母是 planned（真正要动的条目数），不是 total。
 *    用 total 当分母的话，一次都没要动的低置信轮次会凭空拉低比率，
 *    于是「什么都没做」反而得满分 —— 与「闸门必须能被恒真实现骗过」
 *    同一个坑。
 *
 * @param {{total?:number, planned?:number, byReason?:object, byConfidence?:object}} planStats
 * @param {number} reassigned 本轮被用户改判的条数
 * @param {number} [ts]
 * @returns {{ts:number,total:number,planned:number,byReason:object,byConfidence:object,
 *            reassigned:number, reassignRate:number, enough:boolean}}
 */
export function buildSnapshot(planStats, reassigned, ts = 0) {
  const s = planStats || {};
  const planned = Number.isFinite(s.planned) ? s.planned : 0;
  const wrong = Number.isFinite(reassigned) && reassigned > 0 ? reassigned : 0;
  const rate = planned > 0 ? wrong / planned : 0;
  return {
    ts,
    total: Number.isFinite(s.total) ? s.total : 0,
    planned,
    byReason: s.byReason && typeof s.byReason === 'object' ? { ...s.byReason } : {},
    byConfidence: s.byConfidence && typeof s.byConfidence === 'object' ? { ...s.byConfidence } : {},
    reassigned: wrong,
    reassignRate: rate,
    enough: planned >= MIN_SAMPLE,
  };
}

/**
 * 这份快照该不该报红。
 *
 * ⚠️ 返回 `{ok:true}` 而**不是** `true`，是为了把「为什么不报红」
 *    一起带出去 —— 只返回一个布尔值的话，界面上只能写
 *    「样本不足」或者什么都不写，两者都不如实。
 *
 * @param {ReturnType<typeof buildSnapshot>} snap
 * @returns {{ok:boolean, rate:number, reason:string}}
 */
export function evaluate(snap) {
  if (!snap) return { ok: true, rate: 0, reason: '没有数据' };
  if (!snap.enough) {
    return {
      ok: true,
      rate: snap.reassignRate,
      reason: `样本 ${snap.planned} 条，不足 ${MIN_SAMPLE} 条，仅供参考`,
    };
  }
  const pct = (snap.reassignRate * 100).toFixed(1);
  if (snap.reassignRate > REASSIGN_THRESHOLD) {
    return { ok: false, rate: snap.reassignRate, reason: `改判率 ${pct}% 超过 ${REASSIGN_THRESHOLD * 100}%` };
  }
  return { ok: true, rate: snap.reassignRate, reason: `改判率 ${pct}%` };
}

/**
 * 最近 n 份快照的改判率趋势（新 → 旧）。
 *
 * ⚠️ 环比比绝对值更有信息量：绝对值受「这轮整理了多少条」影响极大，
 *    而环比回答的是「我上次改完之后有没有变好」。
 *
 * @param {Array} history
 * @param {number} [n]
 * @returns {Array<{ts:number, rate:number, planned:number}>}
 */
export function trend(history, n = 5) {
  const list = Array.isArray(history) ? history : [];
  return list.slice(-n).reverse().map((s) => ({
    ts: s && s.ts ? s.ts : 0,
    rate: s && Number.isFinite(s.reassignRate) ? s.reassignRate : 0,
    planned: s && Number.isFinite(s.planned) ? s.planned : 0,
  }));
}