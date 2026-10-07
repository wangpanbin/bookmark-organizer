"""打包可直接 load unpacked 的扩展目录为 zip。

只打包运行时真正需要的文件：manifest.json / src / ui / README。
明确排除：tests、node_modules、.git、诊断产物、zip 自身。
`load unpacked` 不需要 zip，但拷到别的机器时直接解压就能用。
"""
import os
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(ROOT), "bookmark-organizer-v1.0.0.zip")

INCLUDE_FILES = ["manifest.json", "README.md", ".gitignore", ".gitattributes"]
INCLUDE_DIRS = ["src", "ui"]

# 面板「帮助」页签在运行时 fetch 这份文件（ui/options.js 的 HELP_DOC_URL）。
# ⚠️ 用**精确白名单**而不是把整个 docs/ 塞进去：
#    docs/ 里其余的是给 agent 与新人看的工程文档（testing.md、
#    lessons-learned.md、agents/*.md），不该发给终端用户。
#    漏了它的症状是「帮助页签空白」—— 而打包机本来不会报任何错，
#    所以下面 main() 里有一条对应的 assert。
INCLUDE_DOCS = ["docs/panel-help.md"]

EXCLUDE_NAMES = {"node_modules", ".git", "tests", "dist"}
EXCLUDE_SUFFIX = {".zip", ".bak", ".map"}
# 注入的 API key：绝不能进发布包
EXCLUDE_FILES = {"llm-key.local.js"}


def should_skip_dir(name):
    return name in EXCLUDE_NAMES or name.startswith(".")


def should_skip_file(name):
    if name in EXCLUDE_FILES:
        return True
    if name.startswith("."):
        return True
    return os.path.splitext(name)[1].lower() in EXCLUDE_SUFFIX


def main():
    if os.path.exists(OUT):
        os.remove(OUT)

    count = 0
    total = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in INCLUDE_FILES:
            p = os.path.join(ROOT, f)
            if os.path.isfile(p):
                z.write(p, f)
                count += 1
                total += os.path.getsize(p)

        for d in INCLUDE_DIRS:
            base = os.path.join(ROOT, d)
            if not os.path.isdir(base):
                continue
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [x for x in dirnames if not should_skip_dir(x)]
                for fn in sorted(filenames):
                    if should_skip_file(fn):
                        continue
                    full = os.path.join(dirpath, fn)
                    arc = os.path.relpath(full, ROOT).replace("\\", "/")
                    z.write(full, arc)
                    count += 1
                    total += os.path.getsize(full)

        for rel in INCLUDE_DOCS:
            p = os.path.join(ROOT, rel)
            assert os.path.isfile(p), (
                f"{rel} 不存在。面板「帮助」页签会在运行时读它，"
                f"缺了就是「点了帮助页签一片空白」，而这个错只有用户看得见。"
            )
            z.write(p, rel.replace("\\", "/"))
            count += 1
            total += os.path.getsize(p)

    size_kb = os.path.getsize(OUT) / 1024
    print(f"打包完成: {OUT}")
    print(f"  文件数 {count}，原始 {total/1024:.1f} KB，压缩后 {size_kb:.1f} KB")

    # 校验：manifest.json 必须在压缩包根
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
        assert "manifest.json" in names, "manifest.json 不在压缩包根目录"
        assert any(n.startswith("src/") for n in names), "src/ 缺失"
        assert any(n.startswith("ui/") for n in names), "ui/ 缺失"
        assert not any(n.startswith("tests/") for n in names), "tests/ 不该进包"
        assert not any(n.startswith("node_modules/") for n in names), "node_modules 不该进包"
        # 面板运行时读的说明文档。漏了它，症状是「帮助页签空白」，
        # 而那正是「界面承诺了一件不会发生的事」的轻量版。
        for rel in INCLUDE_DOCS:
            assert rel in names, f"{rel} 不在包里：面板「帮助」页签会读不到"
        # 反向：工程文档不该发给终端用户
        leaked_docs = [n for n in names
                       if n.startswith("docs/") and n.replace("\\", "/") not in INCLUDE_DOCS]
        assert not leaked_docs, f"工程文档泄漏进发布包：{leaked_docs}"
        # vendor 产物是提交进版本库的构建产物，缺了它就是一个
        # 「装上去能用、但 LLM 兜底永远静默跳过」的包 —— 症状和「没配 key」一模一样，
        # 而用户根本不会想到是包本身少了文件。打包时拦住，别等发出去才发现。
        assert "src/vendor/pi-ai.js" in names, (
            "vendor 产物不在包里：先跑 npm run build:vendor 再打包"
        )
        leaked = [n for n in names if "llm-key.local" in n]
        assert not leaked, f"注入的 API key 泄漏进了发布包：{leaked}"
    print("  校验通过：manifest 在根、src/ui 齐全、vendor 产物在包内、"
          "tests 与 node_modules 已排除、注入的 key 未泄漏、"
          "面板帮助文档已进包且工程文档未泄漏")


if __name__ == "__main__":
    main()
