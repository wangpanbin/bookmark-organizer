/**
 * 移动失败日志：把失败记录送到本机接收器，由脚本落成 F 盘上的 jsonl 文件。
 *
 * ═══ 为什么要绕这一圈 ═══
 * Chrome 扩展**没有任意写本地文件的能力**：MV3 没有文件系统 API，
 * service worker 里连 showSaveFilePicker 都不存在（那只在有 DOM 的面板页、
 * 而且必须由用户手势触发）。所以「把日志写到 F:\logs 下面的新文件夹」这件事，
 * 只能由**本机进程**落地 —— 也就是 tools/fail_log_sink.py 那个接收器。
 *
 * 本模块负责扩展这一侧：组装记录 → 落本机缓冲 → 尽力 POST 给接收器。
 * 接收器不可用时**静默降级**：记录留在缓冲里，用户可以在面板点「重新导出」。
 *
 * ═══ 三条不可破的约束 ═══
 * 1. **本模块同属写操作模块**，绝不能被 plan.js / dedupe.js / normalize.js /
 *    classify/* 导入。tests/helpers/sourceScan.js 的 FORBIDDEN_IN_PURE_CHAIN
 *    里有本文件，删掉那一行闸门就失效了。
 *    ⚠️ 那个列表是**文件名后缀匹配**（spec.endsWith(bad)）：新模块名要是以
 *    storage.js / apply.js / llm.js 之类结尾（比如 fail-log-storage.js），
 *    会**因为名字**被当成写操作模块。本文件因此只叫 fail-log.js。
 * 2. **recordFailure() 绝不抛异常。** 日志是旁路，不能改变整理主流程的
 *    成功率与时序 —— 写日志失败最多丢一条日志，绝不能把一批书签卡死。
 * 3. **未发送成功的记录必须落 chrome.storage.local**，不许攒在内存里。
 *    MV3 service worker 空闲 30 秒即被回收，内存队列会整段丢失。
 *
 * 本模块在 service worker 与面板页里都会被用到，两边都在。
 */

import { get, mutate, K } from './storage.js';

/** 接收器端口。与 tools/fail_log_sink.py 的 --port 默认值必须一致。 */
export const SINK_PORT = 8731;
/** 接收器根地址。 */
export const SINK_ORIGIN = `http://127.0.0.1:${SINK_PORT}`;
/** 权限申请用的 pattern。 */
export const SINK_PERMISSION = `${SINK_ORIGIN}/*`;

/** flush 超时。失败路径才付这个时间成本，成功路径一次都不付。 */
export const FLUSH_TIMEOUT_MS = 1500;
/** 本机缓冲上限。日志不是数据资产，不许无限涨。 */
export const PENDING_LIMIT = 200;

// ───────────────────────── 记录组装（纯函数） ─────────────────────────

/**
 * 从 UA 里取 Chrome 版本。
 * 取不到就 null —— **绝不写 undefined**：JSON.stringify 会把 undefined 的键整个吞掉，
 * 那样日志里就会「少一个字段」而没有任何提示。
 *
 * @returns {string|null}
 */
