/**
 * LLM 兜底层的单测：key 解析优先级、origin 推导、JSON 解析、提示词约束。
 *
 * 关键契约：**从环境变量注入的 key 不能落进 storage**，且面板手填优先。
 * 这条一旦破了，就等于把 key 写进了可能被备份/同步的扩展存储。
 *
 * ⚠️ llm.js 里有 chrome.permissions / fetch，这些在 Node 下不存在。
 *    本文件只测不依赖 chrome 的纯逻辑；涉及权限的分支用替身覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 替身必须在 import llm.js 之前装好
const permissionState = { contains: false, requested: false, removed: false };
globalThis.chrome = {
  permissions: {
    contains: async () => permissionState.contains,
    request: async () => { permissionState.requested = true; return permissionState.contains; },
    remove: async () => { permissionState.removed = true; return true; },
  },
};

const L = await import('../../src/classify/llm.js');

test('originPatternOf 从 base URL 推出 host_permissions 模式', () => {
  assert.equal(L.originPatternOf('https://api.deepseek.com'), 'https://api.deepseek.com/*');
  assert.equal(
    L.originPatternOf('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/*',
  );
  assert.equal(L.originPatternOf('不是 URL'), '', '非法 URL 应返回空串而不是抛异常');
  assert.equal(L.originPatternOf(''), '');
});

test('默认配置指向 DeepSeek 且 LLM 默认开启', async () => {
  const cfg = await L.resolveConfig({});
  assert.equal(cfg.llmEnabled, true, 'LLM 兜底应默认开启');
  assert.equal(cfg.baseUrl, 'https://api.deepseek.com');
  assert.equal(cfg.model, 'deepseek-flash');
});

test('面板显式关闭时，resolveConfig 尊重它', async () => {
  const cfg = await L.resolveConfig({ llmEnabled: false });
  assert.equal(cfg.llmEnabled, false);
});

/**
 * 注入文件是否在本机存在。
 *
 * ⚠️ 这条判据必须由**文件系统**推导，不能写死。
 *    早先这里断言的是 `keySource === 'none'`（固定值），
 *    看起来像在测「没有 key 时的行为」，实际是**把 bug 固化成了期望**：
 *    llm.js 里的动态 import 路径错了一级，注入文件永远读不到，
 *    于是无论本机有没有跑过 inject_key.py，keySource 都是 'none'，
 *    这条断言恒绿 —— 闸门就这样替 bug 打了掩护。
 *    现在改成按磁盘实际情况推导：文件在，就必须读得到。
 */
const INJECTED_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'llm-key.local.js');
const injectedExists = existsSync(INJECTED_FILE);

test('没有面板 key 时：注入文件在就必须被读到，读不到才是 none', async () => {
  const cfg = await L.resolveConfig({});
  if (injectedExists) {
    // 本机注入过 key —— 读不到就是 bug（历史上就是这样坏的）
    assert.equal(cfg.keySource, 'env',
      `注入文件存在（${INJECTED_FILE}）但 keySource=${cfg.keySource} —— `
      + '注入的 key 又没被读到，LLM 兜底会一直静默跳过');
    assert.notEqual(cfg.apiKey, '', '注入文件存在却拿到空 key');
    assert.ok(cfg.injectedLoadedFrom,
      '没记录是从哪个路径读到的 —— 面板上无法自证「为什么读不到 key」');
  } else {
    assert.equal(cfg.keySource, 'none');
    assert.equal(cfg.apiKey, '');
  }
});

test('⚠️ 面板手填的 key 优先，keySource=manual', async () => {
  const cfg = await L.resolveConfig({ apiKey: 'sk-manual', baseUrl: 'https://x.example', model: 'm' });
  assert.equal(cfg.apiKey, 'sk-manual');
  assert.equal(cfg.keySource, 'manual');
  assert.equal(cfg.baseUrl, 'https://x.example', '面板填的 base URL 不该被默认值覆盖');
  assert.equal(cfg.model, 'm');
});

