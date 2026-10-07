/**
 * learned 规则的匹配与晋升判定。
 * ⚠️ 纯函数模块：不得 import chrome API。
 *
 * 闸门要能红：tests/unit/falsification.test.js 之外，这里每条判据都在
 * 本文件里带了「反向样本」，确保它不是恒真的摆设。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMOTE_AFTER, scopeOf, ruleMatches, matchLearned,
  buildUrlRule, shouldPromoteToDomain, promoteToDomain,
} from '../../src/classify/learned.js';

// ───────────────────────── URL 精确语义 ─────────────────────────

test('⚠️ URL 精确规则只命中那一条，不得顺带改道同域其它书签', () => {
  const learned = [buildUrlRule('https://github.com/ruanyf/blog', '学习资料/编程学习')];
  assert.ok(matchLearned({ url: 'https://github.com/ruanyf/blog' }, learned));
  for (const u of [
    'https://github.com/vuejs/core',
    'https://github.com/ruanyf/other-post',   // 同域同前缀，另一篇
    'https://github.com/explore/trending',
    'https://gitlab.com/ruanyf/blog',         // 不同域
  ]) {
    assert.equal(matchLearned({ url: u }, learned), null, `${u} 绝不该被劫持`);
  }
});

test('URL 精确走归一化：http/https、www、大小写不该影响命中', () => {
  const learned = [buildUrlRule('https://example.com/a/b', 'X/Y')];
  for (const u of [
    'http://example.com/a/b',
    'https://www.example.com/a/b',
    'https://EXAMPLE.com/a/b',
  ]) {
    assert.ok(matchLearned({ url: u }, learned), `${u} 归一化后应命中同一条`);
  }
});

test('⚠️ urls 为空的规则永远不命中，绝不退化成「匹配一切」', () => {
  // 这正是原 bug 的形态：限定条件缺失时默认放行。
  const broken = [{ to: 'X/Y', scope: 'url', urls: [] }];
  assert.equal(matchLearned({ url: 'https://anything.example/' }, broken), null);
  assert.equal(ruleMatches(broken, { url: 'https://anything.example/' }), false);
});

test('scope 缺失时按域级处理 —— 向后兼容历史数据', () => {
  assert.equal(scopeOf({ to: 'X' }), 'domain');
  assert.equal(scopeOf({ to: 'X', scope: 'url' }), 'url');
  const legacy = [{ to: 'X/Y', domains: ['github.com'] }];
  assert.ok(matchLearned({ url: 'https://github.com/whatever' }, legacy));
});

test('脏输入不炸', () => {
  assert.equal(matchLearned({ url: 'https://a.example/' }, null), null);
  assert.equal(matchLearned({ url: 'https://a.example/' }, undefined), null);
  assert.equal(matchLearned(null, []), null);
  assert.equal(matchLearned({ url: '' }, [buildUrlRule('https://a.example/', 'X')]), null);
  assert.equal(matchLearned({ url: 'https://a.example/' }, [{ to: '' }]), null);
});

// ───────────────────────── 域级晋升 ─────────────────────────

test(`同域同 to 攒够 ${PROMOTE_AFTER} 次才晋升为域级`, () => {
  const hist = [];
  for (const p of ['/a/1', '/b/2', '/c/3']) {
    hist.push(buildUrlRule(`https://github.com${p}`, 'X/Y'));
  }
  assert.equal(shouldPromoteToDomain(hist.slice(0, 2), 'github.com', 'X/Y'), false,
    '只有 2 条时不得晋升');
  assert.equal(shouldPromoteToDomain(hist, 'github.com', 'X/Y'), true);
});

test('⚠️ 不同域名各自计数，A 站攒够不影响 B 站', () => {
  const hist = [
    buildUrlRule('https://a.com/1', 'X/Y'),
    buildUrlRule('https://a.com/2', 'X/Y'),
    buildUrlRule('https://a.com/3', 'X/Y'),
  ];
  assert.equal(shouldPromoteToDomain(hist, 'b.com', 'X/Y'), false);
});

test('⚠️ 按 to 分别计数：某类够数即单独晋升，不因另一类存在而被卡死', () => {
  const hist = [
    buildUrlRule('https://g.com/1', 'A'), buildUrlRule('https://g.com/2', 'A'),
    buildUrlRule('https://g.com/3', 'B'), buildUrlRule('https://g.com/4', 'B'),
    buildUrlRule('https://g.com/5', 'B'),
  ];
  assert.equal(shouldPromoteToDomain(hist, 'g.com', 'B'), true, 'B 类够 3 条');
  assert.equal(shouldPromoteToDomain(hist, 'g.com', 'A'), false, 'A 类只 2 条');
});

test('重复 URL 不重复计数（去重后仍不足 3 就不晋升）', () => {
  const hist = [
    buildUrlRule('https://g.com/1', 'X'),
    buildUrlRule('https://g.com/1', 'X'),
    buildUrlRule('https://g.com/1', 'X'),
  ];
  assert.equal(shouldPromoteToDomain(hist, 'g.com', 'X'), false,
    '同一条改判三次仍是一条，不该被当成三次独立证据');
});

test('晋升后规则收敛成一条域级规则，且真的对整站生效', () => {
  const hist = [
    buildUrlRule('https://github.com/a', 'X/Y'),
    buildUrlRule('https://github.com/b', 'X/Y'),
    buildUrlRule('https://github.com/c', 'X/Y'),
  ];
  const r = promoteToDomain(hist, 'github.com', 'X/Y');
  assert.equal(r.promoted, true);
  assert.equal(r.learned.length, 1, '三条精确规则应合并成一条域级');
  assert.ok(matchLearned({ url: 'https://github.com/never-seen-before' }, r.learned));
});

test('晋升失败时原样返回，不丢已有规则', () => {
  const hist = [buildUrlRule('https://github.com/a', 'X/Y')];
  const r = promoteToDomain(hist, 'github.com', 'X/Y');
  assert.equal(r.promoted, false);
  assert.equal(r.learned, hist, '不该晋升时必须原样返回同一个数组');
});