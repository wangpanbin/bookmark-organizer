/**
 * 软 404：服务器返回 200，但页面内容其实是「页面不存在」。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，不得 fetch。
 *
 * ═══ 为什么「只标不判」 ═══
 * 特征串匹配一定会误伤 —— 一篇讲「HTTP 404 怎么排查」的文章正文里全是这些词。
 * 所以本模块的产物**只用来在面板上标一行提示**，
 * 绝不参与 `failStreak` 计数，也绝不触发任何自动动作。
 * 宁可多让人看一眼，也不要让启发式去动他的书签。
 */

/**
 * 特征串。
 * ⚠️ 刻意保守：宁可漏判也不要误伤。中英文各取最常见的几种。
 * @type {readonly string[]}
 */
const NOT_FOUND_HINTS = [
  '404 not found',
  'page not found',
  '404 page not found',
  '页面不存在',
  '页面找不到',
  '找不到该页面',
  '页面已删除',
  '内容已删除',
  '该内容已被移除',
  '此页面不存在',
  '该页面不存在',
  '抱歉，此页面',
  '页面不存在或已被移除',
];

/** 只看开头这么多字符 —— 判据是「页面主体是什么」，不是「全文有没有这个词」 */
const HEAD_LIMIT = 2000;

/**
 * 取 <title> 的内容。
 * ⚠️ 单独抽出来是因为 title 里的特征串可信度最高：
 *    正文里提到「404」可能是文章内容，标题里出现才是页面真的挂了。
 * @param {string} html
 * @returns {string}
 */
function titleOf(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return m ? m[1] : '';
}

/**
 * 判断一段文本是否像「页面不存在」。
 *
 * @param {string} text 一般传整个 HTML；函数内部只看 <title> 与开头一段
 * @returns {boolean} true = **疑似**，不是判定
 */
export function looksLikeNotFound(text) {
  if (typeof text !== 'string' || text === '') return false;

  const head = text.slice(0, HEAD_LIMIT).toLowerCase();
  const title = titleOf(text).toLowerCase();

  for (const hint of NOT_FOUND_HINTS) {
    if (title.includes(hint)) return true;
  }
  // 正文只在「很靠前」的位置命中才算 —— 出现在文章深处多半是在讲这个概念
  for (const hint of NOT_FOUND_HINTS) {
    const at = head.indexOf(hint);
    if (at !== -1 && at < 600) return true;
  }
  return false;
}

/** 面板上必须显示的那句提示。别改短它 —— 这是「这是启发式」的唯一证据。 */
export const SOFT404_LABEL = '疑似软 404（启发式判断，仅供参考）';
