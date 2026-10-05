/**
 * fail-log.js 单测。
 *
 * 这个模块的价值全在「**坏掉的时候不许连累别人**」上：
 * 写日志失败最多丢一条日志，绝不能把一批书签卡死、也不能抛出去打断执行器。
 * 所以这里的重点不是「成功时怎么写」，而是**每一条降级路径都钉死**：
 *
 *   ① 没权限        → 不发请求，记录留在缓冲
 *   ② 接收器没开     → 记录留在缓冲
 *   ③ 请求挂住       → 超时放弃，记录留在缓冲
 *   ④ 缓冲上限       → 丢最旧的，不无限涨
 *   ⑤ 发送途中又来一条 → 新来的不能被「成功后清空」误删
 *
 * ⚠️ ⑤ 这条是竞态：读缓冲 → POST → 清空三步之间会有别的失败插进来。
 *    按索引盲删就会把刚来的那条一起吞掉 —— 那种丢法是静默的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/** 最小 chrome 替身：storage + permissions + runtime */
function installChromeStub() {
  const store = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const api = {
    async get(keys) {
      if (keys == null) return Object.fromEntries(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (store.has(k)) out[k] = clone(store.get(k));
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, clone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
  const permissions = {
    contains: async () => true,
    request: async () => true,
    remove: async () => true,
  };
  globalThis.chrome = {
    storage: { local: api },
    permissions,
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
  return { store, permissions, api };
}

const { store, permissions, api } = installChromeStub();
const S = await import('../../src/storage.js');
const F = await import('../../src/fail-log.js');

/** 每个用例前把缓冲和 fetch 复位 */
function reset(fetchImpl) {
  store.clear();
  permissions.contains = async () => true;
  api.get = async function (keys) {
    if (keys == null) return Object.fromEntries(store);
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k));
    return out;
  };
  globalThis.fetch = fetchImpl;
}

const okFetch = async () => ({ ok: true, json: async () => ({ ok: true, written: 1 }) });

const sample = (over = {}) => ({
  kind: 'move',
  id: 1234,
  url: 'https://example.com/a',
  title: '示例',
  error: '移动后回读：改动没有留住。',
  fromPath: ['书签栏', '收集箱'],
  toPath: ['开发与技术', '前端'],
  batch: 1759679130000,
  ...over,
});

// ───────────────────── 记录组装 ─────────────────────

test('buildRecord 字段齐全，jsonl 一行往返不丢字段', () => {
  const rec = F.buildRecord(sample(), {
    now: () => '2026-10-05T13:00:00.000Z',
    chromeVersion: '139.0.1.2',
    extVersion: '1.0.0',
  });
  for (const k of ['ts', 'kind', 'id', 'title', 'url', 'error', 'fromPath', 'toPath', 'batch', 'chrome', 'ext']) {
    assert.ok(k in rec, `少了字段 ${k}`);
  }
  assert.equal(rec.kind, 'move');
  assert.equal(rec.id, '1234', 'id 必须转字符串：Chrome 的 id 就是字符串');
  assert.deepEqual(rec.fromPath, ['书签栏', '收集箱']);
  assert.deepEqual(rec.toPath, ['开发与技术', '前端']);

  const back = JSON.parse(JSON.stringify(rec));
  assert.deepEqual(back, rec, 'jsonl 往返后字段不能变');
});

test('buildRecord 不产出 undefined（会被 JSON.stringify 整个吞掉）', () => {
  const rec = F.buildRecord({ id: 1 }, { now: () => 'T', chromeVersion: null, extVersion: null });
  const keys = Object.keys(JSON.parse(JSON.stringify(rec)));
  for (const k of ['chrome', 'ext', 'title', 'url', 'error', 'batch']) {
    assert.ok(keys.includes(k), `${k} 应该在 json 里保留（值可为 null，但不能整个消失）`);
  }
  assert.equal(rec.batch, null);
});

test('kind 只认 move / delete，其它一律当 move', () => {
  const env = { now: () => 'T', chromeVersion: null, extVersion: null };
  assert.equal(F.buildRecord({ kind: 'delete' }, env).kind, 'delete');
  assert.equal(F.buildRecord({ kind: '乱写的' }, env).kind, 'move');
});

// ───────────────────── 缓冲语义 ─────────────────────

test('缓冲上限 200：超了丢最旧的，留最新的', async () => {
  reset(okFetch);
  for (let i = 0; i < 250; i += 1) await F.appendPending({ seq: i });
  const p = await F.getPending();
  assert.equal(p.length, 200);
  assert.equal(p[0].seq, 50, '留下的应该是 50~249');
  assert.equal(p[199].seq, 249);
});

test('成功送出 → 缓冲清空', async () => {
  reset(okFetch);
  await F.appendPending(sample({ id: 'a' }));
  const r = await F.flushPending();
  assert.equal(r.sent, 1);
  assert.deepEqual(await F.getPending(), []);
});

test('没权限 → 不发请求，记录一条不少地留在缓冲', async () => {
  let called = 0;
  reset(() => { called += 1; throw new Error('不该被调用'); });
  permissions.contains = async () => false;
  await F.appendPending(sample());
  const r = await F.flushPending();
  assert.equal(called, 0, '没权限就不该发请求 —— 省掉必然失败的 fetch');
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 'no-permission');
  assert.equal((await F.getPending()).length, 1);
});

test('接收器没开（fetch 抛错）→ 记录留在缓冲，且不抛', async () => {
  reset(() => { throw new Error('ECONNREFUSED'); });
  await F.appendPending(sample());
  const r = await F.flushPending();
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 'unreachable');
  assert.equal((await F.getPending()).length, 1);
});

