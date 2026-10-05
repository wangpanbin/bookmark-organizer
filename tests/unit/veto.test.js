/**
 * 去重「逐条否决」的单测。
 *
 * 为什么单独一个文件：README 承诺「所有待删条目都会逐条出现在预览清单里，可否决」，
 * 而删除是**不可逆**的（只能靠恢复备份）。这条承诺一旦失效就是静默的数据损失，
 * 所以必须同时钉死两端：
 *   1. 数据层：否决名单存得对、读得对、并发切换不丢
 *   2. 执行层：被否决的条目执行器真的不删（不能只信上游过滤过一遍）
 *
 * 关键设计约束（下面的用例专门钉它）：否决名单存 **id** 不存 URL。
 * 重复项彼此 URL 相同，按 URL 记会把保留项也一起保住，去重等于没做。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function installChromeStub() {
  const store = new Map();
  const removed = [];
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return Object.fromEntries(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (store.has(k)) out[k] = clone(store.get(k));
          return out;
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, clone(v)); },
        async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
      },
    },
    bookmarks: {
      async remove(id) { removed.push(String(id)); },
    },
  };
  return { store, removed };
}

const stub = installChromeStub();
const S = await import('../../src/storage.js');
const A = await import('../../src/apply.js');

// ───────────────────── 数据层 ─────────────────────

test('否决名单：默认空，开/关/再开都正确', async () => {
  assert.deepEqual(await S.getDedupeVeto(), []);
  await S.toggleDedupeVeto('42', true);
  assert.deepEqual(await S.getDedupeVeto(), ['42']);
  assert.equal(S.isDedupeVetoed('42', await S.getDedupeVeto()), true);
  await S.toggleDedupeVeto('42', false);
  assert.deepEqual(await S.getDedupeVeto(), []);
  assert.equal(S.isDedupeVetoed('42', await S.getDedupeVeto()), false);
});

test('否决按 id 记，不按 URL —— 同 URL 的兄弟条目互不影响', async () => {
  // 这是整个设计最容易做错的地方：两条 URL 完全一样，只有 id 不同。
  // 若按 URL 记，否决其中一条会把另一条一起保住。
  await S.clearDedupeVeto();
  await S.toggleDedupeVeto('a', true);
  const list = await S.getDedupeVeto();
  assert.equal(S.isDedupeVetoed('a', list), true);
  assert.equal(S.isDedupeVetoed('b', list), false, '否决 a 竟然连 b 一起保住了');
  assert.equal(list.some((x) => x.includes('://')), false, '名单里出现了 URL，说明存错键了');
});

test('并发切换否决不丢更新（读-改-写全程持锁）', async () => {
  await S.clearDedupeVeto();
  const ids = Array.from({ length: 30 }, (_, i) => String(i));
  await Promise.all(ids.map((id) => S.toggleDedupeVeto(id, true)));
  const list = await S.getDedupeVeto();
  assert.equal(list.length, ids.length, `并发切换后只剩 ${list.length} 条，应为 ${ids.length}`);
});

test('isDedupeVetoed 对数字 id 与字符串 id 结果一致', async () => {
  await S.clearDedupeVeto();
  await S.toggleDedupeVeto(77, true);          // 故意传数字
  assert.equal(S.isDedupeVetoed(77, await S.getDedupeVeto()), true);
  assert.equal(S.isDedupeVetoed('77', await S.getDedupeVeto()), true);
});

// ───────────────────── 执行层 ─────────────────────

test('执行器跳过被否决的条目，其余照删', async () => {
  stub.removed.length = 0;
  await S.clearDedupeVeto();
  await S.toggleDedupeVeto('d2', true);

  const task = {
    removedDuplicates: [],
    duplicates: [
      { id: 'd1', url: 'https://x.dev/a', title: 'A', path: ['其他书签'], keepId: 'k1' },
      { id: 'd2', url: 'https://x.dev/b', title: 'B', path: ['其他书签'], keepId: 'k2' },
      { id: 'd3', url: 'https://x.dev/c', title: 'C', path: ['其他书签'], keepId: 'k3' },
    ],
  };
  const removed = await A.processDuplicates(task);

  assert.deepEqual(stub.removed, ['d1', 'd3'], '被否决的 d2 被删了 —— 不可逆数据损失');
  assert.deepEqual(removed.map((r) => r.title), ['A', 'C']);
  assert.equal(removed.some((r) => r.title === 'B'), false, '回滚清单里混进了被否决的条目');
});

test('执行器不信任上游过滤：payload 里混进被否决条目也不删', async () => {
  // 面板已经在生成 payload 时过滤过一遍，但 payload 可能来自上一轮残留。
  // 执行侧必须自己认否决名单。
  stub.removed.length = 0;
  await S.clearDedupeVeto();
  await S.toggleDedupeVeto('x9', true);

  await A.processDuplicates({
    removedDuplicates: [],
    duplicates: [{ id: 'x9', url: 'https://y.dev/', title: '不该删', path: ['其他书签'], keepId: 'k' }],
  });
  assert.deepEqual(stub.removed, [], '执行器只信上游过滤，没自己查否决名单');
});

test('全部否决时执行器一条不删，且回滚清单保持原样', async () => {
  stub.removed.length = 0;
  await S.clearDedupeVeto();
  await S.toggleDedupeVeto('m1', true);
  await S.toggleDedupeVeto('m2', true);

  const prev = [{ url: 'https://old.dev/', title: '历史', path: ['其他书签'], keepId: 'k' }];
  const removed = await A.processDuplicates({
    removedDuplicates: prev,
    duplicates: [
      { id: 'm1', url: 'https://a.dev/', title: 'A', path: ['其他书签'], keepId: 'k' },
      { id: 'm2', url: 'https://b.dev/', title: 'B', path: ['其他书签'], keepId: 'k' },
    ],
  });
  assert.deepEqual(stub.removed, []);
  assert.deepEqual(removed, prev, '没删任何东西就不该动已有回滚清单');
});
