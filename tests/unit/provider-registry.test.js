/**
 * provider 注册表单测。
 *
 * 这份注册表决定了「面板下拉里有什么」和「请求发到哪个协议」，
 * 两件事都是**错了不会立刻报错、只会返回莫名其妙的 404/400** 的类型：
 *   · 协议走错（openai-responses vs openai-completions）→ 服务端报「不认识的参数」
 *   · baseUrl 写错 → 404，而 404 的文案是「端点或模型名不对」，会把人引向模型名
 *   · 模型名从目录里消失 → 面板下拉空了，用户以为服务下线了
 * 所以这三个字段都要钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../helpers/sourceScan.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

import {
  PROVIDERS, MODEL_PRESETS, DEFAULT_PROVIDER_ID, DEFAULT_MODEL, DEFAULT_BASE_URL,
  getProvider, providerIds, modelsOf, originPatternOf, normalizeBaseUrl,
  providerForBaseUrl, resolveTarget, resolveJsonMode, supportsJsonMode,
} from '../../src/ai/provider-registry.js';

/**
 * 运行时真造得出可用 Model 的协议。
 *
 * 与 `provider-registry.js` 里的 `JSON_MODE_APIS` 是同一个集合，但不是同一个来源：
 * 这里的用途是「协议对不对」，那边是「这个协议认不认 response_format」。
 * 两者今天内容相同，**不要**直接 import 过去复用 ——
 * 一旦将来某个协议支持 JSON 输出却不是 OpenAI 形状，
 * 「能造出 Model」与「能吃 response_format」就该分开了。
 */
const SUPPORTED_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

test('每个 provider 都有可用的 base URL、协议与至少一个模型', () => {
  assert.ok(PROVIDERS.length >= 4, '供应商数量回退了 —— 用户选的「扩到更多供应商」没落地');
  for (const p of PROVIDERS) {
    assert.doesNotThrow(() => new URL(p.baseUrl), `${p.id} 的 baseUrl 非法: ${p.baseUrl}`);
    assert.ok(p.label, `${p.id} 没有显示名`);
    // ⚠️ 这条判据原来写死成「只有 openai-completions / openai-responses」。
    //    接入 MiniMax 后它会红 —— 但**原判据本身也是错的**，它把「协议」
    //    当成了「注册表里那两家」。真正的要求是「这个协议 runtime 造得出可用的 Model」，
    //    所以这里跟着 JSON_MODE_APIS 一起走（它就是当前真正支持的那几种）。
    //    把 anthropic-messages 从这里拿掉不会让任何东西坏，只会让 MiniMax
    //    在「下拉里能选、点了必失败」的状态下静默存在。
    assert.ok(
      SUPPORTED_APIS.includes(p.api),
      `${p.id} 的协议是 ${p.api} —— 运行时造不出可用的 Model，注册表就不该列它`,
    );
    assert.ok(p.models.length > 0, `${p.id} 一个模型都没有，面板下拉会是空的`);
    for (const m of p.models) assert.ok(m.id && m.name, `${p.id} 有个模型缺 id 或 name`);
  }
});

test('⚠️ MiniMax 走 anthropic-messages，且 baseUrl 带 /anthropic 后缀', () => {
  // 两处都实测自 node_modules 的 dist/providers/minimax-cn.js，不是记忆。
  //
  // ① 协议：写成 openai-completions 不会立刻报错，只会拿到莫名其妙的 400/404。
  // ② baseUrl：`https://api.minimaxi.com/anthropic` 才是 Anthropic 兼容端点。
  //    习惯性写成 `/v1` 会 404，而 404 的文案是「端点或模型名不对」——
  //    用户会去换模型名，而真正该改的是地址。方向完全带偏。
  const m = getProvider('minimax-cn');
  assert.ok(m, 'MiniMax 不在注册表里 —— 面板上选不到它');
  assert.equal(m.api, 'anthropic-messages');
  assert.equal(m.baseUrl, 'https://api.minimaxi.com/anthropic');
  assert.equal(m.factory, 'minimaxCnProvider');
  assert.ok(modelsOf('minimax-cn').some((x) => x.id === 'MiniMax-M3'),
    'MiniMax-M3 不在模型目录里（1M 上下文那个）');
  // 面板上是自由填写模型名的，所以自由填写也要能落到正确的协议上
  assert.equal(resolveTarget({ baseUrl: m.baseUrl, model: 'MiniMax-M2.7' }).api, 'anthropic-messages');
});

