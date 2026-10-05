/**
 * 书签树读取与扁平化。
 *
 * flattenTree 是纯函数（不碰 chrome），可在 Node 下单测；
 * readTree 是唯一的 chrome 入口。
 *
 * ⚠️ 移动设备书签根（Chrome 恒为 id '3'）是只读的：move() 进去/出来都会失败。
 *    必须在扁平化阶段就标出来，而不是等执行时逐条失败。
 */

const SYNCED_ROOT_ID = '3';
const READ_ONLY_NAMES = ['移动设备书签', '移动设备', '手机书签', 'Mobile bookmarks'];

/**
 * 读整棵树。
 * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
 */
export async function readTree() {
  return chrome.bookmarks.getTree();
}

/**
 * 判断某个根节点是否只读。
 * @param {object} node
 * @returns {boolean}
 */
export function isReadOnlyRoot(node) {
  if (!node) return false;
  if (String(node.id) === SYNCED_ROOT_ID) return true;
  return READ_ONLY_NAMES.includes(String(node.title || '').trim());
}

/**
 * 把 getTree() 的结果扁平化成条目列表。
 *
 * @param {chrome.bookmarks.BookmarkTreeNode[]} trees getTree() 的返回值
 * @returns {Array<{id:string,type:string,title:string,url:string|null,parentId:string,path:string[],depth:number,dateAdded:number,dateLastUsed:number,index:number,readOnly:boolean}>}
 *          path 从根文件夹名开始，例：['其他书签'] 或 ['书签栏','开发与技术','前端']
 */
export function flattenTree(trees) {
  const out = [];
  const root = Array.isArray(trees) ? trees[0] : null;
  const tops = Array.isArray(root?.children) ? root.children : [];

  const walk = (node, path, parentId, depth, readOnly) => {
    if (!node) return;
    out.push({
      id: String(node.id),
      type: node.url ? 'url' : 'folder',
      title: node.title || '',
      url: node.url || null,
      parentId: String(parentId),
      path: path.slice(),
      depth,
      dateAdded: Number(node.dateAdded) || 0,
      dateLastUsed: Number(node.dateLastUsed) || 0,
      index: Number(node.index) || 0,
      readOnly,
    });
    const children = Array.isArray(node.children) ? node.children : [];
    for (const c of children) {
      walk(c, [...path, node.title || ''], node.id, depth + 1, readOnly);
    }
  };

  for (const top of tops) {
    walk(top, [], top.id === SYNCED_ROOT_ID ? '0' : '-1', 0, isReadOnlyRoot(top));
  }
  return out;
}

/**
 * 读 + 扁平化，一步到位。
 * @returns {Promise<Array>}
 */
export async function readFlatTree() {
  return flattenTree(await readTree());
}

/** 只要书签条目（type === 'url'） */
export function urlEntries(entries) {
  return (entries || []).filter((e) => e.type === 'url');
}

/** 只要文件夹条目 */
export function folderEntries(entries) {
  return (entries || []).filter((e) => e.type === 'folder');
}

/**
 * 用已有条目列表按 id 反查某节点的完整路径。
 * @param {Array} entries flattenTree 的结果
 * @param {string} id
 * @returns {string[]|null}
 */
export function pathOfId(entries, id) {
  const hit = (entries || []).find((e) => e.id === String(id));
  return hit ? hit.path : null;
}

/**
 * 找出「某个根下的全部 id」，用于判断某文件夹是否在快照范围内。
 * @param {string} rootId
 * @returns {Promise<string[]>}
 */
export async function descendantIds(rootId) {
  let subtree;
  try {
    subtree = await chrome.bookmarks.getSubTree(rootId);
  } catch {
    return [];
  }
  const ids = [];
  const walk = (n) => {
    ids.push(String(n.id));
    for (const c of n.children || []) walk(c);
  };
  walk(subtree);
  return ids;
}
