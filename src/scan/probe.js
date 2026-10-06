/**
 * 单条探测。
 *
 * ⚠️ 这个模块会 **fetch 出网**，属于写操作模块。
 *
 * ═══ 三个决定，别改（理由都在 spec §5.3）═══
 *
 * ① **用 GET 不用 HEAD**
 *    很多服务器对 HEAD 返回 405/501，而且元数据补全需要正文。
 *
 * ② **用 `redirect: 'follow'` 不用 `'manual'`**
 *    `manual` 会得到 `opaqueredirect` 过滤响应：状态码 0、Location 头不可见。
 *    `follow` 下 `response.redirected` 与 `response.url` 就能告诉我们
 *    「跳了、跳到哪」，**而且还能拿到落地页的最终状态码** ——
 *    「跳完之后是 200 还是 404」才是这个功能真正要回答的问题。
 *    代价是看不到 301 与 302 的区别，而那个区别对决策没有价值。
 *
 * ③ **每次探测都带超时**
 *    与 `src/ai/runtime.js` 同一条纪律：挂住的连接会把整个面板冻住。
 */

import { extractMeta } from './extract-meta.js';
import { classifySite } from './classify-site.js';
import { looksLikeNotFound } from './soft404.js';

/** 错误文案：用户看到报错时唯一能立刻做的事 */
function describeProbeError(e) {
  const name = e && e.name ? String(e.name) : '';
  const msg = e && e.message ? String(e.message) : String(e || '');
  if (name === 'TimeoutError' || /abort|timeout/i.test(msg)) return 'timeout';
  if (/certificate|SSL|TLS/i.test(msg)) return 'tls';
  if (/getaddrinfo|ENOTFOUND|dns/i.test(msg)) return 'dns';
  return `network:${msg.slice(0, 120)}`;
}

/** 两个 URL 是不是同一个站（按 hostname 比较，忽略 www 与端口） */
export function sameSiteOf(fromUrl, toUrl) {
  try {
    const a = new URL(fromUrl).hostname.toLowerCase().replace(/^www\./, '');
    const b = new URL(toUrl).hostname.toLowerCase().replace(/^www\./, '');
    return a === b;
  } catch {
    return null;
  }
}

/**
 * 探一个 URL。
 *
 * @param {string} url
 * @param {{timeoutMs?:number, wantSoft404?:boolean}} [opts]
 * @returns {Promise<{
 *   status:number, finalUrl:string, redirected:boolean, sameSite:boolean|null,
 *   error:string|null, html:string, meta:object|null, kind:string, provider:string|null,
 *   kindConfidence:string, soft404:boolean, probeMethod:string
 * }>}
 */
export async function probeOne(url, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
  // ⚠️ 默认开。早先这个开关在设置里躺着没人读 ——
  //    「有个设置项但它不生效」比「没有这个设置项」更坏，用户会以为关了。
  const wantSoft404 = opts.wantSoft404 !== false;
  const base = {
    status: 0, finalUrl: url, redirected: false, sameSite: null,
    error: null, html: '', meta: null,
    kind: 'web', provider: null, kindConfidence: 'unknown',
    soft404: false, probeMethod: 'follow',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const finalUrl = typeof res.url === 'string' && res.url ? res.url : url;
    const redirected = res.redirected === true || finalUrl !== url;

    let html = '';
    try {
      // 正文上限 512KB：再大对元数据抽取没有额外价值，只会撑爆内存
      html = (await res.text()).slice(0, 512 * 1024);
    } catch {
      // 正文读不到不影响状态码判定：正文只是用来抽 meta 与判软 404
    }

    let meta = null;
    let kind = 'web';
    let provider = null;
    let kindConfidence = 'unknown';
    if (html) {
      meta = extractMeta(html, finalUrl);
      let host = '';
      let path = '/';
      try {
        const u = new URL(finalUrl);
        host = u.hostname;
        path = u.pathname;
      } catch { /* 落地 URL 畸形就保持 unknown */ }
      const c = classifySite(host, path, meta);
      kind = c.kind;
      provider = c.provider;
      kindConfidence = c.confidence;
    }

    return {
      ...base,
      status: res.status,
      finalUrl,
      redirected,
      sameSite: redirected ? sameSiteOf(url, finalUrl) : null,
      html,
      meta,
      kind,
      provider,
      kindConfidence,
      soft404: res.ok && html && wantSoft404 ? looksLikeNotFound(html) : false,
    };
  } catch (e) {
    return { ...base, error: describeProbeError(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发受限的一批探测。
 *
 * ⚠️ 并发上限不是「越高越快」：再高会撞服务端连接数限制，
 *    表现是**大面积超时**，而超时会全被判成 net_error ——
 *    于是报告里出现一大片「可疑」，而那全是自己打自己造成的噪声。
 *
 * @param {string[]} urls
 * @param {{concurrency?:number, timeoutMs?:number, onEach?:Function, shouldStop?:Function}} [opts]
 * @returns {Promise<Array<{url:string, result:object|null, skipped?:boolean}>>}
 */
export async function probeMany(urls, opts = {}) {
  const limit = Math.max(1, Number.isFinite(opts.concurrency) ? opts.concurrency : 6);
  const list = Array.isArray(urls) ? urls : [];
  const out = new Array(list.length).fill(null);
  let next = 0;

  const worker = async () => {
    for (;;) {
      if (opts.shouldStop && opts.shouldStop()) return;
      const i = next++;
      if (i >= list.length) return;
      try {
        const result = await probeOne(list[i], opts);
        out[i] = { url: list[i], result };
        opts.onEach?.(out[i], i, list.length);
      } catch (e) {
        out[i] = { url: list[i], result: { status: 0, finalUrl: list[i], redirected: false, sameSite: null, error: `internal:${e && e.message}`, html: '', meta: null, kind: 'web', provider: null, kindConfidence: 'unknown', soft404: false, probeMethod: 'follow' } };
        opts.onEach?.(out[i], i, list.length);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}
