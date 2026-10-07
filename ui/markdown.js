/**
 * 面板「帮助」页签的极简 Markdown 渲染器。
 *
 * 为什么单独成文件：它**不碰任何 chrome API**，所以能被 node 直接 import 走单测。
 * 2026-10-07 它刚被写出来时就带着两个 bug（多行列表项被拆成独立段落、
 * 连续多条列表被合并成一条），两者在浏览器里都表现为「排版有点怪」，
 * 不看代码根本发现不了 —— 而这是唯一一处「界面替文档说话」的地方，
 * 排版坏了等于文档读不懂。
 *
 * 支持的子集（docs/panel-help.md 里不许用别的）：
 *   `#`~`###` 标题 / 无序与有序列表 / 段落 / ``` 代码块 /
 *   行内 `代码` / **粗体** / [文字](https://链接) / `---`
 *   - 不支持表格、不支持嵌套列表、不支持引用块、不支持图片。
 *   - 链接只放行 https:，其余协议降级成纯文字而不是一个点得动的链接。
 *
 * ⚠️ 一律用 DOM API 拼节点，**禁止 innerHTML**：文档是仓库内容，
 *   但 innerHTML 会把它当 HTML 解析，一个笔误的尖括号就能改掉整页结构。
 */

/** 行内标记：`code` / **粗体** / [链接](url)，只认这三种，别的原样当文字。 */
const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;

function renderInlineInto(parent, text, doc = globalThis.document) {
  INLINE_RE.lastIndex = 0;
  let at = 0;
  let m;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > at) parent.append(text.slice(at, m.index));
    if (m[1] !== undefined) {
      const code = doc.createElement('code');
      code.textContent = m[1];
      parent.append(code);
    } else if (m[2] !== undefined) {
      const strong = doc.createElement('strong');
      strong.textContent = m[2];
      parent.append(strong);
    } else {
      const label = m[3];
      const url = m[4];
      // 只放行 https。别的协议（javascript:、file:）一律降级成纯文字，
      // 而不是「渲染成一个点不动就生效的链接」。
      if (/^https:\/\//i.test(url)) {
        const a = doc.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        a.textContent = label;
        parent.append(a);
      } else {
        parent.append(label);
      }
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) parent.append(text.slice(at));
}

/**
 * 把 Markdown 渲染进 into（一个 append 接受节点的容器）。
 *
 * ⚠️ doc 可注入：浏览器里是 globalThis.document，而单测传一个最小替身。
 *   不这么做的话这个文件就只能靠肉眼看，而它已经错过两个 bug 了。
 */
export function renderMarkdown(src, into, doc = globalThis.document) {
  const lines = String(src).split(/\r?\n/);
  const isBullet = (l) => /^[-*]\s+/.test(l);
  const isNumber = (l) => /^\d+\.\s+/.test(l);
  const isHeading = (l) => /^#{1,3}\s+/.test(l);
  const isRule = (l) => /^(---+|\*\*\*+)$/.test(l.trim());
  const isFence = (l) => /^```/.test(l.trim());
  // 缩进的续行：Markdown 里一个列表项 / 段落是可以折行写的。
  // ⚠️ 不认它就会把第二行当成**新的块**：一个两行的列表项会被渲染成
  //    「一个列表项 + 一个跟在外面孤零零的段落」，而界面上看不出发生了什么。
  const isContinuation = (l) => /^[ \t]+\S/.test(l);
  // 能把当前块断开的行（非缩进的块级标记，或空行）
  // ⚠️ 不单独特判 '>'：文件头写着「不支持引用块」，那就让它当普通段落渲染 ——
  //    一个「不支持但偷偷按块级处理」的分叉，比明确不支持更难排查。
  const breaksBlock = (l) => !l.trim() || isHeading(l) || isBullet(l)
    || isNumber(l) || isRule(l) || isFence(l);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }

    if (isFence(line)) {
      // 代码块：不解析行内标记，原样放进去
      const lang = t.replace(/^```/, '').trim();
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾的 ```
      const pre = doc.createElement('pre');
      if (lang) pre.dataset.lang = lang;
      const code = doc.createElement('code');
      code.textContent = buf.join('\n');
      pre.append(code);
      into.append(pre);
      continue;
    }

    if (isHeading(line)) {
      const level = t.match(/^#+/)[0].length;
      const h = doc.createElement(`h${level}`);
      renderInlineInto(h, t.replace(/^#+\s+/, ''), doc);
      into.append(h);
      i++;
      continue;
    }

    if (isRule(line)) {
      into.append(doc.createElement('hr'));
      i++;
      continue;
    }

    if (isBullet(line) || isNumber(line)) {
      const ordered = isNumber(line);
      const list = doc.createElement(ordered ? 'ol' : 'ul');
      // 外层每轮一个列表项，内层吃它自己的缩进续行。
      // ⚠️ 两个 while 必须是嵌套的两个列表项而不是两个收集器 ——
      //    写成「先收完整个列表再发一个 li」会把 5 条列表渲染成 1 条。
      while (i < lines.length && (ordered ? isNumber(lines[i]) : isBullet(lines[i]))) {
        const buf = [lines[i].trim().replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, '')];
        i++;
        while (i < lines.length && isContinuation(lines[i]) && !isFence(lines[i])) {
          buf.push(lines[i].trim());
          i++;
        }
        const li = doc.createElement('li');
        renderInlineInto(li, buf.join(' '), doc);
        list.append(li);
      }
      into.append(list);
      continue;
    }

    // 段落：连续的普通行（含缩进续行）合成一个 <p>
    const buf = [];
    while (i < lines.length && !breaksBlock(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    // 空行收尾
    const p = doc.createElement('p');
    renderInlineInto(p, buf.join(' '), doc);
    into.append(p);
  }
}
