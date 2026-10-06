/**
 * 语义去重（F2）与归档客户端（F3）的单测。
 *
 * F2 的核心断言只有一条方向：**结果永不进删除清单**。
 * 那是 D6 拍板的，理由是 embedding 判错的概率天然比 URL 归一化高一个量级。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function installChromeStub() {
  const store = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return Object.fromEntries(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (store.has(k)) out[k] = clone(store.get(k));
          return out;
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, clone(v)); },
        async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
      },
    },
  };
  return { store };
}
const stub = installChromeStub();
beforeEach(() => { stub.store.clear(); });

const SEM = await import('../../src/dedupe/semantic.js');
const EC = await import('../../src/dedupe/embedding-client.js');
const AC = await import('../../src/archive/client.js');
const { DEFAULT_SETTINGS } = await import('../../src/storage.js');

// ═══════════ 余弦与阈值 ═══════════

test('cosine 边界情况不抛异常', () => {
  assert.equal(SEM.cosine([1, 0], [1, 0]), 1);
  assert.equal(SEM.cosine([1, 0], [0, 1]), 0);
  assert.equal(SEM.cosine([1, 0], [-1, 0]), -1);
  assert.equal(SEM.cosine([], []), 0, '空向量不该抛');
  assert.equal(SEM.cosine([1, 2], [1]), 0, '维度不等不该抛');
  assert.equal(SEM.cosine([0, 0], [1, 1]), 0, '零向量不该抛除零');
  assert.equal(SEM.cosine(null, [1]), 0);
});

test('⚠️ 阈值默认 0.92 —— 宁可漏判不要误判', () => {
  // 用**跨站**的两条：同站且标题无重合的会被粗筛砍掉，那条另有一个用例在钉。
  // 跨站镜像/转载正是这个功能最大的价值所在。
  const items = [
    { id: 'a', url: 'https://docs.example.com/guide', title: '安装指南' },
    { id: 'b', url: 'https://mirror.other.com/guide', title: '安装指南' },
  ];
  const v = { a: [1, 0, 0], b: [0.95, 0.31, 0] }; // cos ≈ 0.9507
  assert.equal(SEM.suggestMerges(items, v).length, 1, '0.95 相似度应该命中');
  const mid = { a: [1, 0, 0], b: [0.9, 0.44, 0] }; // cos ≈ 0.898
  assert.equal(SEM.suggestMerges(items, mid).length, 0, '0.90 低于阈值，不该判成重复');
  // 显式阈值可调（面板上要能调）
  assert.equal(SEM.suggestMerges(items, mid, { threshold: 0.85 }).length, 1);
});

test('⚠️ 没有向量的条目不参与判定，不瞎猜', () => {
  const items = [
    { id: 'a', url: 'https://x.com/1', title: '安装指南' },
    { id: 'b', url: 'https://y.com/2', title: '安装指南' },
  ];
  assert.equal(SEM.suggestMerges(items, { a: [1, 0] }).length, 0, 'b 没有向量却判成重复了');
  assert.equal(SEM.suggestMerges(items, {}).length, 0);
});

test('粗筛：同站且标题毫无重合的直接砍掉', () => {
  const items = [
    { id: 'a', url: 'https://x.com/1', title: 'Vue 3 组合式 API' },
    { id: 'b', url: 'https://x.com/2', title: 'PostgreSQL 索引优化' },
  ];
  assert.deepEqual(SEM.candidatePairs(items), [], '同站但标题完全不同的不该进候选');

  // 但跨站的镜像/转载**不能**被砍 —— 那是这个功能最大的价值所在
  const mirror = [
    { id: 'a', url: 'https://docs.example.com/guide', title: '安装指南' },
    { id: 'b', url: 'https://mirror.other.com/guide', title: '安装指南' },
  ];
  assert.equal(SEM.candidatePairs(mirror).length, 1, '跨站同内容被粗筛砍掉了');
});

test('pickKeeper 复用 dedupe 的语义：路径浅 → 早收藏 → id', () => {
  const a = { id: 'z', path: ['书签栏'], dateAdded: 200 };
  const b = { id: 'a', path: ['书签栏', '收集箱'], dateAdded: 100 };
  assert.equal(SEM.pickKeeper(a, b), a, '已深度归类的（路径浅）该保留');
  assert.equal(SEM.pickKeeper(b, a), a, '顺序不该影响结果');

  const c = { id: 'b', path: ['x'], dateAdded: 100 };
  const d = { id: 'a', path: ['x'], dateAdded: 100 };
  assert.equal(SEM.pickKeeper(c, d), d, '完全并列时按 id 定，保证幂等');
});

test('buildEmbeddingText 有正文摘要就用，没有就退回标题', () => {
  const item = { title: '标题', url: 'https://a.com/p' };
  assert.match(SEM.buildEmbeddingText(item), /标题/);
  assert.match(SEM.buildEmbeddingText(item), /a\.com/);
  assert.doesNotMatch(SEM.buildEmbeddingText(item), /undefined/);

  const withBody = SEM.buildEmbeddingText(item, { text: '这是归档出来的正文摘要' });
  assert.match(withBody, /这是归档出来的正文摘要/);
  // 正文超长要截断 —— 8192 token/条是官方硬限制
  const long = SEM.buildEmbeddingText(item, { text: 'x'.repeat(5000) });
  assert.ok(long.length <= 1200, `太长了：${long.length}`);
});

// ═══════════ embedding 客户端 ═══════════

test('⚠️ 单批超过 10 条要本地就拦下来 —— 官方硬限制，超了是 400', () => {
  assert.equal(EC.MAX_BATCH, 10);
  assert.equal(EC.chunk(Array.from({ length: 23 }, (_, i) => i)).length, 3);
  assert.deepEqual(EC.chunk(Array.from({ length: 10 }, (_, i) => i))[0].length, 10);
  assert.deepEqual(EC.chunk([]), []);
});

test('embedOnce 超过批量上限时抛错，而不是发出去拿 400', async () => {
  await assert.rejects(
    () => EC.embedOnce(new Array(11).fill('x'), { apiKey: 'k' }),
    /单次最多 10 条/,
  );
});

test('embedOnce 按 index 排序返回，不假设响应顺序', async () => {
  globalThis.fetch = async () => ({
    status: 200, ok: true,
    async text() {
      return JSON.stringify({
        data: [
          { index: 1, embedding: [2, 2] },
          { index: 0, embedding: [1, 1] },
        ],
      });
    },
  });
  const v = await EC.embedOnce(['a', 'b'], { apiKey: 'k', baseUrl: 'https://api.deepseek.com' });
  assert.deepEqual(v, [[1, 1], [2, 2]], '顺序错了 → 向量和条目对不上，后果是乱判重复');
});

test('embedOnce 的 401 复用百炼区域提示，而不是笼统说 key 无效', async () => {
  globalThis.fetch = async () => ({
    status: 401, ok: false, async text() { return '{"message":"InvalidApiKey"}'; },
  });
  await assert.rejects(
    () => EC.embedOnce(['a'], { apiKey: 'k', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }),
    /区域强绑定/,
  );
});

// ═══════════ 阈值接缝 ═══════════

test('⚠️ background.js 的 semanticRun 真的把 semanticThreshold 传下去了', async () => {
  // 这是一条**接缝**断言，不是单测。
  //
  // 「相似度阈值」滑块以前渲染了、存了、显示成有效设置，但 `background.js`
  // 调 runSemanticDedupe 时**不传 threshold** → `semantic.js:123` 永远用硬编码
  // 0.92。两轴评审各自独立撞上这一条（Standards 记 S2，Spec 记 P1-1），
  // 共同点是：unit test 全绿，因为 `suggestMerges` 的 threshold 参数**本身是对的**
  // —— 错的是没人给它值。
  //
  // 为什么用静态断言而不是跑起来验：`runSemanticDedupe` 要联网调 embedding，
  // 而「不传 threshold」这件事在**联网之前**就已经决定了。
  // 为验一行参数是否被传去搭一套假 embedding 服务，是本末倒置。
  // reachability 闸门也解决不了：它查「名字在别处出现过」，一行 import 就能满足。
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { stripComments } = await import('../helpers/sourceScan.js');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const bg = stripComments(readFileSync(resolve(root, 'src', 'background.js'), 'utf8'));
  const m = bg.match(/semanticRun:\s*async[\s\S]*?\n {2}\},\n/);
  assert.ok(m, 'background.js 里找不到 semanticRun 处理器的边界 —— 判据得跟着代码改');
  const body = m[0];
  assert.match(body, /threshold\s*:\s*[^,]*semanticThreshold/,
    'semanticRun 没有把 semanticThreshold 传给 runSemanticDedupe —— '
    + '面板上的阈值滑块改不动任何一条建议，而单测照样全绿');
  // 反向：实参里不该出现第二个 threshold 把前者盖掉
  assert.equal((body.match(/\bthreshold\s*:/g) || []).length, 1,
    'semanticRun 里出现了多个 threshold，后者会盖掉前者');

  // 另一头也要钉住：suggestMerges 真的认这个参数
  // （否则上面那个断言会变成「传了但没用」的恒真）
  const mid = { a: [1, 0, 0], b: [0.9, 0.44, 0] }; // cos ≈ 0.898
  const items = [
    { id: 'a', url: 'https://docs.example.com/g', title: '安装指南' },
    { id: 'b', url: 'https://mirror.other.com/g', title: '安装指南' },
  ];
  assert.equal(SEM.suggestMerges(items, mid, { threshold: 0.95 }).length, 0,
    '阈值 0.95 下不该命中 —— 说明 suggestMerges 忽略了 threshold');
  assert.equal(SEM.suggestMerges(items, mid, { threshold: 0.85 }).length, 1,
    '阈值 0.85 下该命中 —— 说明 suggestMerges 忽略了 threshold');
});

// ═══════════ 归档客户端 ═══════════

test('归档：接收器在线时报告写入成功', async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/health')) {
      return { ok: true, status: 200, async json() { return { ok: true, written: 7, dir: 'D:\\a' }; } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, file: 'x.html' }); } };
  };
  assert.equal((await AC.probeSink()).online, true);
  const r = await AC.archiveOne({ url: 'https://a.com/p', html: '<html>x</html>', title: 'T' });
  assert.equal(r.ok, true);
  assert.equal(r.file, 'x.html');
  assert.equal(AC.getSinkStatus().online, true);
});

test('⚠️ 接收器离线要明说，不静默假装存了', async () => {
  // 「以为存了其实没存」是本项目栽过最多的那类坑。
  // 归档是「防链接腐烂」的全部价值所在，静默降级等于功能不存在。
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await AC.probeSink()).online, false);
  const r = await AC.archiveOne({ url: 'https://a.com/p', html: '<html>x</html>' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /archive_sink\.py/, '没告诉用户怎么把接收器起起来');
});

test('归档：没有正文就跳过，不当成错误', async () => {
  const r = await AC.archiveOne({ url: 'https://a.com/p', html: '' });
  assert.equal(r.skipped, true);
});

test('默认设置里 link-scan 与语义去重都是关的', () => {
  // ⚠️ 默认开启 = 装上就静默联网上千个域名，用户从 Network 面板看到的就是「偷偷联网上」。
  assert.equal(DEFAULT_SETTINGS.linkScanEnabled, false);
  assert.equal(DEFAULT_SETTINGS.linkScanIntervalMinutes, 360);
  assert.equal(DEFAULT_SETTINGS.linkScanConcurrency, 6);
  // 这两项曾经**根本没定义**，而 background.js 读的是 `s.linkScanAiFind !== false`
  // —— undefined !== false 恒为 true，「AI 找新地址」变成无条件常开且没人能关。
  assert.equal('linkScanAiFind' in DEFAULT_SETTINGS, true,
    'linkScanAiFind 不在 DEFAULT_SETTINGS 里 —— 读它的代码会恒为真');
  assert.equal(DEFAULT_SETTINGS.linkScanAiFind, false);
  assert.equal('semanticDedupeEnabled' in DEFAULT_SETTINGS, true,
    'semanticDedupeEnabled 不在 DEFAULT_SETTINGS 里');
  assert.equal(DEFAULT_SETTINGS.semanticDedupeEnabled, false,
    '语义去重会把标题与正文摘要发给云端，必须显式开启');
  assert.equal(DEFAULT_SETTINGS.semanticThreshold, 0.92);
});
