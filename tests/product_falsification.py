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
