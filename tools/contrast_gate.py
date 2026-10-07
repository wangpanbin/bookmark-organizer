#!/usr/bin/env python3
"""调色板对比度闸门：把「亮色模式不达标」这件事变成会红的检查。

为什么需要它
------------
重构前这套色板的问题不是「看起来不够精致」，是**亮色模式下一片 AA 不达标**：
`--muted` 4.05:1、`.card` 标签 3.84:1、`.tabs .active` 3.40:1、
白字压在 `--accent` 上 3.40:1（暗色 2.36:1）。这些数字肉眼很难判断，
但 WCAG AA 的门槛是确定的，所以把它写成脚本。

判据是**先证伪**：脚本第一段故意用**旧值**跑一遍，并要求它们必须红。
没有这一段，一个恒真的检查等于没有检查 —— 它会一直「通过」，
而实际色板早就坏了。

跑法
----
    python tools/contrast_gate.py

退出码 0 = 新值全部达标；1 = 有回归。
"""

import sys
from collections import namedtuple
from copy import deepcopy

# ── 底色（两套模式各自独立取色，不是自动反色）────────────────────
BASE = {
    'light': {
        'bg': '#f4f5f4',
        'surface': '#ffffff',
        'sunken': '#eceeed',
        'exec-track': '#e6e8e7',
    },
    'dark': {
        'bg': '#121413',
        'surface': '#1a1c1b',
        'sunken': '#222423',
        'exec-track': '#2a2c2b',
    },
}

# ── 2026-10-07 换色后的墨色（与 ui/options.css 的 :root 逐项对应）────
# ⚠️ 品牌绿拆成三个角色，因为同一个色值没法同时满足三种对比度门槛：
#   #26ba82 在亮色白底上只有 2.49:1，当文字色是不合格的，
#   当装饰填充又需要 ≥3:1 的非文字对比度。所以：
#     accent      装饰填充（不进 TEXT_PAIRS，也不进 FILL_PAIRS）
#     accent-line 线性元素，≥3.0（WCAG 1.4.11）
#     accent-ink  文字与按钮底，≥4.5（WCAG 1.4.3）
INK = {
    'light': {
        'muted': '#5b625e',
        'accent': '#26ba82',
        'accent-line': '#1e9568',
        'accent-ink': '#17704e',
        'warn': '#8a5a10',
        'danger': '#a32d24',
        'ok': '#16663f',
        'accent-soft': '#e0f2ea',
        'warn-soft': '#fbf3e0',
    },
    'dark': {
        'muted': '#a0a4a1',
        'accent': '#2f9d6c',
        'accent-line': '#56c99e',
        'accent-ink': '#26ba82',
        'warn': '#e5bd66',
        'danger': '#f2907f',
        'ok': '#5cc79a',
        'accent-soft': '#1a2b23',
        'warn-soft': '#332a15',
    },
}

# 压在填充色上的文字色
# ⚠️ on-accent 是压在 **--accent** 上的（主按钮底色），不是压在 --accent-ink 上。
ON = {
    'light': {'on-accent': '#0d1a14', 'on-danger': '#ffffff', 'on-ok': '#ffffff'},
    'dark': {'on-accent': '#0d1a14', 'on-danger': '#0f1712', 'on-ok': '#0d1a14'},
}

# 重构前的旧值，仅用于负控
OLD = {
    'light': {
        'bg': '#f1f5ee', 'surface': '#ffffff', 'sunken': '#e9f0e5',
        'muted': '#6c7b70', 'accent-ink': '#2f9e5e', 'warn': '#b7791f',
        'danger': '#c0392b', 'ok': '#1e7f4f', 'accent': '#2f9e5e',
    },
    'dark': {
        'bg': '#121813', 'surface': '#1a211c', 'sunken': '#222a24',
        'muted': '#96a39a', 'accent-ink': '#5cc98d', 'warn': '#e0b050',
        'danger': '#ef7a6d', 'ok': '#5cc98d', 'accent': '#5cc98d',
    },
}

# ── 非文字对比度的负控样本（2026-10-07）────────────────────────
# ⚠️ 这道判据刚加进来时**一次都没红过**。一道从来没红过的闸门等于没有闸门，
#    所以给它配一对「拿来当线性色一定不合格」的样本，必须能红。
# 亮色那个正是本次指定的品牌色 #26ba82：它当装饰填充很好看，
# 但压在自己的进度条轨道上只有 2.02:1 —— 这就是为什么要拆出 accent-line。
LINE_BAD = {
    'light': '#26ba82',
    'dark': '#315a44',
}

