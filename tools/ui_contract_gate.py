#!/usr/bin/env python3
"""面板 DOM 契约闸门：把「布局重构不能碰的东西」写成会红的检查。

为什么需要它
------------
这个面板的 E2E 有一批**看不见的耦合**：它们靠数行数、按 td 下标取字段来
判断「这一轮真的渲染完了」「这条被分到了哪里」。改布局时这些耦合一个都看不出来，
编译也不报错，E2E 却会在别的地方红掉，甚至更糟 —— **假绿**：

  · ``document.querySelectorAll('#planBody tr').length``（harness.js / llm-path.js）
    一旦往 tbody 里塞骨架占位行，「还没加载完」会被读成「加载完了」，
    后面所有断言都建立在错误前提上。
  · ``tr.querySelectorAll('td')`` 按下标读（repro-organize / repro-real / diagnose）
    一旦调整单元格顺序或结构，字段会静默读空。
  · ``tds[5].textContent`` 读依据列（repro-organize.js:46），
    为了排版把两个徽章包一层容器，文本必须**逐字不变**。

这三类耦合肉眼不可见，所以钉在这里。判据先证伪：本文件第一段会
先验证「tbody 里确实一个骨架节点都没有」，不是恒真。

跑法
----
    python tools/ui_contract_gate.py

退出码 0 = 契约完好；1 = 有东西被改坏了。
"""
import io
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = Path(__file__).resolve().parent.parent
fails = []

css = (ROOT / 'ui' / 'options.css').read_text(encoding='utf-8')
html = (ROOT / 'ui' / 'options.html').read_text(encoding='utf-8')
js = (ROOT / 'ui' / 'options.js').read_text(encoding='utf-8')

print('[structure]')
print(f'  css braces balanced: {css.count("{") == css.count("}")} '
      f'({css.count("{")} open / {css.count("}")} close)')
if css.count('{') != css.count('}'):
    fails.append('css braces unbalanced')

# Classes referenced from JS/HTML that had no rules before the token/layout pass
for n in ['stat-row', 'grid', 'row-title', 'favicon', 'skip-link']:
    hit = f'.{n}' in css
    print(f'  .{n:11} has rules: {hit}')
    if not hit:
        fails.append(f'.{n} still has no rules')

# Tokens the new CSS depends on。
# ⚠️ 这两段曾经是两个逐字相同的循环（一个查九个、一个查两个），
#    第二个是 2026-10-07 换色时补的。合并成一张表：两段同形的循环
#    迟早会长出第三个，而第三个的差异没人说得清是有意还是手滑。
# --accent-line 在其中：少了它，focus 环与进度条就得退回 --accent
#（亮色下只有 2.49:1，压在自己的轨道上更是 2.02:1）。
REQUIRED_TOKENS = [
    '--accent', '--accent-line', '--accent-ink', '--on-accent', '--muted',
    '--container', '--gutter', '--z-topbar', '--shadow-1', '--radius-pill', '--sp-9',
]
for t in REQUIRED_TOKENS:
    hit = t in css
    print(f'  token {t:14} defined: {hit}')
    if not hit:
        fails.append(f'{t} missing')

# ── popup.html 的令牌是 options.css 的**手工副本**（它没引 options.css）──
# 换色时最容易漏的就是这一份，而漏了不会有任何报错：popup 照样能开，
# 只是主面板和工具栏弹窗是两个色系。
# 判据：三个绿色角色的取色必须逐字一致（取 :root 里的第一个，即亮色档）。
popup_html = (ROOT / 'ui' / 'popup.html').read_text(encoding='utf-8')


def token_value(src: str, name: str):
    m = re.search(re.escape(name) + r':\s*(#[0-9a-fA-F]{3,8})\s*;', src)
    return m.group(1).lower() if m else None


print('\n  popup.html 令牌副本与 options.css 同步：')
for t in ['--accent', '--accent-line', '--accent-ink', '--on-accent', '--danger']:
    a, b = token_value(css, t), token_value(popup_html, t)
    same = a is not None and a == b
    print(f'  {same!s:5} {t:14} options.css={a}  popup.html={b}')
    if not same:
        fails.append(f'{t} 在 popup.html 里是 {b}，options.css 是 {a}（手工副本漂了）')

# ── 第三份副本：contrast_gate.py 自己的 INK / BASE ──────────────────
# ⚠️ 这是本闸门最该防的一处，也是原来漏得最彻底的一处。
#    contrast_gate.py **不读任何文件**，它的色值全是硬编码字面量。
#    于是「改 CSS 不改它」时它照样 PASS —— 一道量着自己字面量的闸门，
#    对真实色板一行都量不到，而且没有任何东西会红。
#    症状不是某个对比度超标，而是**整个对比度体系悄悄失效**。
import ast


def py_consts(path: str):
    """取出模块顶层的字面量赋值（dict 与 list 都要）。

    ⚠️ 第一版只收 ast.Dict，于是 package.py 的 INCLUDE_DOCS（是个 list）
       被静默跳过、读成 None —— 而「读不到」和「不一致」在输出里长得几乎一样，
       一道自己都可能误报的闸门没人敢信。
    """
    tree = ast.parse(Path(path).read_text(encoding='utf-8'))
    out = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not (isinstance(node.value, ast.Dict) or isinstance(node.value, ast.List)):
            continue
        for t in node.targets:
            if isinstance(t, ast.Name):
                try:
                    out[t.id] = ast.literal_eval(node.value)
                except ValueError:
                    pass
    return out


