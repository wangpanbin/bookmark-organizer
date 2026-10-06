/**
 * link-scan 的权限门控。
 *
 * ⚠️ 这个模块**会**调 chrome.permissions，属于写操作模块。
 *    文件名刻意不叫 `*-permission.js` 之类会被 `FORBIDDEN_IN_PURE_CHAIN`
 *    误伤的名字 —— 不过 2026-10-06 那次修复已经把后缀匹配换成了精确路径，
 *    地雷拆了。这里保留 `permission.js` 是因为它读起来最准。
 *
 * ═══ 为什么要单独一个门 ═══
 * 没有 host 权限时，跨源 fetch 的响应默认对 JS **不透明**：
 * 状态码、重定向目标全部读不到。因此判断 404 还是 200 **必须**先有权限。
 * 这不是「要不要给」的问题，是「能不能做」的问题。
 *
 * 范式照抄 `src/classify/llm.js` 的权限三件套（has / request / revoke），
 * 不要重新发明按需权限的写法。
 */

/** 一次性拿全站权限时用的模式串 */
export const ALL_URLS = 'http://*/*';

/** 另有一条 https —— 两者都要，缺一条就会漏掉一半的站点 */
export const ALL_URLS_HTTPS = 'https://*/*';

/** 两条一起。Chrome 的 host 权限是分协议给的，给一条不覆盖另一条。 */
export const ALL_ORIGINS = Object.freeze([ALL_URLS, ALL_URLS_HTTPS]);

/**
 * 当前是否已拿到全站访问权限。
 * @returns {Promise<boolean>}
 */
export async function hasScanPermission() {
  if (!chrome.permissions) return false;
  try {
    return await chrome.permissions.contains({ origins: [...ALL_ORIGINS] });
  } catch {
    return false;
  }
}

/**
 * 申请权限。
 *
 * ⚠️ **必须由用户手势（点击）直接触发**，否则 Chrome 直接拒绝 ——
 *    没有弹窗、也没有报错，表现为「点了没反应」。
 *    调用点必须在事件处理器里，不能经过 await 之后再调。
 *
 * @returns {Promise<boolean>}
 */
export async function requestScanPermission() {
  if (!chrome.permissions) return false;
  try {
    return await chrome.permissions.request({ origins: [...ALL_ORIGINS] });
  } catch (e) {
    console.warn('[link-scan] 权限申请失败', e);
    return false;
  }
}

/**
 * 撤销权限（用户想彻底关掉这个功能时用）。
 * @returns {Promise<boolean>}
 */
export async function revokeScanPermission() {
  if (!chrome.permissions) return false;
  try {
    return await chrome.permissions.remove({ origins: [...ALL_ORIGINS] });
  } catch {
    return false;
  }
}

/**
 * 面板上那行「出网范围与去向」说明。
 *
 * ⚠️ 这段字是**许可与信任之间唯一的桥**，不要为了简洁而删减。
 *    扩展会访问你书签里的几百个域名，用户在 Network 面板里看到的就是
 *    「这扩展在偷偷联网上上下」——没有这行字，许可就变成了被墙。
 *    具体到「访问哪些」「不做什么」，含糊其辞比不写更伤。
 */
export const OUTBOUND_DISCLOSURE = [
  '启用后会做这些事：',
  '· 定时访问**你书签里的那些 URL**，读它们的 HTTP 状态码、跳转目标与页面头部信息',
  '· 死链会去 archive.org 查它有没有存档快照',
  '',
  '不会做的事：',
  '· **不向任何第三方上传你的书签数据**（没有埋点、没有统计、没有同步）',
  // ⚠️ 这两句不要改回「任何替换都要你在面板上逐条确认后亲自执行」。
  //    2026-10-06 评审发现它**承诺了一个不存在的流程**：spec §6.5 已经删掉
  //    「采纳替换」按钮，界面上唯一能给的是「复制新地址」。
  //    「逐条确认后亲自执行」读起来像面板里有个确认步骤，于是用户会去找它。
  //    界面承诺一件永远不会发生的事，比功能缺失更伤 —— 用户会据此安排自己的工作。
  '· **不写入你的书签，一个字都不改**。检测只出建议：',
  '  同站改址会把新地址摆出来（可直接点开或复制）；死链与跨站跳转可以去查存档快照和候选地址',
  '  改不改、怎么改，都由你自己动手',
  '· 页面正文只在你自己电脑上，不进云端（embedding 那一项是单独的开关，默认关）',
].join('\n');
