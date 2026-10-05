/**
 * 去重：高危路径。每一条都对应「误删用户书签」的可能。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { findDuplicates, toRemovalList, dedupeStats, compareKeeper } from '../../src/dedupe.js';
import { dedupeKey } from '../../src/normalize.js';

const E = (id, url, extra = {}) => ({
  id,
  type: 'url',
  url,
  title: extra.title || id,
  path: extra.path || ['其他书签'],
  dateAdded: extra.dateAdded,
});

test('同文件夹内完全相同的 URL 判为重复', () => {
  const g = findDuplicates([
    E('1', 'https://a.com/x', { dateAdded: 100 }),
    E('2', 'https://a.com/x', { dateAdded: 200 }),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].keeper.id, '1');
  assert.equal(g[0].duplicates.length, 1);
  assert.equal(g[0].duplicates[0].id, '2');
});

test('跨文件夹重复同样判出，keeper 优先留路径更浅的', () => {
  const g = findDuplicates([
    E('1', 'https://a.com/x', { path: ['书签栏', '开发', '前端'], dateAdded: 1 }),
    E('2', 'https://a.com/x', { path: ['其他书签'], dateAdded: 999 }),
  ]);
  assert.equal(g[0].keeper.id, '2', '散落的那条应当保留，已归类的会被移动');
});

test('路径深度相同时保留更早收藏的', () => {
  const g = findDuplicates([
    E('1', 'https://a.com/x', { dateAdded: 500 }),
    E('2', 'https://a.com/x', { dateAdded: 100 }),
  ]);
  assert.equal(g[0].keeper.id, '2');
});

test('⚠️ SPA hash 路由不得判为重复', () => {
  const g = findDuplicates([
    E('1', 'https://app.example.com/#/settings'),
    E('2', 'https://app.example.com/#/profile'),
  ]);
  assert.equal(g.length, 0, '两个不同路由被判成重复 —— 会删掉用户真收藏的页面');
});

test('⚠️ 不同 id 的 query 参数不得判为重复', () => {
  const g = findDuplicates([
    E('1', 'https://api.example.com/data?id=1'),
    E('2', 'https://api.example.com/data?id=2'),
  ]);
  assert.equal(g.length, 0);
});

test('跟踪参数不同视为同一条重复', () => {
  const g = findDuplicates([
    E('1', 'https://news.example.com/a?utm_source=wx'),
    E('2', 'https://news.example.com/a'),
  ]);
  assert.equal(g.length, 1);
});

test('http 与 https 视为重复', () => {
  const g = findDuplicates([E('1', 'http://a.com/x'), E('2', 'https://a.com/x')]);
  assert.equal(g.length, 1);
});

test('浏览器内部页与本机地址不参与去重（不删用户手动加的本地页）', () => {
  const g = findDuplicates([
    E('1', 'chrome://bookmarks'),
    E('2', 'chrome://bookmarks'),
    E('3', 'file:///c:/notes.html'),
    E('4', 'file:///c:/notes.html'),
  ]);
  assert.equal(g.length, 0);
});

test('文件夹节点不参与去重', () => {
  const g = findDuplicates([
    { id: '1', type: 'folder', title: '开发', path: ['书签栏'] },
    { id: '2', type: 'folder', title: '开发', path: ['书签栏'] },
  ]);
  assert.equal(g.length, 0);
});

test('三条以上同组时只保留一条', () => {
  const g = findDuplicates([
    E('1', 'https://a.com/x', { dateAdded: 3 }),
    E('2', 'https://a.com/x', { dateAdded: 1 }),
    E('3', 'https://a.com/x', { dateAdded: 2 }),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].keeper.id, '2');
  assert.equal(g[0].duplicates.length, 2);
});

test('toRemovalList 展开待删列表并带上 keepId', () => {
  const g = findDuplicates([
    E('1', 'https://a.com/x', { dateAdded: 1 }),
    E('2', 'https://a.com/x', { dateAdded: 2 }),
    E('3', 'https://a.com/x', { dateAdded: 3 }),
  ]);
  const list = toRemovalList(g);
  assert.equal(list.length, 2);
  assert.ok(list.every((d) => d.keepId === '1'));
  assert.deepEqual(list.map((d) => d.id).sort(), ['2', '3']);
});

test('dedupeStats 汇总', () => {
  const g = findDuplicates([
    E('1', 'https://a.com/x', { dateAdded: 1 }),
    E('2', 'https://a.com/x', { dateAdded: 2 }),
    E('3', 'https://b.com/y', { dateAdded: 1 }),
    E('4', 'https://b.com/y', { dateAdded: 2 }),
  ]);
  const s = dedupeStats(g);
  assert.equal(s.groups, 2);
  assert.equal(s.removable, 2);
  assert.ok(s.savedBytes > 0);
});

test('compareKeeper 对缺字段输入不炸且稳定', () => {
  const a = { id: '1' };
  const b = { id: '2' };
  assert.ok(compareKeeper(a, b) < 0);
  assert.ok(compareKeeper(a, a) === 1); // 同一条不应返回 -1
  assert.ok(Number.isFinite(compareKeeper({}, {})));
});

test('空输入返回空结果', () => {
  assert.deepEqual(findDuplicates([]), []);
  assert.deepEqual(findDuplicates(null), []);
  assert.deepEqual(toRemovalList(null), []);
  assert.equal(dedupeStats(null).removable, 0);
});

test('dedupeKey 与 findDuplicates 口径一致', () => {
  const a = 'https://a.com/x?utm_source=wx';
  const b = 'https://a.com/x';
  assert.equal(dedupeKey(a), dedupeKey(b));
  assert.equal(findDuplicates([E('1', a), E('2', b)]).length, 1);
});
