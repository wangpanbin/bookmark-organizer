"""产品级证伪：把真实源码改坏，确认整套测试【确实会红】，然后还原。

为什么必须做这一步：
  进程内造个「坏变体」再断言它不满足某个性质，只能证明那个断言有效；
  改真实文件重跑整套，才能证明【整套闸门】对真实实现的退化是敏感的。
  来源：AdGuard 0.2.0 迁移期出现过「测试全绿但坏实现从未真正跑过」。

用法：python tests/product_falsification.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(os.environ, NO_COLOR="1", NODE_DISABLE_COLORS="1")

# (用例名, 目标文件, 坏补丁 old→new, 预期失败关键字, 前置文件)
CASES = [
    (
        "过度归一化：剥掉全部 hash（SPA 路由会被误判为重复 → 误删书签）",
        os.path.join("src", "normalize.js"),
        "  if (hash !== '') {\n"
        "    const anchor = hash.slice(1);\n"
        "    if (PURE_TOP_ANCHORS.has(anchor.toLowerCase())) hash = '';\n"
        "  }",
        "  if (hash !== '') {\n"
        "    hash = '';   // ← 证伪补丁：无脑剥掉所有 hash\n"
        "  }",
        ["SPA hash", "判成重复", "归一化"],
        None,
    ),
    (
        "过度归一化：剥掉全部 query（?id=1 与 ?id=2 会被误判为重复）",
        os.path.join("src", "normalize.js"),
        "  const kept = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));",
        "  const kept = [...u.searchParams.entries()];  // ← 证伪补丁：不再剥任何参数",
        ["跟踪参数", "去重", "id=1", "业务参数"],
        None,
    ),
    (
        "计划生成引入写操作 import（dry-run 不再零写入）",
        os.path.join("src", "plan.js"),
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';",
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';\n"
        "import { isRunnerActive } from './apply.js';   // ← 证伪补丁：混入了写操作模块",
        ["写操作", "零写入", "plan.js", "闸门"],
        # 注入的模块必须真实存在，否则 Node 解析失败会让整个测试文件加载失败，
        # 具名断言根本没机会跑 —— 那种「红」是加载错误，不是闸门在工作。
        os.path.join("src", "apply.js"),
    ),
    (
        "计划生成引入【跨行】写操作 import（扫描器曾用 [^;\\n]*?，整类绕过）",
        os.path.join("src", "plan.js"),
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';",
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';\n"
        "import {\n"
        "  isRunnerActive,\n"
        "} from './apply.js';   // ← 证伪补丁：跨行形态的多行 import",
        ["写操作", "零写入", "plan.js", "闸门"],
        os.path.join("src", "apply.js"),
    ),
    (
        "计划生成引入动态 import 写操作模块（作用域由运行时决定，闸门不能放过）",
        os.path.join("src", "plan.js"),
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';",
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';\n"
        "const lazyApply = () => import('./apply.js');   // ← 证伪补丁：动态 import 写操作模块",
        ["写操作", "零写入", "plan.js", "闸门", "动态"],
        os.path.join("src", "apply.js"),
    ),
    (
        "字典位置参数错位（pathWords 落进 domains，标题匹配全废）",
        os.path.join("src", "classify", "dict.js"),
        "const R = (to, domains = [], pathWords = [], titleWords = [], domainSuffixes = []) => ({",
        "const R = (to, domains = [], domainSuffixes = [], pathWords = [], titleWords = []) => ({",
        ["pathWords", "titleWords", "domains", "命中率", "expect", "错位"],
        None,
    ),
    (
        "计划生成引入日志模块（预览阶段就可能发网络请求，dry-run 不再零外发）",
        os.path.join("src", "plan.js"),
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';",
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';\n"
        "import { recordFailure } from './fail-log.js';   // ← 证伪补丁：纯链路混入了日志模块",
        ["写操作", "零写入", "plan.js", "闸门"],
        os.path.join("src", "fail-log.js"),
    ),
    (
        "发送成功后整条清空缓冲（发送途中新来的失败会被静默吞掉）",
        os.path.join("src", "fail-log.js"),
        "  await removeDelivered(pending);",
        "  await clearPending();   // ← 证伪补丁：整条清空，不再按内容比对",
        ["发送途中", "误删", "缓冲"],
        None,
    ),
    (
        "recordFailure 不再兜底（日志功能一坏，整批书签跟着卡死）",
        os.path.join("src", "fail-log.js"),
        "    console.warn('[fail-log] 记录失败日志时出错（已忽略，不影响整理）', e);",
        "    throw e;   // ← 证伪补丁：把异常直接抛回执行器",
        ["storage 整个炸了", "不 reject", "recordFailure"],
        None,
    ),
    (
        "「归入位置」又写死成根 id（Chrome 154 的根是 279/280/281，'1' 查无此节点）",
        os.path.join("src", "storage.js"),
        "  targetRoot: 'bar',",
        "  targetRoot: '1',   // ← 证伪补丁：把根 id 又当成常量",
        ["归入位置", "根 id"],
        None,
    ),
    # ─────────── AI 模型接入改造（2026-10-06）新增的 5 处 ───────────
    (
        "把失败当成成功读（pi-ai 失败时 resolve 而不 reject → 整套错误诊断消失）",
        os.path.join("src", "ai", "context.js"),
        "  if (message.stopReason === 'error') return true;",
        "  if (message.stopReason === 'error') return false;   // ← 证伪补丁：把失败当成功",
        ["静默", "错误诊断", "isErrorResult", "当成成功", "运行时结果"],
        None,
    ),
    (
        "去掉 30s 超时（挂住的连接会让整个面板永久冻结在「LLM 兜底分类中…」）",
        os.path.join("src", "ai", "runtime.js"),
        "const REQUEST_TIMEOUT_MS = 30_000;",
        "const REQUEST_TIMEOUT_MS = 0;   // ← 证伪补丁：超时形同虚设",
        ["超时", "AbortController", "fetch 必须带超时", "冻结"],
        None,
    ),
    (
        "capturingFetch 不透传 init（signal 就在 init 里 → 超时保护被悄悄摘掉）",
        os.path.join("src", "ai", "runtime.js"),
        "    const res = await fetch(url, init);",
        "    const res = await fetch(url);   // ← 证伪补丁：把 init 丢掉，signal 没了",
        ["capturingFetch", "signal", "超时", "init"],
        None,
    ),
    (
        "注入的 key 被写进 storage（安全不变量：环境变量密钥不得落进扩展存储）",
        os.path.join("src", "ai", "credential-store.js"),
        "      const envOwner = envKey ? providerForBaseUrl(injected.baseUrl)?.id : null;\n"
        "      if (envOwner === id) return { type: 'api_key', key: envKey, source: 'env' };",
        "      const envOwner = envKey ? providerForBaseUrl(injected.baseUrl)?.id : null;\n"
        "      if (envOwner === id) {\n"
        "        await this.writeManual(id, envKey);   // ← 证伪补丁：把注入的 key 落盘\n"
        "        return { type: 'api_key', key: envKey, source: 'env' };\n"
        "      }",
        ["storage", "注入", "密钥", "credential", "出现在 storage"],
        None,
    ),
    (
        "百炼漏掉 regionBound（401 会给出错误排障方向：让人换 key，而真正要改的是区域）",
        os.path.join("src", "ai", "provider-registry.js"),
        "    regionBound: true,",
        "    regionBound: false,   // ← 证伪补丁：区域绑定标志被抹掉",
        ["百炼", "区域", "regionBound", "区域绑定"],
        None,
    ),
    # ─────── 零写入闸门补洞（link-scan 01 号工单）新增的 3 处 ───────
    # 这三条打的是**闸门本身**：2026-10-06 之前 chrome.alarms / chrome.permissions /
    # fetch / indexedDB 全部逃过零写入闸门，而它们正是 link-scan 要用的全部能力。
    # 闸门对新区块覆盖为零 = 一道看不见的网。
    (
        "纯模块开始用 chrome.alarms（闸门曾对定时能力零覆盖）",
        os.path.join("src", "plan.js"),
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';",
        "import { isExcludedUrl, dedupeKey, pathQueryOf } from './normalize.js';\n"
        "export function schedule() { chrome.alarms.create('x', { periodInMinutes: 360 }); }",
        ["不得命中新闸门", "纯链路源码"],
        None,
    ),
    (
        "纯模块开始 fetch 出网（闸门曾对网络能力零覆盖）",
        os.path.join("src", "dedupe.js"),
        "import { dedupeKey, isExcludedUrl } from './normalize.js';",
        "import { dedupeKey, isExcludedUrl } from './normalize.js';\n"
        "export async function ping(u) { const r = await fetch(u); return r.status; }",
        ["不得命中新闸门", "纯链路源码"],
        None,
    ),
    (
        "纯模块开始用 indexedDB（闸门曾对异步存储零覆盖）",
        os.path.join("src", "normalize.js"),
        "export function parseUrl(raw) {",
        "export function db() { return indexedDB.open('bo', 1); }\n\n"
        "export function parseUrl(raw) {",
        ["不得命中新闸门", "纯链路源码"],
        None,
    ),
    # ─── link-scan 的 5 处（.scratch/link-scan）───
    (
        "死链阈值去掉「跨 24h」（alarms 会任意延迟 → 丢一轮就误杀）",
        os.path.join("src", "scan", "dead-threshold.js"),
        "  return t - lastOkAt >= DEAD_MIN_SPAN_MS;",
        "  return t - lastOkAt >= 0;   // ← 证伪补丁：丢一轮探测就判死",
        ["24h", "不得判死", "跨度不够", "dead-threshold"],
        None,
    ),
    (
        "403/429/5xx 也计入失败计数（一次网络抖动毁掉一批书签）",
        os.path.join("src", "scan", "dead-threshold.js"),
        "  return status === 404 || status === 410;",
        "  return status >= 400;   // ← 证伪补丁：什么错都算「链接没了」",
        ["403", "永不进", "failStreak", "被当成了死链", "算进去"],
        None,
    ),
    (
        "软 404 开始计入失败计数（启发式不该参与判定）",
        os.path.join("src", "scan", "verdict.js"),
        "  if (rec.soft404 === true) return VERDICT.SOFT404;",
        "  if (rec.soft404 === true) { rec.failStreak = 99; return VERDICT.DEAD; }"
        "   // ← 证伪补丁：启发式直接判死",
        ["软 404", "启发式", "failStreak", "不许参与计数"],
        None,
    ),
    (
        "跨站重定向也允许一键采纳（写错了没法撤销）",
        os.path.join("src", "scan", "verdict.js"),
        "  return verdict === VERDICT.REDIRECT_SAME;",
        "  return verdict === VERDICT.REDIRECT_SAME || verdict === VERDICT.REDIRECT_CROSS;"
        "   // ← 证伪补丁：跨站也放行",
        ["一键采纳", "跨站", "人工判断", "D7"],
        None,
    ),
    (
        "embedding 超过批量上限不拦（官方硬限制 10 条，超了是 400）",
        os.path.join("src", "dedupe", "embedding-client.js"),
        "export const MAX_BATCH = 10;",
        "export const MAX_BATCH = 50;   // ← 证伪补丁：撞官方硬限制",
        ["单次最多", "MAX_BATCH", "批量", "400"],
        None,
    ),
    # ─── 2026-10-06 评审后的补丁（评审抓出来的两个真 bug）───
    (
        "某条探不到时游标不前进（800 条里卡住一条，整轮再也走不到终点）",
        os.path.join("src", "scan", "runner.js"),
        "    if (r) {\n      const prev = prevs.get(id) || {};",
        "    if (false) {\n      const prev = prevs.get(id) || {};   // ← 证伪补丁：结果拿不到就跳过",
        ["游标", "停滞", "no-result", "整轮", "走不到终点"],
        None,
    ),
    (
        "设置项没有默认值（读它并与 false 比较恒为真，功能在但没人能关）",
        os.path.join("src", "storage.js"),
        "  linkScanAiFind: false,",
        "  // ← 证伪补丁：把默认值删掉，于是 s.linkScanAiFind 恒为 undefined\n"
        "  // undefined !== false 永远为真，「AI 找新地址」无条件常开",
        # ⚠️ 这条要同时匹配**两个**会红的测试标题。
        #    删掉 linkScanAiFind 的默认值后：
        #      ① semantic-archive 的「默认设置里 link-scan 与语义去重都是关的」会红
        #         （它断言 'linkScanAiFind' in DEFAULT_SETTINGS）
        #      ② falsification 的「读设置项的 !== false …」**不会**红
        #         —— 因为修 bug 时已把 background.js 的读取处改成 === true，
        #            不再存在 X.linkScanAiFind !== false 这个模式了
        #    早先只配了 ②，证伪跑出「RED 但关键字未匹配」——
        #    变红是真的，只是量具没对准。**红灯找对了，尺子刻错了。**
        ["默认设置里 link-scan", "读设置项", "恒为真"],
        None,
    ),
    (
        "F4：执行侧范围校验形同虚设（勾选范围之外的书签也会被移动）",
        os.path.join("src", "apply.js"),
        "export function isInScope(allowed, id) {\n"
        "  if (allowed === null) return true;\n"
        "  return allowed.has(String(id));\n"
        "}",
        "export function isInScope(allowed, id) {\n"
        "  return true;   // ← 证伪补丁：范围校验被短路，谁都能动\n"
        "}",
        ["拦住", "清单外", "空数组"],
        None,
    ),
    (
        "F4：手动模式没收窄去重清单（勾 2 条会连带删掉全树重复项）",
        os.path.join("ui", "options.js"),
        "  state.dupPayload = scoped ? [] : dupPayload;",
        "  state.dupPayload = dupPayload;   // ← 证伪补丁：手动模式也带上全量删除清单",
        ["删除清单恒为空"],
        None,
    ),
    (
        "F4：scopeIds 只留在载荷里、不落进 task（worker 被回收后续跑就没有范围限制）",
        os.path.join("src", "apply.js"),
        "    scopeIds,\n"
        "  };\n"
        "  await set(K.TASK_CURRENT, task);",
        "  };\n"
        "  await set(K.TASK_CURRENT, task);   // ← 证伪补丁：scopeIds 不落盘",
        ["落进 task", "回收"],
        None,
    ),
]


def run_suite():
    """返回 (exit_code, 所有失败条目, 具名失败条目)。

    ⚠️ 文件级 `not ok N - tests\\unit\\xxx.test.js` 也要算失败。
    早先只把具名用例算进去，于是「模块因 SyntaxError 加载失败」这种红灯
    被判成「没红」—— 那不是闸门在测量，而是测量根本没跑起来。
    """
    proc = subprocess.run(
        ["node", "--test", "--test-reporter=tap", "tests/unit/*.test.js"],
        cwd=ROOT,
        capture_output=True,
        env=ENV,
    )
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")

    all_fail = []
    named = []
    for line in out.split("\n"):
        if not line.startswith("not ok "):
            continue
        body = line[7:]
        num, sep, title = body.partition(" - ")
        if not sep:
            continue
        title = title.strip()
        all_fail.append((num.strip(), title))
        if not title.endswith(".test.js"):
            named.append((num.strip(), title))
    return proc.returncode, all_fail, named, out


def main():
    results = []
    overall_ok = True

    for name, rel, old, new, expect_kw, requires in CASES:
        if requires and not os.path.isfile(os.path.join(ROOT, requires)):
            print(f"[DEFERRED] {name}")
            print(f"           前置文件 {requires} 尚不存在，现在注入只会造成模块解析失败，验不到闸门本身")
            results.append((name, None))
            continue
        target = os.path.join(ROOT, rel)
        backup = target + ".bak"
        shutil.copy2(target, backup)
        try:
            text = open(target, encoding="utf-8").read()
            if text.count(old) != 1:
                print(f"[SKIP] {name}\n       补丁锚点命中 {text.count(old)} 次（需恰好 1）")
                overall_ok = False
                continue
            open(target, "w", encoding="utf-8", newline="\n").write(text.replace(old, new))

            code, failing, named, out = run_suite()
            red = code != 0 and len(failing) > 0
            if red:
                hit = [t for _, t in named if any(k in t for k in expect_kw)]
                if not hit:
                    # 具名用例没命中时，用文件级失败兜底（加载失败也算红）
                    hit = [t for _, t in failing if any(k in t for k in expect_kw)]
                status = "RED  ✓" if hit else "RED  (关键字未匹配)"
                if not hit:
                    overall_ok = False
                print(f"[{status}] {name}")
                print(f"         失败条目 {len(failing)} 条（具名 {len(named)}），样例：{failing[0][1][:110]}")
                if not hit:
                    print(f"         实际标题：{[t for _, t in failing][:6]}")
            else:
                overall_ok = False
                print(f"[!! 未红] {name} —— 这道闸门测不出该退化，测试是摆设")
                print(f"         失败用例：{len(failing)}")
                results.append((name, False))
                continue
            results.append((name, True))
        finally:
            shutil.move(backup, target)

    # 还原后必须恢复全绿
    code, failing, _, _ = run_suite()
    restored_ok = code == 0 and not failing
    print("-" * 68)
    print(f"还原后整套测试：{'全绿 ✓' if restored_ok else f'仍红 ✗ ({len(failing)} 失败)'}")
    for name, ok in results:
        mark = "—" if ok is None else ("✓" if ok else "✗")
        print(f"  {mark} {name[:58]}")

    if not restored_ok or not overall_ok:
        print("\n结论：证伪未通过 —— 至少有一处闸门对该退化不敏感，或还原失败。")
        return 1
    print("\n结论：每处退化都让整套测试变红，还原后恢复全绿 —— 闸门是真的在测量。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
