"""提交前闸门：暂存区的 JS 逐个过语法检查，然后跑整套单测。

为什么要有这一步（2026-10-05 复盘）：
    这个仓库有 170 条单测、10 处产品级证伪点，却**没有任何东西会调用它们** ——
    没有 pre-commit、没有 CI、没有 husky。`npm run test:all` 写得很好，
    但它只在一个记得跑它的人手里。
    于是出现过「单测 136/136、E2E 9/9 全绿，而用户那边 100% 失败」。
    测试没撒谎，它只是从来没被要求跑。

    这里把最便宜的那部分（2 秒、零浏览器成本）接成默认动作：
      1. 暂存区的 .js / .mjs 逐个 `node --check` —— 抓语法错，不花秒级
      2. 暂存区的 .json 逐个 parse —— 抓 manifest 写坏
      3. `npm test` —— 170 条单测
    E2E 与证伪仍然**不**接进钩子：它们要开浏览器、耗时分钟级，
    塞进每次提交会把钩子变成没人愿意等的门。手动跑 `npm run test:all`。

用法：
    python tools/precommit.py           # 查暂存区（钩子走这条）
    python tools/precommit.py --all     # 查 src/ ui/ tests/ 全部文件
    python tools/precommit.py --tests-only

退出码：0 放行；非 0 拦下提交。
"""
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(os.environ, NO_COLOR="1", NODE_DISABLE_COLORS="1")

# --all 模式要扫的目录。暂存模式不看目录，只看暂存了哪些文件。
# tests/ 也在内：这个模式只做**语法**检查，而 tests/ 里的坏样本都是
# 字符串字面量（不是真的语法错），所以扫它没有误报风险。
SOURCE_DIRS = ("src", "ui", "tools", "tests")
CHECK_EXT = (".js", ".mjs")
JSON_EXT = (".json",)


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, env=ENV, **kw)


def staged_files():
    p = run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"])
    if p.returncode != 0:
        print("[precommit] 读不到暂存区，跳过语法检查")
        return []
    return [f for f in p.stdout.decode("utf-8", "replace").split("\n") if f.strip()]


def all_source_files():
    out = []
    for d in SOURCE_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirs, files in os.walk(base):
            for f in files:
                if f.endswith(CHECK_EXT + JSON_EXT) and "node_modules" not in dirpath:
                    rel = os.path.relpath(os.path.join(dirpath, f), ROOT)
                    out.append(rel.replace("\\", "/"))
    return sorted(out)


def check_syntax(files):
    bad = 0
    checked = 0
    for rel in files:
        if not os.path.isfile(os.path.join(ROOT, rel)):
            continue
        ext = os.path.splitext(rel)[1].lower()
        if ext in JSON_EXT:
            path = os.path.join(ROOT, rel)
            try:
                with open(path, encoding="utf-8") as fh:
                    json.load(fh)
            except Exception as exc:  # noqa: BLE001
                print(f"[precommit] ✗ {rel} 不是合法 JSON：{exc}")
                bad += 1
            checked += 1
            continue
        # ⚠️ 扩展名白名单必须在这里判，不能只在收集文件时判。
        #    早先只在 all_source_files() 里过滤了扩展名，而暂存模式直接把
        #    `git diff --cached --name-only` 的结果丢进来 —— 于是第一次实跑就把
        #    AGENTS.md / product_falsification.py 也塞给 node --check，
        #    报 ERR_UNKNOWN_FILE_EXTENSION，**把一次完全正常的提交拦下来了**。
        #    这就是本仓库 README 说的「闸门因为错误的原因而红」：
        #    红灯是真的，但红的原因与被测性质无关。
        if ext not in CHECK_EXT:
            continue
        p = run(["node", "--check", rel])
        checked += 1
        if p.returncode != 0:
            err = (p.stderr or p.stdout).decode("utf-8", "replace").strip()
            print(f"[precommit] ✗ {rel} 语法错误：\n{err}")
            bad += 1
    if not bad:
        print(f"[precommit] ✓ 语法/JSON 检查通过（{checked} 个文件）")
    return bad


def run_unit_tests():
    # ⚠️ 不要把 glob 当**单个参数**交给 node，指望它自己展开 ——
    #    `node --test "tests/unit/*.test.js"` 只有 Node 22+ 认，
    #    Node 20 上它会当成一个字面文件名，然后在别处静默失败
    #    （CI 首次实跑就是这么红的：失败条目一片空白）。
    #    `node --test <目录>` 也不行 —— 本机会报 MODULE_NOT_FOUND。
    #    所以这里用 Python 枚举出**显式文件列表**，对所有 Node 版本都成立。
    #    直接调 node 而不走 npm：Windows 上 npm 是 .cmd shim，
    #    subprocess 找不到它（FileNotFoundError [WinError 2]），
    #    顺带也省掉每次提交的 npm 启动开销。
    files = sorted(glob.glob(os.path.join(ROOT, "tests", "unit", "*.test.js")))
    if not files:
        print("[precommit] ✗ 一个 tests/unit/*.test.js 都没找到，单测无法运行")
        return 1
    rel = [os.path.relpath(f, ROOT).replace("\\", "/") for f in files]
    print(f"[precommit] → node --test（{len(rel)} 个单测文件）")
    p = run(["node", "--test", "--test-reporter=tap", *rel])
    out = (p.stdout or b"").decode("utf-8", "replace") + (p.stderr or b"").decode("utf-8", "replace")
    if p.returncode == 0:
        # 只摘 TAP 的汇总行。⚠️ 别用「包含 pass/fail 就打印」那种宽过滤：
        # TAP 把被测代码的 console.warn 也编成 `# ...` 注释行，而那些行里
        # 同样会出现 "fail" 字样（例：fail-log 的降级告警）—— 捞进来一屏噪音。
        summary = [l for l in out.split("\n")
                   if re.match(r"^#\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+\d+\s*$", l)]
        for l in summary:
            print(f"    {l.strip()}")
        if not summary:
            # 没汇总行却 rc=0 = 什么都没跑。绿灯必须是真的跑过了。
            print("[precommit] ✗ 没有 TAP 汇总行，怀疑单测根本没执行，按失败处理")
            return 1
        print("[precommit] ✓ 单测通过")
        return 0
    print("[precommit] ✗ 单测未通过，提交已被拦下。失败条目：\n")
    # 用 TAP reporter 时失败标记是字面量 `not ok`，直接原样打出来
    for line in out.split("\n"):
        if line.startswith("not ok"):
            print(f"    {line}")
    if not any(l.startswith("not ok") for l in out.split("\n")):
        # 一条 not ok 都没有却失败了 —— 那不是测试红，是根本没跑起来。
        # 原来这里会打印一个空列表，看起来像「测试跑了但没列出失败项」。
        print("    （没有 not ok 行，说明不是测试红，而是测试进程本身没跑起来）")
        print("    " + "\n    ".join(out.strip().split("\n")[-12:]))
    return 1


def main():
    args = sys.argv[1:]
    tests_only = "--tests-only" in args
    files = [] if tests_only else (all_source_files() if "--all" in args else staged_files())

    red = 0
    if not tests_only:
        print(f"[precommit] 待查文件 {len(files)} 个")
        red += check_syntax(files)
        if red:
            print("[precommit] 语法没过就不再跑测试 —— 先把语法修对")
            return 1
    red += run_unit_tests()
    if red:
        print("\n[precommit] 提交被拦下。修好再提交；"
              "\n           确认是闸门本身有问题时，先跑 npm run test:falsify 证明它该红。")
    return 1 if red else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
