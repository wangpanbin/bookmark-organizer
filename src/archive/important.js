/**
 * 「重要页」标记。
 *
 * ⚠️ 这个模块碰 chrome.storage（经 storage.js），属于写操作模块，已进
 *    FORBIDDEN_IN_PURE_CHAIN —— 被纯链路 import 就等于把 storage 拖进 dry-run。
 *
 * ═══ 它是什么 ═══
 * 用户在「链接健康」明细表里点星标，标出「这一页我以后还要读」。
 * 归档时这些 URL 会带上 `important: true` 送给接收器，接收器才去渲染 PDF + 整页截图。
 * G4 拍板的是「全部存 HTML，PDF/截图只给重要页」，所以这份标记是那个分级的**唯一入口**。
 *
 * ═══ 它不是什么（这一段比上面那段重要）═══
 * **它不是锁。** `K.LOCKS` 的语义是「不要移动这条书签」（整理时不许动它），
 * 存的是**书签 id**；星标存的是 **URL**，语义是「归档时值得多花一份 PDF」。
 * 两者唯一的共同点只是「一个开关」，把它们合并的后果是：
 * 用户为了归档打一个星，结果整理时那条书签被锁死不敢动，而且界面上看不出来。
 * 所以这里刻意不复用 LOCKS，也不共用任何键位。
 *
 * 同样地：星标**不参与去重、不参与分类**，唯一作用是归档时是否渲染。
 *
 * ═══ 为什么存 URL 而不是书签 id ═══
 * 因为标记要跨越「书签被删/被移动」而存活：用户标的是一个**页面**，
 * 不是某个文件夹里的某一条。归档时手里只有 URL，没有 id。
 */

import { get, mutate, set, K } from '../storage.js';

/** 归一化：URL 前后空白、大小写以外的差异都不该让标记丢失。 */
function norm(url) {
  return String(url == null ? '' : url).trim();
}

/**
 * 读全部被标记的 URL。
 * @returns {Promise<string[]>}
 */
export async function getImportantUrls() {
  const v = await get(K.ARCHIVE_IMPORTANT, []);
  if (!Array.isArray(v)) return [];
  // 去重 + 去空：storage 里的值可能来自旧版本或被手改过，
  // 而这里的结果要拿去做 Set 成员判断，一个空串就能让 `has('')` 恒为真。
  return [...new Set(v.map(norm).filter(Boolean))];
}

/**
 * 归档要用的那个 Set。
 * @returns {Promise<Set<string>>}
 */
export async function importantUrlSet() {
  return new Set(await getImportantUrls());
}

/**
 * 某个 URL 是否被标记。
 *
 * ⚠️ 同步函数，刻意不做成 async：面板渲染几百行时逐行 await 会把表格拖垮。
 *    代价是**必须由调用方先把列表读出来传进来**。
 *
 * @param {string} url
 * @param {string[]} list getImportantUrls() 的结果
 */
export function isMarkedImportant(url, list) {
  const u = norm(url);
  if (!u) return false;
  return Array.isArray(list) && list.includes(u);
}

/**
 * 切换一条的标记。
 *
 * 走 storage 的 mutate（读-改-写在同一个串行临界区内），
 * 不做「内存累积 + hydrate」—— 理由见 storage.js 顶部。
 *
 * @param {string} url
 * @param {boolean} [force] 显式指定目标状态；不给就是切换
 * @returns {Promise<{url:string, marked:boolean, count:number, urls:string[]}>}
 */
export function toggleImportant(url, force) {
  const u = norm(url);
  if (!u) return Promise.resolve({ url: '', marked: false, count: 0, urls: [] });
  return mutate(K.ARCHIVE_IMPORTANT, (cur) => {
    const s = new Set(Array.isArray(cur) ? cur.map(norm).filter(Boolean) : []);
    const on = typeof force === 'boolean' ? force : !s.has(u);
    if (on) s.add(u);
    else s.delete(u);
    return [...s];
  }, []).then((urls) => ({ url: u, marked: urls.includes(u), count: urls.length, urls }));
}

/** 全部取消标记。 */
export function clearImportant() {
  return set(K.ARCHIVE_IMPORTANT, []).then(() => ({ count: 0, urls: [] }));
}
