/**
 * 域名权威度分级。
 * ⚠️ 纯函数模块：不得 import chrome API。
 *
 * 闸门要能红：每条判据都配了反向样本，确保不是恒真的摆设。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORITY_DOMAINS, MULTI_PURPOSE_DOMAINS,
  isAuthorityDomain, isMultiPurposeDomain, confidenceForDomain, overlappingDomains,
} from '../../src/classify/authority.js';
import { matchRule, compileRules } from '../../src/classify/rules.js';
import { DEFAULT_RULES } from '../../src/classify/dict.js';

const compiled = compileRules(DEFAULT_RULES);

// ───────────────── 默认多用途（最重要的一条） ─────────────────

test('⚠️ 未登记的域名一律按多用途处理 —— 漏登记的代价是多问一次 AI，不是错搬一整站', () => {
  // 这条是本模块的核心设计决定。若哪天把默认反过来，
  // 每新增一个未登记域名都会被静默标 high，而那正是本模块要消灭的东西。
  for (const h of ['some-new-site.example', 'random-blog.cn', 'unknown.dev', 'foo.bar.baz']) {
    assert.equal(isAuthorityDomain(h), false, `${h} 未登记，不得当成权威站`);
    assert.equal(isMultiPurposeDomain(h), true);
    assert.equal(confidenceForDomain(h), 'medium');
  }
});

test('⚠️ 明知的坑必须标成多用途', () => {
  for (const h of ['github.com', 'notion.so', 'medium.com', 'csdn.net', 'stackoverflow.com']) {
    assert.equal(isMultiPurposeDomain(h), true, `${h} 是多用途站`);
    assert.equal(confidenceForDomain(h), 'medium');
  }
});

test('⚠️ 权威站保持 high —— 词典的判断是真的，不进 LLM 精判', () => {
  for (const h of ['developer.mozilla.org', 'reactjs.org', 'docs.docker.com', 'dev.mysql.com']) {
    assert.equal(isAuthorityDomain(h), true, `${h} 应为权威站`);
    assert.equal(isMultiPurposeDomain(h), false);
    assert.equal(confidenceForDomain(h), 'high');
  }
});

// ───────────────── 卫生检查 ─────────────────

test('⚠️ 两份清单不得重叠 —— 重叠会让「走不走 LLM」不可预测', () => {
  const dup = overlappingDomains();
  assert.deepEqual(dup, [], `清单重叠：${dup.join(', ')}`);
});

test('清单里不得有非法域名（空串、带协议、带路径、带空格）', () => {
  for (const d of [...AUTHORITY_DOMAINS, ...MULTI_PURPOSE_DOMAINS]) {
    assert.ok(d && typeof d === 'string', '域名必须是非空字符串');
    assert.ok(!/^[a-z]+:\/\//i.test(d), `${d} 不该带协议`);
    assert.ok(!d.includes('/'), `${d} 不该带路径`);
    assert.ok(!/\s/.test(d), `${d} 不该含空格`);
    assert.equal(d, d.toLowerCase(), `${d} 必须小写`);
  }
});

test('权威清单内部不得有重复项', () => {
  assert.equal(new Set(AUTHORITY_DOMAINS).size, AUTHORITY_DOMAINS.length);
});

test('脏输入按多用途处理，不炸', () => {
  for (const h of ['', null, undefined, 0]) {
    assert.equal(isAuthorityDomain(h), false);
    assert.equal(isMultiPurposeDomain(h), true);
    assert.equal(confidenceForDomain(h), 'medium');
  }
});

test('大小写不敏感', () => {
  assert.equal(isAuthorityDomain('ReactJS.org'), true);
  assert.equal(isAuthorityDomain('GITHUB.COM'), false);
});

// ───────────────── 与词典的实际联动 ─────────────────

test('⚠️ 接进 rules 后：多用途站降 medium，权威站仍 high，且 to 不变', () => {
  // 降的只能是置信度，**分类结果本身不能变** —— 否则就不是「更谨慎」而是「改错了」。
  const multi = matchRule({ url: 'https://github.com/vuejs/core', title: 'x' }, compiled);
  assert.equal(multi.reason, 'rule:domain');
  assert.equal(multi.confidence, 'medium');
  assert.equal(multi.to, '开发与技术/代码托管', '分类结果不得因降级而改变');

  const auth = matchRule({ url: 'https://vuejs.org/guide/', title: 'x' }, compiled);
  assert.equal(auth.confidence, 'high');
});

test('⚠️ 低置信闸门对多用途站真正生效：medium 不是 low，但必须不再被当 high 直接搬走', () => {
  // medium 会进 LLM 精判队列（见 plan.js），所以它不该落进
  // needsConfirm 的 low 分支；但也绝不能是 high —— 那样闸门就形同虚设。
  const r = matchRule({ url: 'https://github.com/x/y', title: 'x' }, compiled);
  assert.notEqual(r.confidence, 'high');
  assert.notEqual(r.confidence, 'low', 'medium 才有资格送 LLM 精判；落成 low 就该被闸门扣下');
});