test('⚠️ 别给 anthropic-messages 注入 response_format', () => {
  // MiniMax 走 anthropic-messages，而 Anthropic 请求体里**没有** response_format，
  // 塞进去会被 400 拒。恢复路径有（isJsonModeRejection 嗅探后重试），
  // 但那意味着每次调用都先白吃一个 400，400 还会进错误统计。
  // 所以要在发出去之前就关掉。
  assert.equal(resolveJsonMode({ requested: true, api: 'anthropic-messages' }), false,
    '给 MiniMax 发了 response_format → 每次调用先吃一个 400');
  assert.equal(resolveJsonMode({ requested: undefined, api: 'anthropic-messages' }), false,
    '没显式请求也不能默认打开');
  // 原有四家一个都不能被误伤 —— 这条闸门要是写得太宽就是在制造新的静默故障
  for (const api of ['openai-completions', 'openai-responses']) {
    assert.equal(resolveJsonMode({ requested: true, api }), true, `${api} 的 JSON 模式被误关了`);
  }
  // 显式关掉仍然照关（调用方的意愿优先）
  assert.equal(resolveJsonMode({ requested: false, api: 'openai-completions' }), false);

  // 底层的「协议认不认这个字段」与「要不要开」是两条判据，钉住前者
  assert.equal(supportsJsonMode('anthropic-messages'), false);
  assert.equal(supportsJsonMode('openai-completions'), true);
  assert.equal(supportsJsonMode(''), false);
  assert.equal(supportsJsonMode(undefined), false);
});

test('⚠️ runtime.js 真的**调用**了 resolveJsonMode，而不是只 import 了它', () => {
  // 这条判据是补上一个实测出来的漏洞。
  //
  // `reachability.test.js` 查的是「这个名字在别的文件里出现过」。
  // 而 `import { resolveJsonMode } from './provider-registry.js'` 这一行
  // **本身就足以让它通过** —— 于是把调用点删掉、只留 import，那道闸门照样全绿。
  // 实测过：这么改之后 18 条相关单测一条没红。
  //
  // 而这里留一个没人调的纯函数是本项目最贵的失败模式：
  // 「JSON 模式闸门存在」看起来是真的，实际每个 MiniMax 用户仍在吃 400。
  //
  // 所以判据必须是「**被调用**」，不是「被提到」：找 `resolveJsonMode(`，
  // 括号是关键 —— 裸名字匹配会再次栽在 import 语句上。
  const runtimeSrc = stripComments(readFileSync(resolve(ROOT, 'src', 'ai', 'runtime.js'), 'utf8'));
  assert.match(
    runtimeSrc,
    /resolveJsonMode\s*\(/,
    'runtime.js 没有调用 resolveJsonMode —— 只 import 而不调用，'
    + 'MiniMax 每次调用都会先吃一个 400，而 reachability 闸门照样绿'
    + '（它只查「这个名字出现过」，import 语句就能满足它）。',
  );
  // 反向：不能只在文件里出现一次（那就是 import 本身）
  const hits = (runtimeSrc.match(/resolveJsonMode/g) || []).length;
  assert.ok(hits >= 2,
    `runtime.js 里 resolveJsonMode 只出现 ${hits} 次 —— `
    + '那只是 import，整个文件没有调用点。');
});

test('provider id 唯一 —— setProvider 按 id 覆盖，重复会让一家顶掉另一家', () => {
  const ids = providerIds();
  assert.equal(new Set(ids).size, ids.length, `provider id 重复: ${ids.join(', ')}`);
});

test('默认供应商在目录里，且默认模型属于该供应商', () => {
  const p = getProvider(DEFAULT_PROVIDER_ID);
  assert.ok(p, `默认供应商 ${DEFAULT_PROVIDER_ID} 不在注册表里`);
  assert.equal(p.baseUrl, DEFAULT_BASE_URL);
  assert.ok(
    modelsOf(DEFAULT_PROVIDER_ID).some((m) => m.id === DEFAULT_MODEL),
    `默认模型 ${DEFAULT_MODEL} 不在 ${DEFAULT_PROVIDER_ID} 的模型目录里`,
  );
});

test('百炼走 openai-completions 且标记为区域绑定', () => {
  // 百炼是本机实际在用的一家：它的 key 与区域强绑定，
  // 跨区调返回的 401 看起来和「key 无效」完全一样。
  // regionBound 标志驱动的是错误文案，不是功能开关 —— 漏了它，
  // 百炼用户会被引导去换 key，而真正要改的是区域。
  const q = getProvider('dashscope');
  assert.ok(q, '百炼不在注册表里');
  assert.equal(q.api, 'openai-completions');
  assert.equal(q.regionBound, true, '百炼漏了 regionBound —— 401 会给出错误的排障方向');
  assert.equal(q.factory, null, '百炼不该有内置工厂，库里没有它，走 createProvider 自建');
});

test('openai 是 openai-responses 而非 openai-completions', () => {
  // 实测结论，不是笔误。写错不会报错，只会拿到莫名其妙的 400。
  assert.equal(getProvider('openai').api, 'openai-responses');
});

test('originPatternOf 产出合法的 host 权限模式，非法输入返回空串', () => {
  assert.equal(originPatternOf('https://api.deepseek.com'), 'https://api.deepseek.com/*');
  assert.equal(
    originPatternOf('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/*',
  );
  assert.equal(originPatternOf('不是 URL'), '', '非法 URL 应返回空串，让设置页还能打开');
  assert.equal(originPatternOf(''), '');
});

test('baseUrl 末尾斜杠归一，避免「同一个端点认成两个」', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('  https://api.deepseek.com  '), 'https://api.deepseek.com');
  assert.equal(providerForBaseUrl('https://api.deepseek.com/')?.id, 'deepseek');
});

