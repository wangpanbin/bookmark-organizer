/**
 * 规则匹配器 + 命中率闸门。
 * 闸门要能红：见 tests/unit/falsification.test.js 里的「坏样本会红」用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { compileRules, matchRule, matchAll } from '../../src/classify/rules.js';
import { DEFAULT_RULES } from '../../src/classify/dict.js';
import { buildUrlRule } from '../../src/classify/learned.js';
import { SAMPLE_BOOKMARKS, HIT_RATE_THRESHOLD } from '../fixtures/samples.js';

const compiled = compileRules(DEFAULT_RULES);

test('⚠️ 域名精确匹配 → 置信度按域名性质分级，不再一律 high', () => {
  // 早先这条断言 github.com → high。那个 high 是**虚假的信心**：
  // 「我确信这是 github.com」不等于「我确信它该进代码托管」——
  // 同一域名上可能是别人的教程、issue、数据集、公司主页。
  // 而多用途站点标 high 会让低置信闸门形同虚设。
  const multi = matchRule({ url: 'https://github.com/vuejs/core', title: 'x' }, compiled);
  assert.equal(multi.to, '开发与技术/代码托管');
  assert.equal(multi.reason, 'rule:domain');
  assert.equal(multi.confidence, 'medium', '多用途站点不得标 high，否则低置信闸门被架空');

  // 权威站（站点性质唯一且稳定）才配 high，且不进 LLM 精判
  const auth = matchRule({ url: 'https://reactjs.org/docs/hooks-intro.html', title: 'x' }, compiled);
  assert.equal(auth.reason, 'rule:domain');
  assert.equal(auth.confidence, 'high', '官方文档站保持 high');
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
  // ⚠️ 这条用例早先构造的是 `{ to, pathWords:['/special'] }`（**不含 domains**），
  //    那种形状天然只走 pathWords 分支，于是「或语义没炸 pathWords」这件事
  //    在测试里永远看不见。而生产代码 buildLearnedRule 实际产出的是
  //    `{ to, domains:[host], pathWords:[path] }` —— 带 domains。
  //    下面用真实形状重写：正是它在旧实现下把整站 github 改道。
  const learned = [buildUrlRule('https://github.com/special', '其他/待归类')];
  const hit = matchRule({ url: 'https://github.com/special', title: 'x' }, compiled, learned);
  const miss = matchRule({ url: 'https://github.com/other', title: 'x' }, compiled, learned);
  assert.equal(hit.to, '其他/待归类');
  assert.equal(miss.to, '开发与技术/代码托管', '未被 learned 命中的不应受影响');
});

test('⚠️ 改判一条 github 书签，不得把整站 github 改道（真实 bug 的回归闸门）', () => {
  // 症状：改判 ruanyf/blog 之后，vuejs/core、tailwindcss、explore/trending
  //       全部被判成同一类且 confidence: high，压过预置词典。
  // 判据：只有被改判的那一条走 learned，其余必须照常走词典。
  const learned = [buildUrlRule('https://github.com/ruanyf/blog', '学习资料/编程学习')];
  for (const u of [
    'https://github.com/vuejs/core',
    'https://github.com/tailwindlabs/tailwindcss',
    'https://github.com/explore/trending',
  ]) {
    const hit = matchRule({ url: u, title: 'x' }, compiled, learned);
    assert.equal(hit.reason, 'rule:domain', `${u} 不该被 learned 劫持`);
    assert.equal(hit.to, '开发与技术/代码托管');
  }
  assert.equal(
    matchRule({ url: 'https://github.com/ruanyf/blog', title: 'x' }, compiled, learned).reason,
    'learned',
  );
});

test('⚠️ 预置词典仍是「或」语义 —— 不许为了统一而改成「且」', () => {
  // 两条语义是相反的且各自必需：learned 要精确，词典必须或。
  // 把 hitLevel 改成「且」会让命中率从 90.3% 塌到接近 0。
  //
  // 这里用公共 API matchRule 表达同一件事，不为了断言去导出私有的 hitLevel。
  // 造一条「域名对不上、只有 titleWords 对得上」的规则：或语义下必须命中。
  const orRule = [{ to: 'X/Y', domains: ['never-matched.example'], titleWords: ['github'] }];
  const hit = matchRule({ url: 'https://unrelated.example/a', title: '我的 github 收藏' },
    compileRules(orRule), []);
  assert.equal(hit.to, 'X/Y', '只靠 titleWords 也必须命中，否则词典命中率会塌');
  assert.equal(hit.reason, 'rule:title');
});

test('learned 的历史规则（无 scope 字段）仍按域级生效，向后兼容', () => {
  const legacy = [{ to: '其他/待归类', domains: ['github.com'] }];
  const hit = matchRule({ url: 'https://github.com/anything', title: 'x' }, compiled, legacy);
  assert.equal(hit.reason, 'learned', '老数据不能因为加了 scope 字段就整体失效');
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
