/**
 * 规则匹配器 + 命中率闸门。
 * 闸门要能红：见 tests/unit/falsification.test.js 里的「坏样本会红」用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { compileRules, matchRule, matchAll } from '../../src/classify/rules.js';
import { DEFAULT_RULES } from '../../src/classify/dict.js';
import { SAMPLE_BOOKMARKS, HIT_RATE_THRESHOLD } from '../fixtures/samples.js';

const compiled = compileRules(DEFAULT_RULES);

test('域名精确匹配 → high', () => {
  const r = matchRule({ url: 'https://github.com/vuejs/core', title: 'x' }, compiled);
  assert.equal(r.to, '开发与技术/代码托管');
  assert.equal(r.confidence, 'high');
  assert.equal(r.reason, 'rule:domain');
});

test('www 前缀不影响匹配', () => {
  const r = matchRule({ url: 'https://www.github.com/a', title: 'x' }, compiled);
  assert.equal(r.to, '开发与技术/代码托管');
});

test('域名后缀按点边界匹配', () => {
  // a.github.com 应命中 github.com 的规则
  const r = matchRule({ url: 'https://gist.github.com/user/1', title: 'x' }, compiled);
  assert.equal(r.to, '开发与技术/代码托管');
});

test('⚠️ 点边界：notgithub.com 不得命中 github.com', () => {
  const r = matchRule({ url: 'https://notgithub.com/x', title: '随便什么' }, compiled);
  // 它有自己的规则就不是 null；关键是 reason 不能是 rule:domain（后缀误匹配）
  if (r) assert.notEqual(r.reason, 'rule:domain', '字符串后缀误匹配：notgithub.com 命中了 github.com');
});

test('path 关键词匹配 → medium', () => {
  const r = matchRule({ url: 'https://unknown-vendor.cn/docs/intro', title: '无意义标题' }, compiled);
  assert.equal(r.to, '开发与技术/技术文档');
  assert.equal(r.reason, 'rule:path');
  assert.equal(r.confidence, 'medium');
});

test('title 关键词匹配 → low（UI 必须标黄待确认）', () => {
  const r = matchRule({ url: 'https://unknown-site.cn/page', title: '某教程页面' }, compiled);
  assert.ok(r, '标题含「教程」应命中学习资料/编程学习');
  assert.equal(r.reason, 'rule:title');
  assert.equal(r.confidence, 'low');
});

test('learned 规则优先级高于预置规则', () => {
  const learned = [{ to: '其他/待归类', domains: ['github.com'] }];
  const r = matchRule({ url: 'https://github.com/a', title: 'x' }, compiled, learned);
  assert.equal(r.to, '其他/待归类');
  assert.equal(r.reason, 'learned');
  assert.equal(r.confidence, 'high');
});

test('learned 规则按 URL 精确匹配而非域名 —— 同域不同路径可分别改判', () => {
  const learned = [
    { to: '其他/待归类', pathWords: ['/special'] },
  ];
  const hit = matchRule({ url: 'https://github.com/special', title: 'x' }, compiled, learned);
  const miss = matchRule({ url: 'https://github.com/other', title: 'x' }, compiled, learned);
  assert.equal(hit.to, '其他/待归类');
  assert.equal(miss.to, '开发与技术/代码托管', '未被 learned 命中的不应受影响');
});

test('被排除的 URL 一律不匹配', () => {
  for (const u of ['chrome://extensions', 'file:///c:/a.html', 'http://localhost:1/', 'garbage']) {
    assert.equal(matchRule({ url: u, title: 'github' }, compiled), null, `${u} 不该被分类`);
  }
});

test('空输入不炸', () => {
  assert.equal(matchRule(null, compiled), null);
  assert.equal(matchRule({}, compiled), null);
  assert.equal(matchRule({ url: '' }, compiled), null);
  assert.deepEqual(matchAll([], DEFAULT_RULES), []);
});

test('compileRules 容忍脏规则', () => {
  const c = compileRules([null, undefined, {}, { to: '' }, { to: 'a/b' }]);
  assert.equal(c.domainMap.size, 0);
  assert.equal(c.suffixRules.length, 0);
  assert.equal(matchRule({ url: 'https://a.com' }, c), null);
});

test('规则全命中不了时返回 null（交给 LLM / 兜底桶）', () => {
  assert.equal(matchRule({ url: 'https://totally-unknown-xyz.net/q', title: 'zzz' }, compiled), null);
});

// ───────────────────────── 命中率闸门 ─────────────────────────

test(`命中率 ≥ ${HIT_RATE_THRESHOLD * 100}%`, () => {
  const results = matchAll(SAMPLE_BOOKMARKS, DEFAULT_RULES);
  const hit = results.filter(Boolean).length;
  const rate = hit / SAMPLE_BOOKMARKS.length;
  const misses = SAMPLE_BOOKMARKS.filter((s, i) => !results[i]).map((s) => s.url);
  assert.ok(
    rate >= HIT_RATE_THRESHOLD,
    `命中率 ${(rate * 100).toFixed(1)}% < ${HIT_RATE_THRESHOLD * 100}%。未命中：\n  ${misses.join('\n  ')}`,
  );
});

test('写死 expect 的样本必须分到指定类目', () => {
  const results = matchAll(SAMPLE_BOOKMARKS, DEFAULT_RULES);
  const wrong = [];
  SAMPLE_BOOKMARKS.forEach((s, i) => {
    if (!s.expect) return;
    if (!results[i]) wrong.push(`${s.url} → 未命中（期望 ${s.expect}）`);
    else if (results[i].to !== s.expect) wrong.push(`${s.url} → ${results[i].to}（期望 ${s.expect}）`);
  });
  assert.deepEqual(wrong, [], '以下样本的分类与预期不符');
});
