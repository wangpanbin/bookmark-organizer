/**
 * 语义去重的编排：取正文 → 批量 embedding → 建议合并。
 *
 * ⚠️ 这个模块会 fetch 出网，属于写操作模块。
 *
 * ═══ 处置被拍成最保守的一档，不要往上调 ═══
 * D6：结果**只进「建议合并」，永不进删除清单**。
 * 理由在 `semantic.js` 顶部：embedding 判错的概率天然比 URL 归一化高一个量级，
 * 而「误删你真收藏的内容」在这个项目里是最贵的错误。
 * 现有的逐条否决机制（`K.DEDUPE_VETO`，按条目 id 记）可以原样复用。
 */

import { get, set, K } from '../storage.js';import { suggestMerges, buildEmbeddingText, pickKeeper, cosine } from './semantic.js';
import { embedAll, MAX_BATCH } from './embedding-client.js';

/** 向量存哪。⚠️ 不进 storage.local：800 × 1024 维按 JSON 数存是 ~8MB 的字符串，
 *  每次读写都要整体序列化。用 IndexedDB 存 Float32Array 才是对的。 */
const VEC_DB = 'bo-vectors';
const VEC_STORE = 'vectors';

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(VEC_DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(VEC_STORE)) r.result.createObjectStore(VEC_STORE);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function putVectors(idToVec) {
  const db = await openDb();
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction(VEC_STORE, 'readwrite');
      const store = tx.objectStore(VEC_STORE);
      for (const [id, vec] of Object.entries(idToVec)) {
        store.put(Float32Array.from(vec), id);
      }
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

async function getVectors(ids) {
  const db = await openDb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(VEC_STORE, 'readonly');
      const store = tx.objectStore(VEC_STORE);
      const out = {};
      let pending = ids.length;
      if (!pending) return res(out);
      for (const id of ids) {
        const rq = store.get(id);
        rq.onsuccess = () => { out[id] = rq.result; if (--pending === 0) res(out); };
        rq.onerror = () => { if (--pending === 0) res(out); };
      }
    });
  } finally {
    db.close();
  }
}

/** 建议合并的列表存在哪 */
const MERGE_KEY = 'dedupe:semantic';

/**
 * 跑一轮语义去重，产出「建议合并」清单。
 *
 * @param {Array<{id:string,url:string,title?:string,path?:string[],dateAdded?:number}>} items
 * @param {{apiKey:string, baseUrl?:string, texts?:Map<string,string>, threshold?:number, onProgress?:Function}} opts
 *   texts: id → 正文摘要（F3 归档出来的）。有它时用「标题+正文」，没有就只用标题。
 * @returns {Promise<{suggestions:Array, embedded:number, reason?:string}>}
 */
export async function runSemanticDedupe(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { suggestions: [], embedded: 0, reason: '没有可比较的条目' };
  if (!opts.apiKey) {
    return { suggestions: [], embedded: 0, reason: '没配 embedding 的 API key，语义去重已跳过（URL 归一化去重不受影响）' };
  }

  // ① 取已有的，没取的才去算 —— 800 条每次全量 embedding 是浪费
  const ids = list.map((x) => String(x.id));
  const have = await getVectors(ids).catch(() => ({}));
  const missing = list.filter((x) => !have[String(x.id)]);

  if (missing.length) {
    const texts = missing.map((x) => buildEmbeddingText(x, { text: opts.texts?.get(String(x.id)) }));
    opts.onProgress?.({ stage: 'embedding', done: 0, total: missing.length, batches: Math.ceil(missing.length / MAX_BATCH) });
    const vecs = await embedAll(texts, {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      onProgress: (p) => opts.onProgress?.({ stage: 'embedding', ...p }),
    });
    const add = {};
    missing.forEach((x, i) => { add[String(x.id)] = vecs[i]; have[String(x.id)] = vecs[i]; });
    await putVectors(add).catch(() => {});
  }

  // ② 比对
  const suggestions = suggestMerges(list, have, { threshold: opts.threshold });
  for (const s of suggestions) {
    s.keeper = pickKeeper(s.a, s.b);
    s.loser = s.keeper === s.a ? s.b : s.a;
    // ⚠️ 面板上要能一眼看出「为什么判成同内容」，
    //    否则一个 0.93 的数字对用户毫无意义
    s.evidence = {
      score: Number(s.score.toFixed(4)),
      sameTitle: String(s.a.title || '').trim() === String(s.b.title || '').trim(),
      fromText: !!opts.texts?.get(String(s.a.id)) && !!opts.texts?.get(String(s.b.id)),
    };
  }

  // 刻意**不**在这里回写 settings。早先有一行
  // `await set(K.SETTINGS, {...DEFAULT_SETTINGS, ...(await get(K.SETTINGS, {}))})`
  // 看着像「保存配置」，其实是**读-改-写绕过了 storage.js 的 mutate 串行锁**，
  // 而且它的内容等于原值 —— 一次没有任何效果的写操作。
  // 无效果的写比不写更糟：它看起来像做了点事。
  await set(MERGE_KEY, { at: Date.now(), suggestions });
  return { suggestions, embedded: missing.length };
}

/** 读上次的建议清单 */
export async function getSuggestions() {
  return (await get(MERGE_KEY, null)) || { at: 0, suggestions: [] };
}

/** 清掉向量缓存（换了模型或维度之后必须清，否则新旧向量混在一起比） */
export async function clearVectors() {
  const db = await openDb();
  try {
    await new Promise((res) => {
      const tx = db.transaction(VEC_STORE, 'readwrite');
      tx.objectStore(VEC_STORE).clear();
      tx.oncomplete = res;
    });
  } finally {
    db.close();
  }
  await set(MERGE_KEY, { at: 0, suggestions: [] });
}

/** 相似度自检：给两个 id 看它们的分数（面板调试用） */
export async function similarityOf(aId, bId) {
  const v = await getVectors([String(aId), String(bId)]).catch(() => ({}));
  return cosine(v[String(aId)], v[String(bId)]);
}
