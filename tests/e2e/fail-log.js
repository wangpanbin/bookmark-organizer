/**
 * 闸门：移动失败必须真的落到磁盘文件里。
 *
 * ═══ 为什么这条闸门不可省 ═══
 * Node 单测能验缓冲语义、能验「不抛」，但它**验不到**这条链路上最脆的三件事：
 *   ① Local Network Access：extension origin → 127.0.0.1 属于
 *      「公开来源访问私有网络」。少一个 `Access-Control-Allow-Private-Network` 响应头，
 *      浏览器会在 service worker 里**直接把 fetch 掐掉**，
 *      现象是「失败明明发生了、日志文件一直没生成」—— 和没接一样。
 *   ② 跨源：POST application/json 一定触发预检，OPTIONS 处理错了就发不出去。
 *   ③ MV3 service worker 回收：日志绝不能只攒在内存里。
 * 这三样只有真实浏览器能暴露。
 *
 * 判据：**读磁盘上的 jsonl 内容**，不是接口返回码。
 * 「面板报成功 / 接口回 200」都不等于落盘成功 ——
 * 本项目已经有「面板报 100% 成功、书签栏一点没变」的前科。
 *
 * 用法：node tests/e2e/fail-log.js
 */

import { launchWithExtension, openPanel, seedBookmarks, runPreview, cleanupAll } from './harness.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SINK_PORT = 8731;
const SINK_ORIGIN = `http://127.0.0.1:${SINK_PORT}`;

process.on('exit', cleanupAll);

const LOG = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  LOG.push(line);
  console.log(line);
};

const FIXTURES = [
  { title: 'GitHub 日志闸门', url: 'https://github.com/fail-log/gate' },
  { title: 'Redis 日志闸门', url: 'https://redis.io/docs/latest/' },
  { title: '知乎日志闸门', url: 'https://www.zhihu.com/q/1' },
];

/**
 * 端口被占就早失败并说清楚 —— 不然症状是「日志没生成」，会误判成代码问题。
 *
 * ⚠️ 判据是「**能不能连上**」，不是「有没有报错」：
 *    连不上（ECONNREFUSED）说明端口是空的，连得上才说明被占。
 *    写反的话每次跑都会误报「端口已占用」，闸门变成永远红的摆设。
 */
function portBusy(port) {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; s.destroy(); res(v); } };
    s.once('connect', () => done(true));    // 连得上 = 被占
    s.once('error', () => done(false));     // 连不上 = 空着
    setTimeout(() => done(false), 1500);    // 连不上也不报错 = 当成空着
  });
}

