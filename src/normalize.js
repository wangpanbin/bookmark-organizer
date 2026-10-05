/**
 * URL 归一化与去重键。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，否则单元测试无法在 Node 下运行。
 *    plan.js / dedupe.js / rules.js 全部依赖本文件，间接依赖也不能引入 chrome。
 */

/** 排除出分类的协议：浏览器内部页、扩展页、本机文件——规则和 LLM 都判不了。 */
const EXCLUDED_SCHEMES = new Set([
  'chrome:',
  'edge:',
  'chrome-extension:',
  'moz-extension:',
  'about:',
  'file:',
  'view-source:',
  'devtools:',
  'chrome-search:',
  'data:',
  'javascript:',
]);

/**
 * 「纯顶部锚点」白名单。只有这四个 hash 会被剥掉。
 *
 * 为什么这么保守：hash 往往是 SPA 路由（`#/settings` vs `#/profile` 是两个不同页面），
 * 剥掉就会把不同页面判成重复、进而误删用户真收藏的条目。
 * 这四个值的语义都是「跳到页面顶部」，携带零信息，合并它们一定正确。
 * 其余一律保留——宁可漏判重复，也绝不误删。
 */
const PURE_TOP_ANCHORS = new Set(['', '!', '_', 'top']);

/** 明确的跟踪参数（精确名）。刻意不含 `src` / `source`：它们常常是真实业务参数。 */
const TRACKING_PARAM_EXACT = new Set([
  'from', 'spm', 'ref', 'referrer', 'share_token',
  '_t', 'timestamp', 'hmsr', 'hmpl', 'hmcu', 'hmkw', 'hmci',
  'yclid', 'gclid', 'fbclid', 'msclkid', '_hsenc', '_hsmi', 'mc_cid', 'mc_eid',
]);

/** 跟踪参数前缀。 */
const TRACKING_PARAM_PREFIX = ['utm_', 'share_', 'sc_', 'wt_', '_ga', 'pk_', 'piwik_', 'mtm_'];

/** 本机地址：后缀匹配。 */
const LOCAL_HOST_SUFFIX = ['.local', '.localhost', '.internal', '.home.arpa'];

/**
 * 解析 URL。解析失败返回 null（不抛异常——书签树里出现畸形 URL 是常态）。
 * @param {string} raw
 * @returns {URL|null}
 */
export function parseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

/**
 * 该 URL 是否应被排除出分类流程。
 * 排除项：浏览器内部协议、本机地址、无法解析的畸形 URL。
 * @param {string} raw
 * @returns {boolean}
 */
export function isExcludedUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return true;
  if (EXCLUDED_SCHEMES.has(u.protocol.toLowerCase())) return true;

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  if (LOCAL_HOST_SUFFIX.some((s) => host.endsWith(s))) return true;
  return false;
}

/** @param {string} key */
function isTrackingParam(key) {
  const k = key.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(k)) return true;
  return TRACKING_PARAM_PREFIX.some((p) => k.startsWith(p));
}

/**
 * 取主机名（小写、去 www. 前缀）。规则匹配与统计都用它。
 * @param {string} raw
 * @returns {string} 无法解析时返回空串
 */
export function hostOf(raw) {
  const u = parseUrl(raw);
  if (!u) return '';
  const host = u.hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * 取 pathname + search（不含主机、不含 hash），小写。
 * 规则里的 pathWords 在这个串上做子串匹配。
 * @param {string} raw
 * @returns {string}
 */
export function pathQueryOf(raw) {
  const u = parseUrl(raw);
  if (!u) return '';
  return `${u.pathname}${u.search}`.toLowerCase();
}

/**
 * 归一化 URL。
 *
 * 规则顺序（与实施计划一致）：
 *   1. 协议与主机小写；去 www. 前缀
 *   2. hash：仅当属于「纯顶部锚点」白名单才剥，其余（SPA 路由）一律保留
 *   3. query：仅剥跟踪参数白名单；剩余参数按名排序以保证参数顺序不同也算同一条
 *   4. pathname：去末尾斜杠（根路径除外）
 *   5. path 与 query 的值统一 re-encode，防止值里的 & / = 破坏 key
 *
 * @param {string} raw
 * @returns {string|null} 归一化结果；无法解析返回 null
 */
export function normalizeUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return null;

  const protocol = u.protocol.toLowerCase();
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  // 2. hash —— SPA 路由保留，只剥纯顶部锚点
  let hash = u.hash || '';
  if (hash !== '') {
    const anchor = hash.slice(1);
    if (PURE_TOP_ANCHORS.has(anchor.toLowerCase())) hash = '';
  }

  // 3. query —— 只剥白名单；排序保证顺序无关
  const kept = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = kept.length
    ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  // 4. pathname —— 去末尾斜杠
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  return `${protocol}//${host}${path}${search}${hash}`;
}

/**
 * 去重键。相对 normalizeUrl 多一步：http 与 https 视为同一资源。
 *
 * 这一步是激进的（个别站点确实只提供 http），但书签去重的收益远大于误判成本，
 * 且所有待删条目都会在 dry-run 清单里逐条可见，用户可逐条否决。
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function dedupeKey(raw) {
  const n = normalizeUrl(raw);
  if (!n) return null;
  if (n.startsWith('http://')) return 'https://' + n.slice('http://'.length);
  return n;
}