export function detectChromeVersion() {
  try {
    const m = /Chrome\/([\d.]+)/.exec(globalThis.navigator?.userAgent || '');
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 扩展自身版本 */
export function detectExtVersion() {
  try {
    return globalThis.chrome?.runtime?.getManifest?.()?.version || null;
  } catch {
    return null;
  }
}

/** 运行环境依赖。抽出来是为了让 buildRecord 在 Node 下能纯测（不装 chrome 替身）。 */
export function runtimeEnv() {
  return {
    now: () => new Date().toISOString(),
    chromeVersion: detectChromeVersion(),
    extVersion: detectExtVersion(),
  };
}

const str = (v) => (v === null || v === undefined ? null : String(v));
const pathArr = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/**
 * 把一条失败组装成日志记录。
 *
 * ⚠️ 为什么不再回读「实际落在哪」：assertMoved() 抛出的错误文案里已经带
 *    「实际在「X」而不是「Y」」两个可读名字（见 apply.js 的 assertMoved）。
 *    为每条失败再加一次 chrome.bookmarks.get() 换不到任何新信息，只增加 API 调用。
 *
 * @param {object} input 失败信息
 * @param {object} [env] 依赖注入，见 runtimeEnv()
 * @returns {object} 一行 jsonl
 */
export function buildRecord(input, env = runtimeEnv()) {
  const i = input || {};
  return {
    ts: env.now(),
    kind: i.kind === 'delete' ? 'delete' : 'move',
    id: str(i.id),
    title: str(i.title) ?? '',
    url: str(i.url) ?? '',
    error: str(i.error) ?? '',
    fromPath: pathArr(i.fromPath),
    toPath: pathArr(i.toPath),
    // 本轮 task.startedAt。日志按天追加、跨批次混在一起，没有它就没法
    // 把一次执行的失败从整月记录里摘出来。**这是失败明细的一个字段，不是汇总行。**
    batch: i.batch === null || i.batch === undefined ? null : Number(i.batch),
    chrome: env.chromeVersion ?? null,
    ext: env.extVersion ?? null,
  };
}

// ───────────────────────── 本机缓冲 ─────────────────────────

/** 读还没送出去的记录 */
export async function getPending() {
  const v = await get(K.FAIL_LOG_PENDING, []);
  return Array.isArray(v) ? v : [];
}

/** 清空缓冲 */
export async function clearPending() {
  await mutate(K.FAIL_LOG_PENDING, () => [], []);
}

/** 追加一条到缓冲（持串行锁，超出上限丢最旧的） */
export async function appendPending(record) {
  await mutate(
    K.FAIL_LOG_PENDING,
    (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      const next = [...list, record];
      return next.length > PENDING_LIMIT ? next.slice(next.length - PENDING_LIMIT) : next;
    },
    [],
  );
}

/**
 * 只移除**本次确认写入**的那些。
 *
 * ⚠️ 不能直接 clearPending()：读缓冲 → POST → 清空这三步之间，
 *    另一条失败可能刚 append 进来，直接清空会把那条一起吞掉。
 *    按内容比对移除，新来的自然不在集合里。
 */
async function removeDelivered(sent) {
  const keys = new Set(sent.map((r) => JSON.stringify(r)));
  await mutate(
    K.FAIL_LOG_PENDING,
    (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      return list.filter((r) => !keys.has(JSON.stringify(r)));
    },
    [],
  );
}

// ───────────────────────── 权限（按需申请） ─────────────────────────

/** 是否已授权访问本机接收器 */
export async function hasSinkPermission() {
  try {
    return await chrome.permissions.contains({ origins: [SINK_PERMISSION] });
  } catch (e) {
    console.warn('[fail-log] 读权限失败', e);
    return false;
  }
}

/** 请求授权。必须由用户手势触发（弹窗）。 */
export async function requestSinkPermission() {
  try {
    return await chrome.permissions.request({ origins: [SINK_PERMISSION] });
  } catch (e) {
    console.warn('[fail-log] 申请权限失败', e);
    return false;
  }
}

/** 撤销授权 */
export async function revokeSinkPermission() {
  try {
    return await chrome.permissions.remove({ origins: [SINK_PERMISSION] });
  } catch {
    return false;
  }
}

// ───────────────────────── 网络 ─────────────────────────

/**
 * 带超时的 fetch。
 * ⚠️ 超时不是可选项：接收器没开时 TCP 连 127.0.0.1 会被立刻拒绝（快），
 *    但端口被防火墙黑洞掉时会一直挂着 —— 服务端 30 秒不响应，
 *    不设超时就会把整个整理流程挂死。
 *
 * @param {string} path
 * @param {object} [body] 传了就是 POST
 * @returns {Promise<object|null>} null 表示失败
 */
async function request(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FLUSH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SINK_ORIGIN}${path}`, body === undefined
      ? { method: 'GET', signal: ctl.signal }
      : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    if (!res.ok) return null;
    return await res.json().catch(() => ({ ok: true }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── 对外：记录与 flush ─────────────────────────

/**
 * 把缓冲里未发的全送一遍。
 *
 * 静默降级：任何一步不成功都只 console.warn，绝不抛。
 *
 * @returns {Promise<{sent:number, remaining:number, skipped?:string}>}
 */
export async function flushPending() {
  const pending = await getPending();
  if (!pending.length) return { sent: 0, remaining: 0, skipped: 'empty' };

  if (!(await hasSinkPermission())) {
    return { sent: 0, remaining: pending.length, skipped: 'no-permission' };
  }

  const res = await request('/log', { records: pending });
  if (!res || res.ok === false) {
    console.warn(
      `[fail-log] 接收器（${SINK_ORIGIN}）没接住这 ${pending.length} 条，`
      + '记录已留在本机缓冲，可在面板点「重新导出」补存。',
    );
    return { sent: 0, remaining: pending.length, skipped: 'unreachable' };
  }

  await removeDelivered(pending);
  return { sent: pending.length, remaining: (await getPending()).length };
}

/**
 * 失败点唯一入口：组装 → 落缓冲 → 尽力送出。
 *
 * ⚠️ 本函数**绝不抛、绝不 reject**。它有自己的 try/catch，
 *    调用方不需要（也不应该）再包一层 —— 包了反而会让人以为它会抛。
 *
 * @param {object} input 见 buildRecord
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function recordFailure(input) {
  try {
    const enabled = await isEnabled();
    if (!enabled) return { ok: false, reason: 'disabled' };

    const record = buildRecord(input);
    await appendPending(record);
    await flushPending();
    return { ok: true };
  } catch (e) {
    console.warn('[fail-log] 记录失败日志时出错（已忽略，不影响整理）', e);
    return { ok: false, reason: 'error' };
  }
}

/** 功能总开关（设置项 failLogEnabled，默认开） */
export async function isEnabled() {
  try {
    const s = await get(K.SETTINGS, {});
    return s?.failLogEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * 探一下接收器活没活。给面板状态 chip 用。
 * @returns {Promise<{state:'online'|'offline'|'no-permission', dir?:string, lines?:number}>}
 */
export async function probeSink() {
  if (!(await hasSinkPermission())) return { state: 'no-permission' };
  const res = await request('/health');
  if (!res || res.ok !== true) return { state: 'offline' };
  return { state: 'online', dir: res.dir || null, lines: Number(res.lines) || 0 };
}

// ───────────────────────── 导出（面板用） ─────────────────────────

/** 缓冲里的记录转成 jsonl 文本（每行一个 JSON 对象） */
export function toJsonl(records) {
  return (records || [])
    .map((r) => JSON.stringify(r))
    .filter(Boolean)
    .join('\n');
}