_cg = py_consts(ROOT / 'tools' / 'contrast_gate.py')
print('\n  contrast_gate.py 的 INK / BASE 与 options.css 同步：')
_sync_map = [('INK', 'light', '--accent'), ('INK', 'light', '--accent-line'),
             ('INK', 'light', '--accent-ink'), ('INK', 'light', '--muted'),
             ('INK', 'light', '--warn'), ('INK', 'light', '--danger'),
             ('INK', 'light', '--ok'), ('INK', 'light', '--accent-soft'),
             ('INK', 'light', '--warn-soft'),
             ('INK', 'dark', '--accent'), ('INK', 'dark', '--accent-line'),
             ('INK', 'dark', '--accent-ink'), ('INK', 'dark', '--muted'),
             ('INK', 'dark', '--warn'), ('INK', 'dark', '--danger'),
             ('INK', 'dark', '--ok'), ('INK', 'dark', '--accent-soft'),
             ('INK', 'dark', '--warn-soft'),
             ('BASE', 'light', '--bg'), ('BASE', 'light', '--surface'),
             ('BASE', 'light', '--sunken'), ('BASE', 'light', '--exec-track'),
             ('BASE', 'dark', '--bg'), ('BASE', 'dark', '--surface'),
             ('BASE', 'dark', '--sunken'), ('BASE', 'dark', '--exec-track')]


def css_token(mode: str, name: str):
    """options.css 里某个模式下某个 token 的值。"""
    if mode == 'light':
        head = css[:css.index('@media (prefers-color-scheme: dark)')]
        return token_value(head, name)
    # 暗色有两块，逐字相同（下面单独查），取第一块即可
    block = re.search(r':root:not\(\[data-theme="light"\]\) \{(.*?)\n  \}', css, re.S)
    return token_value(block.group(1), name) if block else None


for dict_name, mode, name in _sync_map:
    key = name.lstrip('-')
    a, b = css_token(mode, name), (_cg.get(dict_name, {}).get(mode, {}) or {}).get(key)
    same = a is not None and a == (b or '').lower()
    print(f'  {same!s:5} {mode:5} {name:14} options.css={a}  contrast_gate={b}')
    if not same:
        fails.append(f'contrast_gate.py 的 {dict_name}["{mode}"]["{key}"] 是 {b}，'
                     f'options.css 是 {a} —— 这道闸门正在认证一份没人在用的色板')

# ── 暗色调色板写了两遍，必须逐字相同 ────────────────────────────────
# CSS 没有「媒体查询 + 属性覆盖」的组合选择器，所以手动切暗色与系统暗色
# 只能各写一块。漂了不会报错、不会红在任何单测上，症状是
# 「我手动切到暗色，怎么和系统暗色长得不一样」—— 一个没人会归因到 CSS 的差异。
#
# ⚠️ 判据与自证伪共用 `_dark_blocks_differ`（下面定义）。这两处必须同一份逻辑：
#    自证伪若另写一份，哪一份漂了都没人知道 —— 那等于用一道未验证的检查去验证另一道。
def _dark_blocks_differ(css_src: str) -> bool:
    """两块暗色调色板不一致（或缺一块）时为真。"""
    a = re.search(r':root:not\(\[data-theme="light"\]\) \{\n(.*?)\n  \}', css_src, re.S)
    b = re.search(r':root\[data-theme="dark"\] \{\n(.*?)\n\}', css_src, re.S)
    if not a or not b:
        return True
    return a.group(1) != b.group(1)


_m_a = re.search(r':root:not\(\[data-theme="light"\]\) \{\n(.*?)\n  \}', css, re.S)
_m_b = re.search(r':root\[data-theme="dark"\] \{\n(.*?)\n\}', css, re.S)
if not _m_a or not _m_b:
    fails.append('options.css 里找不到两块暗色调色板 —— 手动切换与系统偏好缺一个')
    print('  False 两块暗色调色板都在')
elif _m_a.group(1) != _m_b.group(1):
    fails.append('options.css 的两块暗色调色板不一致 —— 手动切暗色与系统暗色会长得不一样')
    print('  False 两块暗色调色板逐字相同')
    n = _m_a.group(1).count('\n') + 1
    print('  True  两块暗色调色板逐字相同（%d 行）' % n)

# ── 死令牌 / 死类：定义了却没人用的东西 ────────────────────────────
# 为什么这道闸门值得存在：2026-10-07 的换色里，`--accent: #26ba82` 被定义了
# 一次、在整个 CSS 里被引用 **0 次** —— 于是「用户指定的品牌色亮色下原样出现」
# 这句话说给用户听的时候是假的，而**没有任何东西会红**：
# 它有定义、有文档、有对比度闸门替它背书，唯独没有使用者。
# 同一次重构还留下过 --z-hero（stale）与 .hint-flow（HTML 已删、CSS 还在）。
#
# ⚠️ 判据只查「引用数为 0」，不查「引用得对不对」——
#    那是评审的活，不是脚本能判的形状。
#
# ⚠️ **刻度家族豁免**。--sp-1..9、--shadow-1..3、--radius-*、--t-* 是刻度：
#    刻度存在的意义就是「先定义好，以后有地方用」，删掉没用到的那一档
#    只会让整把尺子歪掉。豁免的是**家族**，不是那几个具体值 ——
#    家族里新增一个非刻度的令牌照样会被抓出来。
SCALES = ('--sp-', '--shadow-', '--radius', '--t-')


def dead_tokens(src: str) -> list:
    """:root 里定义了、但全文一次都没用 var() 引用的自定义属性（刻度家族除外）。"""
    defined = set(re.findall(r'(--[a-z0-9-]+)\s*:', src))
    # 引用形态：var(--x, ...) / var(--x)
    used = set(re.findall(r'var\(\s*(--[a-z0-9-]+)', src))
    return sorted(t for t in defined - used
                  if not t.startswith(SCALES))


