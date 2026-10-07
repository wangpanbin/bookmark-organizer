/**
 * chrome.storage.local 封装。
 *
 * ═══ 为什么不是「内存累积 + hydrate」 ═══
 * 计划里写的是「内存累积 + 单 Promise 队列串行落盘，写入前 await hydrate」。
 * 实现时改成了更强的做法：**所有读-改-写都发生在同一个串行临界区内**
 * （serialize() 里的 mutate()，先 get 再算再 set，中间不让出）。
 *
 * 原因：本项目几乎所有写都是「基于当前值的变换」（追加 learned rule、更新任务进度、
 * 维护快照索引），不是「事件累加」。对变换类写入，hydrate 方案必须同时保证
 * ①内存态与 storage 同步 ②新 worker 回灌，二者任一失效就是静默覆盖 —— 记忆分册里
 * 那个「4 个事件只落盘 2 条、且不报错」的坑就是这么来的。
 * 把 get 放进临界区后，这条风险整类消失：不存在「内存态」这个可能过期的副本。
 * hydrate 方案要防的竞态，前提就是它自己引入的。
 *
 * 仍然保留的防护：
 *   1. 单条 Promise 链串行化所有写（chrome.storage 本身不是事务）
 *   2. setVerified() 写完回读校验条数（诊断信息一律落 storage，不依赖 SW 内存 ——
 *      MV3 SW 空闲 30 秒即被回收，只读内存的接口在真实使用中恒为空）
 */

/** @type {Promise<any>} 串行链。写失败也不能让链断掉，否则后续写全部卡死。 */
let chain = Promise.resolve();

/** 传给 mutate 的 fn 返回这个值表示「算完了但不要写」 */
export const SKIP = Symbol('SKIP');

function area() {
  return chrome.storage.local;
}

/**
 * 把 fn 排进串行链。fn 内不允许 await 与本模块无关的长耗时操作，
 * 否则会把无关的写一起阻塞住。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function serialize(fn) {
  const p = chain.then(() => fn());
  chain = p.then(
    () => {},
    () => {},
  );
  return p;
}

/**
 * 读一个键。
 * @template T
 * @param {string} key
 * @param {T} [dflt]
 * @returns {Promise<T|undefined>}
 */
export async function get(key, dflt) {
  const got = await area().get(key);
  const v = got[key];
  return v === undefined ? dflt : v;
}

/**
 * 读多个键。
 * @param {string[]} keys
 * @returns {Promise<object>}
 */
export async function getMany(keys) {
  return area().get(keys);
}

/**
 * 写一个键（进入串行链）。
 * @param {string} key
 * @param {any} value
 */
export async function set(key, value) {
  return serialize(async () => {
    await area().set({ [key]: value });
    return value;
  });
}

/**
 * 多个键一次写入（单次 set 调用，减少往返并让这几个键同时可见）。
 * @param {Record<string, any>} obj
 */
export async function setMany(obj) {
  return serialize(async () => {
    await area().set(obj);
    return obj;
  });
}

/**
 * 读-改-写，全程持锁。这是本模块的主入口。
 *
 * @template T
 * @param {string} key
 * @param {(current: T) => T|Promise<T>|typeof SKIP} fn
 * @param {T} [dflt] 当前值不存在时的初值
 * @returns {Promise<T>} 写入后的值（返回 SKIP 时返回未改动的当前值）
 */
export function mutate(key, fn, dflt = undefined) {
  return serialize(async () => {
    const got = await area().get(key);
    const cur = got[key] === undefined ? dflt : got[key];
    const next = await fn(cur);
    if (next === SKIP) return cur;
    await area().set({ [key]: next });
    return next;
  });
}

/**
 * 多个键的原子式变换：在同一个临界区内一起读、一起算、一起写。
 * 任务状态（plan + 进度）用这个，避免「plan 写进去了但进度没跟上」这种半状态。
 *
 * @param {string[]} keys
 * @param {(current: Record<string, any>) => Promise<Record<string, any>>|Record<string, any>} fn
 * @param {Record<string, any>} [dflt]
 */
export function mutateMany(keys, fn, dflt = {}) {
  return serialize(async () => {
    const got = await area().get(keys);
    const cur = { ...dflt };
    for (const k of keys) if (got[k] !== undefined) cur[k] = got[k];
    const next = (await fn(cur)) || {};
    await area().set(next);
    return next;
  });
}

