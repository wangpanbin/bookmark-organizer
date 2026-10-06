/**
 * 站点类型识别：文档 / 视频 / 工具 / 论文 / 代码 / 新闻 / 网页。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，不得 fetch。
 *
 * ═══ 规则优先，猜不出来就说猜不出来 ═══
 * 与本项目一贯的「规则基线 + LLM 兜底」一致：
 * 这里只做**规则**，命中不了就返回 `confidence: 'unknown'`、kind 落到 `web`。
 *
 * 绝不在规则没命中时给一个**看起来很确定**的答案。
 * 理由：站点类型是要显示给用户看的。写「视频」但它其实是文档，
 * 用户会以为扩展在胡说 —— 而一个诚实的「网页（未识别）」没人会怪它。
 * 真想要更强的判断，走 LLM 兜底并把 confidence 标成 'llm'。
 */

/** kind 的全部取值 */
export const KIND = Object.freeze({
  DOC: 'doc',
  VIDEO: 'video',
  TOOL: 'tool',
  PAPER: 'paper',
  CODE: 'code',
  NEWS: 'news',
  WEB: 'web',
});

export const KIND_LABEL = Object.freeze({
  [KIND.DOC]: '文档',
  [KIND.VIDEO]: '视频',
  [KIND.TOOL]: '工具',
  [KIND.PAPER]: '论文',
  [KIND.CODE]: '代码',
  [KIND.NEWS]: '新闻',
  [KIND.WEB]: '网页',
});

/**
 * 按 host 精确/后缀判定。**后缀必须按点边界**，
 * 否则 `notarxiv.org` 会被 `arxiv.org` 命中 —— 与 `rules.js` 同一条纪律。
 * @type {Array<{host:string, kind:string, provider:string}>}
 */
const BY_HOST = [
  { host: 'github.com', kind: KIND.CODE, provider: 'github' },
  { host: 'gist.github.com', kind: KIND.CODE, provider: 'github' },
  { host: 'gitlab.com', kind: KIND.CODE, provider: 'gitlab' },
  { host: 'bitbucket.org', kind: KIND.CODE, provider: 'bitbucket' },
  { host: 'youtube.com', kind: KIND.VIDEO, provider: 'youtube' },
  { host: 'youtu.be', kind: KIND.VIDEO, provider: 'youtube' },
  { host: 'bilibili.com', kind: KIND.VIDEO, provider: 'bilibili' },
  { host: 'vimeo.com', kind: KIND.VIDEO, provider: 'vimeo' },
  { host: 'arxiv.org', kind: KIND.PAPER, provider: 'arxiv' },
  { host: 'doi.org', kind: KIND.PAPER, provider: 'doi' },
  { host: 'springer.com', kind: KIND.PAPER, provider: 'springer' },
  { host: 'acm.org', kind: KIND.PAPER, provider: 'acm' },
  { host: 'ieee.org', kind: KIND.PAPER, provider: 'ieee' },
  { host: 'zhihu.com', kind: KIND.NEWS, provider: 'zhihu' },
  { host: 'medium.com', kind: KIND.NEWS, provider: 'medium' },
  { host: 'news.ycombinator.com', kind: KIND.NEWS, provider: 'hackernews' },
];

/**
 * 路径特征。
 *
 * ⚠️ 这里**刻意不认领 provider**，只给 kind。
 * 理由：`/abs/` 这种路径是 arxiv 特有的，但它**只看了路径没看主机** ——
 * 任何站的 `/abs/` 都会被贴上「arxiv」标签，而那是编造出来的。
 * 真要认 provider，只能凭主机（`arxiv.org` / `doi.org` 已在 BY_HOST 里）。
 * 路径只能支撑「这看起来像什么」，不能支撑「这是谁」。
 * 同理 `/doi/` 已从本表移除：doi.org 是主机规则，不是路径规则。
 */
const BY_PATH = [
  { re: /^\/(watch|video|v|episode)\//i, kind: KIND.VIDEO },
  { re: /^\/(docs?|documentation|guide|manual|reference|api)\//i, kind: KIND.DOC },
  // ⚠️ 刻意**没有** `/blog/` `/post/` `/article/` 这类「新闻」路径规则。
  //    海量站点拿这些路径放的东西根本不是新闻（工具、文档、随便什么）。
  //    认成「新闻」就是一个看起来很确定、实际很可能错的答案。
  //    新闻靠 og:type=article 与已知站点（zhihu/medium/HN）判。
];

/** host 后缀（按点边界） */
const BY_HOST_SUFFIX = [
  { suffix: 'readthedocs.io', kind: KIND.DOC, provider: 'readthedocs' },
  { suffix: 'githubusercontent.com', kind: KIND.DOC, provider: 'github' },
  { suffix: 'developer.mozilla.org', kind: KIND.DOC, provider: 'mdn' },
  { suffix: 'docs.python.org', kind: KIND.DOC, provider: 'python' },
];

/** 整站就是工具的 */
const TOOL_HOSTS = new Set([
  'dcloud.io', 'caniuse.com', 'tinypng.com', 'excalidraw.com',
  'regex101.com', 'jsonformatter.org', 'carbon.now.sh',
]);

function normHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

/** 后缀按点边界：a.github.com 命中 github.com，但 notgithub.com 不命中 */
function hostMatchesSuffix(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * @param {string} host
 * @param {string} path pathname，不含 query
 * @param {{ogType?:string, pageTitle?:string}} [meta]
 * @returns {{kind:string, provider:string|null, confidence:'rule'|'unknown'}}
 */
export function classifySite(host, path, meta = {}) {
  const h = normHost(host);
  const p = String(path || '/');

  for (const r of BY_HOST) {
    if (h === r.host) return { kind: r.kind, provider: r.provider, confidence: 'rule' };
  }
  for (const r of BY_HOST_SUFFIX) {
    if (hostMatchesSuffix(h, r.suffix)) return { kind: r.kind, provider: r.provider, confidence: 'rule' };
  }
  if (TOOL_HOSTS.has(h)) return { kind: KIND.TOOL, provider: h, confidence: 'rule' };
  for (const r of BY_PATH) {
    if (r.re.test(p)) return { kind: r.kind, provider: null, confidence: 'rule' };
  }

  // og:type 是站点自己声明的，比我们猜的准
  const og = String(meta?.ogType || '').toLowerCase();
  if (og.startsWith('video')) return { kind: KIND.VIDEO, provider: null, confidence: 'rule' };
  if (og === 'article' || og === 'news') return { kind: KIND.NEWS, provider: null, confidence: 'rule' };
  if (og === 'book') return { kind: KIND.PAPER, provider: null, confidence: 'rule' };

  // 认不出来就说认不出来。**不猜。**
  return { kind: KIND.WEB, provider: null, confidence: 'unknown' };
}

/**
 * 汇总一处书签上出现过的 provider（面板显示「来源」用）。
 * @param {Array<{provider?:string|null}>} records
 * @returns {string[]}
 */
export function providersOf(records) {
  const s = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (r && typeof r.provider === 'string' && r.provider) s.add(r.provider);
  }
  return [...s].sort();
}