test('providerForBaseUrl 认不出的端点返回 null，而不是猜一家', () => {
  assert.equal(providerForBaseUrl('https://x.example'), null);
  assert.equal(providerForBaseUrl(''), null);
  assert.equal(providerForBaseUrl('不是 URL'), null);
});

test('resolveTarget 认不出的端点按 OpenAI 兼容处理，不报错', () => {
  // 改造前用户可以填任意 OpenAI 兼容端点，那是既有能力。
  // 认不出就报错 = 一次真实的用户可见回退。
  const t = resolveTarget({ baseUrl: 'https://x.example', model: 'm' });
  assert.equal(t.providerId, null);
  assert.equal(t.isCustom, true);
  assert.equal(t.api, 'openai-completions');
  assert.equal(t.regionBound, false);
  assert.equal(t.model, 'm');
});

test('resolveTarget 空白值回落到默认值，不产生空串 base URL', () => {
  const t = resolveTarget({ baseUrl: '   ', model: '  ' });
  assert.equal(t.baseUrl, DEFAULT_BASE_URL);
  assert.equal(t.model, DEFAULT_MODEL);
  assert.equal(t.providerId, DEFAULT_PROVIDER_ID);
});

test('deepseek-v4-flash 保留在预设里 —— 不在 pi-ai 目录中但一直可用', () => {
  // 实测：pi-ai 自带目录只有 deepseek-flash 与 deepseek-v4-pro。
  // 改造前 deepseek-v4-flash 就在面板下拉里，删掉是用户可见回退。
  // runtime.js 的 synthesizeModel 负责让它继续能调。
  const hit = MODEL_PRESETS.find((p) => p.model === 'deepseek-v4-flash');
  assert.ok(hit, 'deepseek-v4-flash 从预设里消失了');
  assert.equal(hit.baseUrl, 'https://api.deepseek.com');
});

test('MODEL_PRESETS 由注册表派生，每条都合法且带 providerId', () => {
  assert.ok(MODEL_PRESETS.length >= 3);
  for (const p of MODEL_PRESETS) {
    assert.doesNotThrow(() => new URL(p.baseUrl), `base URL 非法: ${p.baseUrl}`);
    assert.ok(typeof p.model === 'string' && p.model.length > 0);
    assert.ok(p.label, '预设没有 label，面板下拉会是空白项');
    assert.ok(getProvider(p.providerId), `预设指向了不存在的 provider: ${p.providerId}`);
    // 面板靠 `${baseUrl}::${model}` 当 option 的 value，值里出现 :: 会串行
    assert.ok(!String(p.baseUrl).includes('::') && !String(p.model).includes('::'));
  }
});

test('MODEL_PRESETS 与各 provider 的模型目录一一对应（防两份列表漂移）', () => {
  for (const p of PROVIDERS) {
    for (const m of p.models) {
      const found = MODEL_PRESETS.find((x) => x.providerId === p.id && x.model === m.id);
      assert.ok(found, `注册表里的 ${p.id}/${m.id} 没出现在 MODEL_PRESETS —— 下拉里选不到`);
      assert.equal(found.baseUrl, p.baseUrl);
    }
  }
});