/**
 * 写完立刻回读校验条数。
 * 用于备份索引、任务进度这类「丢了就出事」的数据。
 * MV3 的诊断信息一律走 storage，不走内存 —— 否则 SW 被回收后统计有值但列表为空。
 *
 * @param {string} key
 * @param {any} value
 * @param {(v:any)=>number|null} [countOf] 返回期望条数；返回 null 表示不校验
 * @returns {Promise<{ok:boolean, expected:number|null, actual:number|null}>}
 */
export async function setVerified(key, value, countOf) {
  await set(key, value);
  const expected = countOf ? countOf(value) : null;
  if (expected === null) return { ok: true, expected: null, actual: null };

  const readBack = await get(key);
  const actual = countOf ? countOf(readBack) : null;
  return { ok: actual === expected, expected, actual };
}

/** 删一个键 */
export function remove(key) {
  return serialize(async () => {
    await area().remove(key);
  });
}

/** 删多个键 */
export function removeMany(keys) {
  return serialize(async () => {
    await area().remove(keys);
  });
}

// ───────────────────────── 键位常量 ─────────────────────────

export const K = {
  TAXONOMY_OVERRIDE: 'taxonomy:override',
  RULES_LEARNED: 'rules:learned',
  LOCKS: 'locks',
  SETTINGS: 'settings',
  SNAPSHOT_INDEX: 'snapshot:index',
  TASK_CURRENT: 'task:current',
  STATS: 'stats',
  MANUAL_ASSIGNMENTS: 'manual:assignments',
  DEDUPE_VETO: 'dedupe:veto',
  LAST_PLAN: 'plan:last',
  PENDING_COUNT: 'pending:count',
  TREE_VERSION: 'tree:version',
  /** 还没成功送到本机接收器的失败记录。既是重试队列，也是「重新导出」的数据源 */
  FAIL_LOG_PENDING: 'fail:pending',
  /**
   * 按 providerId 分开存的模型凭据。值形如 `{ [providerId]: {type:'api_key', key} }`。
   * ⚠️ 这里**只允许存面板手填的 key**。`src/llm-key.local.js` 注入的环境变量
   *    key 只能在内存里参与解析，任何路径写进这里都是安全事故。
   */
  AI_CREDENTIALS: 'ai:credentials',
  /**
   * link-scan（.scratch/link-scan）的键位。
   *
   * ⚠️ 每条书签一个键（`link:rec:<id>`），**不要**改成一个大 map 再整份重写：
   *    800 条 × 每条一次全量写 = O(n²)，而探测是每条都要落盘的。
   */
  get linkRec() {
    return (id) => `link:rec:${id}`;
  },
  /** 扫描循环的游标与状态机（形状抄 task:current） */
  LINK_STATE: 'link:state',
  /** 待归档正文队列，由 F3（content-archive）消费 */
  LINK_QUEUE: 'link:queue',
  /**
   * 被用户标成「重要」的 URL 列表（数组）。
   *
   * ⚠️ **存 URL，不存书签 id**，且与 `LOCKS` 刻意不合并。
   *    LOCKS 是「不要移动这条书签」，星标是「归档时多渲染一份 PDF」——
   *    合并的后果是用户为归档打个星就把书签锁死，而界面上看不出来。
   *    详见 src/archive/important.js。
   */
  ARCHIVE_IMPORTANT: 'archive:important',
  /**
   * 归档循环的游标（形状抄 LINK_STATE / TASK_CURRENT）。
   * 归档 800 条要很久，SW 必然被回收好几次，所以进度必须落盘。
   */
  ARCHIVE_STATE: 'archive:state',
  /**
   * 手动指定书签范围的清单（F4）。
   *
   * ⚠️ 语义是「**这次动这些**」，刻意不复用上面任何一套键：
   *    LOCKS 是「永不动」、DEDUPE_VETO 是「别删」、ARCHIVE_IMPORTANT 是
   *    「归档时多渲染一份」。三个语义域分别是移动 / 删除 / 归档，
   *    复用任何一个都会产生「用户以为锁了、结果只影响归档」这类静默失效
   *    —— 那正是 archive:important 曾经踩过的坑。
   *
   * ⚠️ 存书签 **id**（与 LOCKS 存 URL 相反）。
   *    id 会因书签被删后重建、恢复备份而失效，所以清单同时留一份 url
   *    和当时的 path 快照 —— 但 url **只用于失效时给人看，绝不用于认领**，
   *    同一 URL 存过多条是常事，按 URL 顶替会整理到用户没选的那条上。
   *
   * ⚠️ 这是**数据**不是设置项，所以不在 DEFAULT_SETTINGS 里。
   *    约束 9 只针对「开关」：一个没进 DEFAULT_SETTINGS 的设置项配上
   *    `x !== false` 判据会恒真、开关关不掉。清单没有开关，不适用这条。
   *
   * 形状：{ v, updatedAt, items: [{ id, url, title, path, status, addedAt, updatedAt, lastReason, lastError }] }
   * 解析与派生一律走 src/scope-list.js，不要在这里复述它的规则。
   */
  SCOPE_LIST: 'scope:list',
  get snapshot() {
    return (ts) => `snapshot:${ts}`;
  },
};

