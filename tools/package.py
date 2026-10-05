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

EXCLUDE_NAMES = {"node_modules", ".git", "tests", "dist"}
EXCLUDE_SUFFIX = {".zip", ".bak", ".map"}


def should_skip_dir(name):
    return name in EXCLUDE_NAMES or name.startswith(".")


def should_skip_file(name):
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
    print("  校验通过：manifest 在根、src/ui 齐全、tests 与 node_modules 已排除")


if __name__ == "__main__":
    main()
