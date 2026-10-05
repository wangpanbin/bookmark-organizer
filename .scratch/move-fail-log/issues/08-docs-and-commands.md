# 08 · 文档与命令

Status: ready-for-agent
Spec: ../spec.md
Blocked by: 01, 02, 03, 04, 05, 06, 07

## 做什么

1. `README.md` 新增一节「移动失败日志」，写清：
   - 为什么要本机接收器（扩展不能写任意路径）
   - 怎么开接收器（`npm run log:sink` 或双击 `tools/start_fail_log_sink.bat`）
   - 授权与端口（8731，两处常量，改端口要同时改两侧）
   - 日志在哪、什么格式、怎么读
   - 接收器没开怎么办（静默 + 重新导出按钮）
   - **命名地雷**：新模块名不要以 `storage.js` / `apply.js` / `llm.js` 等结尾
2. `AGENTS.md` 在「三条不可破的约束」旁补一句 `fail-log.js` 同属写操作模块
3. `package.json` 加 `"log:sink": "python tools/fail_log_sink.py"`
4. `tools/package.py` 若有白名单，确认 `tools/*.py` 与 `.scratch/` 的打包策略

## 验收

- 照 README 从零走一遍：开接收器 → 授权 → 造失败 → F 盘看到文件。别人照着能做出来。

## Comments
