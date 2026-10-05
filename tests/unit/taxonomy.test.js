/**
 * 类目树：预置值、用户覆盖合并、路径收敛。
 * 重点是「其他 / 待归类」这个用户编辑入口必须真的能改。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TAXONOMY,
  getTaxonomy,
  pathArray,
  pathString,
  allPaths,
  isKnownPath,
  fallbackPath,
  coercePath,
  FALLBACK_TOP,
  FALLBACK_SUB,
} from '../../src/classify/taxonomy.js';

test('预置类目树：10 个顶层，全部两层', () => {
  assert.equal(DEFAULT_TAXONOMY.length, 10);
  for (const t of DEFAULT_TAXONOMY) {
    assert.ok(Array.isArray(t.children) && t.children.length > 0, `${t.name} 没有子类`);
  }
  // 兜底桶必须存在，否则未分类条目无处可去
  assert.ok(DEFAULT_TAXONOMY.some((t) => t.name === FALLBACK_TOP));
});

test('路径字符串与数组互转', () => {
  assert.deepEqual(pathArray('开发与技术/前端'), ['开发与技术', '前端']);
  assert.deepEqual(pathArray('无斜杠'), ['无斜杠']);
  assert.deepEqual(pathArray(['a', 'b']), ['a', 'b']);
  assert.deepEqual(pathArray(''), []);
  assert.deepEqual(pathArray(null), []);
  assert.equal(pathString(['开发与技术', '前端']), '开发与技术/前端');
});

test('子类名里含空格（模型与 API）不破坏解析', () => {
  const p = pathArray('AI 与大模型/模型与 API');
  assert.deepEqual(p, ['AI 与大模型', '模型与 API']);
  assert.ok(isKnownPath(DEFAULT_TAXONOMY, p));
});

test('allPaths 展开出全部合法两级路径', () => {
  const paths = allPaths(DEFAULT_TAXONOMY);
  assert.ok(paths.includes('开发与技术/前端'));
  assert.ok(paths.includes('其他/待归类'));
  assert.equal(paths.length, DEFAULT_TAXONOMY.reduce((n, t) => n + t.children.length, 0));
});

test('isKnownPath 区分合法与非法', () => {
  assert.ok(isKnownPath(DEFAULT_TAXONOMY, '开发与技术/前端'));
  assert.ok(isKnownPath(DEFAULT_TAXONOMY, ['开发与技术']));
  assert.ok(!isKnownPath(DEFAULT_TAXONOMY, '开发与技术/不存在'));
  assert.ok(!isKnownPath(DEFAULT_TAXONOMY, '不存在/前端'));
  assert.ok(!isKnownPath(DEFAULT_TAXONOMY, ''));
});

test('用户 override 整棵替换预置值', () => {
  const custom = [{ name: '我的分类', children: ['甲', '乙'] }];
  assert.deepEqual(getTaxonomy(custom), custom);
  // 空 / 非数组 / 空数组都回退到预置
  assert.deepEqual(getTaxonomy(null), DEFAULT_TAXONOMY);
  assert.deepEqual(getTaxonomy([]), DEFAULT_TAXONOMY);
  assert.deepEqual(getTaxonomy('不是数组'), DEFAULT_TAXONOMY);
});

test('「其他」改名后兜底路径跟着变', () => {
  const custom = [
    { name: '开发', children: ['前端'] },
    { name: '待整理', children: ['杂项'] },
  ];
  // 没有叫「其他」的节点时，退到第一个节点的第一个子节点
  assert.deepEqual(fallbackPath(custom), ['开发', '前端']);
  // 有「其他」时用「其他」
  const withOther = [{ name: '其他', children: ['暂存'] }];
  assert.deepEqual(fallbackPath(withOther), ['其他', '暂存']);
});

test('空类目树也必须给出非空兜底（不能返回 null）', () => {
  assert.deepEqual(fallbackPath([]), []);
  const r = coercePath([], ['x', 'y']);
  assert.ok(Array.isArray(r));
});

test('coercePath 把非法路径收敛到最近合法路径', () => {
  assert.deepEqual(
    coercePath(DEFAULT_TAXONOMY, '开发与技术/前端'),
    ['开发与技术', '前端'],
  );
  // 顶层合法但子类不存在 → 落到该顶层的第一个子类
  assert.deepEqual(
    coercePath(DEFAULT_TAXONOMY, '开发与技术/瞎写的'),
    ['开发与技术', '前端'],
  );
  // 顶层就不存在 → 兜底
  assert.deepEqual(
    coercePath(DEFAULT_TAXONOMY, '完全不存在的类目/子类'),
    [FALLBACK_TOP, FALLBACK_SUB],
  );
  // 空路径 → 兜底
  assert.deepEqual(coercePath(DEFAULT_TAXONOMY, ''), [FALLBACK_TOP, FALLBACK_SUB]);
});
