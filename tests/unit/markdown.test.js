/**
 * 「帮助」页签的 Markdown 渲染器单测。
 *
 * 为什么这道闸门不是可有可无的：这是整个扩展里**唯一一处界面替文档说话**的地方，
 * 渲染器坏了不会报错、不会空页 —— 它只是把一段两行的列表渲染成
 * 「一个列表项 + 一个跟在外面孤零零的段落」，读起来像文档本身写乱了。
 * 那种退化只有断言抓得到，肉眼在截图上一眼扫过去根本不会停。
 *
 * 用法：node 里造一个最小的 DOM 替身（不引 jsdom），断言**结构**而不是文本。
 * 结构对了，浏览器里的长相就对了 —— 剩下的交给 CSS。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../ui/markdown.js';

/** 够用的最小 DOM：只实现渲染器真正用到的那几个方法。 */
function fakeDoc() {
  const mk = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      _text: '',
      append(...nodes) {
        for (const n of nodes) {
          if (n === null || n === undefined) continue;
          el.children.push(n);
        }
      },
      appendChild(n) { el.children.push(n); return n; },
      set textContent(v) { el._text = String(v); el.children = []; },
      get textContent() {
        if (el.children.length === 0) return el._text;
        // 裸字符串节点也要能取到值：渲染器会把 inline 的普通文本
        // 直接 append 成字符串，不是每个碎片都是元素。
        return el.children
          .map((c) => (typeof c === 'string' ? c : c.textContent))
          .join('');
      },
    };
    return el;
  };
  return { createElement: mk };
}

function render(md) {
  const host = { children: [], append(...n) { this.children.push(...n); } };
  renderMarkdown(md, host, fakeDoc());
  return host.children;
}

/** 把结构压成一行便于断言：ul>li、h2、p… */
function shape(nodes) {
  return nodes.map((n) => {
    if (n.tagName === 'UL' || n.tagName === 'OL') {
      return `${n.tagName}(${n.children.length})`;
    }
    return n.tagName;
  }).join(' ');
}

test('标题、段落、分隔线各自成一个块', () => {
  const out = render('# 标题\n\n一段话。\n\n---\n\n## 次级标题\n');
  assert.deepEqual(shape(out), 'H1 P HR H2');
});

test('连续多条无序列表 = 一个 ul 里的多个 li', () => {
  const out = render('- 一\n- 二\n- 三\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].tagName, 'UL');
  assert.equal(out[0].children.length, 3, '三条列表被合并成一条就是这里红');
  assert.deepEqual(out[0].children.map((li) => li.textContent), ['一', '二', '三']);
});

test('⚠️ 一个列表项折行写，续行必须留在同一个 li 里', () => {
  // 2026-10-07 的真实 bug：续行被当成新块，渲染成「列表项 + 孤立段落」。
  // 症状是文档读起来像排版坏了，而不是像一条完整的说明。
  const out = render('- 第一行\n  第二行是它的续行\n- 另一条\n');
  assert.equal(out.length, 1, '续行漏出去会多出一个块');
  assert.equal(out[0].tagName, 'UL');
  assert.equal(out[0].children.length, 2, '续行不该变成第三个 li');
  assert.match(out[0].children[0].textContent, /第一行/);
  assert.match(out[0].children[0].textContent, /第二行是它的续行/);
});

test('有序列表用 ol，编号被剥掉', () => {
  const out = render('1. 甲\n2. 乙\n');
  assert.equal(out[0].tagName, 'OL');
  assert.deepEqual(out[0].children.map((li) => li.textContent), ['甲', '乙']);
});

test('段落折行合成一个 p', () => {
  const out = render('第一行\n第二行\n\n另一段\n');
  assert.deepEqual(shape(out), 'P P');
  assert.match(out[0].textContent, /第一行 第二行/);
});

test('代码块原样保留，不解析行内标记', () => {
  const out = render('```bash\nnpm run log:sink\n```\n');
  assert.equal(out[0].tagName, 'PRE');
  assert.equal(out[0].children[0].tagName, 'CODE');
  assert.equal(out[0].children[0].textContent, 'npm run log:sink');
});

test('代码块里的 ** 不会被当成粗体', () => {
  const out = render('```\n**不是粗体**\n```\n');
  assert.equal(out[0].children[0].children.length, 0, '代码块里不该有子节点');
  assert.match(out[0].children[0].textContent, /\*\*不是粗体\*\*/);
});

test('行内代码 / 粗体 / 链接各自成节点', () => {
  const out = render('用 `npm test` 跑，**很重要**，见 [闸门](https://example.com/a)。\n');
  const kinds = out[0].children.map((c) => c.tagName || `#${c}`);
  assert.ok(kinds.includes('CODE'), '行内代码没成节点');
  assert.ok(kinds.includes('STRONG'), '粗体没成节点');
  const a = out[0].children.find((c) => c.tagName === 'A');
  assert.ok(a, 'https 链接没成 <a>');
  assert.equal(a.href, 'https://example.com/a', '链接地址没写上');
  assert.equal(a.textContent, '闸门');
  assert.equal(a.rel, 'noreferrer noopener', '新窗口打开必须带 rel');
});

test('⛔ 非 https 链接降级成纯文字，不做成点得动的链接', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/x', 'http://x.test/a']) {
    const out = render(`点 [这里](${url})\n`);
    const hasLink = out[0].children.some((c) => c.tagName === 'A');
    assert.equal(hasLink, false, `${url} 不该被渲染成可点击链接`);
    assert.match(out[0].textContent, /这里/, `${url} 的链接文字要保留`);
  }
});

test('标记语法原样透传，不丢字', () => {
  const out = render('前 **粗** 中 `码` 后\n');
  const text = out[0].textContent;
  for (const piece of ['前', '粗', '中', '码', '后']) {
    assert.ok(text.includes(piece), `渲染后丢了「${piece}」`);
  }
});

test('⚠️ 产物里没有一个 innerHTML：文档不该被当 HTML 解析', () => {
  // 判据查**实际产物**，不是查源码里有没有这个词 ——
  // 否则把渲染实现整个换掉，这道闸门也会一直绿。
  const out = render('正常段落\n');
  assert.ok(out.length > 0);
  assert.equal(out.some((n) => typeof n.innerHTML === 'string'), false);
});

test('真实文档能整篇渲染，不抛异常也不产出空壳', () => {
  const src = [
    '# 面板使用说明',
    '',
    '面板读的就是这份文件。',
    '',
    '- 它必须进打包白名单：`tools/package.py` 的 `INCLUDE_DOCS`',
    '- **不要写表格**，当前渲染器不支持',
    '',
    '## 计划明细',
    '',
    '点「读取并预览」，**一条都不改**。',
    '',
    '```bash',
    'python tools/inject_key.py',
    '```',
    '',
    '---',
    '',
    '1. 第一步',
    '2. 第二步',
  ].join('\n');
  const out = render(src);
  assert.deepEqual(shape(out), 'H1 P UL(2) H2 P PRE HR OL(2)');
  assert.ok(out.map((n) => n.textContent).join(' ').includes('面板使用说明'));
});