def dead_classes(css_src: str, html_src: str, js_src: str) -> list:
    """CSS 里有规则、但 html/js 里一次都没出现的 class。

    ⚠️ 三处必须踩准，踩错就是**误报**——而误报的闸门比没有闸门更糟
       （大家只会学会忽略它，真违规也一起被忽略）：
      ① 先剥 CSS 注释。样式表里满是「.panel-*」「.exec-bar-*」这类
         命名空间说明，剥之前它们会被当成类候选，报出 `panel-` 这种不存在的东西。
      ② 用**朴素子串**而不是带边界的正则。JS 里大量写法是
         `bar.className = \`skeleton-bar ${w}\``，右边界是反引号而不是引号，
         带边界的正则会漏掉它并误报「这个类没人用」。
      ③ 宁可漏报也不误报：漏掉的代价是少抓一个死类，误报的代价是这道闸门被关掉。
    """
    bare = re.sub(r'/\*.*?\*/', ' ', css_src, flags=re.S)
    candidates = set(re.findall(r'(?<![\w-])\.([a-z][a-z0-9-]*)', bare))
    haystack = html_src + js_src + popup_html
    skip = {'css', 'js', 'md', 'html', 'json'}      # 出现在散文里的扩展名
    return [c for c in sorted(candidates)
            if c not in skip and c not in haystack]


_dead_tok = dead_tokens(css)
print(f'\n  {not _dead_tok!s:5} 自定义属性零引用（{len(_dead_tok)} 个）')
if _dead_tok:
    for t in _dead_tok:
        print(f'    {t}  定义了但全文件没有 var({t}) —— '
              f'要么删掉，要么你以为它在生效')
    fails.append(f'定义了却零引用的自定义属性：{_dead_tok}')

_dead_cls = dead_classes(css, html, (ROOT / 'ui' / 'options.js').read_text(encoding='utf-8'))
print(f'  {not _dead_cls!s:5} class 规则零使用（{len(_dead_cls)} 个）')
if _dead_cls:
    print('    ' + ', '.join(_dead_cls))
    fails.append(f'CSS 里有规则但 html/js 从没用过的 class：{_dead_cls}')

# ── 运行时那份文档在三处各有一份路径，互相之间没人对过 ──────────────
# options.js 的 HELP_DOC_URL / package.py 的 INCLUDE_DOCS / harness.js 的 RUNTIME_DOCS。
# 三者只要有一处漂了：面板读不到、打包漏掉、或者 E2E 复制的副本里没有 ——
# 三种症状完全不同，而这三种都表现为「帮助页签空白」，
# 排查时会各自被归因到完全不相干的地方。
_help_src = (ROOT / 'ui' / 'options.js').read_text(encoding='utf-8')
_m_help = re.search(r"HELP_DOC_URL\s*=\s*'([^']+)'", _help_src)
_help_js = _m_help.group(1).rsplit('/', 1)[-1] if _m_help else None
_help_py_raw = py_consts(ROOT / 'tools' / 'package.py').get('INCLUDE_DOCS')
_help_py = _help_py_raw[0].rsplit('/', 1)[-1] if isinstance(_help_py_raw, list) and _help_py_raw else None
_harness_src = (ROOT / 'tests' / 'e2e' / 'harness.js').read_text(encoding='utf-8')
_m_harn = re.search(r"RUNTIME_DOCS\s*=\s*new Set\(\['([^']+)'\]\)", _harness_src)
_help_harness = _m_harn.group(1) if _m_harn else None
_same = _help_js and _help_js == _help_py == _help_harness
print(f'  {_same!s:5} 运行时文档三处路径一致：'
      f'options.js={_help_js} package.py={_help_py} harness.js={_help_harness}')
if not _same:
    fails.append(f'运行时文档的路径在 options.js({_help_js}) / package.py({_help_py}) / '
                 f'harness.js({_help_harness}) 三处不一致 —— 症状都是「帮助页签空白」，'
                 f'但会被分别归因到完全不相干的地方')

html = (ROOT / 'ui' / 'options.html').read_text(encoding='utf-8')
ids = set(re.findall(r'\bid="([^"]+)"', html))

GATED = [
    'healthDisclosureText', 'btnLinkGrant', 'btnLinkRevoke', 'healthPermState',
    'btnLinkRun', 'btnLinkResume', 'btnLinkPause', 'healthProgress', 'linkInterval',
    'linkAiFind', 'healthSummary', 'healthRows', 'healthEmpty', 'healthAlt',
    'tabHealthCount', 'btnArchiveRun', 'btnArchiveProbe', 'archiveState',
    'archiveNote', 'semanticEnabled', 'semanticThreshold', 'btnSemanticRun',
    'btnSemanticClear', 'semanticState', 'semanticTable', 'semanticRows',
    'btnArchiveReset', 'importantCount', 'btnImportantClear',
    'planEmpty', 'dupEmpty', 'snapEmpty', 'execBar', 'report', 'tabs',
    'btnExecute', 'btnPreview', 'targetRoot',
    # F4 手动整理
    'tabScopeCount', 'btnScopePick', 'btnScopePreview', 'btnScopeRetry',
    'btnScopeClearDone', 'btnScopeClearAll', 'btnScopePickToggle',
    'btnScopeAddPicked', 'btnScopeCancelPick', 'scopeSearch',
    'scopePicker', 'scopeTree', 'scopeTreeEmpty', 'scopeList', 'scopeEmpty',
    'scopePending', 'scopeDone', 'scopeFailed', 'scopeStale', 'scopeNote',
    'scopeListCount', 'planScopeChip',
    # 2026-10-07 手动整理重做：七档状态 + 执行闸门 + 每行的分类下拉。
    # 移除了 scopeReady / scopeReadyText / btnScopeGoExecute ——
    # 本页现在自己承担预览职责，不再需要把人送去另一页核对。
    'scopeInPlace', 'scopeUnclassified', 'scopeBlocked',
    'scopeGate', 'scopeGateText', 'btnScopeAcceptAll', 'btnScopeRetryUnclassified',
    'onlyUnclassified', 'unclassifiedNote',
    # 2026-10-07 面板重排与换色新增。
    # 窄栏（整理栏）：只有这几件属于「计划明细」页。
    'hero', 'planSpine', 'spineVal', 'planScopeChip',
    # 重复项页的自有入口
    'btnDupPreview',
    # 帮助页签
    'tab-help', 'panel-help', 'helpBody', 'helpError', 'helpEmpty', 'btnHelpReload',
    # 亮/暗切换
    'btnTheme', 'themeIcon',
]
miss = [i for i in GATED if i not in ids]
print(f'\n  gated ids present: {"ALL OK" if not miss else miss}')
if miss:
    fails.append(f'missing ids: {miss}')

