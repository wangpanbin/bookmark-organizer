/**
 * 域名权威度分级：这条域名值不值得直接信词典的判断。
 * ⚠️ 纯数据 + 纯函数模块：不得 import chrome API。
 *
 * ═══ 为什么需要这个模块 ═══
 *
 * `rules.js` 把 domain 精确命中一律标成 `confidence: 'high'`。
 * 但「我确信这是 github.com」和「我确信它该进「代码托管」」是**两件事**：
 * 同一个域名上可能是别人的教程、issue、数据集、面试题、公司主页。
 * 那个 high 是**虚假的信心** —— 它会让低置信闸门（apply.js 的
 * needsConfirm）形同虚设，因为这些条目全部标成了 high 而直接被搬走。
 *
 * 所以要按「这个站点的性质是否唯一且稳定」把域名分成两档。
 *
 * ═══ 分档判据 ═══
 *
 * · **权威档**：站点就是为**这一件事**服务的。打开 developer.mozilla.org
 *   就是查 API 文档，不可能是博客；打开 reactjs.org 就是看框架文档。
 *   同一域名下所有页面属于同一类目 → 词典的 high 是**真的**，直接采信，
 *   不进 LLM 精判（省一次请求，也省一次外发）。
 *
 * · **多用途档**：同一域名下不同页面可能属于完全不同的类目。
 *   显式登记多用途站（github.com、notion.so、medium.com……），
 *   其余**未登记的一律按多用途处理**。
 *
 * ⚠️⚠️ 默认必须是「多用途」。这是本模块最重要的一条设计决定：
 *   反过来（默认权威、多用途需登记）的话，每新增一个域名都会因为
 *   「忘了登记」而被静默标成 high —— 而那正是本模块要消灭的东西。
 *   漏登记的代价应该是「多问一次 AI」，不是「错搬一整站」。
 *
 * 多用途档的条目 confidence 降为 medium 并进 LLM 精判队列
 * （见 plan.js 的分类优先级），带上已有的页面 description 时
 * 准确率提升最明显。
 */

/**
 * 权威域名清单：**只登记站点性质唯一且稳定的**。
 *
 * 🔴 **未校准 —— 这份清单需要人工审阅**。
 * 划宽了等于关掉本次改造的主要收益（条目全被当权威、跳过 LLM 精判）。
 * 判一条域名该不该进来，只问一句：
 *   「同一域名下的任意两个页面，会属于两个完全不同的类目吗？」
 * 会 → 不该进清单。
 *
 * 收录标准：官方文档站、API 参考、框架官网、规范与标准、厂商官方教程站。
 */
export const AUTHORITY_DOMAINS = Object.freeze([
  // ── 语言与平台官方文档 ──
  'developer.mozilla.org', 'docs.python.org', 'docs.oracle.com',
  'docs.microsoft.com', 'learn.microsoft.com', 'docs.python-requests.org',
  'nodejs.org', 'go.dev', 'golang.org', 'doc.rust-lang.org', 'php.net',
  'ruby-doc.org', 'docs.ruby-lang.org', 'developer.apple.com',
  'developer.android.com', 'developer.chrome.com',

  // ── 框架与库官网 ──
  'reactjs.org', 'vuejs.org', 'angular.io', 'svelte.dev', 'solidjs.com',
  'nextjs.org', 'nuxt.com', 'astro.build', 'vitejs.dev', 'webpack.js.org',
  'rollupjs.org', 'babeljs.io', 'tailwindcss.com', 'sass-lang.com',
  'postcss.org', 'lesscss.org', 'jquery.com', 'd3js.org', 'threejs.org',
  'spring.io', 'docs.spring.io', 'springboot.io', 'mybatis.org',
  'hibernate.org', 'laravel.com', 'symfony.com', 'rubyonrails.org',
  'django-project.com', 'fastapi.tiangolo.com', 'flask.palletsprojects.com',
  'expressjs.com', 'nestjs.com', 'gin-gonic.com', 'jhipster.tech',

  // ── 数据与基础设施 ──
  'dev.mysql.com', 'postgresql.org', 'redis.io', 'mongodb.com',
  'docs.docker.com', 'kubernetes.io', 'www.jenkins.io', 'helm.sh',
  'grafana.com', 'prometheus.io', 'nginx.org', 'apache.org',
  'elastic.co', 'kafka.apache.org', 'clickhouse.com', 'sqlite.org',
  'mariadb.com',

  // ── 语言与协议规范 ──
  'www.rfc-editor.org', 'datatracker.ietf.org', 'www.w3.org',
  'tc39.es', 'tc39.github.io', 'www.python.org', 'www.rust-lang.org',
]);

