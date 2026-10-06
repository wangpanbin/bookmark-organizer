/**
 * CredentialStore 单测。
 *
 * 替身沿用 `storage.test.js` 的那套（带可注入延迟来制造真实并发）——
 * 重复造一个更差的替身没有意义，而两份替身漂移会让「并发丢更新」这条判据失真。
 *
 * 本文件钉死两条：
 *   ① **注入的 key 永不出现在 storage**（安全不变量）
 *   ② modify 的读-改-写全程持锁（并发 50 次不丢更新）
 *   ③ 旧设置项里的单值 key 仍然认（否则所有存量用户会突然变成「没有 key」）
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** 与 storage.test.js 同款的最小替身 */
function installChromeStub(opts = {}) {
  const store = new Map();
  const delay = opts.delayMs || 0;
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (keys == null) return Object.fromEntries(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (store.has(k)) out[k] = clone(store.get(k));
          return out;
        },
        async set(obj) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          for (const [k, v] of Object.entries(obj)) store.set(k, clone(v));
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
  };
  return store;
}

const stub = installChromeStub({ delayMs: 1 });
const { createCredentialStore, credentialStatus } = await import('../../src/ai/credential-store.js');
const { K } = await import('../../src/storage.js');
const { PROVIDERS } = await import('../../src/ai/provider-registry.js');

/** 造一个可控的 store 依赖 */
function makeStore({ settings = {}, injected = null } = {}) {
  return createCredentialStore({
    getSettings: async () => settings,
    getInjected: async () => injected,
  });
}

const SECRET = 'sk-injected-must-never-persist';

// ⚠️ 必须清空：替身是模块级的，一个 Map 被所有用例共用。
//    早先漏了这一步，前面的用例写进 deepseek 的 'sk-manual' 泄漏到后面，
//    于是「注入的 key 读不到」这类断言会以 'sk-manual' 失败 ——
//    红灯的含义被前一个用例污染，看起来像实现坏了，其实是用例没隔离。
beforeEach(() => { stub.clear(); });

test('手填的 key 能写能读，来源标记为 manual', async () => {
  const s = makeStore();
  await s.writeManual('deepseek', '  sk-manual  ');
  const got = await s.read('deepseek');
  assert.equal(got.key, 'sk-manual', '空白应当被裁掉');
  assert.equal(got.source, 'manual');
  assert.equal(got.type, 'api_key');
});

test('⚠️ 注入的 key 可以在内存里读到，但绝不写进 storage', async () => {
  const s = makeStore({ injected: { apiKey: SECRET, baseUrl: 'https://api.deepseek.com' } });

  const got = await s.read('deepseek');
  assert.equal(got.key, SECRET, '注入的 key 必须能被读到，否则面板会谎称「没有 key」');
  assert.equal(got.source, 'env');

  // 判据是 storage 里**根本不存在**这个字符串，不是「读回来是空」
  const raw = JSON.stringify(Object.fromEntries(stub.entries()));
  assert.ok(
    !raw.includes(SECRET),
    `注入的 key 出现在了 storage 里：${raw} —— `
    + '这把一个「本机生成、从不进版本库」的密钥搬进了会被备份/同步的扩展存储',
  );
  const creds = stub.get(K.AI_CREDENTIALS);
  assert.equal(creds, undefined, '只读不写时，storage 里不该凭空多出 ai:credentials');
});

test('写入手填 key 不会把注入的 key 一起带进去', async () => {
  const s = makeStore({ injected: { apiKey: SECRET, baseUrl: 'https://api.deepseek.com' } });
  await s.read('deepseek'); // 先触发一次注入路径
  await s.writeManual('deepseek', 'sk-manual');
  const stored = stub.get(K.AI_CREDENTIALS);
  assert.equal(stored.deepseek.key, 'sk-manual');
  assert.ok(!JSON.stringify(stored).includes(SECRET));
});

test('面板手填优先于注入（两级来源的顺序不可颠倒）', async () => {
  const s = makeStore({ injected: { apiKey: SECRET, baseUrl: 'https://api.deepseek.com' } });
  await s.writeManual('deepseek', 'sk-manual');
  assert.equal((await s.read('deepseek')).key, 'sk-manual');
});