for t in ['plan', 'dup', 'health', 'snap', 'settings']:
    ok = f'data-tab="{t}"' in html
    print(f'  data-tab={t:9} present: {ok}')
    if not ok:
        fails.append(f'data-tab={t} missing')

# F4 的页签同样要点得到（E2E 按 data-tab 点）。
ok = 'data-tab="scope"' in html
print(f'  data-tab={"scope":9} present: {ok}')
if not ok:
    fails.append('data-tab=scope missing')

# ── 2026-10-07 新契约：「整理」栏只属于「计划明细」页 ──────────────
# 这条判据量的正是用户提的那件事：读一遍计划就能看懂要动什么，
# 不必先猜「这 45 条书签是不是会动、动了会怎样」。
#
# ⚠️ 为什么不能用源码顺序：六个 .panel 是**兄弟**节点，所以
#    「hero 排在 panel-plan 之后、下一个面板之前」这句话，
#    「在 plan 面板内部」和「整个落在 plan 面板外面」同样成立。
#    判据必须真的做配对扫描：数 <section / </section> 的深度。
# ⚠️ 为什么不能用 `<section id="panel-plan">...</section>` 的非贪婪正则：
#    重排之后 #panel-plan 内部**会有一个嵌套的 <section class="hero">**，
#    非贪婪匹配会在 hero 的 </section> 处截断，于是 hero 被判成「在面板外」——
#    闸门因为错误的原因而红，而真违规也一起被忽略。
def _section_span(src: str, section_id: str):
    """返回带 section_id 的 <section> 的 (开, 闭) 区间；找不到返回 None。"""
    m = re.search(r'<section\b[^>]*\bid="' + re.escape(section_id) + r'"[^>]*>', src)
    if not m:
        return None
    pos, depth = m.end(), 1
    while depth > 0:
        nxt_open = src.find('<section', pos)
        nxt_close = src.find('</section>', pos)
        if nxt_close == -1:
            return None
        if nxt_open != -1 and nxt_open < nxt_close:
            depth += 1
            pos = nxt_open + len('<section')
        else:
            depth -= 1
            pos = nxt_close + len('</section')
            if depth == 0:
                return (m.start(), pos)
    return None


def _node_within(src: str, section_id: str, node_id: str):
    """node_id 所在位置是否落在 section_id 的配对区间内（含边界外则 False）。"""
    span = _section_span(src, section_id)
    if span is None:
        return None
    try:
        at = src.index(f'id="{node_id}"')
    except ValueError:
        return None
    return span[0] <= at < span[1]


def hero_is_inside_plan(src: str) -> bool:
    return _node_within(src, 'panel-plan', 'hero') is True


# 判据本身必须两侧都对过 —— 绿灯不算证据，一道从来没红过的闸门等于没有闸门。
_HERO_BAD_PLAIN = (
    '<section class="plan-actions" id="hero"></section>\n'
    '<section class="panel" data-panel="plan" id="panel-plan"></section>\n'
    '<section class="panel" data-panel="scope"></section>\n'
)
_HERO_BAD_OUTSIDE = (
    '<section class="panel" data-panel="plan" id="panel-plan"></section>\n'
    '<aside class="plan-side" id="hero"></aside>\n'
    '<section class="panel" data-panel="scope"></section>\n'
)
# ⚠️ 这个样本必须与 ui/options.html 里**真实产出**的结构一致。
#    第一版写的是「plan 面板里嵌一个 <section class="hero">」，理由是
#    「重排后会有嵌套 section」—— 而实际产出是 `<aside class="plan-side" id="hero">`，
#    零嵌套。于是自检验证的是一个代码里根本不存在的形状：
#    判据在样本上过了，在真文件上却可能完全是另一回事。
#    「样本长得像真东西」是自检有效的前提，不是形式。
_HERO_GOOD_INSIDE = (
    '<section class="panel" data-panel="plan" id="panel-plan">\n'
    '  <aside class="plan-side" id="hero">\n'
    '    <div class="spine" id="planSpine"></div>\n'
    '    <button id="btnExecute" disabled></button>\n'
    '  </aside>\n'
    '</section>\n'
    '<section class="panel" data-panel="scope"></section>\n'
)
if hero_is_inside_plan(_HERO_BAD_PLAIN):
    fails.append('hero 归属判据失灵：hero 在面板外时竟然判成在里面')
    print('    ⚠️ 自检失败：已知的坏样本没被抓到')
