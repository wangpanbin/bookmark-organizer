/**
 * HTTP 错误诊断。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，也不得 import vendor 产物。
 *
 * ═══ 为什么从 llm.js 抽出来 ═══
 * `runtime.js` 需要它来把供应商返回的失败翻译成可操作中文，
 * 而 `llm.js` 又要调用 `runtime.js` —— 不抽出来就是循环依赖。
 * `llm.js` 会 re-export 本文件，`llm.js` 的对外 API 因此完全不变。
 *
 * ═══ 为什么这些文案一个字都不能改 ═══
 * 401 的两条分支、400 的三条分支，都是对着**具体服务商的真实报错**写的：
 * 百炼的 key 与区域强绑定，跨区调返回的 401 看起来和「key 无效」一模一样，
 * 但修法完全相反（一个改区域，一个换 key）。文案糊了，用户就会照着错误方向
 * 排查到怀疑人生。这不是文案偏好，是排障路径本身。
 *
 * 唯一的**新增**：区域提示除了嗅探响应体，还能由调用方按 provider 直接指定
 * （`regionBound`）。原因见 runtime.js —— 响应体在某些失败形态下取不到，
 * 那时若只靠嗅探，百炼用户会拿到「key 无效」这条**错误**的排障方向。
 */

/** 判断这次失败是否值得重试。4xx（429 除外）重试没有意义。 */
export function isRetryableStatus(status) {
  if (!Number.isFinite(status)) return true; // 网络层错误（无状态码）值得重试
  if (status === 429) return true;
  return status < 400 || status >= 500;
}

/**
 * 400 是否意味着「这个模型不支持 JSON 模式」。
 *
 * ⚠️ 改造前靠嗅探响应体（/response_format|json_object|json mode/）。
 *    改造后响应体在部分失败形态下取不到，所以调用方可以传 `hint` 兜底。
 */
export function isJsonModeRejection(status, text, hint) {
  if (status !== 400) return false;
  if (hint === true) return true;
  return /response_format|json_object|json mode/i.test(String(text || ''));
}

/**
 * 统一错误信息。
 * @param {number} status HTTP 状态码（无响应体时可能是 0 或 NaN）
 * @param {string} body 响应体文本，取不到就传空串
 * @param {{regionBound?:boolean}} [opts] regionBound=true 时，无论响应体有没有提到区域都给出区域提示
 * @returns {string}
 */
export function describeHttpError(status, body, opts) {
  const text = String(body || '');
  const regionBound = opts && opts.regionBound === true;

  if (status === 401 || status === 403) {
    if (regionBound || /region|区域|cross-region|invalid_api_key|incorrect api key/i.test(text)) {
      return `HTTP ${status} 鉴权失败：${text.slice(0, 200)}\n`
        + '（若你用的是阿里云百炼：它的 key 与区域强绑定，用某区 key 调另一区端点就会报这个错，'
        + '请让 base URL 的区域与创建 key 的区域一致。DeepSeek 无此限制。）';
    }
    return `HTTP ${status} 鉴权失败：key 无效、已过期或没有该模型的权限。${text.slice(0, 200)}`;
  }

  if (status === 404) {
    return `HTTP 404：端点或模型名不对。请检查 base URL（DeepSeek 官方格式是 https://api.deepseek.com，`
      + '不带 /v1 也能通）与 model 名。DeepSeek 的模型名变动较频繁，建议在面板里换一个预设。';
  }

  if (status === 400) {
    if (isJsonModeRejection(status, text)) {
      return `HTTP 400：该模型不支持 JSON 模式（response_format）。${text.slice(0, 200)}`;
    }
    if (/model/i.test(text)) {
      return `HTTP 400：请求被拒，通常是模型名不存在或已下线。${text.slice(0, 200)}\n`
        + '（DeepSeek 曾公告 deepseek-chat / deepseek-reasoner 于 2026-07-24 弃用，'
        + '请在面板里换一个预设模型。）';
    }
    return `HTTP 400：请求格式有误。${text.slice(0, 200)}`;
  }

  if (status === 429) return 'HTTP 429：触发限流或额度用尽。稍后重试，或减少批次大小。';
  if (status >= 500) return `HTTP ${status}：服务端错误，稍后重试。`;
  return `HTTP ${status}：${text.slice(0, 300)}`;
}

/**
 * 把「连上了但服务器不回」与「根本连不上」区分开。
 *
 * ⚠️ 两者在 `models.complete()` 里都会被压成同一句 "Connection error."，
 *    而排查方向完全相反：前者是慢/被墙，后者是 DNS/证书/断网。
 *    所以这里只认我们自己 AbortController 触发的中断 —— 那是我们确知
 *    「它已经超过 30s 了」的信号，其余一律按网络错误处理。
 *
 * @param {unknown} e
 * @param {boolean} abortedByUs 我们的超时定时器是否已经触发
 * @param {number} timeoutMs
 * @returns {string} 错误文案
 */
export function describeTransportError(e, abortedByUs, timeoutMs) {
  if (abortedByUs) {
    return `请求超时（${Math.round(timeoutMs / 1000)}s 无响应）。`
      + '通常是网络不通或服务商不可达 —— 可以在「设置」里关掉 LLM 兜底，'
      + '规则分类不受影响。';
  }
  const raw = e && e.message ? String(e.message) : String(e || '');
  return `请求失败：${raw || '未知错误'}。`
    + '这通常是网络不通、代理拦截或 DNS 解析失败，'
    + '可以在「设置」里关掉 LLM 兜底，规则分类不受影响。';
}
