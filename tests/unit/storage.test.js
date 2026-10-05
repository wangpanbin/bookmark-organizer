/**
 * storage.js 单测。
 *
 * 为什么需要给 chrome 装替身：
 * storage.js 是全项目最容易**静默**损坏数据的模块（丢更新、结构写坏都��报错），
 * 之前它只能靠 E2E 间接覆盖，而 E2E 失败时定位成本极高。
 * 装一个最小替身后就能在 Node 下直接测契约。
 *
 * 本文件要钉死的两个契约：
 *   1. mutate / mutateMany 的读-改-写在同一个串行临界区内 → 并发不丢更新
 *   2. mutateMany 的回调收到的是 **{ key: value } 映射**，不是单个值
 *      （踩过：把映射整个摊平，落盘对象多出一个嵌套的 'task:current'，
 *        plan 被重建成 { items: [] }，执行器只搬第一条就停）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/** 最小 chrome.storage.local 替身（带可注入延迟，用来制造真实并发） */
function installChromeStub(opts = {}) {
  const store = new Map();
  const delay = opts.delayMs || 0;
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  const api = {
    async get(keys) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (keys == null || keys === undefined) return Object.fromEntries(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (store.has(k)) out[k] = clone(store.get(k));
      return out;
    },
    async set(obj) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      for (const [k, v] of Object.entries(obj)) store.set(k, clone(v));
    },
    async remove(keys) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };

  globalThis.chrome = { storage: { local: api } };
  return store;
}

const stub = installChromeStub();
const S = await import('../../src/storage.js');

test('set / get 往返', async () => {
  await S.set('a', { n: 1 });
  assert.deepEqual(await S.get('a'), { n: 1 });
  assert.equal(await S.get('missing', 'dflt'), 'dflt');
});

test('mutate 基于当前值变换', async () => {
  await S.set('counter', 1);
  const r = await S.mutate('counter', (c) => c + 1, 0);
  assert.equal(r, 2);
  assert.equal(await S.get('counter'), 2);
});

test('mutate 在键不存在时用初值', async () => {
  const r = await S.mutate('brand-new', (c) => (c || 0) + 5, 0);
  assert.equal(r, 5);
});

test('mutate 返回 SKIP 时不写盘', async () => {
  await S.set('k', 'orig');
  const r = await S.mutate('k', () => S.SKIP, 'x');
  assert.equal(r, 'orig');
  assert.equal(await S.get('k'), 'orig');
});

test('⚠️ 并发 mutate 不丢更新（读-改-写全程持锁）', async () => {
  installChromeStub({ delayMs: 2 }); // 制造真实的交错窗口
  await S.set('n', 0);
  // 不 await 间隔地连打 50 次 —— 若是「各自 get 再 set」，必然丢一大半
  const jobs = [];
  for (let i = 0; i < 50; i++) jobs.push(S.mutate('n', (c) => c + 1, 0));
  await Promise.all(jobs);
  assert.equal(await S.get('n'), 50, '并发写丢了更新 —— 串行临界区没生效');
});

test('mutateMany：回调收到的是 { key: value } 映射', async () => {
  await S.set('x', 1);
  await S.set('y', 2);
  let seen = null;
  await S.mutateMany(['x', 'y'], (cur) => {
    seen = cur;
    return { x: cur.x + 10, y: cur.y + 20 };
  }, {});
  assert.deepEqual(seen, { x: 1, y: 2 }, '回调拿到的不是映射');
  assert.equal(await S.get('x'), 11);
  assert.equal(await S.get('y'), 22);
});

