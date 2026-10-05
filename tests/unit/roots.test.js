/**
 * 顶层根解析的回归闸门。
 *
 * ═══ 这道闸门守的是什么 ═══
 * 2026-10-05，用户 45 条书签整理全军覆没，45 条报同一句
 * `Can't find bookmark for id.`。真实存储里那 45 个 id **一个都没失效**，
 * 计划本身也完全正确。根因是代码把「书签栏 = id '1'」当成常量：
 * storage.js 默认值、options.html 的 option value、apply.js 的兜底，三处都写死。
 *
 * 而根 id 不是常量 —— 用户本机 Chrome 154 的账号书签模型实测是
 *   书签栏 = 279 / 其他书签 = 280 / 移动设备书签 = 281
 * （同时传统 `Bookmarks` 文件被清空，真实数据搬进了 `AccountBookmarks`）。
 *
 * 下面的 TREE_154 就是照着那棵真实的树复刻的：
 * 3 个顶层根、id 是三位数、顺序仍是 [书签栏, 其他书签, 移动设备]。
 *
 * ⚠️ 本文件里凡是断言 id 的地方，**都不许写 '1'**。
 *    闸门自己若也开始假设根 id 是常量，它就再也抓不到下一次同类回归。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rootsFromTree, pickRootKey, resolveRoot, ROOT_BAR, ROOT_OTHER } from '../../src/roots.js';

/** 照抄用户本机真实 profile 的形状 */
const TREE_154 = [{
  id: '0',
  title: '',
  children: [
    { id: '279', title: '书签栏', children: [
      { id: '282', title: 'resource', children: [
        { id: '283', title: '探索 GitHub', url: 'https://github.com/explore' },
      ] },
    ] },
    { id: '280', title: '其他书签', children: [] },
    { id: '281', title: '移动设备书签', children: [] },
  ],
}];

/** 经典模型：根 id 就是 1/2/3 */
const TREE_CLASSIC = [{
  id: '0',
  title: '',
  children: [
    { id: '1', title: '书签栏', children: [] },
    { id: '2', title: '其他书签', children: [] },
    { id: '3', title: '移动设备书签', children: [] },
  ],
}];

/** 装一个只够 roots.js 用的 chrome 替身 */
function fakeChrome(tree, { alive = null } = {}) {
  const byId = new Map();
  const index = (n) => {
    byId.set(String(n.id), n);
    for (const c of n.children || []) index(c);
  };
  for (const t of tree) index(t);
  return {
    bookmarks: {
      getTree: async () => JSON.parse(JSON.stringify(tree)),
      get: async (id) => {
        const ok = alive ? alive(String(id)) : byId.has(String(id));
        if (!ok) throw new Error(`Can't find bookmark for id. ${id}`);
        return [byId.get(String(id))];
      },
    },
  };
}

// ───────────────────────── rootsFromTree ─────────────────────────

test('rootsFromTree 按位置认根，id 不是 1/2/3 也能认对', () => {
  const roots = rootsFromTree(TREE_154);
  assert.equal(roots.length, 3);
  assert.equal(roots[0].id, '279');
  assert.equal(roots[0].key, ROOT_BAR, '第 0 个顶层根恒为书签栏');
  assert.equal(roots[1].id, '280');
  assert.equal(roots[1].key, ROOT_OTHER, '第 1 个顶层根恒为其他书签');
  assert.equal(roots[2].key, null, '第 3 个是只读的移动设备根，不可作为目标');
});

test('rootsFromTree 标出只读根', () => {
  const roots = rootsFromTree(TREE_154);
  assert.equal(roots[0].readOnly, false);
  assert.equal(roots[1].readOnly, false);
  assert.equal(roots[2].readOnly, true, '移动设备书签必须标只读，否则 move 进去逐条失败');
});

test('rootsFromTree 对经典模型同样成立', () => {
  const roots = rootsFromTree(TREE_CLASSIC);
  assert.deepEqual(roots.map((r) => r.key), [ROOT_BAR, ROOT_OTHER, null]);
  assert.equal(roots[2].readOnly, true);
});

test('rootsFromTree 容忍空树 / 畸形输入', () => {
  assert.deepEqual(rootsFromTree(null), []);
  assert.deepEqual(rootsFromTree([]), []);
  assert.deepEqual(rootsFromTree([{}]), []);
});

// ───────────────────────── pickRootKey ─────────────────────────

