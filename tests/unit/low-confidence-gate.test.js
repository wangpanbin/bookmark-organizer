/**
 * 低置信执行闸门：低置信条目默认不执行。
 *
 * ═══ 这道闸门守的是什么 ═══
 *
 * 面板早就把低置信标黄了（options.css 的 tr.is-low），也给了「只看低置信」
 * 的筛选开关，但**标黄不拦人**。用户在 apply.js 里 grep `confidence`
 * 得到 0 个命中 —— 执行侧唯一的状态过滤是 `status === 'pending'`，
 * 于是低置信和高置信被无差别批量搬走。
 *
 * 「未分类」那一批兜底桶同样是 `low`，此前被静默搬进「其他/待归类」，
 * 用户看到的是「整理完成 100%」，而那些条目其实是被硬塞的。
 *
 * ⚠️ 双层防护，缺一不可：
 *   ① 运行时断言：summarize 必须报出 awaitingConfirm 的条数
 *      —— 静默吞掉等于「假装拦住了」。
 *   ② 源码静态扫描：执行循环里必须真的存在低置信转态的分支。
 *      只测 summarize 的话，一个把过滤写在别处（或根本没写）的实现
 *      也能全绿 —— 静态扫描是防恒真的那只手。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, needsConfirm } from '../../src/apply.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const applySrc = readFileSync(join(REPO, 'src', 'apply.js'), 'utf8');

// ───────────────────── ① 运行时：报告必须说清 ─────────────────────

test('⚠️ summarize 必须报出「本轮没执行、等确认」的条数', () => {
  const s = summarize({
    status: 'done',
    plan: {
      items: [
        { id: '1', status: 'done', confidence: 'high' },
        { id: '2', status: 'awaiting-confirm', confidence: 'low', title: 'T2', url: 'u2', toStr: '其他/待归类' },
        { id: '3', status: 'awaiting-confirm', confidence: 'low', title: 'T3', url: 'u3', toStr: '其他/待归类' },
      ],
    },
  });
  assert.equal(s.awaitingConfirm, 2, '等确认的条数必须露出来，不能吞掉');
  assert.equal(s.awaitingConfirmList.length, 2);
  assert.equal(s.awaitingConfirmList[0].title, 'T2');
  assert.ok(s.awaitingConfirmList[0].to, '要显示它本该去哪，用户才知道值不值得确认');
});

test('全部执行完时 awaitingConfirm 为 0，不许虚报', () => {
  const s = summarize({
    status: 'done',
    plan: { items: [{ id: '1', status: 'done', confidence: 'high' }] },
  });
  assert.equal(s.awaitingConfirm, 0);
  assert.deepEqual(s.awaitingConfirmList, []);
});

test('空计划不炸', () => {
  const s = summarize({ status: 'idle' });
  assert.equal(s.awaitingConfirm, 0);
  assert.equal(s.total, 0);
});

// ───────────────────── ② 判据本身：直接断言行为 ─────────────────────

test('⚠️ needsConfirm 只对 low 为真 —— 这是闸门的全部语义', () => {
  // ⚠️ 这条是真正的「防恒真」测试。早先这里只有一条静态扫描
  //    `applySrc.includes('needsConfirm(')`，把函数体改成 `return false`
  //    （闸门彻底失效）后它照样全绿 —— 名字在、调用在、检查在，
  //    唯独判据被掏空了。静态扫描守不了语义，语义必须直接断言行为。
  for (const c of ['high', 'medium', 'low', undefined, null, '', 'LOW', 'low ']) {
    const item = c === null || c === undefined ? { confidence: c } : { confidence: c };
    assert.equal(
      needsConfirm(item),
      c === 'low',
      `confidence=${JSON.stringify(c)} 时的判定必须符合预期`,
    );
  }
  assert.equal(needsConfirm(null), false, '空输入不得当成低置信');
  assert.equal(needsConfirm(undefined), false);
});

test('⚠️ 「未分类」兜底桶必须落在闸门内（它历史上被静默塞进待归类）', () => {
  // plan.js 给未分类条目的就是 confidence:'low'。若哪天把兜底桶改成
  // medium，这条断言会红 —— 那正是我们要知道的：未分类又变成静默硬塞了。
  assert.equal(needsConfirm({ confidence: 'low', reason: 'unclassified' }), true);
});

// ───────────────────── ③ 静态：守顺序与落点（不是语义） ─────────────────────

test('⚠️ 执行循环里必须存在低置信转态分支（防「只报不拦」）', () => {
  // 汇总能报出 awaitingConfirm，不等于执行时真的拦了 —— 一个把过滤写在
  // 报告里、move() 照旧全跑的实现，上面那几条照样全绿。这条守的是落点。
  // 注意它只守**位置**（代码在不在执行循环里、排序对不对），
  // 语义由 ② 里对 needsConfirm 的行为断言负责。两者分工明确。
  assert.match(
    applySrc,
    /status\s*===?\s*'pending'\s*&&\s*needsConfirm\(/,
    '低置信判定必须挂在 pending 上：已转态的不能被重复处理（幂等）',
  );
  assert.match(
    applySrc,
    /status:\s*AWAITING_CONFIRM/,
    '必须真的把状态写成 awaiting-confirm',
  );
});

test('⚠️ 低置信转态必须落盘，不能只在内存里过滤', () => {
  // MV3 SW 空闲 30 秒即被回收，续跑是新进程从 storage 读回 task。
  // 若这一步不落盘，「这批要确认」会在回收时丢，恢复后又被当成 pending 搬走。
  assert.match(
    applySrc,
    /persistItem\([\s\S]{0,120}AWAITING_CONFIRM/,
    '转态必须走 persistItem 落进 task payload',
  );
  assert.match(
    applySrc,
    /AWAITING_CONFIRM\s*=\s*'awaiting-confirm'/,
    '状态字面量必须与 summarize 统计用的是同一个常量',
  );
});

test('⚠️ 转态必须发生在取待办项之前 —— 顺序错了闸门就是摆设', () => {
  // 取 next 之后再过滤，move() 仍会先搬走第一条低置信项。
  const gateAt = applySrc.indexOf('needsConfirm(');
  const nextAt = applySrc.indexOf("items.find((i) => i.status === 'pending')");
  assert.ok(gateAt > 0, '闸门代码必须在');
  assert.ok(nextAt > 0, '取待办项的代码必须在');
  assert.ok(
    gateAt < nextAt,
    `闸门(${gateAt}) 必须排在取待办项(${nextAt}) 之前，否则会先搬走一条再拦`,
  );
});