# (墨色, 底色, 最低比值, 说明)
TEXT_PAIRS = [
    ('muted', 'bg', 4.5, '.hint body text'),
    ('muted', 'surface', 4.5, '.hint on card'),
    ('muted', 'sunken', 4.5, '.card label on sunken'),
    ('accent-ink', 'bg', 4.5, 'primary metric on body'),
    ('accent-ink', 'surface', 4.5, '.tabs .active on card'),
    ('accent-ink', 'sunken', 4.5, 'primary metric on sunken'),
    ('warn', 'bg', 4.5, '.warn-text on body'),
    ('warn', 'surface', 4.5, '.warn-text on card'),
    ('warn', 'sunken', 4.5, 'unclassified metric on sunken'),
    ('danger', 'bg', 4.5, '.fail-banner text on body'),
    ('danger', 'surface', 4.5, '.danger-ghost on card'),
    ('danger', 'sunken', 4.5, 'duplicate metric on sunken'),
    ('ok', 'surface', 4.5, 'kept entry on card'),
]

# (文字色名, 填充色名, 最低比值, 说明)
FILL_PAIRS = [
    # ⚠️ 主按钮压的是 --accent（品牌色）而不是 --accent-ink，配近黑字而不是白字。
    #    2026-10-07 之前这里是 ('on-accent','accent-ink') + 白字：
    #    白字压 #26ba82 只有 2.49:1，而近黑字有 7.17:1。
    #    判据要跟着实现走 —— 闸门量的是实际那一对，不是当初设想的那一对。
    ('on-accent', 'accent', 4.5, 'label on primary button'),
    ('on-danger', 'danger', 4.5, 'label on execute button'),
    ('on-ok', 'ok', 4.5, 'label on learned badge'),
]

# ── 非文字对比度（2026-10-07 新增）──────────────────────────────
# 为什么加这一组：换色之前，这道闸门**只量文字**，于是「品牌绿当文字合格、
# 当线条不合格」这类缺陷整套漏过去 —— 旧 --accent #2f9e5e 对白底 3.40:1
# 勉强过非文字门槛，可它压在自己那条进度条轨道上只有 2.93:1，从来没被量过。
# 判据是 WCAG 1.4.11：UI 组件与有意义的图形 ≥3:1。
LINE_PAIRS = [
    ('accent-line', 'bg', 'focus ring on body'),
    ('accent-line', 'surface', 'focus ring on card'),
    ('accent-line', 'sunken', 'focus ring on sunken'),
    ('accent-line', 'exec-track', 'progress fill vs its own track'),
]


def _lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def ratio(fg, bg):
    a, b = lum(fg), lum(bg)
    if a < b:
        a, b = b, a
    return (a + 0.05) / (b + 0.05)