if hero_is_inside_plan(_HERO_BAD_OUTSIDE):
    fails.append('hero 归属判据失灵：hero 排在下一个面板之后仍判成在里面')
    print('    ⚠️ 自检失败：位置判据没抓住面板后的 hero')
if not hero_is_inside_plan(_HERO_GOOD_INSIDE):
    fails.append('hero 归属判据误报：plan 面板里的整理栏被判成面板外')
    print('    ⚠️ 自检失败：正常样本被误报')
# 样本与真实结构必须同步：id 与 class 都对得上，否则样本在验另一件事
if not (re.search(r'class="[^"]*plan-side[^"]*"\s+id="hero"', html) or
        re.search(r'id="hero"[^>]*class="[^"]*plan-side', html)):
    fails.append('整理栏已经不是 <aside class="plan-side" id="hero"> 了 —— '
                 '自检样本要跟着一起改，否则它在验一个已经不存在的形状')
    print('    ⚠️ 自检样本与真实结构不同步')
if (not hero_is_inside_plan(_HERO_BAD_PLAIN) and not hero_is_inside_plan(_HERO_BAD_OUTSIDE)
        and hero_is_inside_plan(_HERO_GOOD_INSIDE)):
    print('    自检：面板外 / 面板后 两种坏样本都能抓到，真实的窄列结构不误报')

hero_ok = hero_is_inside_plan(html)
print(f'  {hero_ok!s:5} 整理栏 #hero 落在「计划明细」面板之内（其它页签不该看见它）')
if not hero_ok:
    fails.append('#hero 不在 #panel-plan 之内 —— 整理栏会出现在每一个页签上')

# busy 是全局浮层，不是某一页的控件：busy() 有 7 个调用点来自别的页签
# （勾选区读树、快照恢复、展开全部）。它若留在 #panel-plan 里，
# 那些进度提示会静默不可见，症状是「点了没反应」且界面上没有任何解释。
def busy_outside_plan(src: str) -> bool:
    """#busy 存在，且不落在 plan 面板的配对区间内。"""
    span = _section_span(src, 'panel-plan')
    try:
        at = src.index('id="busy"')
    except ValueError:
        return False
    if span is None:
        return True
    return not (span[0] <= at < span[1])


_BUSY_BAD = (
    '<section class="panel" data-panel="plan" id="panel-plan">\n'
    '  <span id="busy"></span>\n'
    '</section>\n'
    '<section class="panel" data-panel="scope"></section>\n'
)
_BUSY_GOOD = (
    '<span id="busy"></span>\n'
    '<section class="panel" data-panel="plan" id="panel-plan"></section>\n'
    '<section class="panel" data-panel="scope"></section>\n'
)
if busy_outside_plan(_BUSY_BAD):
    fails.append('busy 归属判据失灵：面板内的 busy 竟然判成全局')
    print('    ⚠️ 自检失败：busy 的坏样本没被抓到')
if not busy_outside_plan(_BUSY_GOOD):
    fails.append('busy 归属判据误报：全局的 busy 被判成面板内')
    print('    ⚠️ 自检失败：busy 的正常样本被误报')
if not busy_outside_plan(_BUSY_BAD) and busy_outside_plan(_BUSY_GOOD):
    print('    自检：busy 判据两侧都对')

busy_ok = busy_outside_plan(html)
print(f'  {busy_ok!s:5} #busy 存在，且是全局浮层（不在「计划明细」面板里）')
if 'id="busy"' not in html:
    # ⚠️ 原来这里是 `if 'id="busy"' in html else True` —— 也就是
    #    「#busy 被整段删掉」会转绿。那是一道**永远绿**的闸门：
    #    它要防的正是「busy 被藏进面板里」，而「藏起来」的最彻底形式是删掉，
    #    删掉反而通过了判据。
    fails.append('options.html 里没有 #busy —— busy() 有 14 个调用点，'
                 '没有它所有进度提示都静默消失，而界面上不作任何解释')
elif not busy_ok:
    fails.append('#busy 落在 #panel-plan 内 —— 别的页签上的进度提示会静默消失')

# E2E clicks the tab by data-tab; confirm role attributes did not break that
print(f'\n  role="tablist": {"role=\"tablist\"" in html}')
print(f'  role="tab":    {html.count("role=\"tab\"")} buttons')
print(f'  role="tabpanel": {html.count("role=\"tabpanel\"")} panels')
print(f'  aria-selected: {html.count("aria-selected")}')
print(f'  <main id="main">: {"<main id=\"main\">" in html}')
print(f'  skip-link:      {"class=\"skip-link\"" in html}')
print(f'  favicon link:   {"rel=\"icon\"" in html}')
print(f'  color-scheme:   {"color-scheme" in css}')

# remaining em-dashes: only the null placeholder may survive
print('\n  remaining em-dash lines that are NOT the null placeholder:')
leftover = 0
for f in ('options.js', 'options.html', 'popup.html'):
    for i, line in enumerate((ROOT / 'ui' / f).read_text(encoding='utf-8').splitlines(), 1):
        s = line.strip()
        if not re.search(r'[\u2014\u2013]', s):
            continue
        if s.startswith(('*', '//', '<!--')) or '-->' in s:
            continue          # comment
        if "'—'" in s or '>—<' in s or '=== ' in s and "'—'" in s:
            continue          # null placeholder, functionally coupled
        leftover += 1
        print(f'    ui/{f}:{i}  {s[:90]}')
if leftover:
    fails.append(f'{leftover} prose em-dash(es) remain')
else:
    print('    (none)')

