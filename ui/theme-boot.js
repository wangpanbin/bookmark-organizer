/**
 * 主题引导：在第一次绘制**之前**定下亮/暗。
 *
 * ⚠️ 为什么必须是一个独立的同步脚本，而不是塞进 options.js：
 *    MV3 扩展页的 CSP 是 `script-src 'self'`，**行内脚本会被直接拦掉**；
 *    而 `options.js` 是 `type="module"`，模块天生 defer，要等 DOM 解析完才跑 ——
 *    那时候第一屏已经用系统偏好画完了，再切暗色就是一次白闪（FOUC）。
 *    放在 <head> 的经典脚本会阻塞解析，是唯一能在首绘前定主题的合法位置。
 *
 * 只做两件事：不读 storage API（localStorage 是同步的，且读-改-写不进
 * storage.js 那个串行临界区 —— 这里只有一次 setItem，没有竞态）。
 */
(function bootTheme() {
  var KEY = 'bo-theme';
  var root = document.documentElement;
  var saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch (e) {
    // 隐私模式下 localStorage 可能抛。静默退回系统偏好即可 ——
    // 主题不是功能，抛错只会让整个引导脚本挂掉。
    saved = null;
  }
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  // saved 为空时不写 data-theme，交给 CSS 的 prefers-color-scheme 决定。
})();