/**
 * 默认设置。
 * ⚠️ apiKey 一律留空：注入的 key 走 tools/inject_key.py 落在 src/llm-key.local.js，
 *    由 llm.js 在内存里读，**不写入 storage**。这里只存用户手填的覆盖值。
 *    LLM 默认开启 —— 规则命中率已经 90%，剩下的未分类量很小，值得兜底；
 *    没配 key 时会自动跳过，不影响其余整理。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  llmEnabled: true,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',
  /**
   * 目标顶层根。
   *
   * ⚠️ 这里存的是**语义键**（'bar' / 'other'），**不是根 id**。
   *    早先存的是 '1' / '2'，默认「根 id 恒为 1/2/3」——
   *    而根 id 根本不是常量：Chrome 154 的账号书签模型里实测是
   *    书签栏=279 / 其他书签=280 / 移动设备=281，传统 Bookmarks 文件被清空。
   *    于是 2026-10-05 用户 45 条书签全军覆没（17 个分类文件夹一个也没建成）。
   *    真实 id 由 roots.js 在每次使用时从活着的书签树解析。
   */
  targetRoot: 'bar',
  /** 快照保留份数 */
  keepSnapshots: 10,
  /** 自动去重 */
  dedupeEnabled: true,

  /**
   * ═══ link-scan（死链/改链检测 + 元数据补全）═══
   *
   * ⚠️ 默认**关闭**。D3 拍板的是「一次性可选全量权限」，
   *    不是「装上就开始联网上千个域名」。
   *    扩展在你没打开面板时静默访问你收藏的 600 个域名，
   *    用户从 Network 面板看到的就是「这扩展在偷偷联网上上」。
   *    必须用户点一次「立即检测」并授予 <all_urls> 才开始。
   */
  linkScanEnabled: false,
  /** 探测节奏：360=6小时 / 1440=每天 / 10080=每周 */
  linkScanIntervalMinutes: 360,
  /** 单条探测超时（毫秒）。太长会让一轮拖到天亮 */
  linkScanTimeoutMs: 8000,
  /**
   * 并发上限。
   * ⚠️ 6 是保守值，不要调高。再高会撞服务端连接数限制，
   *    表现是**大面积超时** → 全被判成 net_error → 报告里一大片「可疑」，全是噪声。
   */
  linkScanConcurrency: 6,
  /** 是否做软 404 检测。关掉可以省一点正文的正则开销 */
  linkScanSoft404: true,
  /**
   * ⚠️ 这项曾经**根本不存在**，而 `background.js` 写的是
   *    `s.linkScanAiFind !== false` —— undefined !== false 恒为 true，
   *    于是「AI 找新地址」无条件常开，且没有任何开关能关它。
   *    症状是那种最难被发现的一类：功能「正常」，只是没人能关掉它。
   *    教训：**读一个设置项之前先确认它被定义了。**
   */
  linkScanAiFind: false,

  /**
   * ═══ 语义去重（F2）═══
   * ⚠️ 默认**关闭**。它要把标题（以及归档出来的正文摘要）发给百炼做向量化，
   *    这是比 LLM 分类更敏感的一类外发：向量本身就是你书签的指纹。
   *    所以它必须是显式开启的，而不是「配了 key 就自动跑」。
   */
  semanticDedupeEnabled: false,
  /** 相似度阈值。越高越保守 —— 默认 0.92，宁可漏判镜像站 */
  semanticThreshold: 0.92,
  /** embedding 端点。百炼是 OpenAI 兼容接口，dart 已在可选权限里 */
  embeddingBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
});

