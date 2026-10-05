/**
 * 预置类目树 + 用户覆盖合并。
 * ⚠️ 纯函数模块：不得 import chrome API。
 *
 * 「其他 / 待归类」是刻意留的用户编辑入口：第一轮跑完若大量条目落这里，
 * 用户在面板里把它改名或拆分后重跑即可，无需重装扩展。
 */

export const DEFAULT_TAXONOMY = Object.freeze([
  { name: '开发与技术', children: ['前端', '后端', '数据库', 'DevOps', '代码托管', '技术文档'] },
  { name: 'AI 与大模型', children: ['模型与 API', '提示词工程', 'AI 工具', '论文与研究'] },
  { name: '效率工具', children: ['笔记与知识', '任务管理', '在线文档', '协作工具'] },
  { name: '学习资料', children: ['编程学习', '技术课程', '电子书', '考试认证'] },
  { name: '设计资源', children: ['UI 设计', '素材与图标', '配色与灵感', '设计工具'] },
  { name: '工作办公', children: ['企业协作', '邮箱', '财务与报销', '行业资讯'] },
  { name: '新闻资讯', children: ['科技媒体', '综合新闻', '财经市场'] },
  { name: '影音娱乐', children: ['视频', '音乐', '游戏', '图像与动漫'] },
  { name: '购物消费', children: ['电商', '比价', '数码产品', '生活服务'] },
  { name: '其他', children: ['待归类'] },
]);

export const FALLBACK_TOP = '其他';
export const FALLBACK_SUB = '待归类';

/**
 * 取生效类目树：用户 override 非空则整棵替换，否则用预置。
 *
 * 为什么是「整棵替换」而不是「逐个合并」：面板写回 override 时写入的是
 * 编辑后的完整树（含所有未改动的类目），因此整棵替换语义正确且可预测；
 * 逐项合并会在用户删除某个类目时把它复活。
 *
 * @param {Array|null|undefined} override
 * @returns {Array<{name:string, children:string[]}>}
 */
export function getTaxonomy(override) {
  return Array.isArray(override) && override.length > 0 ? override : DEFAULT_TAXONOMY;
}

/**
 * 把 '开发与技术/前端' 这样的字符串路径拆成数组。
 * @param {string|string[]} p
 * @returns {string[]}
 */
export function pathArray(p) {
  if (Array.isArray(p)) return p.filter((s) => typeof s === 'string' && s !== '');
  if (typeof p !== 'string') return [];
  return p.split('/').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * 数组路径转 '开发与技术/前端'。
 * @param {string[]} arr
 * @returns {string}
 */
export function pathString(arr) {
  return pathArray(arr).join('/');
}

/**
 * 展开出全部合法两级路径，形如 ['开发与技术/前端', ...]。
 * @param {Array} taxonomy
 * @returns {string[]}
 */
export function allPaths(taxonomy) {
  const out = [];
  for (const top of taxonomy) {
    const children = Array.isArray(top.children) ? top.children : [];
    if (children.length === 0) {
      out.push(top.name);
      continue;
    }
    for (const sub of children) out.push(`${top.name}/${sub}`);
  }
  return out;
}

/**
 * 该路径是否在类目树中合法。
 * @param {Array} taxonomy
 * @param {string|string[]} p
 * @returns {boolean}
 */
export function isKnownPath(taxonomy, p) {
  const arr = pathArray(p);
  if (arr.length === 0) return false;
  if (arr.length === 1) return taxonomy.some((t) => t.name === arr[0]);
  return taxonomy.some((t) => t.name === arr[0] && (t.children || []).includes(arr[1]));
}

/**
 * 兜底路径：优先找「其他 / 待归类」，否则用类目树第一个节点的第一个子节点，
 * 再退化为第一个节点本身。保证任何类目树（含用户自建的）都有兜底，不会返回 null。
 * @param {Array} taxonomy
 * @returns {string[]}
 */
export function fallbackPath(taxonomy) {
  const other = taxonomy.find((t) => t.name === FALLBACK_TOP);
  if (other) {
    const sub = (other.children || []).includes(FALLBACK_SUB)
      ? FALLBACK_SUB
      : (other.children || [])[0];
    return sub ? [other.name, sub] : [other.name];
  }
  const first = taxonomy[0];
  if (!first) return [];
  const sub = (first.children || [])[0];
  return sub ? [first.name, sub] : [first.name];
}

/**
 * 把任意（可能非法、可能越界）路径收敛到最近的合法路径。
 * 顶层合法就取顶层；否则取兜底。用于 LLM 返回结果与用户手改的兜底校正。
 * @param {Array} taxonomy
 * @param {string|string[]} p
 * @returns {string[]}
 */
export function coercePath(taxonomy, p) {
  const arr = pathArray(p);
  if (arr.length === 0) return fallbackPath(taxonomy);
  if (isKnownPath(taxonomy, arr)) return arr;
  if (taxonomy.some((t) => t.name === arr[0])) {
    const top = taxonomy.find((t) => t.name === arr[0]);
    return [top.name, (top.children || [])[0]].filter(Boolean);
  }
  return fallbackPath(taxonomy);
}