def _xyz(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lab(hexstr):
    """sRGB hex -> CIE L*a*b*（D65）。"""
    h = hexstr.lstrip('#')
    r, g, b = (_xyz(int(h[i:i + 2], 16)) for i in (0, 2, 4))
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def delta_e(a, b):
    """CIE76 色差。<2 不可分，>20 一眼可辨。"""
    la, aa, ba = lab(a)
    lb, ab, bb = lab(b)
    return ((la - lb) ** 2 + (aa - ab) ** 2 + (ba - bb) ** 2) ** 0.5


Row = namedtuple('Row', 'kind mode a b note value need ok')


def evaluate(base, ink, on):
    """把判据表求值成一张行表。

    ⚠️ 判据与自证伪**必须共用这一个函数**。自证伪若另写一份求值逻辑，
       两份会漂，而且漂了没人知道是哪一份 —— 那等于用一道未验证的检查
       去验证另一道。2026-10-07 之前这里是一段 print+append，
       于是「判据还灵不灵」根本没法在脚本里回答自己。
    """
    rows = []

    def add(kind, mode, a, b, note, value, need):
        rows.append(Row(kind, mode, a, b, note, value, need, value >= need))

    for mode in ('light', 'dark'):
        for fg, bg, need, note in TEXT_PAIRS:
            add('text', mode, fg, bg, note,
                ratio(ink[mode][fg], base[mode][bg]), need)
        for on_name, fill, need, note in FILL_PAIRS:
            add('fill', mode, on_name, fill, note,
                ratio(on[mode][on_name], ink[mode][fill]), need)
        # 非文字对比度：门槛 3.0（WCAG 1.4.11），不是 4.5
        for fg, bg, note in LINE_PAIRS:
            add('line', mode, fg, bg, note,
                ratio(ink[mode][fg], base[mode][bg]), 3.0)
        # 徽章两级：填充明度承载「实心 vs 软底」，墨色色相承载「中 vs 低」
        for soft, label in (('accent-soft', 'solid vs medium-soft'),
                            ('warn-soft', 'solid vs low-soft')):
            add('badge-lum', mode, 'accent-ink', soft, label,
                ratio(ink[mode]['accent-ink'], ink[mode][soft]), 3.0)
        add('badge-de', mode, 'accent-ink', 'warn', 'medium-ink vs low-ink',
            delta_e(ink[mode]['accent-ink'], ink[mode]['warn']), 20.0)
    return rows


def _mutate_row(row, base, ink, on):
    """构造一组色值，让**这一条**判据必然翻红。

    ⚠️ 突变不引入任何魔法色值：一律把「被比较的那一方」改成「比较它的那一方」。
       比值于是精确等于 1.00:1，与门槛差得最远。
       换一个随手挑的颜色就得验一遍「它到底够不够低」，
       而那种验法本身就会漂 —— 这里没有可漂的地方。
    """
    b, i, o = deepcopy(base), deepcopy(ink), deepcopy(on)
    m = row.mode
    if row.kind in ('text', 'line'):
        i[m][row.a] = b[m][row.b]      # 前景 = 它所压的那个底
    elif row.kind == 'fill':
        o[m][row.a] = i[m][row.b]      # 文字 = 它所压的那个填充
    elif row.kind in ('badge-lum', 'badge-de'):
        i[m][row.b] = i[m][row.a]      # 软底 / warn = 实心墨色
    return b, i, o


def _row_key(r):
    return (r.kind, r.mode, r.a, r.b)


def _covered_tokens(rows):
    """判据表真正引用到的每一个 (dict 名, 模式, 键)。"""
    seen = set()
    for r in rows:
        if r.kind in ('text', 'line'):
            seen.add(('INK', r.mode, r.a))
            seen.add(('BASE', r.mode, r.b))
        elif r.kind == 'fill':
            seen.add(('ON', r.mode, r.a))
            seen.add(('INK', r.mode, r.b))
        else:
            seen.add(('INK', r.mode, r.a))
            seen.add(('INK', r.mode, r.b))
    return seen


# ── 判据表的清单锚点 ───────────────────────────────────────────────
# 覆盖度检查能抓「某个色值没有任何判据在量」，但**抓不到「删掉一行判据、
# 而那个色值在别处还被量着」** —— 覆盖度纹丝不动，闸门照样绿。
# 换句话说：判据表能自我删减而不留痕迹。
#
# 这是刻意设计的摩擦：**增删任何一条判据都必须同时改这一行**，
# 于是删判据在 diff 里永远看得见。按 AGENTS.md「放宽判据要双向证伪」，
# 放宽本来就应该是一件需要被看见的事。
# 换判据表的合法理由：新增 / 删除一条判据、改门槛。
CRITERIA_DIGEST = 'a8abdc61d8f3'


def self_falsify(rows, bad):
    """把判据表逐条打坏一遍，并检查没有令牌是「改了也不会让任何判据翻红」的。

    为什么这道关是新的：原来只有两个**聚合**信号 ——
    「负控复现数 ≥ 7」和「非文字负控全红」。它们量的是总数，
    也就是说：**悄悄删掉一条判据，这个数一点都不会动。**
    判据表能自我删减而不留痕迹 —— 这是比「某条判据写错了」更隐蔽的失效。

    逐判据映射回答的正是「改一处色值会不会让它失去证明力」：
    每一个令牌都至少参与一条判据，而每一条判据都至少被一个针对性突变打红。
    """
    ok = True
    n_cascaded = 0

    # ── (0) 判据表清单：表被动过没有？ ────────────────────────
    import hashlib
    canon = repr((TEXT_PAIRS, FILL_PAIRS, LINE_PAIRS))
    digest = hashlib.sha256(canon.encode('utf-8')).hexdigest()[:12]
    if digest != CRITERIA_DIGEST:
        # ⚠️ 这里刻意**没有**「首次运行自动记下」那条路。
        #    自动记 = 每次都绿 = 锚点不存在。锚点必须是文件里的一行字面量，
        #    改它要过 review，那正是它存在的理由。
        ok = False
        bad.append(f'判据表变了但 CRITERIA_DIGEST 没同步：{CRITERIA_DIGEST} -> {digest}。'
                   f'这是有意的摩擦 —— 请确认你确实要增删判据或改门槛，'
                   f'然后把 tools/contrast_gate.py 里的 CRITERIA_DIGEST 一起改掉。')
        print(f'  False 判据表指纹变了：{CRITERIA_DIGEST} -> {digest}')
    else:
        print('\n[criteria manifest] 判据表指纹未变（%s，%d 条判据）' % (digest, len(rows)))

    # ── (A) 覆盖度：没有「改了也没用」的令牌 ──────────────────
    covered = _covered_tokens(rows)
    orphans = []
    for dict_name, palette in (('INK', INK), ('BASE', BASE), ('ON', ON)):
        for mode, values in palette.items():
            for key in values:
                if (dict_name, mode, key) not in covered:
                    orphans.append(f'{dict_name}[{mode}][{key}]')
    print('\n[self-falsification] 每个令牌都参与至少一条判据')
    if orphans:
        ok = False
        bad.append(f'这些色值没有任何判据在量：{orphans} —— 改掉它们，闸门照样绿')
        print('  False  全部令牌都被判据覆盖')
    else:
        print(f'  True  {len(covered)} 个 (dict, 模式, 键) 全被覆盖')

    # ── (B) 逐判据可证伪 ────────────────────────────────────
    print('\n[self-falsification] 每条判据都能被自己的突变打红')
    for row in rows:
        b2, i2, o2 = _mutate_row(row, BASE, INK, ON)
        after_rows = evaluate(b2, i2, o2)
        after = {_row_key(r): r for r in after_rows}
        target = after.get(_row_key(row))
        caught = target is not None and not target.ok
        # 连带：改一个令牌常会连带打红别的判据（例如 warn 同时在 TEXT 与徽章里）。
        # 这不是缺陷 —— 一条判据用到的令牌就该一起动。记下来是为了看得见。
        cascaded = sum(1 for r in after.values()
                       if r.ok is False and r.value < r.need
                       and _row_key(r) != _row_key(row))
        if cascaded:
            n_cascaded += 1
        print(f'  {caught!s:5} {row.kind:9} {row.mode:5} {row.a}/{row.b:12}'
              f'  ({row.value:.2f} -> {target.value if target else float("nan"):.2f})')
        if not caught:
            ok = False
            bad.append(f'判据 {row.kind} {row.mode} {row.a}/{row.b} 抓不住自己的突变 —— '
                       f'它可能已经不量这一对了')
    if ok:
        print(f'  -> {len(rows)} 条判据全部能被自己打坏时抓住'
              + (f'（{n_cascaded} 条判据的令牌同时喂给同组其它判据，'
                 f'打坏一个会连带翻红——这正是覆盖度该有的样子）'
                 if n_cascaded else ''))
    return ok


def show(tag, r, need, note, bad):
    ok = r >= need
    if not ok:
        bad.append(f'{note} = {r:.2f} (need {need})')
    print(f'  {"OK " if ok else "NG "} {r:5.2f} (need {need})  {note}')


def main():
    bad = []

    # ── 负控：旧值必须红，否则这道闸门是恒真的 ────────────────────
    print('[negative control] old palette - these MUST fail, else the gate is broken')
    negative_passed = 0
    for mode in ('light', 'dark'):
        for fg, bg in (('muted', 'sunken'), ('muted', 'bg'),
                       ('accent-ink', 'surface'), ('warn', 'surface')):
            r = ratio(OLD[mode][fg], OLD[mode][bg])
            if r < 4.5:
                negative_passed += 1
                print(f'  {mode:5} NG  {r:5.2f}  {fg} on {bg}')
            else:
                print(f'  {mode:5} ??  {r:5.2f}  {fg} on {bg}  <- old value unexpectedly passes')
    # 旧版白字压 accent 是最严重的一处，单独钉死
    for mode, on in (('light', '#ffffff'), ('dark', '#ffffff')):
        r = ratio(on, OLD[mode]['accent'])
        if r < 4.5:
            negative_passed += 1
            print(f'  {mode:5} NG  {r:5.2f}  white on old --accent')
    if OLD['light']['ok'] == OLD['light']['accent']:
        negative_passed += 1
        print('  light COLLISION  --ok == --accent  (high/medium badges indistinguishable)')
    if OLD['dark']['ok'] == OLD['dark']['accent']:
        negative_passed += 1
        print('  dark  COLLISION  --ok == --accent  (identical value)')

    # 非文字对比度的负控：LINE_BAD 当线性色必须在**每个**底上都红。
    # 只红一个不算数 —— 那说明判据只量了某一个底，漏的正是最贴近实际的那处。
    #
    # ⚠️ 刻意用**独立**计数器，不并进 negative_passed：
    #    共用一个的话，这 8 次「通过」会把 OLD 侧的回归抬到门槛之上，
    #    于是「旧色板还能否复现历史缺陷」这个信号被另一个判据的通过次数稀释。
    #    两个负控量的是两件不同的事，混在一个数里就都看不见了。
    print('\n[negative control] line contrast - the bad line token MUST fail everywhere')
    line_failures = 0
    for mode in ('light', 'dark'):
        for _, bg_name, note in LINE_PAIRS:
            r = ratio(LINE_BAD[mode], BASE[mode][bg_name])
            if r < 3.0:
                line_failures += 1
                print(f'  {mode:5} NG  {r:5.2f}  bad line token on {bg_name}  ({note})')
            else:
                print(f'  {mode:5} ??  {r:5.2f}  bad line token on {bg_name}  <- it passed!')
    EXPECTED_LINE_FAILURES = len(LINE_PAIRS) * 2
    if line_failures < EXPECTED_LINE_FAILURES:
        print(f'\nFAIL: line-contrast negative control produced only {line_failures} failures,'
              f' expected {EXPECTED_LINE_FAILURES}. The non-text criterion cannot prove'
              f' anything, so the new LINE_PAIRS below is decorative.')
        return 1
    print(f'  -> {line_failures} line-contrast failures reproduced'
          f' (expected {EXPECTED_LINE_FAILURES})\n')

    # 期望复现数。逐条对应下面这 7 处，不是拍脑袋写的：
    #   亮色 ink 4 处（muted/sunken、muted/bg、accent/surface、warn/surface）
    #   白字压 accent 2 处（亮 3.40、暗 2.06）
    #   暗色 --ok 与 --accent 同值 1 处
    # 暗色的 4 个 ink 值本来就达标 —— 暗色真正的坑只有「白字压亮绿」和撞色两处。
    # 这个数一旦对不上，说明 OLD 已经和真实历史值脱节，闸门失去证明力。
    EXPECTED_FAILURES = 7

    if negative_passed < EXPECTED_FAILURES:
        print(f'\nFAIL: negative control only produced {negative_passed} failures,'
              f' expected at least {EXPECTED_FAILURES}.')
        print('The old palette no longer reproduces the bugs, so this gate cannot')
        print('prove anything. Update OLD with the current values first.')
        return 1
    print(f'  -> {negative_passed} failures reproduced (expected >= {EXPECTED_FAILURES}),'
          ' gate is falsifiable.\n')

    # 亮色那两个绿虽然不是同值，但只差 1.47:1，靠色相分不开。
    # 达不到硬失败标准，所以只记录，不计入 EXPECTED_FAILURES。
    near = ratio(OLD['light']['ok'], OLD['light']['accent'])
    print(f'[negative control] light --ok vs --accent = {near:.2f}:1'
          f'  (not equal, but too close to tell apart by hue)\n')

    # ── 正控：新值必须全过 ──────────────────────────────────────
    # 置信度徽章那两级也在这里：高=实心 accent-ink / 中=软底 accent-ink /
    # 低=软底 warn。⚠️ 量的是**两个不同通道** ——
    #    填充明度承载「实心 vs 软底」，墨色色相承载「中 vs 低」。
    #    一开始量错了（拿墨色去比明度比），而这套设计本来就不靠明度分级。
    rows = evaluate(BASE, INK, ON)
    for kind, head in (('text', 'WCAG 1.4.3  4.5:1'),
                       ('fill', 'WCAG 1.4.3  4.5:1'),
                       ('line', 'WCAG 1.4.11 3.0:1  (non-text)'),
                       ('badge-lum', 'badge fill separation 3.0:1'),
                       ('badge-de', 'badge hue separation ΔE>=20')):
        print(f'[positive control] {head}')
        for r in rows:
            if r.kind != kind:
                continue
            flag = 'OK ' if r.ok else 'NG '
            unit = '' if kind != 'badge-de' else ' dE'
            print(f'  {r.mode:5} {flag} {r.value:5.2f}{unit} (need {r.need:g})  {r.note}')
            if not r.ok:
                bad.append(f'{r.mode} {r.kind} {r.a}/{r.b} = {r.value:.2f} (need {r.need:g})')
        print()

    # ── 自证伪：每条判据都必须能被自己打坏 ──────────────────────
    if not self_falsify(rows, bad):
        return 1

    if bad:
        print('FAIL:')
        for f in bad:
            print('  -', f)
        return 1
    print('PASS: every foreground/background pair meets WCAG AA in both modes.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
