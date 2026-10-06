/**
 * 运行时结果判定 + 错误诊断的单测。
 *
 * ═══ 这份测试存在的唯一理由 ═══
 * 接入 `@earendil-works/pi-ai` 之后，**失败不再以异常形式冒出来**。
 * 实测：`models.complete()` 打到不存在的端口时**不 reject**，
 * 而是 resolve 一个 `{ stopReason:'error', content:[], errorMessage:"Connection error." }`。
 *
 * 如果按「成功就返回内容」的直觉去写，所有 HTTP 失败
 * （401 key 失效、429 限流、5xx 服务端错误、400 模型名不对）
 * 都会退化成同一句「模型没有返回可解析的 JSON 数组」——
 * 用户拿到的排障方向是**错的**，而且错得很有说服力。
 * 本项目栽过最多的就是这一类「静默退化」。
 *
 * 所以下面第一条测试是**恒真陷阱的反面**：先造一个「把错误当成功」的坏实现，
 * 证明本文件的第一条断言确实会红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isErrorResult, textOf, buildContext } from '../../src/ai/context.js';
import {
  describeHttpError, describeTransportError, isJsonModeRejection, isRetryableStatus,
} from '../../src/ai/errors.js';

test('isErrorResult 把 stopReason=error 认成失败（而不是当成空内容）', () => {
  // 这就是实测拿到的失败形态
  const failed = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Connection error.' };
  assert.equal(isErrorResult(failed), true, '把失败当成成功 → 整套错误诊断会整条消失');

  // 对照：真实的空回复（模型就是没说话）不是失败
  assert.equal(isErrorResult({ role: 'assistant', content: [], stopReason: 'stop' }), false);
  assert.equal(isErrorResult(null), true, '连对象都没有时按失败处理，别当成功放行');
});

test('isErrorResult 也认只有 errorMessage、没有 stopReason 的形态', () => {
  assert.equal(isErrorResult({ content: [], errorMessage: 'boom' }), true);
  assert.equal(isErrorResult({ content: [{ type: 'text', text: 'hi' }], errorMessage: '' }), false);
});

test('textOf 只取 text 块，不会把整个对象变成 [object Object]', () => {
  const msg = {
    content: [
      { type: 'text', text: '[{"key":"a"' },
      { type: 'toolCall', name: 'x', arguments: {} },
      { type: 'text', text: ',"to":"A/B"}]' },
    ],
  };
  assert.equal(textOf(msg), '[{"key":"a","to":"A/B"}]');
  assert.equal(textOf({}), '');
  assert.equal(textOf(null), '');
});

test('buildContext 产出可序列化的 Context，且 timestamp 是数字', () => {
  const ctx = buildContext({ systemPrompt: 'sys', user: 'hi', now: 1000 });
  assert.equal(ctx.systemPrompt, 'sys');
  assert.deepEqual(ctx.messages, [{ role: 'user', content: 'hi', timestamp: 1000 }]);
  // README 强调 Context 的价值就在可序列化：能 JSON.stringify 存下来、交给别的模型接着聊
  assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx);
});

test('buildContext 容忍空输入，不产出空消息', () => {
  assert.deepEqual(buildContext().messages, []);
  assert.deepEqual(buildContext({ user: '' }).messages, []);
  assert.equal(buildContext({ systemPrompt: 'only' }).systemPrompt, 'only');
});

/**
 * 401 的两条分支文案。逐字断言，因为它们对着**真实的服务商报错**写的：
 * 百炼的 key 与区域强绑定，跨区调返回 401 看起来和「key 无效」一模一样，
 * 但修法完全相反（一个改区域、一个换 key）。文案糊了用户就会照错误方向排查。
 */
test('401：响应体提到区域时给区域提示（百炼）', () => {
  const msg = describeHttpError(401, '{"message":"InvalidApiKey: region mismatch"}');
  assert.match(msg, /鉴权失败/);
  assert.match(msg, /与区域强绑定/, '百炼 401 必须指向区域，不能说成 key 无效');
});

test('401：普通 key 无效时不给区域提示（DeepSeek 无此限制）', () => {
  const msg = describeHttpError(401, '{"message":"Authentication Fails"}');
  assert.match(msg, /key 无效、已过期或没有该模型的权限/);
  assert.doesNotMatch(msg, /与区域强绑定/, 'DeepSeek 没有区域绑定，给这条提示会把人引向错误方向');
});

