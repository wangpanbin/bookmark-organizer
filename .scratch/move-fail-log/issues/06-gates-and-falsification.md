# 06 · 闸门与证伪

Status: ready-for-agent
Spec: ../spec.md
Blocked by: 01, 03, 04

## 做什么

1. `tests/helpers/sourceScan.js` 的 `FORBIDDEN_IN_PURE_CHAIN` 增加 `'fail-log.js'`
2. `tests/unit/fail-log.test.js` —— 覆盖工单 01/03 的验收点
3. **先证伪**（本项目的规矩：绿灯不算证据）：
   - 在 `falsification.test.js` 加一条：临时在 `plan.js` 里插 `import './fail-log.js'` →
     闸门必须报红 → 还原
   - 注入坏补丁「成功后不清缓冲」→ 单测必须红
   - 注入坏补丁「fetch 去掉 AbortController 超时」→ 单测必须红
4. `tests/product_falsification.py` 增加退化项（沿用现有备份-打坏-还原套路）

## 关键点

- `FORBIDDEN_IN_PURE_CHAIN` 是**后缀匹配**（`endsWith`）。加完 `fail-log.js` 后，
  顺手在 README/AGENTS 记一句：**新模块名不要以任何禁用名结尾**
  （`xxx-storage.js` 会因为名字被判成 `storage.js`）。
- 证伪用例必须**自己先红一次**并把输出留在报告里，不能只写「应该会红」。

## 验收

```bash
npm test            # 全绿
npm run test:falsify  # 全绿，且报告里能看到每一处都真的红过
```

## Comments
