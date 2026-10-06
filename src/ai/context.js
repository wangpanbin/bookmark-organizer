/**
 * Context 构造 —— 对齐 pi-ai 的 `Context = { systemPrompt, messages }` 形态。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，也不得 import vendor 产物。
 *
 * ═══ 为什么要单独一个文件 ═══
 * 改造前 `llm.js` 的 `buildPrompt()` 返回 `{ system, user }` 两个裸字符串，
 * 由调用方自己拼进请求体。改造后由库负责把它变成标准 `Context`，
 * 而 `Context` 的关键性质是**可序列化**（README：整个对象 `JSON.stringify`
 * 即可持久化，消息能原样交给另一个模型接着聊）。
 * 这条性质是后续 4 个功能的地基：F1 找新地址、F3 摘要、F2 判重
 * 都要把「同一段上下文」交给不同模型复用，所以形态必须一开始就定对。
 */

/** @typedef {{ role:'user'|'assistant', content:string, timestamp:number }} Message */

/**
 * 构造一次调用的 Context。
 *
 * ⚠️ `timestamp` 必须填：库的消息类型要求它，缺了会在类型层面报错，
 *    而 `JSON.parse(JSON.stringify(...))` 恢复上下文时它是保序的依据。
 *
 * @param {{systemPrompt?:string, user?:string, assistant?:string, now?:number}} input
 * @returns {{systemPrompt:string, messages:Message[]}}
 */
export function buildContext({ systemPrompt, user, assistant, now } = {}) {
  const ts = Number.isFinite(now) ? now : Date.now();
  const messages = [];
  if (typeof user === 'string' && user !== '') {
    messages.push({ role: 'user', content: user, timestamp: ts });
  }
  if (typeof assistant === 'string' && assistant !== '') {
    messages.push({ role: 'assistant', content: assistant, timestamp: ts + 1 });
  }
  return { systemPrompt: String(systemPrompt || ''), messages };
}

/**
 * 从 assistant 消息里取出纯文本。
 *
 * ⚠️ `content` 是**内容块数组**，不是字符串。直接 `String(content)` 会得到
 *    `[object Object]` —— 这个坑在 pi-ai 的类型定义里写得很明确
 *    （`response.content` 要先按 `block.type` 分发），但读起来很像普通字符串，
 *    很容易顺手就 `await res.text()` 那样处理，然后拿到一堆乱码当结果。
 *
 * @param {{content?:Array<{type:string,text?:string}>}} message
 * @returns {string}
 */
export function textOf(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * 这次调用是否失败了。
 *
 * ⚠️ **这是接入 pi-ai 后最容易踩的一个坑**：
 *    `models.complete()` 在请求失败时**不 reject**，而是 resolve 一个
 *    `{ stopReason: 'error', content: [], errorMessage }` 的对象。
 *    把它当成成功，就会把 HTTP 401/429/5xx 全部读成
 *    「模型返回了空内容」——于是百炼的区域绑定诊断、400 的模型名提示、
 *    429 的限流提示**整条消失**，用户只看到一句「模型没有返回可解析的 JSON」。
 *    这正是本项目栽过最多的「静默退化」类型，所以单独抽成一个判定函数，
 *    并由 `tests/unit/runtime-result.test.js` 钉死。
 *
 * @param {{stopReason?:string, errorMessage?:string}} message
 * @returns {boolean}
 */
export function isErrorResult(message) {
  if (!message) return true;
  if (message.stopReason === 'error') return true;
  if (typeof message.errorMessage === 'string' && message.errorMessage !== '') return true;
  return false;
}