test('面板的空白值回落默认值，不产生空串 base URL', async () => {
  const cfg = await L.resolveConfig({ baseUrl: '   ', model: '  ' });
  assert.equal(cfg.baseUrl, 'https://api.deepseek.com');
  assert.equal(cfg.model, 'deepseek-flash');
});

test('parseJsonArray：剥代码块、从噪声里抠数组', () => {
  assert.deepEqual(L.parseJsonArray('[{"key":"a","to":"A/B"}]'), [{ key: 'a', to: 'A/B' }]);
  assert.deepEqual(
    L.parseJsonArray('```json\n[{"key":"a","to":"A/B"}]\n```'),
    [{ key: 'a', to: 'A/B' }],
  );
  assert.deepEqual(
    L.parseJsonArray('好的，结果如下：\n[{"key":"a","to":"A/B"}]\n希望有帮助'),
    [{ key: 'a', to: 'A/B' }],
  );
  assert.equal(L.parseJsonArray('没有数组'), null);
  assert.equal(L.parseJsonArray('[{"坏的":}]'), null, '非法 JSON 返回 null 而不是抛异常');
  assert.equal(L.parseJsonArray(null), null);
});

test('buildPrompt 把完整类目树写进 system，并禁止自造类目', () => {
  const taxonomy = [
    { name: '开发与技术', children: ['前端', '后端'] },
    { name: '其他', children: ['待归类'] },
  ];
  const { system, user } = L.buildPrompt([{ key: 'k1', url: 'https://a.com', title: 'A' }], taxonomy);

  assert.match(system, /开发与技术：前端、后端/);
  assert.match(system, /其他：待归类/);
  assert.match(system, /绝对不许发明新分类/, '必须显式禁止模型自造类目');
  assert.match(system, /返回空数组/, '必须给模型一条「不确定就不猜」的出路');
  assert.match(user, /key=k1/);
  assert.match(user, /https:\/\/a\.com/);
});

test('buildPrompt 对无标题条目有兜底文案', () => {
  const { user } = L.buildPrompt([{ key: 'k', url: 'https://a.com', title: '' }], [
    { name: '其他', children: ['待归类'] },
  ]);
  assert.match(user, /\(无标题\)/);
});

test('buildPrompt 容忍空 taxonomy（至少能发请求）', () => {
  const { system, user } = L.buildPrompt([{ key: 'k', url: 'https://a.com', title: 't' }], []);
  assert.ok(system.length > 0);
  assert.match(user, /k/);
});

test('validateAssignments 丢掉模型自造的类目', () => {
  const taxonomy = [{ name: '其他', children: ['待归类'] }];
  const known = (t, p) => {
    const [a, b] = String(p).split('/');
    return t.some((x) => x.name === a && (x.children || []).includes(b));
  };
  const { valid, dropped } = L.validateAssignments(
    { k1: '其他/待归类', k2: '瞎编的类目/瞎编的子类', k3: '完全不存在/子类' },
    taxonomy,
    known,
  );
  assert.deepEqual(valid, { k1: '其他/待归类' });
  assert.deepEqual(dropped.sort(), ['完全不存在/子类', '瞎编的类目/瞎编的子类']);
});

test('MODEL_PRESETS 全部是合法 base URL，且不包含已弃用的 deepseek-chat 作默认', () => {
  assert.ok(L.MODEL_PRESETS.length >= 3);
  for (const p of L.MODEL_PRESETS) {
    assert.doesNotThrow(() => new URL(p.baseUrl), `base URL 非法: ${p.baseUrl}`);
    assert.ok(typeof p.model === 'string' && p.model.length > 0);
  }
  assert.equal(L.DEFAULT_MODEL, 'deepseek-flash');
  assert.notEqual(
    L.DEFAULT_MODEL,
    'deepseek-chat',
    'deepseek-chat 已公告于 2026-07-24 弃用，不能作默认值',
  );
});

test('权限三件套都走 optional host_permissions 派生的 origin', async () => {
  permissionState.contains = true;
  assert.equal(await L.hasLlmPermission('https://api.deepseek.com'), true);
  permissionState.contains = false;
  assert.equal(await L.hasLlmPermission('https://api.deepseek.com'), false);
  assert.equal(await L.hasLlmPermission('非法 URL'), false, '非法 base URL 不该去要权限');
});

