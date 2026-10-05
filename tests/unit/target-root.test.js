/**
 * 闸门：「归入位置」只许存语义键，不许存根 id。
 *
 * 守的是 2026-10-05 那次 45 条书签全军覆没。根因是 `targetRoot` 被当成常量
 * 写死成 `'1'`，而根 id 根本不是常量（Chrome 154 的账号书签模型实测
 * 书签栏=279 / 其他书签=280 / 移动设备=281）。
 *
 * ⚠️ 本文件自己**含有事故原样的坏样本**（下面的 fixture）。
 *    所以真实仓库扫描只扫 `src/` 与 `ui/`，绝不扫 `tests/` ——
 *    否则这道闸门会对着自己的测试数据报红，而实现其实是对的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNonSemanticTargetRoot } from '../helpers/sourceScan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ───────────────── 扫描器自身的正确性（防恒真/恒假）─────────────────

test('抓得住 storage.js 那处：targetRoot: 1', () => {
  const bad = findNonSemanticTargetRoot([
    { rel: 'src/storage.js', text: "  targetRoot: '1',\n" },
  ]);
  assert.equal(bad.length, 1, '必须抓到，写死的根 id 是闸门要拦的东西');
  assert.match(bad[0], /storage\.js/);
  assert.match(bad[0], /'1'/);
});

test('抓得住不带引号的数字', () => {
  assert.equal(
    findNonSemanticTargetRoot([{ rel: 'src/storage.js', text: '  targetRoot: 1,' }]).length,
    1,
  );
});

test('抓得住 HTML 里那处：<select id="targetRoot"> 下的 <option value="1">', () => {
  const html = '<select id="targetRoot">\n  <option value="1">书签栏</option>\n'
    + '  <option value="2">其他书签</option>\n</select>';
  const bad = findNonSemanticTargetRoot([{ rel: 'ui/options.html', text: html }]);
  assert.equal(bad.length, 2, '两个写死的根 id 都得抓到');
  assert.match(bad[0], /options\.html/);
});

test('放过语义键', () => {
  const bad = findNonSemanticTargetRoot([
    { rel: 'src/storage.js', text: "  targetRoot: 'bar',\n" },
    { rel: 'ui/options.html', text: '<select id="targetRoot"><option value="other">其他书签</option></select>' },
  ]);
  assert.deepEqual(bad, [], '语义键是唯一合法的取值');
});

test('放过 HTML 注释里引用的旧代码（否则闸门会对着注释报红）', () => {
  const html = '<select id="targetRoot">\n'
    + '  <!-- 早先这里写死 value="1" / "2" -->\n'
    + '  <option value="bar">书签栏</option>\n</select>';
  assert.deepEqual(findNonSemanticTargetRoot([{ rel: 'ui/options.html', text: html }]), []);
});

test('放过 JS 注释里引用的旧代码', () => {
  const js = "  // 早先是 targetRoot: '1'\n  targetRoot: 'bar',\n";
  assert.deepEqual(findNonSemanticTargetRoot([{ rel: 'src/storage.js', text: js }]), []);
});

test('不误伤别的 select（同名的 value="1" 不是根 id）', () => {
  const html = '<select id="failLogEnabled">\n  <option value="1">开启</option>\n</select>';
  assert.deepEqual(findNonSemanticTargetRoot([{ rel: 'ui/options.html', text: html }]), []);
});

test('放过指向标识符的赋值（它必然过 pickRootKey）', () => {
  assert.deepEqual(
    findNonSemanticTargetRoot([{ rel: 'src/apply.js', text: '  targetRoot: ROOT_BAR,' }]),
    [],
  );
});

test('容忍空输入', () => {
  assert.deepEqual(findNonSemanticTargetRoot([]), []);
  assert.deepEqual(findNonSemanticTargetRoot(null), []);
});

// ───────────────── 真实仓库 ─────────────────

test('真实 src/ 与 ui/ 里没有把「归入位置」写成根 id', () => {
  const sources = [
    ...readdirSync(join(ROOT, 'src'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => ({ rel: `src/${f}`, text: readFileSync(join(ROOT, 'src', f), 'utf8') })),
    ...readdirSync(join(ROOT, 'ui'))
      .filter((f) => f.endsWith('.html'))
      .map((f) => ({ rel: `ui/${f}`, text: readFileSync(join(ROOT, 'ui', f), 'utf8') })),
  ];
  assert.ok(sources.length >= 10, `扫到的文件太少（${sources.length}），路径可能变了`);
  assert.deepEqual(
    findNonSemanticTargetRoot(sources),
    [],
    '「归入位置」只能存语义键 bar/other，真实 id 由 src/roots.js 运行时解析',
  );
});