export async function getSettings() {
  const s = await get(K.SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export function updateSettings(patch) {
  return mutate(K.SETTINGS, (cur) => ({ ...DEFAULT_SETTINGS, ...(cur || {}), ...patch }), {});
}

// ───────────────────────── 小工具 ─────────────────────────

/** 任务状态机的合法状态 */
export const TASK_STATUS = Object.freeze({
  IDLE: 'idle',
  PLANNING: 'planning',
  REVIEWING: 'reviewing',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
  FAILED: 'failed',
});

/** 读任务状态；没有则返回一个空壳，避免调用方到处判空 */
export async function getTask() {
  return (
    (await get(K.TASK_CURRENT)) || {
      status: TASK_STATUS.IDLE,
      plan: null,
      lastDoneIndex: -1,
      failed: [],
      createdFolders: [],
      removedDuplicates: [],
      folderCache: {},
      startedAt: 0,
      updatedAt: 0,
      snapshotTs: null,
    }
  );
}

// ───────────────────── 去重逐条否决 ─────────────────────

/**
 * 读「不要删」的条目 id 列表。
 *
 * ⚠️ 这里必须存 **id** 而不是 URL。
 *    重复项彼此的 URL 是同一个（否则就不算重复了），
 *    按 URL 记会把该组的**保留项也一起保住**，等于去重完全失效。
 *    id 恰好也是执行器 chrome.bookmarks.remove() 用的键，两边对齐。
 */
export async function getDedupeVeto() {
  const v = await get(K.DEDUPE_VETO, []);
  return Array.isArray(v) ? v.map(String) : [];
}

/** 某条是否被否决（不删） */
export function isDedupeVetoed(id, vetoList) {
  return (vetoList || []).includes(String(id));
}

/** 否决/取消否决一条。读-改-写走 mutate，全程持串行锁。 */
export function toggleDedupeVeto(id, on) {
  return mutate(
    K.DEDUPE_VETO,
    (cur) => {
      const s = new Set(Array.isArray(cur) ? cur.map(String) : []);
      const k = String(id);
      if (on) s.add(k);
      else s.delete(k);
      return [...s];
    },
    [],
  );
}

/** 清空所有否决 */
export function clearDedupeVeto() {
  return set(K.DEDUPE_VETO, []);
}

// ───────────────────────── 手动指定书签范围（F4）─────────────────────────
//
// 访问器放在 storage.js 而不是 scope-list.js，是为了保住后者的纯函数性：
// scope-list.js 不 import 任何写操作模块，是它能在 Node 下直接单测的前提。
// 这里只做「读出来先收敛成合法清单」和「改写走同一个串行临界区」两件事。

/**
 * 读清单。返回的一定是合法结构（见 scope-list.js 的 normalizeList）。
 *
 * ⚠️ 读接口一律**读 storage**，不缓存到内存。
 *    MV3 service worker 空闲 30 秒即被回收，任何「内存累积 + 落盘」的形态
 *    在被回收后都会读回空 —— 而清单读空的表现是「用户勾的东西全没了」，
 *    比一般的数据丢失更让人不敢用。
 */
export async function getScopeList() {
  const { normalizeList } = await import('./scope-list.js');
  return normalizeList(await get(K.SCOPE_LIST, null));
}

/**
 * 读-改-写清单，全程在**一个串行临界区**内。
 *
 * ⚠️ 必须走 mutate 而不是 get→算→set 三次独立进出：
 *    分开做会丢更新。清单是用户反复增删的东西，丢更新的后果是
 *    「刚勾上的两条凭空消失」，而且不报错。
 *
 * @param {(list: {v:number, updatedAt:number, items:Array}) => object} fn
 *        收到合法清单，返回新的清单
 */
export async function updateScopeList(fn) {
  const { normalizeList, EMPTY_LIST } = await import('./scope-list.js');
  return mutate(K.SCOPE_LIST, (cur) => {
    const next = fn(normalizeList(cur));
    return { ...normalizeList(next), v: 1, updatedAt: Date.now() };
  }, { ...EMPTY_LIST, items: [] });
}

/** 清空整份清单 */
export function clearScopeList() {
  return set(K.SCOPE_LIST, { v: 1, updatedAt: Date.now(), items: [] });
}