test('注入的 key 只属于它自己的端点，不会串到别家', async () => {
  const s = makeStore({ injected: { apiKey: SECRET, baseUrl: 'https://api.deepseek.com' } });
  assert.equal(await s.read('openai'), undefined, 'DeepSeek 的注入 key 不该被 OpenAI 读走');
  assert.equal(await s.read('dashscope'), undefined);
});

test('旧设置项里的单值 key 仍然认 —— 否则存量用户会突然变成「没有 key」', async () => {
  const s = makeStore({
    settings: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-legacy' },
  });
  const got = await s.read('deepseek');
  assert.equal(got.key, 'sk-legacy');
  assert.equal(got.source, 'manual');
});

test('旧设置项的 key 不会串到别的 provider', async () => {
  const s = makeStore({ settings: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-legacy' } });
  assert.equal(await s.read('openai'), undefined);
});

test('自定义端点（不在注册表里）的旧 key 认不出来，但也不能被别家拿走', async () => {
  const s = makeStore({ settings: { baseUrl: 'https://x.example', apiKey: 'sk-custom' } });
  for (const p of PROVIDERS) {
    assert.equal(await s.read(p.id), undefined, `自定义端点的 key 不该落到 ${p.id} 上`);
  }
});

test('modify 是唯一的写入口，并发 50 次不丢更新', async () => {
  const s = makeStore();
  const ids = Array.from({ length: 50 }, (_, i) => `p${i}`);
  await Promise.all(ids.map((id) => s.writeManual(id, `sk-${id}`)));
  for (const id of ids) {
    const got = await s.read(id);
    assert.equal(got.key, `sk-${id}`, `${id} 的 key 丢了 —— mutate 没持住串行锁`);
  }
});

test('modify 传空 key 等于清除（用户要能删掉 key）', async () => {
  const s = makeStore();
  await s.writeManual('deepseek', 'sk-x');
  await s.writeManual('deepseek', '');
  assert.equal(await s.read('deepseek'), undefined, '删不掉的 key 比没有 key 更气人');
});

test('delete 移除凭据', async () => {
  const s = makeStore();
  await s.writeManual('openai', 'sk-o');
  await s.delete('openai');
  assert.equal(await s.read('openai'), undefined);
});

test('list 只回元数据，绝不回密钥', async () => {
  const s = makeStore({ injected: { apiKey: SECRET, baseUrl: 'https://api.deepseek.com' } });
  await s.writeManual('openai', 'sk-o');
  const list = await s.list();
  const dumped = JSON.stringify(list);
  assert.ok(!dumped.includes(SECRET), 'list 泄露了注入的密钥');
  assert.ok(!dumped.includes('sk-o'), 'list 泄露了手填的密钥');
  assert.ok(list.every((x) => Object.keys(x).sort().join(',') === 'providerId,type'),
    `list 只应有 providerId/type，实际: ${dumped}`);
  const ids = list.map((x) => x.providerId).sort();
  assert.deepEqual(ids, ['deepseek', 'openai'], '注入的与手填的都要能被枚举到');
});

test('list 不重复枚举同一个 provider', async () => {
  const s = makeStore({
    settings: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-legacy' },
  });
  await s.writeManual('deepseek', 'sk-newer');
  const ids = (await s.list()).map((x) => x.providerId);
  assert.equal(ids.filter((x) => x === 'deepseek').length, 1, `重复枚举: ${ids.join(',')}`);
});

test('空 providerId 一律不认，不返回空凭据对象', async () => {
  const s = makeStore({ injected: { apiKey: SECRET, baseUrl: 'https://api.deepseek.com' } });
  assert.equal(await s.read(''), undefined);
  assert.equal(await s.read(null), undefined);
});

test('credentialStatus 覆盖全部已登记供应商，且不泄露密钥', async () => {
  const s = makeStore({ injected: { apiKey: SECRET, baseUrl: 'https://api.deepseek.com' } });
  await s.writeManual('openai', 'sk-o');
  const st = await credentialStatus(s, PROVIDERS);
  assert.equal(st.length, PROVIDERS.length);
  assert.ok(!JSON.stringify(st).includes(SECRET));
  assert.ok(!JSON.stringify(st).includes('sk-o'));
  assert.equal(st.find((x) => x.providerId === 'deepseek').hasKey, true);
  assert.equal(st.find((x) => x.providerId === 'openai').hasKey, true);
  assert.equal(st.find((x) => x.providerId === 'dashscope').hasKey, false);
});