/** 起接收器并等它真的在监听（不是「进程起来了」就算数） */
async function startSink(logDir) {
  const proc = spawn('python', [join(ROOT, 'tools', 'fail_log_sink.py'), '--dir', logDir, '--port', String(SINK_PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${SINK_ORIGIN}/health`);
      if (r.ok) return { proc, stop: () => proc.kill() };
    } catch { /* 还没起来 */ }
    await new Promise((x) => setTimeout(x, 200));
  }
  proc.kill();
  throw new Error(`接收器 15 秒内没起来：\n${out}`);
}

/** 把磁盘上 jsonl 里的记录全读出来 */
function readAllRecords(logDir) {
  if (!existsSync(logDir)) return [];
  const recs = [];
  for (const f of readdirSync(logDir).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(logDir, f), 'utf8').split('\n')) {
      if (line.trim()) recs.push(JSON.parse(line));
    }
  }
  return recs;
}

/**
 * 在 service worker 上装两个替身：
 *   ① move 搬完就改回  → 逼出 assertMoved 的失败分支（与 revert-guard.js 同一手法）
 *   ② permissions.contains 一律 true → 跳过浏览器弹窗（弹窗是浏览器级的，自动化点不了）
 *
 * ⚠️ 替身必须打在 **service worker** 上。执行器跑在 SW 里，
 *    面板页和 SW 是两个独立 JS 上下文、两份独立 chrome 对象，
 *    在页面里替换对执行器毫无影响。
 */
async function patchWorker(sw) {
  return sw.evaluate(async () => {
    const real = chrome.bookmarks.move.bind(chrome.bookmarks);
    chrome.bookmarks.move = async (id, dest) => {
      const before = await chrome.bookmarks.get(id);
      const node = await real(id, dest);
      await real(id, { parentId: before[0].parentId });   // 模拟被改回
      return node;
    };
    chrome.permissions.contains = async () => true;
    self.__patched = true;
    return true;
  });
}

const readTask = (page) =>
  page.evaluate(async () => {
    const t = (await chrome.storage.local.get(['task:current', 'fail:pending']))['task:current'];
    const pending = (await chrome.storage.local.get('fail:pending'))['fail:pending'] || [];
    const items = t?.plan?.items || [];
    return {
      status: t?.status,
      total: items.length,
      done: items.filter((i) => i.status === 'done').length,
      failedItems: items.filter((i) => i.status === 'failed').length,
      failed: t?.failed || [],
      pendingCount: pending.length,
    };
  });

async function runExecute(page) {
  await page.click('#btnExecute');
  const dl = Date.now() + 90000;
  let st = '';
  while (Date.now() < dl) {
    st = await page.evaluate(() => (document.getElementById('reportStatus')?.textContent || '').trim());
    if (['已完成', '失败', '已暂停'].includes(st)) break;
    await new Promise((x) => setTimeout(x, 150));
  }
  await new Promise((x) => setTimeout(x, 1000));   // 等 pollProgress 收尾
  return st;
}

// ───────────────── 变体 A：接收器开着 ─────────────────

async function variantSinkOn() {
  say('\n═══ 变体 A：接收器开着 → 失败必须落到磁盘文件 ═══');
  const bad = [];
  const logDir = mkdtempSync(join(tmpdir(), 'bo-faillog-on-'));
  let sink = null;
  let ctxRef = null;
  try {
    sink = await startSink(logDir);
    const { ctx, extensionId, sw } = await launchWithExtension();
    ctxRef = ctx;
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, FIXTURES);

    const r = await runPreview(page, { timeout: 60000 });
    say(`  预览: 待移动=${r.move} 总数=${r.total}`);
    if (!r.move) { bad.push('预览算出 0 条待移动 —— 夹具没造出可执行的计划，闸门没在测量'); return bad; }

    await patchWorker(sw);
    const st = await runExecute(page);
    const s = await readTask(page);
    say(`  状态=${st}  done=${s.done}/${s.total}  失败条目=${s.failedItems}  缓冲=${s.pendingCount}`);

    if (s.failedItems === 0) { bad.push('替身装上了却 0 条失败 —— 失败路径压根没被触发'); return bad; }

    // 判据：磁盘文件
    const recs = readAllRecords(logDir);
    say(`  磁盘上读到 ${recs.length} 条记录`);
    if (!recs.length) {
      bad.push(`接收器明明在线（${SINK_ORIGIN}/health 有响应），磁盘上却一条记录都没有 —— `
        + '要么 fetch 被浏览器掐掉（CORS/PNA 头问题），要么失败路径没调 recordFailure');
      return bad;
    }

    const ids = new Set((s.failed || []).map((f) => String(f.id)));
    const hit = recs.filter((r2) => ids.has(String(r2.id)));
    if (!hit.length) {
      bad.push(`磁盘上有 ${recs.length} 条，但没有一条对得上失败清单里的 id `
        + `（失败 id: ${[...ids].join(',')}；日志 id: ${recs.map((x) => x.id).join(',')}）`);
    } else {
      say(`  ✓ 磁盘上找到 ${hit.length} 条对应记录`);
    }

    const one = hit[0] || recs[0];
    const missing = ['ts', 'kind', 'id', 'url', 'error', 'toPath', 'batch', 'chrome', 'ext']
      .filter((k) => !(k in one));
    if (missing.length) bad.push(`记录缺字段：${missing.join(',')}`);
    if (!/回读|没有留住|实际在/.test(one.error || '')) {
      bad.push(`error 字段不是可操作的中文原因：「${String(one.error).slice(0, 100)}」`);
    } else {
      say('  ✓ error 是可操作的中文原因');
    }
    if (one.kind !== 'move') bad.push(`kind 应为 move，实际 ${one.kind}`);

    if (s.pendingCount !== 0) {
      bad.push(`送出了却还剩 ${s.pendingCount} 条在缓冲 —— 「成功后清空」没生效`);
    } else {
      say('  ✓ 送出后缓冲已清空');
    }
  } catch (e) {
    bad.push(`sink-on: ${e && e.message ? e.message : e}`);
  } finally {
    if (sink) sink.stop();
    if (ctxRef) await ctxRef.close().catch(() => {});
    try { rmSync(logDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  return bad;
}

// ───────────────── 变体 B：接收器没开 ─────────────────

async function variantSinkOff() {
  say('\n═══ 变体 B：接收器没开 → 静默降级，失败记录留在缓冲可导出 ═══');
  const bad = [];
  let ctxRef = null;
  try {
    const { ctx, extensionId, sw } = await launchWithExtension();
    ctxRef = ctx;
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, FIXTURES);

    const r = await runPreview(page, { timeout: 60000 });
    if (!r.move) { bad.push('预览算出 0 条待移动 —— 夹具没造出可执行的计划'); return bad; }

    await patchWorker(sw);
    const st = await runExecute(page);
    const s = await readTask(page);
    say(`  状态=${st}  done=${s.done}/${s.total}  失败条目=${s.failedItems}  缓冲=${s.pendingCount}`);

    if (s.failedItems === 0) { bad.push('0 条失败 —— 失败路径没被触发'); return bad; }

    // 静默降级的核心承诺：记录一条都不能丢
    if (s.pendingCount !== s.failedItems) {
      bad.push(`接收器没开，缓冲里却有 ${s.pendingCount} 条，失败 ${s.failedItems} 条 —— `
        + '要么记录被吞了，要么重复了');
    } else {
      say(`  ✓ ${s.pendingCount} 条失败全部留在缓冲，一条没丢`);
    }

    // 面板必须给出「重新导出」这个退路
    const ui = await page.evaluate(async () => {
      const el = document.getElementById('btnExportPending');
      return { exists: !!el, disabled: el ? !!el.disabled : null };
    });
    if (!ui.exists) bad.push('面板上没有「重新导出」按钮 —— 静默降级没有退路');
    else if (ui.disabled) bad.push('有失败记录时「重新导出」按钮却是禁用的');
    else say('  ✓ 「重新导出」按钮可用');

    // 整理不能因为日志写不进去而崩
    if (st !== '已完成' && st !== '失败') bad.push(`任务没跑到终态：${st}`);
    else say(`  ✓ 整理流程照常走到终态（${st}），没被日志写入拖垮`);
  } catch (e) {
    bad.push(`sink-off: ${e && e.message ? e.message : e}`);
  } finally {
    if (ctxRef) await ctxRef.close().catch(() => {});
  }
  return bad;
}

const main = async () => {
  if (await portBusy(SINK_PORT)) {
    say(`🔴 端口 ${SINK_PORT} 已被占用。先关掉正在跑的接收器（tools\\start_fail_log_sink.bat），再跑这条闸门。`);
    process.exitCode = 1;
    return;
  }
  const all = [];
  all.push(...(await variantSinkOn()));
  all.push(...(await variantSinkOff()));

  say('\n═══════════ 汇总 ═══════════');
  if (all.length) { for (const b of all) say(`🔴 ${b}`); say(`\nRED: ${all.length} 条`); }
  else say('\nGREEN: 失败真的落到了磁盘文件；接收器没开时静默降级且一条不丢。');
  process.exitCode = all.length ? 1 : 0;
};

main().catch((e) => {
  say(`FATAL ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