test("pickRootKey 把旧值 '1' 翻成书签栏（本次事故的回归点）", () => {
  const roots = rootsFromTree(TREE_154);
  assert.equal(pickRootKey('1', roots), ROOT_BAR);
  assert.notEqual(pickRootKey('1', roots), '279', '语义键不是 id —— 这里只该得到 bar');
});

test("pickRootKey 把旧值 '2' 翻成其他书签", () => {
  assert.equal(pickRootKey('2', rootsFromTree(TREE_154)), ROOT_OTHER);
});

test('pickRootKey 认活着的真实 id', () => {
  const roots = rootsFromTree(TREE_154);
  assert.equal(pickRootKey('280', roots), ROOT_OTHER, '存过的真 id 要按 id 认，不能当成别的');
  assert.equal(pickRootKey('279', roots), ROOT_BAR);
});

test('pickRootKey 语义键原样通过', () => {
  const roots = rootsFromTree(TREE_154);
  assert.equal(pickRootKey('bar', roots), ROOT_BAR);
  assert.equal(pickRootKey('other', roots), ROOT_OTHER);
});

test('pickRootKey 认不出来时回落到书签栏', () => {
  const roots = rootsFromTree(TREE_154);
  assert.equal(pickRootKey(null, roots), ROOT_BAR);
  assert.equal(pickRootKey(undefined, roots), ROOT_BAR);
  assert.equal(pickRootKey('', roots), ROOT_BAR);
  assert.equal(pickRootKey('99999', roots), ROOT_BAR, '别的 Chrome 版本留下的失效 id');
  assert.equal(pickRootKey('bar', []), ROOT_BAR, '没有根列表时也要给出合法语义键');
});

// ───────────────────────── resolveRoot ─────────────────────────

test('resolveRoot 在 Chrome 154 形状的树上返回 279，**绝不是 1**', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = fakeChrome(TREE_154);
  try {
    const r = await resolveRoot('bar');
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.id, '279', '这就是 2026-10-05 全军覆没的那条判据');
    assert.notEqual(r.id, '1', '根 id 绝不能回落成 1');
    assert.equal(r.title, '书签栏');
  } finally {
    globalThis.chrome = prev;
  }
});

test('resolveRoot 认「其他书签」时给 280', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = fakeChrome(TREE_154);
  try {
    const r = await resolveRoot('other');
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.id, '280');
  } finally {
    globalThis.chrome = prev;
  }
});

test('resolveRoot 在经典模型上仍给 1（向后兼容）', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = fakeChrome(TREE_CLASSIC);
  try {
    assert.equal((await resolveRoot('bar')).id, '1');
    assert.equal((await resolveRoot('other')).id, '2');
  } finally {
    globalThis.chrome = prev;
  }
});

test('resolveRoot 用 get() 实测存在性，快照过了但节点没了要报失败', async () => {
  const prev = globalThis.chrome;
  // getTree() 里明明有 279，get() 却拿不到 —— 树在读之后被改了
  globalThis.chrome = fakeChrome(TREE_154, { alive: (id) => id !== '279' });
  try {
    const r = await resolveRoot('bar');
    assert.equal(r.ok, false, '拿不到就必须说不行，不能返回一个用不了的 id');
    assert.match(r.reason, /279/);
  } finally {
    globalThis.chrome = prev;
  }
});

test('resolveRoot 只有书签栏时，「其他书签」回落到书签栏而不是拒绝', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = fakeChrome([{ id: '0', title: '', children: [
    { id: '900', title: '书签栏', children: [] },
  ] }]);
  try {
    const r = await resolveRoot('other');
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.id, '900');
  } finally {
    globalThis.chrome = prev;
  }
});

test('resolveRoot 一个根都没有时报失败并给出可读原因', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = fakeChrome([{ id: '0', title: '', children: [] }]);
  try {
    const r = await resolveRoot('bar');
    assert.equal(r.ok, false);
    assert.equal(r.id, null);
    assert.ok(r.reason && r.reason.length > 0, '失败必须带原因，否则面板只能显示空白');
  } finally {
    globalThis.chrome = prev;
  }
});

test('resolveRoot 读树抛错时不假装成功', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = { bookmarks: { getTree: async () => { throw new Error('boom'); } } };
  try {
    const r = await resolveRoot('bar');
    assert.equal(r.ok, false);
    assert.match(r.reason, /boom/);
  } finally {
    globalThis.chrome = prev;
  }
});