# ── HTML 注释不得自我截断 ────────────────────────────────────────
#
# ═══ 这道检查守的是一次真实事故 ═══
# 2026-10-07，界面上出现了一串莫名其妙的半句话：
#     「，会被当成正文散文报红。） -->
# 根因是写注释时在**注释正文里写了注释的结束记号**。HTML 注释不能嵌套，
# 于是注释在那一处被截断，后半句当成**可见正文**渲染到了页面上。
#
# ⚠️ 为什么上面那道逐行 em-dash 检查没能抓到它：
#    逐行检查靠「这行含结束记号 → 当注释跳过」来识别注释，
#    而出事那行**恰好含结束记号** —— 量具和缺陷长成了同一个形状，
#    于是它精准地对正确代码放行、对错误代码也放行。
#    这类「闸门用了一个恰好与缺陷同形的判据」是最难发现的一种失效，
#    所以下面这段自检是必须的：判据本身必须先证明两侧都对过。

def broken_comment_hits(src):
    """返回 [(残留起始行号, 残留片段)]；没有则返回 []。

    做法：按非贪婪解析取出每个注释，把它们的区间挖掉之后，
    剩下的正文里不该再出现任何注释记号 —— 出现即说明有注释提前截断了。
    """
    spans = [(m.start(), m.end()) for m in re.finditer(r'<!--.*?-->', src, re.S)]
    rest, prev = [], 0
    for a, b in spans:
        rest.append(src[prev:a])
        prev = b
    rest.append(src[prev:])
    residue = ''.join(rest)
    out = []
    for m in re.finditer(r'<!--|-->', residue):
        out.append((residue[:m.start()].count('\n') + 1,
                    residue[max(0, m.start() - 24):m.start() + 32]))
    return out


# 自检：判据必须两侧都对。绿灯本身不算证据，一道从来没红过的闸门等于没有闸门。
_SELF_BAD = '<div>a</div>\n<!-- 说明里写了结束记号 --> 的后半句 -->\n<div>b</div>\n'
_SELF_GOOD = '<div>a</div>\n<!-- 说明里提到「结束记号」三个字\n     但没有真的写出它 -->\n<div>b</div>\n'
if not broken_comment_hits(_SELF_BAD):
    fails.append('注释自截断判据失灵：喂了已知坏样本却没报错')
    print('    ⚠️ 自检失败：已知坏样本没被抓到')
if broken_comment_hits(_SELF_GOOD):
    fails.append('注释自截断判据误报：正常注释被判成截断')
    print('    ⚠️ 自检失败：正常样本被误报')
if broken_comment_hits(_SELF_BAD) and not broken_comment_hits(_SELF_GOOD):
    print('    自检：已知坏样本能抓到、正常样本不误报')

print('\n  HTML 注释未被自身截断:')
broken = 0
for f in ('options.html', 'popup.html'):
    src = (ROOT / 'ui' / f).read_text(encoding='utf-8')
    hits = broken_comment_hits(src)
    if hits:
        broken += 1
        print(f'    ui/{f}: 注释正文里写了注释记号，其后半句会变成可见正文：'
              f'约第 {hits[0]} 行 …{hits[1][:44]}…')
if broken:
    fails.append(f'{broken} 个 HTML 文件里有注释写成了自我截断（后半句会漏到页面上）')
else:
    print('    (none)')

# ── E2E 契约不变量 ──────────────────────────────────────────────
# 布局重构最容易在这里悄悄弄坏：E2E 靠数 #planBody 的行数判断「渲染完了」，
# 靠 td 的下标读字段。下面把这些钉死，改 DOM 前先看这一段。
print('\n[E2E contract] invariants the layout refactor must not break')
js = (ROOT / 'ui' / 'options.js').read_text(encoding='utf-8')

# 1) 骨架屏绝不能落进被计数的 tbody。
#    ⚠️ 判据查的是 **class**，不是骨架容器的 id —— 真正的手滑是「往 tbody 里
#    append 了几条占位行」，这时 planSkeleton 这个 id 根本不在 tbody 里，
#    只查 id 会漏掉。（第一版就是这么写的，证伪时被它漏过一次。）
for tid, host in (('planBody', 'planSkeleton'), ('healthRows', 'healthSkeleton')):
    m = re.search(r'<tbody[^>]*id="' + tid + r'"[^>]*>(.*?)</tbody>', html, re.S)
    if not m:
        print(f'  False <tbody id="{tid}"> not found in HTML')
        fails.append(f'tbody {tid} not found')
        continue
    inner = m.group(1)
    has_skel_class = 'skeleton' in inner
    has_skel_id = host in inner
    ok = not (has_skel_class or has_skel_id)
    print(f'  {ok!s:5} no skeleton node inside <tbody id="{tid}">')
    if not ok:
        fails.append(f'skeleton leaked into tbody {tid}')

    # JS 侧：被计数的 tbody 只允许被 append 真实行
    bad = re.search(r"\$\('" + tid + r"'\)\.append\((?!frag|tr\b|rows?\b)", js)
    ok2 = bad is None
    print(f'  {ok2!s:5} JS never appends non-row nodes into {tid}')
    if not ok2:
        fails.append(f'JS appends non-row nodes into {tid}')
    if re.search(r"\$\('" + tid + r"'\)\.appendChild", js):
        fails.append(f'JS appendChild into {tid}')

# 2) 计划表 7 个 td 的顺序不能动（repro-organize / repro-real / diagnose 按下标读）
m = re.search(r'tr\.append\((.*?)\);', js, re.S)
order = [x.strip() for x in m.group(1).split(',')] if m else []
expected = ['tdLock', 'tdItem', 'tdFrom', 'tdArrow', 'tdTo', 'tdWhy', 'tdFb']
ok = order == expected
print(f'  {ok!s:5} plan row td order: {order}')
if not ok:
    fails.append(f'td order changed: {order} != {expected}')

