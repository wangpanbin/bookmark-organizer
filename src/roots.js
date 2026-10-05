/**
 * 顶层根（书签栏 / 其他书签）的解析。
 *
 * ═══ 为什么必须有这个模块 ═══
 * 2026-10-05，用户 45 条书签全军覆没，45 条报的是同一句
 * `Can't find bookmark for id.`。而真实存储
 * （`User Data\Default\AccountBookmarks`）里那 45 个 id **一个都没失效**，
 * 计划里的 fromPath / toPath 也和真实文件夹逐个吻合 —— 计划本身完全正确。
 *
 * 根因：代码把「书签栏 = id '1'」当成了**常量**，写在三处：
 *   - `storage.js` 的默认值 `targetRoot: '1'`
 *   - `options.html` 的 `<option value="1">书签栏</option>`
 *   - `apply.js` 里按 '1' 去 getTree() 找、找不到就**兜底返回 '1'**
 *
 * 但**根 id 根本不是常量**。实测 Chrome 154（本机真实 profile）：
 *   经典书签模型：书签栏=1 / 其他书签=2 / 移动设备=3
 *   账号书签模型：书签栏=**279** / 其他书签=**280** / 移动设备=**281**
 *   （同时传统 `Bookmarks` 文件被清空，真实数据搬进了 `AccountBookmarks`）
 *
 * 于是 '1' 在 live tree 里查无此节点 → 兜底仍给 '1'
 * → `getChildren('1')` / `create({parentId:'1'})` 报「根节点不存在」
 * → **17 个分类文件夹一个都没建成**，45 条 move 全部撞同一堵墙，
 * 而 Chrome 那句原话对用户零信息量。
 *
 * ═══ 本模块的约定 ═══
 * 1. 设置里存**语义键**（'bar' / 'other'），**永远不存 id**。
 *    id 每次 Chrome 换书签模型都可能变，存下来就是一颗定时炸弹。
 * 2. 语义键 → 真实 id 靠**位置**：`getTree()[0].children` 的第 0 个恒为
 *    书签栏、第 1 个恒为其他书签 —— 两种模型实测顺序一致。
 *    根标题是本地化的（书签栏 / Bookmarks bar / ブックマークバー…），
 *    靠标题匹配换个语言就废，所以**不用标题**。
 * 3. 解析出来必须用 `chrome.bookmarks.get()` 实测存在性：
 *    `getTree()` 只是快照，`get()` 才是权威。
 *
 * 本模块只读 chrome.bookmarks，不写。它不属于写操作链，
 * 但仍不进 FORBIDDEN_IN_PURE_CHAIN —— plan.js 是纯函数，不能有 chrome 依赖。
 */

export const ROOT_BAR = 'bar';
export const ROOT_OTHER = 'other';

/** 第 3 个顶层根（移动设备书签）是只读的，move 进出会失败 */
export const MOBILE_ROOT_INDEX = 2;

/** 位置 → 语义键。下标越界就是只读根（key 为 null） */
const KEY_BY_INDEX = [ROOT_BAR, ROOT_OTHER];

/**
 * 从 getTree() 的返回值里抽出顶层根。
 *
 * 纯函数：Node 下可单测，不需要 chrome 替身。
 *
 * @param {chrome.bookmarks.BookmarkTreeNode[]} trees
 * @returns {Array<{id:string, title:string, key:string|null, readOnly:boolean}>}
 */
export function rootsFromTree(trees) {
  const root = Array.isArray(trees) ? trees[0] : null;
  const tops = Array.isArray(root?.children) ? root.children : [];
  return tops.map((t, i) => ({
    id: String(t?.id ?? ''),
    title: String(t?.title || ''),
    key: KEY_BY_INDEX[i] || null,
    readOnly: i >= MOBILE_ROOT_INDEX,
  }));
}

/**
 * 把设置里存的值翻译成语义键。
 *
 * ⚠️ 四段兜底的顺序是有讲究的：
 *   ① 已经是语义键 → 直接用
 *   ② **还活着的 id** → 按 id 认（不看数字大小）
 *      用户可能存过 '280'，它在 154 下是真实存在的「其他书签」
 *   ③ 旧版本写死的 '1' / '2' → 按位置语义翻译。
 *      经典模型里 1=书签栏、2=其他书签，154 里第 0/1 个位置也是这两个，
 *      所以这条映射在两种模型下都成立。
 *   ④ 认不出来（存的是别的 Chrome 版本的失效 id、或空）→ 书签栏。
 *      第 0 个根恒为书签栏，回落它是最安全的选择。
 *
 * @param {unknown} raw 设置里的原值
 * @param {Array<{id:string,key:string|null}>} roots 活的根列表
 * @returns {string} 'bar' | 'other'
 */
export function pickRootKey(raw, roots = []) {
  const v = raw === null || raw === undefined ? '' : String(raw);
  if (v === ROOT_BAR || v === ROOT_OTHER) return v;

  const byId = (roots || []).find((r) => r && String(r.id) === v && r.key);
  if (byId) return byId.key;

  if (v === '1') return ROOT_BAR;
  if (v === '2') return ROOT_OTHER;

  return ROOT_BAR;
}

/** 列出生效的顶层根（chrome 入口） */
export async function listRoots() {
  const trees = await chrome.bookmarks.getTree();
  return rootsFromTree(trees);
}

/**
 * 解析出真正可写的目标根，并**实测它存在**。
 *
 * ⚠️ 为什么要多这一次 get()：getTree() 是快照，用户可能在读之后
 *    拖走了文件夹、另一个扩展删了它、或者同步落地覆盖了。
 *    而「根 id 解析错」这件事一旦发生，后果是 45 条 move 报同一句话 ——
 *    所以宁可在动手前多花一次调用，也不让它变成 45 条一模一样的失败。
 *
 * 找不到 other 时会退回 bar：只有「其他书签」缺失而书签栏还在，
 *    与其拒绝执行不如整理到书签栏（用户点的是「执行整理」，
 *    面板上会显示实际归入位置）。
 *
 * @param {unknown} raw 设置里的原值
 * @returns {Promise<{ok:boolean, key:string, id:string|null, title:string, reason?:string}>}
 */
export async function resolveRoot(raw) {
  let roots = [];
  try {
    roots = await listRoots();
  } catch (e) {
    return { ok: false, key: ROOT_BAR, id: null, title: '', reason: `读不到书签树：${e && e.message ? e.message : e}` };
  }

  const key = pickRootKey(raw, roots);
  const hit = roots.find((r) => r.key === key) || (key === ROOT_OTHER ? roots.find((r) => r.key === ROOT_BAR) : null);
  if (!hit) {
    return { ok: false, key, id: null, title: '', reason: '书签树里没有「书签栏」这个顶层文件夹' };
  }

  // 权威判据：get() 拿不到就是真拿不到
  const node = await chrome.bookmarks.get(String(hit.id)).then((r) => (r && r[0]) || null).catch(() => null);
  if (!node) {
    return { ok: false, key: hit.key, id: String(hit.id), title: hit.title, reason: `顶层文件夹「${hit.title}」已不存在（id ${hit.id}）` };
  }

  return { ok: true, key: hit.key, id: String(node.id), title: String(node.title || hit.title) };
}
