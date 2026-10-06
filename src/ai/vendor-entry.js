/**
 * esbuild 入口 —— 本项目与 `@earendil-works/pi-ai` 之间的**唯一**接缝。
 *
 * ═══ 为什么要有这个文件 ═══
 * 扩展是 `load unpacked` 直跑的，解析不了 `@earendil-works/pi-ai` 这样的裸模块名，
 * 必须由 esbuild 打成一个本地文件（`src/vendor/pi-ai.js`）。
 * 这个入口只 re-export 我们真正用到的面，**不要 import 根入口或 `providers/all`**：
 *   - `@earendil-works/pi-ai` 根入口会**急切**引入 TypeBox 与 schema 校验；
 *   - `providers/all` 引入全部 provider 工厂与全部目录，README 明示那是 heavy entry。
 *
 * ═══ 分层依据（全部实测自 node_modules 里的 .d.ts，不是照 README 抄的）═══
 * T1 —— `openai-completions` / `openai-responses`，只依赖 `openai` 一个 SDK：
 *   deepseek         → openai-completions
 *   moonshotai-cn    → openai-completions
 *   openai           → openai-responses
 *   dashscope(百炼)  → 库里没有，custom provider + openai-completions（见 runtime.js）
 * T2 —— 依赖 @anthropic-ai/sdk 或 @google/genai，体积与打包风险都上一个台阶：
 *   minimax-cn       → **anthropic-messages**（不是 openai-completions，名字有迷惑性）
 *   anthropic / google —— 仍未接入
 *
 * ⚠️ `minimaxCnProvider()` 返回 `Provider<"anthropic-messages">`，
 *    所以「国产厂商都是 OpenAI 兼容」这个直觉在这里是错的 —— 接线时按 .d.ts 为准。
 *
 * ⚠️⚠️ **minimax 已于 2026-10-06 接入，代价是 +215KB。**
 *    vendor 产物 386KB → 601KB，增量几乎全部是 `@anthropic-ai/sdk`：
 *    esbuild 没开 `--splitting`，`anthropic-messages.lazy.js` 里那个
 *    `import()` 会被**内联**进同一个文件，所以「lazy」这个名字在本项目里是失效的。
 *    上限由 `tests/unit/vendor-path.test.js` 的体积闸门盯着（当前 800KB 红线）。
 *    要再接 anthropic / google 就必须先改用 code splitting ——
 *    那会一次产出十来个哈希命名的 chunk，届时必须同步改本文件、`package.py`
 *    的产物校验与 `vendor-path.test.js` 的「单文件」前提。
 *
 *    为什么现在不直接上 splitting：那份产物从「一个文件」变成「一个入口 + 十几个 chunk」，
 *    而这整套架构（单文件 + mtime 契约 + 打包断言）都是围绕单文件建的。
 *    为一家供应商改这些契约，代价大于它省下的 215KB。
 */
export { createModels, createProvider, hasApi, ModelsError } from '@earendil-works/pi-ai/models';
export { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
export { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
export { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn';
export { minimaxCnProvider } from '@earendil-works/pi-ai/providers/minimax-cn';