# 3) .title 必须仍在标题元素上（不能为了加 <a> 而换掉宿主结构）
ok = "title.className = 'title'" in js and "document.createElement('a')" in js
print(f'  {ok!s:5} .title class preserved on the title element')
if not ok:
    fails.append('.title class/host changed')

# 4) .why 包裹不能改变 tds[5] 的 textContent（repro-organize.js:46 读它）
ok = 'conf.style.marginLeft' not in js and 'why.append(badge, conf)' in js
print(f'  {ok!s:5} why-cell textContent unchanged (inline style replaced by .why)')
if not ok:
    fails.append('why cell textContent may have changed')

# 5) 锁的 checkbox 仍必须是行内第一个 checkbox（run.js:274 按 first-child 定位）
ok = "tr.append(tdLock, tdItem" in js
print(f'  {ok!s:5} lock checkbox still first cell (run.js:274 selector)')

# 6) 反馈按钮仍是 2 个（repro-organize.js:115 点 nth-child(2)）
ok = "fb.append(ok, bad)" in js
print(f'  {ok!s:5} .fb still has exactly 2 buttons in order')

# 7) 新增的 id 必须在 HTML 里真实存在
for new_id in ['planSkeleton', 'healthSkeleton', 'reportCard']:
    ok = f'id="{new_id}"' in html
    print(f'  {ok!s:5} new id {new_id} exists in HTML')
    if not ok:
        fails.append(f'new id {new_id} missing from HTML')

# 8) 新增的 class 必须有样式
for c in ['.skeleton', '.skeleton-row', '.skeleton-bar', '.empty-mark', '.empty-title',
          '.empty-hint', '.why', 'a.title', 'a.url']:
    ok = c in css
    print(f'  {ok!s:5} {c} has styles')
    if not ok:
        fails.append(f'{c} has no styles')

# 9) 归档的「重要」星标：表头、单元格、样式、aria 六件套缺一不可。
#    少任何一件的症状都是同一个：星标「不见了」，而没有任何报错。
#    判据查的是**四者同时存在**，不是「.star 有样式」这一半 ——
#    只有样式没有 aria 的话，读屏用户根本听不出当前是标记还是没标记。
print('\n[important star] G4 tiered archiving depends on this column')
star_checks = [
    ('header cell', '<th>重要</th>' in html),
    ('cell class', 'c-star' in js),
    ('button class', "'star'" in js),
    ('aria-pressed', "aria-pressed" in js),
    ('css rule', '.star' in css),
    ('css pressed state', '.star[aria-pressed="true"]' in css),
    ('wired to storage', 'toggleImportant' in js),
]
for label, ok in star_checks:
    print(f'  {ok!s:5} {label}')
    if not ok:
        fails.append(f'important star: {label} missing')

# 10) 「采纳替换」按钮不许回来（AGENTS.md 第 8 条）
#     spec §6.5 删掉了自动改址，界面上唯一能给的是「复制新地址」。
#     曾经有个「采纳替换」按钮，它登记一条全仓库没人读的提案，
#     toast 还承诺「到计划明细预览确认后才会执行」——
#     界面承诺一件永远不会发生的事，比功能缺失更伤。
#
# ⚠️ 判据必须**先去掉注释**（2026-10-06 实踩）。
#     第一版直接查原文，结果被本文件自己写的「为什么不能有采纳按钮」那段
#     解释命中，闸门**因为错误的原因而红** —— 红灯是真的，与被测性质无关。
#     误报的闸门比没有闸门更糟：大家只会学会忽略它，真违规也一起被忽略。
#     JS 的行注释不能用裸 `//` 剥：`options.js` 里到处是 'https://...'，
#     裸剥会把后面整行当注释删掉，真按钮反而被藏起来。
#     所以 `//` 前一个字符是 `:` 时不当注释（那正是 URL 的形态）。
def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)   # 块注释 / JSDoc
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)   # HTML 注释
    text = re.sub(r"(?<!:)//[^\n]*", " ", text)            # 行注释（保护 https://）
    return text


html_code = strip_comments(html)
js_code = strip_comments(js)
disc_code = strip_comments(
    (ROOT / 'src' / 'scan' / 'permission.js').read_text(encoding='utf-8')
)

# ⚠️ docs/panel-help.md 也在扫描范围内，而且**不是**「顺手加上」的：
#    面板的「帮助」页签在运行时把这份 markdown **渲染进 options.html**，
#    所以它就是面板内容本身。第 10、11 条守的是「界面不许承诺一件不会发生的事」，
#    而这份文档里的承诺会以正文的样子出现在用户眼前 ——
#    只扫 options.html/js 等于给承诺留了一条侧门。
#    （em dash 那条**不**扩到这里：那是本仓库自己的行文风格，不是承诺问题。）
help_doc_path = ROOT / 'docs' / 'panel-help.md'
help_code = strip_comments(help_doc_path.read_text(encoding='utf-8')) if help_doc_path.exists() else ''

print('\n[no-adopt-affordance] 链接健康只建议，绝不自动改书签')
for banned in ('采纳替换', '采纳', '应用到书签', '一键替换'):
    present = banned in html_code or banned in js_code or banned in help_code
    where = '（options.html / options.js / docs/panel-help.md）'
    print(f'  {not present!s:5} no "{banned}" button/label {where}')
    if present:
        fails.append(f'panel still offers "{banned}" — no such flow exists')

