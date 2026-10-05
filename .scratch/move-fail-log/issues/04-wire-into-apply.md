# 04 · 接入执行器失败路径

Status: ready-for-agent
Spec: ../spec.md
Blocked by: 01, 03

## 做什么

1. `src/apply.js:452` 的 `run()` catch：记进 `task.failed[]` 之后调
   `recordFailure({ kind:'move', ..., fromPath: next.fromPath, toPath: next.toPath, batch: task.startedAt })`
2. `src/apply.js:489` 的 `processDuplicates` catch：同样接，`kind:'delete'`
3. 任务收尾（`status → done`，`run()` 的 `!next` 分支）后调一次 `flushPending()` 兜底

## 关键点

- 调用放在 `persistItem(...)` **之后**：日志失败绝不能影响进度落盘。
- 用到的 `fromPath`/`toPath` 已经在计划项里，**不要额外读书签树**。
- `recordFailure` 是 fire-and-forget 语义（内部不抛），但仍要 `await`
  —— 反正只在失败路径上付这 1.5ms，await 才不会让 SW 在发出去之前就被回收。
- **不要**在纯链路（`plan.js` / `dedupe.js` / `normalize.js` / `classify/*`）里 import 本模块。

## 验收

- 造一次失败移动（用 `tests/e2e/revert-guard.js` 已有的「搬完就改回」手法最省事），
  `task.failed[]` 与本地缓冲都出现该条。
- 恢复备份后重跑，日志里出现**两条**失败（证明断点续跑也会记）。

## Comments
