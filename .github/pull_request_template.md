## 这个 PR 改了什么

<!-- 一两句。写「为什么」不只写「改了什么」。 -->

## 类型

- [ ] 修 bug
- [ ] 加功能
- [ ] 改文档
- [ ] 改测试/闸门 ← **勾这个必须解释，见下**

## 闸门

- [ ] `python tools/precommit.py` 过了（语法 + JSON + 全部单测）
- [ ] 如果动了**测试或扫描器**：`npm run test:falsify` 跑过，并且确认它**确实会红**
- [ ] 我知道 E2E 跑不起来（需要有头 chromium），所以没跑

> 改了闸门却没跑证伪，等于没改。`tests/product_falsification.py` 会
> 备份源码、注入缺陷、跑整套、断言变红、再还原。没红过的闸门和没有闸门一样。

## 硬约束

- [ ] 没有让 `src/plan.js` import 任何写操作模块（dry-run 零写入的依据）
- [ ] 没有把 `src/storage.js` 的读-改-写拆出串行临界区
- [ ] 没有改动去重对 hash 路由的保留行为
- [ ] 新模块名没有以 `storage.js` / `apply.js` / `llm.js` / `tree.js` /
      `backup.js` / `background.js` / `fail-log.js` 结尾（禁用列表是后缀匹配）

## 隐私

- [ ] 没有提交 `src/llm-key.local.js` 或任何真实 API key
- [ ] 没有提交任何**真实书签数据**（URL、租户域名、wiki token）
- [ ] 如果动了 E2E 夹具：形状保留、身份全换，合成值已同步进隐私闸门白名单

## E2E 我没跑

我确认以上都是**我自己核对过的**，但 E2E 需要有头浏览器，我这边没跑。
实际跑过的情况请写在下面：

```
E2E 结果：
```