test('面板没填 key 时 classifyBatch 给出可操作提示', async () => {
  const res = await L.classifyBatch([{ key: 'k', url: 'https://a.com', title: 't' }], {
    taxonomy: [{ name: '其他', children: ['待归类'] }],
    settings: { llmEnabled: true, baseUrl: 'https://api.deepseek.com', model: 'm', apiKey: '' },
  });
  assert.deepEqual(res.assignments, {});
  assert.equal(res.asked, 0);
  assert.equal(res.errors.length, 1);
  // 走到哪个分支取决于本机有没有注入 key（见上面 injectedExists 的说明），
  // 两条分支的提示都必须可操作 —— 不能出现「什么都没说就跳过」。
  if (injectedExists) {
    assert.match(res.errors[0], /尚未授予|访问权限/,
      '本机有注入 key 时应提示去授权域名，而不是谎称没有 key');
  } else {
    assert.match(res.errors[0], /inject_key\.py|没有 API key/, '提示要说清怎么配');
  }
});

test('LLM 关闭时：不发请求，但必须说清「AI 根本没参与」', async () => {
  // ⚠️ 2026-10-07 改了语义。早先是**一个字都不报**地 return，
  //    后果是「AI 没参与」与「AI 说不知道」在界面上长得一模一样 ——
  //    用户看到「其他/待归类」里躺着一批书签，无从判断是模型拒答还是压根没问。
  //    而这正是「AI 过滤了」这种怀疑的来源之一，所以现在必须留痕。
  const res = await L.classifyBatch([{ key: 'k', url: 'https://a.com', title: 't' }], {
    taxonomy: [], settings: { llmEnabled: false, apiKey: 'sk-x' },
  });
  assert.equal(res.asked, 0, '关掉了就不该发请求');
  assert.deepEqual(res.assignments, {});
  assert.equal(res.skipped, 'llm-disabled', '必须能分辨「关掉了」与「没配 key」');
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /LLM 兜底已关闭/, '要说清是关闭，不是失败');
});

test('strict 提示词：强制每条都给一个最接近的分类', async () => {
  const items = [{ key: 'k1', url: 'https://a.com', title: 't' }];
  const tax = [{ name: '开发', children: ['前端'] }];

  const normal = L.buildPrompt(items, tax);
  assert.match(normal.system, /返回空数组/, '默认模式必须保留「不确定就留白」');

  const strict = L.buildPrompt(items, tax, { strict: true });
  assert.ok(!/若没有任何一个合适，就返回空数组/.test(strict.system),
    'strict 模式还留着「返回空数组」这条，等于没换提示词');
  assert.match(strict.system, /每一条都必须给出一个分类/);
  assert.match(strict.system, /最接近/);
});

test('undecided 与 malformed：模型的沉默和残缺输出要分开记账', async () => {
  // parseJsonArray / callOnce 都在真实请求里，Node 下跑不到。
  // 这里直接验证 buildPrompt 的输入契约与记账口径的关键前提：
  // undecided 的来源是「模型没提到这条」，malformed 是「提到了但缺字段」。
  // 两者混在一起的话，界面会把「输出格式坏了」当成「模型不愿意答」，
  // 于是「换个提示词再问一次」这个药方就下错了。
  const { system, user } = L.buildPrompt(
    [{ key: 'k1', url: 'https://a.com', title: 'A' }, { key: 'k2', url: 'https://b.com', title: 'B' }],
    [{ name: '开发', children: ['前端'] }],
    { strict: true },
  );
  assert.match(user, /key=k1/);
  assert.match(user, /key=k2/);
  assert.match(system, /返回的条数必须与输入条数一致/,
    'strict 必须要求条数一致，否则模型照样可以悄悄漏掉几条');
});

test('空条目列表不发请求', async () => {
  const res = await L.classifyBatch([], {
    taxonomy: [], settings: { llmEnabled: true, apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com' },
  });
  assert.equal(res.batches, 0);
  assert.deepEqual(res.assignments, {});
});