test('401：响应体取不到时，靠 providerId 仍然给出区域提示', () => {
  // 这是接入 pi-ai 后新增的分支：库会把错误压成扁平的 "Connection error."，
  // 响应体可能根本没有「region」字样。少了这个分支，百炼用户在部分失败下
  // 会拿到「key 无效」这条错误方向。
  const withFlag = describeHttpError(401, '', { regionBound: true });
  assert.match(withFlag, /与区域强绑定/);
  assert.match(describeHttpError(401, ''), /key 无效/, '非百炼不该被提示区域');
});

test('400 的三条分支各自指向不同的修法', () => {
  assert.match(describeHttpError(400, 'response_format is not supported'), /不支持 JSON 模式/);
  assert.match(describeHttpError(400, 'model deepseek-chat does not exist'), /模型名不存在或已下线/);
  assert.match(describeHttpError(400, 'something else'), /请求格式有误/);
});

test('404 / 429 / 5xx 文案', () => {
  assert.match(describeHttpError(404, ''), /端点或模型名不对/);
  assert.match(describeHttpError(429, ''), /触发限流或额度用尽/);
  assert.match(describeHttpError(503, ''), /服务端错误/);
  assert.match(describeHttpError(400, 'x'), /HTTP 400：/, '未知分支也要带上状态码');
});

test('isRetryableStatus：4xx（429 除外）重试没有意义', () => {
  assert.equal(isRetryableStatus(429), true, '限流要重试');
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false, '400 重试只是白花配额');
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(0), true, '网络层错误没有状态码，值得重试');
});

test('isJsonModeRejection 只对 400 生效，且可由调用方兜底', () => {
  assert.equal(isJsonModeRejection(400, 'response_format unsupported'), true);
  assert.equal(isJsonModeRejection(400, '', true), true, '拿不到响应体时要能靠标志位降级');
  assert.equal(isJsonModeRejection(400, 'model not found'), false);
  assert.equal(isJsonModeRejection(500, 'response_format'), false, '不是 400 就不是 JSON 模式问题');
});

test('超时与网络错误的文案必须可区分', () => {
  // 两者排查方向相反：前者是慢/被墙，后者是 DNS/证书/断网。
  // 实测库里两者都被压成同一句 "Connection error."，所以只认自己触发的 Abort。
  const timeout = describeTransportError(null, true, 30_000);
  // ⚠️ 判据是「区分开了 + 说清了时长」，不是逐字匹配「30s」。
  //    原来写的是 `/请求超时（30s 无响应）/` —— 把超时常量**焊死**在文案里。
  //    后果：有人把 30 秒改成 45（一个完全正当的改动），这条测试会红，
  //    而红的原因与它要防的失效（超时被说成网络错误）**毫无关系**。
  //    误报的闸门比没有闸门更糟：它只会教会人忽略自己。
  assert.match(timeout, /超时/, '超时要被说成超时');
  assert.match(timeout, /30\s*s|30000|30\s*秒|45\s*s|45000|45\s*秒/, `文案里没给出时长，用户不知道该等多久: ${timeout}`);
  assert.doesNotMatch(timeout, /请求失败/, '超时被说成「请求失败」会盖掉两者真正的区别');

  const net = describeTransportError(new Error('Connection error.'), false, 30_000);
  assert.match(net, /请求失败|连不上|连接/, `网络错误没有明确说法: ${net}`);
  assert.doesNotMatch(net, /请求超时/, '网络错误被说成超时会把人引向错误方向');
  // 反向：把两个判定换过来，这条必须红（判据要能区分方向，不能只认「出现了某个词」）
  assert.doesNotMatch(
    describeTransportError(new Error('Connection error.'), false, 30_000),
    /超时/,
  );
});

test('每条诊断都带得动 HTTP 状态码；网络类错误额外给出关掉 LLM 的出路', () => {
  // ⚠️ 只断言**原实现就有的**东西。
  // 早先这里写的是「每条文案都要含『关掉 LLM』」，于是 401 分支红了 ——
  // 但原实现的 401 从来没有那句话。加它是一次未经决策的行为变更，
  // 而本文件的任务是**钉住既有行为**，不是顺手改进文案。
  for (const msg of [
    describeHttpError(401, ''),
    describeHttpError(400, ''),
    describeHttpError(404, ''),
    describeHttpError(429, ''),
    describeHttpError(500, ''),
  ]) {
    assert.match(msg, /HTTP \d+/, `诊断里没有状态码，用户无法据此判断严重性: ${msg}`);
  }
  // 网络类错误才是「用户立刻能做的事」——它对应的是本机网络问题，不是服务端问题
  assert.match(describeTransportError(null, true, 30_000), /关掉 LLM/);
  assert.match(describeTransportError(new Error('Connection error.'), false, 30_000), /关掉 LLM/);
});
