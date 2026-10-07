/**
 * 分类准确率度量。
 * ⚠️ 纯函数模块：不得 import chrome API，不得直接碰 storage。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SAMPLE, REASSIGN_THRESHOLD,
  buildSnapshot, evaluate, trend,
} from '../../src/classify/metrics.js';

const stats = (planned, total = planned) => ({ total, planned, byReason: {} });

// ───────────────── 快照 ─────────────────

test('⚠️ 改判率的分母是 planned，不是 total', () => {
  // 用 total 当分母的话，一次都没要动的低置信轮次会凭空拉低比率，
  // 于是「什么都没做」反而得满分 —— 与「闸门必须能被恒真实现骗过」同一个坑。
  const s = buildSnapshot({ total: 100, planned: 10 }, 5, 0);
  assert.equal(s.reassignRate, 0.5, '5/10 而不是 5/100');
  const s2 = buildSnapshot({ total: 1000, planned: 0 }, 0, 0);
  assert.equal(s2.reassignRate, 0, 'planned 为 0 时不得除零，也不得变成 NaN');
});

test('脏输入不得产出 NaN —— 一个 NaN 指标比没有指标更危险', () => {
  for (const [st, n] of [[null, undefined], [{}, NaN], [{ planned: 'x' }, 'y'], [undefined, -5]]) {
    const s = buildSnapshot(st, n, 0);
    assert.ok(Number.isFinite(s.reassignRate), `${JSON.stringify(st)} 产出了非法比率`);
    assert.ok(Number.isFinite(s.planned));
    assert.ok(Number.isFinite(s.total));
  }
});

test('快照不持有调用方的对象引用', () => {
  const byReason = { a: 1 };
  const s = buildSnapshot({ planned: 5, byReason }, 0, 0);
  byReason.a = 99;
  assert.equal(s.byReason.a, 1, '改了原对象不该影响已记下的快照');
});

// ───────────────── 判定：小样本不报红 ─────────────────

test(`⚠️ 样本不足 ${MIN_SAMPLE} 条时不报红 —— 误报的闸门会被学会忽略`, () => {
  const s = buildSnapshot(stats(MIN_SAMPLE - 1), MIN_SAMPLE - 1, 0);
  assert.equal(s.enough, false);
  const ev = evaluate(s);
  assert.equal(ev.ok, true, '5 条样本上 100% 改判率也不该报红');
  assert.match(ev.reason, /样本/, '必须说清是样本不足，否则用户以为它没生效');
});

test(`样本达到 ${MIN_SAMPLE} 条才启用阈值`, () => {
  const s = buildSnapshot(stats(MIN_SAMPLE), MIN_SAMPLE, 0);
  assert.equal(s.enough, true);
});

test('⚠️ 样本足够且改判率超阈值 → 必须报红', () => {
  const n = MIN_SAMPLE;
  const s = buildSnapshot(stats(n), Math.ceil(n * (REASSIGN_THRESHOLD + 0.1)), 0);
  assert.equal(s.enough, true);
  const ev = evaluate(s);
  assert.equal(ev.ok, false, '样本够还超阈值，不报红等于闸门不存在');
  assert.match(ev.reason, /超过/);
});

test('样本足够且改判率达标 → 绿，且给出真实数字', () => {
  const n = MIN_SAMPLE * 4;          // 120
  const s = buildSnapshot(stats(n), 1, 0);   // 1/120 = 0.83%
  assert.equal(evaluate(s).ok, true);
  assert.match(evaluate(s).reason, /改判率 0\.8%/);
});

test('evaluate 必须同时给出「为什么不报红」，不能只返回一个布尔', () => {
  const noData = evaluate(null);
  assert.equal(noData.ok, true);
  assert.ok(noData.reason, '必须能说清为什么');
});

// ───────────────── 趋势 ─────────────────

test('trend 取最近 n 轮并按新到旧排', () => {
  const h = [1, 2, 3, 4, 5, 6].map((i) => ({ ts: i, planned: 10, reassignRate: i / 10 }));
  const t = trend(h, 3);
  assert.deepEqual(t.map((x) => x.ts), [6, 5, 4]);
});

test('trend 容忍脏历史', () => {
  assert.deepEqual(trend(null, 3), []);
  assert.deepEqual(trend([null, {}, { reassignRate: 'x' }], 3).map((x) => x.rate), [0, 0, 0]);
});

test('⚠️ 阈值与样本量必须是导出的常量，不许散落成魔法数', () => {
  // 闸门自身要能被调整；写成函数里的字面量就没人找得到、也没人敢改。
  assert.ok(Number.isFinite(MIN_SAMPLE) && MIN_SAMPLE > 0);
  assert.ok(Number.isFinite(REASSIGN_THRESHOLD) && REASSIGN_THRESHOLD > 0 && REASSIGN_THRESHOLD < 1);
});