/**
 * CredentialStore —— 把「key 从哪来、存在哪」收敛到一个契约后面。
 *
 * ⚠️ 本模块 import `storage.js`（因此间接依赖 chrome.storage），
 *    但**不 import vendor 产物**。单测给 chrome 装替身即可在 Node 下直接跑。
 *
 * ═══ 契约（对齐 pi-ai 的 CredentialStore）═══
 *   read(providerId)        → 凭据或 undefined
 *   list()                  → 只有 `{ providerId, type }` 元数据，**绝不含密钥**
 *   modify(providerId, fn)  → 唯一的写入口，串行读-改-写
 *   delete(providerId)      → 删掉该 provider 的凭据
 *
 * ═══ 三个 key 来源，优先级不可颠倒 ═══
 *   1. 按 providerId 单独存的凭据（新）
 *   2. 设置项里的 `settings.apiKey`（旧，单值）
 *   3. `src/llm-key.local.js` 注入的环境变量 key
 *
 * 第 2 条看着多余，但删掉它就是一次真实的用户可见回退：
 * 改造前所有人的手填 key 都躺在 `settings.apiKey` 里，
 * 改造后若只认新的按 providerId 存储，**所有存量用户会突然变成「没有 key」**。
 *
 * ⚠️ **本模块最硬的一条不变量**：
 *    从环境变量注入的 key 只在内存里参与解析，**任何路径都不得写进 storage**。
 *    写进去就等于把一个「本机生成、从不进版本库」的密钥
 *    搬进一个会被备份/同步的扩展存储里。`tests/unit/credential-store.test.js`
 *    与 `tests/product_falsification.py` 里的退化用例都钉死这一条。
 */

import { get, mutate, K } from '../storage.js';
import { providerForBaseUrl } from './provider-registry.js';

/** 手填 key 的空值判定：空白串与 null 都不算「配过」 */
function normalizeKey(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {{getSettings:()=>Promise<object>, getInjected:()=>Promise<{apiKey?:string,baseUrl?:string}|null>}} deps
 */
export function createCredentialStore(deps) {
  const getSettings = deps.getSettings;
  const getInjected = deps.getInjected;

  async function readAll() {
    const raw = await get(K.AI_CREDENTIALS, {});
    return raw && typeof raw === 'object' ? raw : {};
  }

  return {
    /**
     * 读某 provider 的凭据。
     * @param {string} providerId
     * @returns {Promise<{type:string, key:string, source:string}|undefined>}
     */
    async read(providerId) {
      const id = String(providerId || '');
      if (!id) return undefined;

      // ① 按 providerId 存的
      const all = await readAll();
      const own = all[id];
      if (own && normalizeKey(own.key)) {
        return { type: 'api_key', key: normalizeKey(own.key), source: 'manual' };
      }

      const [settings, injected] = await Promise.all([
        Promise.resolve().then(getSettings).catch(() => ({})),
        Promise.resolve().then(getInjected).catch(() => null),
      ]);

      // ② 旧设置项里的单值：仅当它对应的 baseUrl 就是本 provider 时才算
      const legacy = normalizeKey(settings && settings.apiKey);
      if (legacy && providerForBaseUrl(settings && settings.baseUrl)?.id === id) {
        return { type: 'api_key', key: legacy, source: 'manual' };
      }

      // ③ 环境变量注入：只在内存里用，绝不落盘
      const envKey = normalizeKey(injected && injected.apiKey);
      const envOwner = envKey ? providerForBaseUrl(injected.baseUrl)?.id : null;
      if (envOwner === id) return { type: 'api_key', key: envKey, source: 'env' };

      return undefined;
    },

    /**
     * 枚举已配置的凭据。
     * ⚠️ 只返回元数据。库明确要求「枚举不得解析密钥或执行取密钥命令」——
     *    这里连 key 的值都不读，调用方想知道有没有配过，看这个就够。
     * @returns {Promise<Array<{providerId:string, type:string}>>}
     */
    async list() {
      const [all, settings, injected] = await Promise.all([
        readAll(),
        Promise.resolve().then(getSettings).catch(() => ({})),
        Promise.resolve().then(getInjected).catch(() => null),
      ]);
      const out = [];
      const seen = new Set();
      for (const [providerId, cred] of Object.entries(all)) {
        if (cred && normalizeKey(cred.key)) {
          out.push({ providerId, type: 'api_key' });
          seen.add(providerId);
        }
      }
      const legacyOwner = normalizeKey(settings && settings.apiKey)
        ? providerForBaseUrl(settings && settings.baseUrl)?.id
        : null;
      if (legacyOwner && !seen.has(legacyOwner)) out.push({ providerId: legacyOwner, type: 'api_key' });
      const envOwner = normalizeKey(injected && injected.apiKey)
        ? providerForBaseUrl(injected.baseUrl)?.id
        : null;
      if (envOwner && !seen.has(envOwner)) out.push({ providerId: envOwner, type: 'api_key' });
      return out;
    },

    /**
     * 唯一的写入口。串行读-改-写由 `storage.js` 的 mutate 保证。
     * @param {string} providerId
     * @param {(cur:{type:string,key:string}|undefined)=>({type:string,key:string}|undefined)} fn
     */
    async modify(providerId, fn) {
      const id = String(providerId || '');
      if (!id) throw new Error('modify 需要 providerId');
      return mutate(K.AI_CREDENTIALS, (cur) => {
        const map = cur && typeof cur === 'object' ? cur : {};
        const nextCred = typeof fn === 'function' ? fn(map[id]) : undefined;
        const next = { ...map };
        if (!nextCred || !normalizeKey(nextCred.key)) delete next[id];
        else next[id] = { type: 'api_key', key: normalizeKey(nextCred.key) };
        return next;
      }, {});
    },

    /** @param {string} providerId */
    async delete(providerId) {
      return this.modify(providerId, () => undefined);
    },

    /**
     * 写入手填 key。这是面板「保存」走的那条路。
     * ⚠️ 传空串等于「清除该 provider 的凭据」，不是「什么都不做」——
     *    后者会让用户删不掉 key。
     */
    async writeManual(providerId, key) {
      return this.modify(providerId, () => (normalizeKey(key) ? { type: 'api_key', key: normalizeKey(key) } : undefined));
    },
  };
}

/**
 * 列出所有已登记的 provider 中，哪些配了凭据 —— 面板状态用。
 * 只回 providerId，不回 key。
 * @param {object} store
 * @param {import('./provider-registry.js').PROVIDERS} providers
 * @returns {Promise<{providerId:string, hasKey:boolean}[]>}
 */
export async function credentialStatus(store, providers) {
  const list = await store.list();
  const known = new Set(list.map((x) => x.providerId));
  return (providers || []).map((p) => ({ providerId: p.id, hasKey: known.has(p.id) }));
}