test('⚠️ 回归：不能把映射整个摊平当任务对象用', async () => {
  // 这是实际踩过的 bug：persistItem 里写 `const t = { ...(cur || {}) }`，
  // 于是 t.plan === undefined → 重建成 { items: [] }，只搬第一条就停。
  installChromeStub();
  await S.set('task:current', {
    status: 'running',
    plan: { items: [{ id: '1', status: 'pending' }, { id: '2', status: 'pending' }] },
    createdFolders: [],
    lastDoneIndex: -1,
  });

  // 正确写法：取映射里的那一项
  await S.mutateMany(['task:current'], (cur) => {
    const t = { ...(cur['task:current'] || {}) };
    const items = t.plan.items.map((i) => (i.id === '1' ? { ...i, status: 'done' } : i));
    return { 'task:current': { ...t, plan: { items }, lastDoneIndex: 0 } };
  }, {});

  const after = await S.get('task:current');
  assert.equal(after.status, 'running', '状态被弄丢了');
  assert.equal(after.plan.items.length, 2, '计划项被清空了');
  assert.equal(after.plan.items[0].status, 'done');
  assert.equal(after.plan.items[1].status, 'pending');
  assert.equal(after.lastDoneIndex, 0);
  assert.ok(!('task:current' in after), '落盘对象里出现了嵌套的 task:current —— 结构被写坏了');
});

test('setVerified 校验条数', async () => {
  const arr = [1, 2, 3];
  const count = (v) => (Array.isArray(v) ? v.length : -1);

  const ok = await S.setVerified('list', arr, count);
  assert.deepEqual(ok, { ok: true, expected: 3, actual: 3 });

  // 不传 countOf 时不校验
  const skip = await S.setVerified('other', arr);
  assert.equal(skip.ok, true);
  assert.equal(skip.expected, null);
});

test('remove / removeMany / getMany', async () => {
  await S.set('p', 1);
  await S.set('q', 2);
  await S.set('r', 3);
  assert.deepEqual(await S.getMany(['p', 'q']), { p: 1, q: 2 });
  await S.remove('p');
  assert.equal(await S.get('p'), undefined);
  await S.removeMany(['q', 'r']);
  assert.deepEqual(await S.getMany(['q', 'r']), {});
});

test('setMany 一次写多个键', async () => {
  await S.setMany({ m: 1, n: 2 });
  assert.deepEqual(await S.getMany(['m', 'n']), { m: 1, n: 2 });
});

test('getTask 无记录时返回空壳（调用方不必到处判空）', async () => {
  await S.remove('task:current'); // 上一条测试写过这个键，先清掉
  const t = await S.getTask();
  assert.equal(t.status, S.TASK_STATUS.IDLE);
  assert.equal(t.plan, null);
  assert.equal(t.lastDoneIndex, -1);
  assert.deepEqual(t.createdFolders, []);
});

test('getSettings 合并默认值', async () => {
  const s = await S.getSettings();
  // ⚠️ 存的是**语义键**不是根 id。写死 '1' 的那版让 2026-10-05 的 45 条书签全军覆没
  // （Chrome 154 的书签栏 id 是 279），真实 id 由 roots.js 运行时解析。
  assert.equal(s.targetRoot, 'bar');
  assert.equal(s.llmEnabled, true, 'LLM 兜底默认开启');
  assert.equal(s.baseUrl, 'https://api.deepseek.com', '默认走 DeepSeek');
  assert.equal(s.model, 'deepseek-flash');
  assert.equal(s.apiKey, '', '注入的 key 不进 storage，默认必须为空');
  await S.updateSettings({ targetRoot: 'other' });
  assert.equal((await S.getSettings()).targetRoot, 'other');
  assert.equal((await S.getSettings()).llmEnabled, true, '未提供的字段应回落默认值');
});

test('串行链在一次写失败后不中断后续写', async () => {
  installChromeStub();
  await S.set('chain', 0);
  // 一个会抛的 mutate，后面跟两个正常 mutate
  const failing = S.mutate('chain', () => { throw new Error('boom'); }, 0).then(
    () => 'resolved',
    () => 'caught',
  );
  const after1 = S.mutate('chain', (c) => c + 1, 0);
  const after2 = S.mutate('chain', (c) => c + 1, 0);
  const results = await Promise.all([failing, after1, after2]);
  assert.equal(results[0], 'caught');
  assert.equal(await S.get('chain'), 2, '一次写失败后串行链断了，后续写没执行');
});

void stub;
