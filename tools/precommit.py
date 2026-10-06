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
SOURCE_DIRS = ("src", "ui", "tools", "tests", "docs")
CHECK_EXT = (".js", ".mjs")
JSON_EXT = (".json",)
# ⚠️ 只做**编码**检查、不做语法检查的扩展名（2026-10-06 补）。
#    早先 --all 模式只收 CHECK_EXT + JSON_EXT，于是 check_encoding 里
#    那几行 `(".py", ".md", ".html", ".css")` 判定**永远走不到** ——
#    死代码。而偏偏是 tools/precommit.py 自己第 210 行坏了一个字节
#    （U+FFFD），--all 模式一路报「编码检查通过」。
#    两道闸门同时坏：闸门自身被损坏，而闸门的覆盖面排除了损坏被发现的那种文件类型。
#
#    刻意**不收** .txt：tests/ 下有一堆 verify_all 写出来的诊断转储
#    （.tap.txt / .final.txt / .revert.txt …），它们是运行产物不是源码，
#    扫进去只会因为某次 diff 带了半个字符就红，那是误报。
TEXT_EXT = (".py", ".md", ".html", ".css", ".yml", ".yaml", ".gitignore", ".gitattributes")
# 编码检查要覆盖的扩展名（collect 与 check_encoding 必须用同一个常量）
ENCODED_EXT = CHECK_EXT + JSON_EXT + TEXT_EXT


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
                # 收集用 ENCODED_EXT（比 CHECK_EXT 宽）：语法检查自己会按扩展名
                # 过滤掉不认的，而编码检查必须真的拿到 .py/.md/.html/.css
                if f.endswith(ENCODED_EXT) and "node_modules" not in dirpath:
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


def check_encoding(files):
    """查字节损坏（U+FFFD 替换字符）。

    为什么这道闸门存在
    ------------------
    2026-10-06 一次会话里引入了 **7 处** U+FFFD —— 写文件时中文被截断，
    产物是 `src/scan/runner.js` / `soft404.js` / `tools/archive_sink.py` /
    `README.md` / spec 里的注释。**全套 300+ 单测全绿**，语法检查全过，
    是最后靠另一个 agent 做字节级扫描才发现的。

    这是纯粹的机械问题：编码被截断。它不该靠人扫、更不该靠另一个 agent 扫。

    ⚠️ 只查 U+FFFD，不查别的编码问题。
        「看起来是乱码」有太多成因（终端代码页、控制台渲染），
        而 U+FFFD 是**文件里真的存了这个字符**——零歧义、零判断成本。

    ⚠️ 扩展名判定用 ENCODED_EXT，与 all_source_files() 收集时用的是**同一个常量**。
        2026-10-06 之前这两处各写了一份，而收集的那份更窄 ——
        于是这个 `if` 在 --all 模式下永远为真地 continue，是死代码。
        两份硬编码清单必然漂移，漂移的表现是「闸门报告通过而它从没看过那个文件」。
    """
    bad = 0
    checked = 0
    for rel in files:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        if not rel.lower().endswith(ENCODED_EXT):
            continue
        try:
            with open(path, encoding="utf-8", errors="strict") as fh:
                text = fh.read()
        except UnicodeDecodeError as exc:
            print(f"[precommit] ✗ {rel} 不是合法 UTF-8：{exc}")
            bad += 1
            continue
        checked += 1
        for i, line in enumerate(text.split("\n"), 1):
            if "\ufffd" in line:
                col = line.index("\ufffd")
                snippet = line.strip()
                if len(snippet) > 70:
                    snippet = snippet[max(0, col - 25): col + 25] + "…"
                print(f"[precommit] ✗ {rel}:{i} 有字节损坏 U+FFFD：…{snippet}…")
                bad += 1
                break  # 一个文件报一次就够，全列出来会淹掉真正的信息
    if not bad:
        print(f"[precommit] ✓ 编码检查通过（{checked} 个文件）")
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


def run_static_gates():
    """跑两个亚秒级静态闸门：面板 DOM 契约 + 前景/背景对比度。

    ⚠️ 为什么它们在**这里**而不只在 `npm run test:all`：
        2026-10-06 之前，`ui_contract_gate.py` 与 `contrast_gate.py`
        两个文件都存在、都能跑、都全绿，但**没接在任何地方**。
        那是本仓库文档里记着的那个失败模式的原样复现：
        「有闸门，但从没被要求跑过」与「没有闸门」长得一模一样。

    ⚠️ 只在 `--all`（全量）模式下跑，暂存模式不跑：
        契约闸门查的是整个面板，而提交时暂存区往往只有一两个文件；
        对着没改动的文件报红是误报，误报的闸门会被学会忽略。

    判据的形状与 `check_syntax` 一致：rc != 0 就是红，输出原样打出来。
    """
    red = 0
    for label, script in (("面板契约", "ui_contract_gate.py"),
                          ("对比度", "contrast_gate.py")):
        p = run(["python", os.path.join("tools", script)], timeout=180)
        if p.returncode == 0:
            continue
        out = (p.stdout or b"").decode("utf-8", "replace") + (p.stderr or b"").decode("utf-8", "replace")
        print(f"[precommit] ✗ {label}闸门没过：")
        for line in out.split("\n"):
            s = line.strip()
            # 只摘失败项，其余几十条 OK 是噪音
            if s.startswith("FAIL:") or s.startswith("- ") or s.startswith("False") or "COLLISION" in s:
                print(f"    {s}")
        red += 1
    if not red:
        print("[precommit] ✓ 面板契约 + 对比度闸门通过")
    return red


def main():
    args = sys.argv[1:]
    tests_only = "--tests-only" in args
    all_mode = "--all" in args
    files = [] if tests_only else (all_source_files() if all_mode else staged_files())

    red = 0
    if not tests_only:
        print(f"[precommit] 待查文件 {len(files)} 个")
        red += check_syntax(files)
        if red:
            print("[precommit] 语法没过就不再跑测试 —— 先把语法修对")
            return 1
        red += check_encoding(files)
        if red:
            print("[precommit] 编码损坏就不往下跑测试 —— 那不是测试红，是文件本身坏了")
            return 1
        if all_mode:
            red += run_static_gates()
            if red:
                return 1
    red += run_unit_tests()
    if red:
        print("\n[precommit] 提交被拦下。修好再提交；"
              "\n           确认是闸门本身有问题时，先跑 npm run test:falsify 证明它该红。")
    return 1 if red else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