test('接收器返回非 2xx → 记录留在缓冲', async () => {
  reset(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  await F.appendPending(sample());
  const r = await F.flushPending();
  assert.equal(r.sent, 0);
  assert.equal((await F.getPending()).length, 1);
});

test('接收器回 {ok:false} → 也算没接住，记录留在缓冲', async () => {
  reset(async () => ({ ok: true, json: async () => ({ ok: false, error: 'write failed' }) }));
  await F.appendPending(sample());
  const r = await F.flushPending();
  assert.equal(r.sent, 0);
  assert.equal((await F.getPending()).length, 1);
});

test('请求挂住 → 到点放弃，不把调用方挂死', async () => {
  reset((_url, opts) => new Promise((_res, rej) => {
    opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
  }));
  await F.appendPending(sample());
  const t0 = Date.now();
  const r = await F.flushPending();
  const dt = Date.now() - t0;
  assert.equal(r.sent, 0);
  assert.ok(dt < F.FLUSH_TIMEOUT_MS + 1500, `应该在超时附近返回，实际 ${dt}ms`);
  assert.equal((await F.getPending()).length, 1, '挂住的那次也要留在缓冲');
});

test('⚠️ 发送途中新来的记录不能被「成功后清空」误删', async () => {
  // 竞态：flushPending 读走 A → POST 途中 B 才进来 → 按内容移除只能删掉 A
  reset(async () => {
    await F.appendPending(sample({ id: 'B-发送途中才来的' }));
    return { ok: true, json: async () => ({ ok: true, written: 1 }) };
  });
  await F.appendPending(sample({ id: 'A-先来的' }));
  await F.flushPending();
  const left = await F.getPending();
  assert.equal(left.length, 1, 'B 不该被顺手清掉 —— 那种丢法是静默的');
  assert.equal(left[0].id, 'B-发送途中才来的');
});

// ───────────────────── 入口不抛 ─────────────────────

test('recordFailure：storage 整个炸了也只返回失败，不 reject', async () => {
  reset(okFetch);
  api.get = async () => { throw new Error('storage 没了'); };
  const r = await F.recordFailure(sample());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
});

test('recordFailure：关掉开关就不缓冲也不发', async () => {
  let called = 0;
  reset(() => { called += 1; return okFetch(); });
  await S.set('settings', { failLogEnabled: false });
  const r = await F.recordFailure(sample());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(called, 0);
  assert.deepEqual(await F.getPending(), []);
});

test('recordFailure 正常路径：记录落盘', async () => {
  reset(okFetch);
  const r = await F.recordFailure(sample({ id: 'x' }));
  assert.equal(r.ok, true);
  assert.deepEqual(await F.getPending(), [], '成功送出后缓冲应为空');
});

// ───────────────────── 探活与导出 ─────────────────────

test('probeSink 三态', async () => {
  reset(async () => ({ ok: true, json: async () => ({ ok: true, dir: 'F:\\logs', lines: 7 }) }));
  assert.deepEqual(await F.probeSink(), { state: 'online', dir: 'F:\\logs', lines: 7 });

  reset(async () => ({ ok: false, status: 502, json: async () => ({}) }));
  assert.deepEqual(await F.probeSink(), { state: 'offline' });

  reset(okFetch);
  permissions.contains = async () => false;
  assert.deepEqual(await F.probeSink(), { state: 'no-permission' });
});

test('toJsonl 每行都能单独 parse', () => {
  const text = F.toJsonl([sample({ id: '1' }), sample({ id: '2' })]);
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).id, '1');
  assert.equal(JSON.parse(lines[1]).id, '2');
});