# 11) 两处「不会改书签」的说明不许再承诺「逐条确认」这个不存在的步骤
#     2026-10-06 评审实拍：html 与 permission.js 的 OUTBOUND_DISCLOSURE
#     都写着「任何替换都要你逐条确认后亲自执行」，而面板里没有任何确认步骤。
for where, text in (('options.html', html_code),
                    ('docs/panel-help.md', help_code),
                    ('OUTBOUND_DISCLOSURE', disc_code)):
    if not text:
        continue
    ok = '逐条确认' not in text
    print(f'  {ok!s:5} {where} does not promise a per-item confirm step')
    if not ok:
        fails.append(f'{where} promises 逐条确认 but no such step exists in the panel')


# ══════════════ 自证伪：每条判据都必须能被自己抓住 ══════════════
# 2026-10-07 的教训：hero 判据的自检样本写的是「嵌套 <section>」，
# 而重构真正产出的是 <aside> —— 样本绿着，判据验的却是另一个形状。
# 「样本绿」证明不了「判据量的是真东西」，只有「把真东西打坏，判据变红」才算。
#
# 做法：对每条判据取**真实文件**的内存副本，注入一处回归，断言判据翻红。
# 全程不落盘 —— 与 tests/product_falsification.py 不同，
# 那份要改真实源文件（因此不能与任何编辑并发），这份只在内存里跑，可以随便跑。
print('\n[self-falsification] 每条判据都必须能抓住自己的回归')

_real_html = html
_real_css = css
_real_pkg = (ROOT / 'tools' / 'package.py').read_text(encoding='utf-8')


def _cg_ink(src: str) -> dict:
    d = py_consts(ROOT / 'tools' / 'contrast_gate.py')
    return d


def _mutate(text: str, old: str, new: str) -> str:
    assert old in text, f'注入锚点找不到：{old[:40]}'
    return text.replace(old, new, 1)


def _busy_into_plan(h: str, c: str):
    """把 #busy 真的搬进 plan 面板内部。

    ⚠️ 不能靠再插一个 `<section id="panel-plan">` 来造这个场景：
       文件里已经有真的那个了，多一个 id 会让判据去量另一个区间 ——
       那样即使判据坏了，这个自检也照样「抓得住」。注入必须改坏**真实**结构。
    """
    span = _section_span(h, 'panel-plan')
    tag_end = h.index('>', h.index('id="panel-plan"')) + 1
    probe = '<span id="busy" class="busy" hidden></span>'
    stripped = h.replace(probe, '', 1)
    if span is None:
        return h, c
    return stripped[:tag_end] + probe + stripped[tag_end:], c


_MUTATIONS = [
    # (名字, 把 (html, css) 打坏的函数, 判据在打坏后的产物上应当为真的函数)
    ('暗色调色板两块漂了',
     lambda h, c: (h, c.replace('--bg: #121413;', '--bg: #0d0f0e;', 1)),
     lambda h, c: _dark_blocks_differ(c)),
    ('自定义属性被留成零引用',
     lambda h, c: (h, c.replace('  --accent-ink: #17704e;',
                                 '  --accent-ink: #17704e;\n  --dead-token: #123456;', 1)),
     lambda h, c: '--dead-token' in dead_tokens(c)),
    ('class 规则被留成死样式',
     lambda h, c: (h, c.replace('.toast {', '.never-used-class {\n  color: red;\n}\n.toast {', 1)),
     lambda h, c: 'never-used-class' in dead_classes(c, h, '')),
    ('帮助页签的容器 id 被改错',
     lambda h, c: (h.replace('id="helpBody"', 'id="helpBodz"', 1), c),
     lambda h, c: not re.search(r'\bid="helpBody"', h)),
    ('帮助页签整个消失',
     lambda h, c: (h.replace('data-panel="help"', 'data-panel="heln"', 1), c),
     lambda h, c: 'data-panel="help"' not in h),
    ('#busy 整段删掉',
     lambda h, c: (h.replace('<span id="busy"', '', 1), c),
     lambda h, c: 'id="busy"' not in h),
    ('#busy 被挪进计划明细面板',
     _busy_into_plan,
     lambda h, c: not busy_outside_plan(h)),
    ('整理栏被挪出计划明细面板',
     lambda h, c: (h.replace('id="panel-plan"', 'id="panel-planX"', 1), c),
     lambda h, c: not hero_is_inside_plan(h)),
]

_bad = 0
for name, mutate, detector in _MUTATIONS:
    h2, c2 = mutate(_real_html, _real_css)
    try:
        caught = bool(detector(h2, c2))
    except Exception as e:            # 判据自己抛了也算没抓住
        caught = False
        name = f'{name}（判据抛 {type(e).__name__}）'
    print(f'  {caught!s:5} {name}')
    if not caught:
        _bad += 1
        fails.append(f'判据「{name}」抓不住自己的回归 —— 它可能量的是别的东西')

# 跨文件那条：禁用词。往 docs/panel-help.md 的**内存副本**里塞一个禁用词，
# 看闸门认不认。它需要第三个文件，所以单列而不是塞进上面的表。
_help_path = ROOT / 'docs' / 'panel-help.md'
_help_txt = _help_path.read_text(encoding='utf-8') if _help_path.exists() else ''
# 注入后判据应当**检出**这个词，所以 caught 就是「检出」本身，不是它的取反。
_caught_help = '一键替换' in strip_comments(_help_txt + '\n这里可以一键替换。')
print(f'  {_caught_help!s:5} 禁用词回到帮助文档里')
if not _caught_help:
    _bad += 1
    fails.append('禁用词检查抓不住 docs/panel-help.md 里的「一键替换」')

if not _bad:
    print('  -> 全部判据都能在自己被打坏时抓住')

print()
if fails:
    print('FAIL:')
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('PASS: all structural checks green.')