/**
 * 显式登记的多用途域名清单。
 *
 * ⚠️ 这份**不是白名单而是黑名单**（默认就是多用途），
 *    列出来只为文档与审计用 —— 让审阅者一眼看到「哪些站是明知的坑」。
 *    它**不影响判定结果**：未列出的域名同样按多用途处理。
 *
 * 判据：同一域名下不同页面属于不同类目。典型如
 *   · github.com —— 仓库 / 教程 / issue / 数据集 / 个人主页
 *   · notion.so  —— 笔记 / 项目管理 / 数据库 / 分享出去的简历
 *   · medium.com —— 技术文章 / 职业博客 / 公司营销
 */
export const MULTI_PURPOSE_DOMAINS = Object.freeze([
  'github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org',
  'notion.so', 'medium.com', 'substack.com', 'zhihu.com', 'csdn.net',
  'juejin.cn', 'cnblogs.com', 'blog.csdn.net', 'youtube.com', 'bilibili.com',
  'weibo.com', 'x.com', 'twitter.com', 'facebook.com', 'reddit.com',
  'news.ycombinator.com', 'stackoverflow.com', 'segmentfault.com',
  'gmail.com', 'outlook.com', 'mail.qq.com', 'feishu.cn', 'docs.google.com',
]);

const AUTHORITY_SET = new Set(AUTHORITY_DOMAINS);
const MULTI_SET = new Set(MULTI_PURPOSE_DOMAINS);

/**
 * 该域名是不是「权威档」。
 *
 * ⚠️ 命中 AUTHORITY 优先于 MULTI：两份清单若将来不慎重叠，
 *    以「站点性质唯一」那一档为准 —— 那是本模块真正想识别的性质。
 *
 * @param {string} host 主机名（不带协议、不带端口）
 * @returns {boolean}
 */
export function isAuthorityDomain(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (AUTHORITY_SET.has(h)) return true;
  return false;
}

/**
 * 该域名是不是「多用途档」。
 * 未登记的一律为 true —— 默认多用途，见文件头的说明。
 * @param {string} host
 * @returns {boolean}
 */
export function isMultiPurposeDomain(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;              // 拿不到域名时保守：不猜，按多用途处理
  if (MULTI_SET.has(h)) return true;
  return !AUTHORITY_SET.has(h);     // 未登记的同样是多用途（默认保守）
}

/**
 * 词典直判一条域名后，它该拿到什么置信度。
 *
 * 权威档 → high（词典的判断是真的）
 * 多用途档 → medium（需要 LLM 精判，不给它 high）
 *
 * @param {string} host
 * @returns {'high'|'medium'}
 */
export function confidenceForDomain(host) {
  return isAuthorityDomain(host) ? 'high' : 'medium';
}

/**
 * 两份清单的交叉检查。
 * 权威清单与多用途清单若重叠，就是一处自相矛盾的登记 ——
 * 而矛盾登记会让「这条到底走不走 LLM」变得不可预测。
 * tests/unit/authority.test.js 会断言两者无交集。
 *
 * @returns {string[]} 重叠的域名
 */
export function overlappingDomains() {
  return AUTHORITY_DOMAINS.filter((d) => MULTI_SET.has(d));
}
