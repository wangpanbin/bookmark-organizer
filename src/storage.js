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
  /** 目标顶层根：'1' = 书签栏，'2' = 其他书签 */
  targetRoot: '1',
  /** 快照保留份数 */
  keepSnapshots: 10,
  /** 自动去重 */
  dedupeEnabled: true,
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
