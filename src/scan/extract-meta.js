/**
 * HTML → 元数据（og: / 标题 / 作者 / 发布时间）。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，不得 fetch。
 *    正则处理，**不建 DOM** —— 这样 Node 下可直接单测，且不需要任何新依赖。
 *
 * ⚠️ 本项目的既定经验：「再泛化就会引入缺陷」。
 *    正则解析 HTML 天生有边界，所以这里**只取那几个几乎所有站点都规规矩矩输出的标签**，
 *    解析不出来就返回空串。宁可少取，不要猜。
 *    **刻意不做 JSON-LD** —— 它是「泛化引入缺陷」的重灾区，而本功能只需要几个字段。
 *
 * 取值优先级（每一栏都是 og → meta → 其它）：
 *   pageTitle    og:title → <title>
 *   description  og:description → meta[name=description]
 *   siteName     og:site_name
 *   ogImage      og:image（相对路径按 baseUrl 解析成绝对）
 *   author       meta[author] → article:author → meta[name=byl]
 *   publishedAt  article:published_time → meta[property='...'] → <time datetime>
 */

/** 把 HTML 实体还原成常见字符。够用即可，不追求完整。 */
export function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 取出标签属性里的 content / href 值（顺序可能是任意的） */
function attr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return '';
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/** 扫出所有 <meta …> 标签，一次遍历建索引 */
function collectMeta(html) {
  const map = new Map();
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    if (!key) continue;
    const content = attr(tag, 'content');
    // 同一 key 出现多次时保留第一个：通常第一个是页面自己声明的那个
    if (content && !map.has(key)) map.set(key, content);
  }
  return map;
}

/** 按 baseUrl 把可能相对的 URL 解析成绝对的。失败就原样返回。 */
function absolutize(url, baseUrl) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (!baseUrl) return u;
  try {
    return new URL(u, baseUrl).toString();
  } catch {
    return u;
  }
}

/**
 * @param {string} html
 * @param {string} baseUrl 用于解析相对的 og:image
 * @returns {{pageTitle:string, description:string, siteName:string, ogImage:string, author:string, publishedAt:string, ogType:string, canonical:string}}
 *   取不到的字段一律是**空串**，不会是 undefined —— 面板直接渲染，不做存在性判断
 */
export function extractMeta(html, baseUrl) {
  const src = String(html || '');
  const metas = collectMeta(src);
  const get = (...keys) => {
    for (const k of keys) {
      const v = metas.get(k.toLowerCase());
      if (v) return v;
    }
    return '';
  };

  const titleTag = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(src);
  const pageTitle = (metas.get('og:title') || (titleTag ? decodeEntities(titleTag[1]) : '')).trim();

  const timeTag = /<time\b[^>]*datetime\s*=\s*("([^"]*)"|'([^']*)')/i.exec(src);

  const canonical = (() => {
    for (const m of src.matchAll(/<link\b[^>]*>/gi)) {
      const rel = attr(m[0], 'rel').toLowerCase();
      if (rel === 'canonical') return absolutize(attr(m[0], 'href'), baseUrl);
    }
    return '';
  })();

  return {
    pageTitle,
    description: get('og:description', 'description'),
    siteName: get('og:site_name'),
    ogImage: absolutize(get('og:image', 'twitter:image'), baseUrl),
    author: get('author', 'article:author', 'byl', 'twitter:creator'),
    publishedAt: get(
      'article:published_time', 'og:published_time', 'publishdate', 'pubdate', 'datepublished',
    ) || (timeTag ? decodeEntities(timeTag[2] ?? timeTag[3] ?? '') : ''),
    ogType: get('og:type'),
    canonical,
  };
}

/**
 * favicon 地址。
 *
 * ⚠️ 优先用 Chrome 自己的 `_favicon` 接口：它读的是浏览器图标缓存，
 *    **不产生网络请求**。800 条书签分布在 600+ 个域名上，
 *    逐个抓 `/favicon.ico` 就是 600 次额外请求，而且是纯浪费 ——
 *    那些图标本来就在 Chrome 的缓存里。
 *    取不到时（接口路径在某些版本上不同）再降级到 `/favicon.ico`。
 *
 * @param {string} url 页面 URL
 * @param {string} [extId] 扩展 id；页面里传 chrome.runtime.id
 * @returns {string} 可直接放进 <img src> 的地址；拿不到返回空串
 */
export function faviconUrlFor(url, extId) {
  const u = String(url || '').trim();
  if (!u) return '';
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (extId) {
      return `chrome-extension://${extId}/_favicon/?pageUrl=${encodeURIComponent(u)}&size=32`;
    }
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return '';
  }
}
