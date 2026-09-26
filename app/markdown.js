/* ============================================================
   app/markdown.js —— 零依赖 Markdown 解析器
   入口：parse(src, options) -> AST（纯函数，不触碰 DOM，可在 Node 里直接跑）
         plainText(inline)    -> 纯文本（标题锚点、侧栏标签用）
   渲染在 app/main.js 完成（createElement + textContent，不做 innerHTML 拼串）

   AST 节点契约
     块级: root{children}                        root.warnings[] 可选（渲染前报一次）
           heading{level,id,inline}            paragraph{inline}
           code{lang,hl,code}                  blockquote{children}
           container{kind,label,title,children}  提示区块，见下
           list{ordered,start,tight,items:[{children,task}]}
           table{ align, head:[{inline}], rows:[[{inline}]] }
           hr                                  html{html}
           footnotes{items:[{id,index,children}]}
     行内: text{value}  code{value}  strong{children}  em{children}  del{children}
           link{href,title,children}  image{src,alt,title}  hardbreak
           html{html}  footnoteRef{id}

   提示区块（container）：
     开行 ::: tip|info|warning|danger|details [自定义标题]，收尾 :::；
     嵌套时内层冒号数别超过外层（同数也可以）；内容照常解析 Markdown。
     kind 为上面五种之一，认不出的名字归为 kind:'plain'（中性样式 + 一条 warn）。

   其它少量拓展（都不是标准 Markdown，写法见 docs/指南/写内容/支持的语法.md）：
     代码块行高亮 ```js{1,4-6}、标题自定义锚点 ## 标题 {#id}、文件开头的 YAML front matter（整块忽略）

   有意不支持（KISS，见 README「已知限制」）：
     setext 标题、引用式链接 [a][b]、Obsidian 双链 [[a]]、HTML 块内部的 Markdown
   ============================================================ */

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'div', 'dl', 'dt', 'dd',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'iframe', 'img', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'script',
  'section', 'style', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  'video', 'audio'
]);

const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_QUOTE = /^ {0,3}>[ \t]?/;
const RE_LIST = /^( *)([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const RE_FOOTNOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const RE_TASK = /^\[([ xX])\][ \t]+/;
const RE_HTML_COMMENT = /^ {0,3}<!--/;
const RE_HTML_OPEN = /^ {0,3}<([a-zA-Z][a-zA-Z0-9-]*)([ \t/>]|$)/;
const RE_CJK = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/;
/* 提示区块 ::: tip 自定义标题 / ::: ；代码块行高亮 ```js{1,4-6} ；标题自定义锚点 {#id} */
const RE_CONTAINER_OPEN = /^ {0,3}(:{3,})[ \t]*([^\s:]+)?[ \t]*(.*)$/;
const RE_CONTAINER_CLOSE = /^ {0,3}(:{3,})[ \t]*$/;
const RE_LINE_MARKS = /\{([\d,\s-]*)\}[ \t]*$/;
const RE_ANCHOR = /^(.*?)[ \t]*\{#([^}\s]+)\}[ \t]*$/;
const CONTAINER_KINDS = new Set(['tip', 'info', 'warning', 'danger', 'details']);
const CONTAINER_ALIASES = { note: 'info', important: 'info', caution: 'danger', error: 'danger' };

/* ---------------- 入口 ---------------- */

export function parse(src, options = {}) {
  const opts = Object.assign({ footnotes: true }, options);
  const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const state = { defs: new Map(), refOrder: [], usedIds: new Map(), warnings: [] };
  const children = parseBlocks(stripFrontMatter(text.split('\n')), state, opts);
  if (state.refOrder.length) {
    const node = makeFootnotes(state);
    if (node.items.length) children.push(node);
  }
  const root = { type: 'root', children };
  if (state.warnings.length) root.warnings = state.warnings;
  return root;
}

/* 文件开头的 YAML front matter（--- 开头、下一行 --- 收尾）整块忽略：
   本站的站点配置在 _config.json 里，正文不需要 front matter，写了也不该渲染出来。
   只在「中间每行都长得像 key: value」时才当 front matter，避免把正文开头的分割线 + 内容整块吃掉。 */
function stripFrontMatter(lines) {
  if (!lines.length || lines[0].trim() !== '---') return lines;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line !== '---') {
      if (line && !/^[A-Za-z_][\w.-]*[ \t]*:/.test(line)) return lines;
      continue;
    }
    return lines.slice(i + 1);
  }
  return lines;                          // 没找到收尾行：不是 front matter，原样交给解析
}

/* ---------------- 块级解析 ---------------- */

function parseBlocks(lines, state, opts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (opts.footnotes) {
      const fm = RE_FOOTNOTE_DEF.exec(line);
      if (fm) { i = readFootnote(lines, i, fm, state, opts); continue; }
    }

    const fence = RE_FENCE.exec(line);
    if (fence) { const r = readFence(lines, i, fence); out.push(r.node); i = r.next; continue; }

    const h = RE_HEADING.exec(line);
    if (h) { out.push(makeHeading(h[2] || '', h[1].length, state)); i++; continue; }

    if (RE_HR.test(line)) { out.push({ type: 'hr' }); i++; continue; }

    if (isTableStart(lines, i)) { const r = readTable(lines, i, state); out.push(r.node); i = r.next; continue; }

    const open = containerOpen(line);
    if (open) { const r = readContainer(lines, i, open, state, opts); out.push(r.node); i = r.next; continue; }

    if (RE_QUOTE.test(line)) { const r = readQuote(lines, i, state, opts); out.push(r.node); i = r.next; continue; }

    if (RE_LIST.test(line)) { const r = readList(lines, i, state, opts); out.push(r.node); i = r.next; continue; }

    if (/^ {4}/.test(line)) { const r = readIndentedCode(lines, i); out.push(r.node); i = r.next; continue; }

    if (isHtmlBlockStart(line)) { const r = readHtmlBlock(lines, i); out.push(r.node); i = r.next; continue; }

    const p = readParagraph(lines, i, state, opts);
    out.push(p.node);
    i = p.next;
  }
  return out;
}

function readParagraph(lines, i, state) {
  const buf = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    if (buf.length && startsNewBlock(lines, i)) break;
    buf.push(line);
    i++;
  }
  return { node: { type: 'paragraph', inline: parseInline(buf.join('\n'), state) }, next: i };
}

function makeHeading(raw, level, state) {
  let cleaned = raw.replace(/[ \t]+#+[ \t]*$/, '').trim();
  let custom = '';
  const anchor = RE_ANCHOR.exec(cleaned);        // ## 标题 {#自定义锚点}
  if (anchor) { cleaned = anchor[1].trim(); custom = anchor[2]; }
  const inline = parseInline(cleaned, state);
  const id = custom ? unique(custom, state.usedIds) : slugify(plainText(inline), state.usedIds);
  return { type: 'heading', level, id, inline };
}

/* 自定义锚点也走 usedIds，保证后面的同名锚点不会撞车 */
function unique(id, usedIds) {
  if (!usedIds) return id;
  const n = usedIds.get(id) || 0;
  usedIds.set(id, n + 1);
  return n ? id + '-' + n : id;
}

function readFence(lines, i, m) {
  const marker = m[1][0];
  const len = m[1].length;
  let info = (m[2] || '').trim();
  const closeRe = new RegExp('^ {0,3}' + (marker === '`' ? '`' : '~') + '{' + len + ',}[ \\t]*$');
  const buf = [];
  let j = i + 1;
  while (j < lines.length && !closeRe.test(lines[j])) { buf.push(lines[j]); j++; }
  if (j < lines.length) j++;
  let hl = [];
  const marks = RE_LINE_MARKS.exec(info);          // ```js{1,4-6}：行高亮，别混进语言名
  if (marks) {
    hl = parseLineMarks(marks[1]).filter((n) => n >= 1 && n <= buf.length);
    info = info.slice(0, marks.index).trim();
  }
  const lang = info.replace(/^\{\.?/, '').replace(/\}$/, '').split(/[\s,]+/)[0] || '';
  const node = { type: 'code', lang, code: buf.join('\n') };
  if (hl.length) node.hl = hl;
  return { node, next: j };
}

/* '1,4,6-7' -> [1,4,6,7]；上限兜底，免得 {1-999999} 把内存吃光 */
function parseLineMarks(spec) {
  const out = [];
  for (const part of String(spec).split(',')) {
    const t = part.trim();
    if (!t) continue;
    const range = /^(\d+)[ \t]*-[ \t]*(\d+)$/.exec(t);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      for (let n = Math.min(a, b); n <= Math.max(a, b) && out.length < 1000; n++) out.push(n);
    } else if (/^\d+$/.test(t)) out.push(parseInt(t, 10));
  }
  return out;
}

/* ---------------- 提示区块 ::: tip ---------------- */

function containerOpen(line) {
  const m = RE_CONTAINER_OPEN.exec(line);
  if (!m || !m[2]) return null;                  // 光秃秃的 ::: 是收尾，不是开行
  const label = m[2].toLowerCase();
  const kind = CONTAINER_KINDS.has(label) ? label : (CONTAINER_ALIASES[label] || 'plain');
  return { colons: m[1].length, kind, label, title: (m[3] || '').trim() };
}

function containerClose(line) {
  const m = RE_CONTAINER_CLOSE.exec(line);
  return m ? m[1].length : 0;
}

function readContainer(lines, i, open, state, opts) {
  const buf = [];
  const stack = [];                              // 内层容器的冒号数：内层自己收自己
  let closed = false;
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    const fence = RE_FENCE.exec(line);
    if (fence) {                                 // 代码块整块抄进来：里面的 ::: 不算容器边界
      const r = readFence(lines, j, fence);
      for (let k = j; k < r.next; k++) buf.push(lines[k]);
      j = r.next;
      continue;
    }
    const nested = containerOpen(line);
    const close = nested ? 0 : containerClose(line);
    if (nested) stack.push(nested.colons);
    else if (close) {
      if (stack.length) {
        if (close >= stack[stack.length - 1]) stack.pop();
      } else if (close >= open.colons) { closed = true; j++; break; }
    }
    buf.push(line);
    j++;
  }
  if (!closed) state.warnings.push('::: ' + open.label + ' 没有找到收尾的 :::，已按到文末处理');
  else if (open.kind === 'plain') state.warnings.push('不认识的提示区块类型「' + open.label + '」，已按中性样式渲染（可用类型见 docs/指南/写内容/支持的语法.md）');
  const node = { type: 'container', kind: open.kind, label: open.label, children: parseBlocks(buf, state, opts) };
  if (open.title) node.title = parseInline(open.title, state);
  return { node, next: j };
}

function readIndentedCode(lines, i) {
  const buf = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (/^ {4}/.test(line)) { buf.push(line.slice(4)); j++; continue; }
    if (!line.trim()) {
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && /^ {4}/.test(lines[k])) {
        for (let x = j; x < k; x++) buf.push('');
        j = k;
        continue;
      }
      break;
    }
    break;
  }
  while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
  return { node: { type: 'code', lang: '', code: buf.join('\n') }, next: j };
}

function readQuote(lines, i, state, opts) {
  const buf = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (RE_QUOTE.test(line)) { buf.push(line.replace(RE_QUOTE, '')); j++; continue; }
    if (!line.trim()) {
      if (j + 1 < lines.length && RE_QUOTE.test(lines[j + 1])) { buf.push(''); j++; continue; }
      break;
    }
    if (startsNewBlock(lines, j)) break;
    buf.push(line);
    j++;
  }
  return { node: { type: 'blockquote', children: parseBlocks(buf, state, opts) }, next: j };
}

function readFootnote(lines, i, m, state, opts) {
  const id = m[1];
  const buf = [m[2]];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (!line.trim()) {
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && /^ {4}/.test(lines[k])) {
        for (let x = j; x < k; x++) buf.push('');
        j = k;
        continue;
      }
      break;
    }
    if (/^ {4}/.test(line)) { buf.push(line.slice(4)); j++; continue; }
    break;
  }
  state.defs.set(id, { id, children: parseBlocks(buf, state, opts) });
  return j;
}

function readHtmlBlock(lines, i) {
  const buf = [];
  let j = i;
  if (RE_HTML_COMMENT.test(lines[j])) {
    while (j < lines.length) {
      buf.push(lines[j]);
      const done = /-->/.test(lines[j]);
      j++;
      if (done) break;
    }
    return { node: { type: 'html', html: buf.join('\n') }, next: j };
  }
  while (j < lines.length && lines[j].trim()) { buf.push(lines[j]); j++; }
  return { node: { type: 'html', html: buf.join('\n') }, next: j };
}

function readList(lines, i, state, opts) {
  const first = RE_LIST.exec(lines[i]);
  const base = first[1].length;
  const ordered = /[0-9]/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  let j = i;

  while (j < lines.length) {
    const m = RE_LIST.exec(lines[j]);
    if (!m || m[1].length !== base || /[0-9]/.test(m[2]) !== ordered) break;

    const contentCol = m[1].length + m[2].length + (m[3] ? m[3].length : 1);
    const buf = [lines[j].slice(Math.min(contentCol, lines[j].length))];
    j++;
    let sawBlank = false;

    while (j < lines.length) {
      const line = lines[j];
      const nm = RE_LIST.exec(line);
      if (nm && nm[1].length <= base) break;
      if (!line.trim()) {
        let k = j;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k >= lines.length) { j = k; break; }
        const nm2 = RE_LIST.exec(lines[k]);
        if (nm2 && nm2[1].length <= base) {
          // 只有「本列表的下一个同级条目」之间的空行才让列表变松散；
          // 空行之后换成别的块/别的列表、或文档末尾，都不算松散（对齐 CommonMark）
          if (nm2[1].length === base && /[0-9]/.test(nm2[2]) === ordered) sawBlank = true;
          j = k;
          break;
        }
        if (countIndent(lines[k]) > base) {
          for (let x = j; x < k; x++) buf.push('');
          sawBlank = true;
          j = k;
          continue;
        }
        j = k;
        break;
      }
      const indent = countIndent(line);
      if (indent > base) { buf.push(line.slice(Math.min(indent, contentCol))); j++; continue; }
      if (startsNewBlock(lines, j)) break;
      buf.push(line.slice(base));
      j++;
    }

    if (sawBlank) loose = true;
    const children = parseBlocks(buf, state, opts);
    let task = null;
    const p0 = children.find(c => c.type === 'paragraph');
    if (p0 && p0.inline.length && p0.inline[0].type === 'text') {
      const t = RE_TASK.exec(p0.inline[0].value);
      if (t) {
        task = /[xX]/.test(t[1]);
        p0.inline[0] = { type: 'text', value: p0.inline[0].value.slice(t[0].length) };
      }
    }
    items.push({ children, task });
  }
  return { node: { type: 'list', ordered, start, tight: !loose, items }, next: j };
}

function readTable(lines, i, state) {
  const align = splitRow(lines[i + 1]).map(c => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return 'none';
  });
  const head = splitRow(lines[i]).map(c => parseInline(c, state));
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].trim() && hasPipe(lines[j])) {
    const cells = splitRow(lines[j]);
    const row = [];
    for (let c = 0; c < head.length; c++) row.push(parseInline(cells[c] == null ? '' : cells[c], state));
    rows.push(row);
    j++;
  }
  return { node: { type: 'table', align, head, rows }, next: j };
}

/* ---------------- 行 / 单元格工具 ---------------- */

function countIndent(line) { return /^ */.exec(line)[0].length; }

function hasPipe(line) { return /(^|[^\\])\|/.test(line); }

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '\\|'; k++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function isDelimRow(line) {
  if (!hasPipe(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  if (!hasPipe(lines[i])) return false;
  if (!isDelimRow(lines[i + 1])) return false;
  return splitRow(lines[i + 1]).length === splitRow(lines[i]).length;
}

function isHtmlBlockStart(line) {
  if (RE_HTML_COMMENT.test(line)) return true;
  const m = RE_HTML_OPEN.exec(line);
  return !!(m && BLOCK_TAGS.has(m[1].toLowerCase()));
}

function startsNewBlock(lines, i) {
  const line = lines[i];
  if (!line.trim()) return true;
  if (RE_HEADING.test(line) || RE_FENCE.test(line) || RE_HR.test(line)) return true;
  if (RE_QUOTE.test(line) || RE_LIST.test(line) || isHtmlBlockStart(line)) return true;
  if (containerOpen(line)) return true;
  return isTableStart(lines, i);
}

/* ---------------- 脚注 / 锚点 / 纯文本 ---------------- */

function makeFootnotes(state) {
  const seen = new Set();
  const items = [];
  for (const id of state.refOrder) {
    if (seen.has(id)) continue;
    const def = state.defs.get(id);
    if (!def) continue;
    seen.add(id);
    items.push({ id, index: items.length + 1, children: def.children });
  }
  return { type: 'footnotes', items };
}

export function slugify(text, usedIds) {
  let s = String(text == null ? '' : text).trim().toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~[\]()!.,;:'"“”‘’]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) s = 'section';
  if (!usedIds) return s;
  const n = usedIds.get(s) || 0;
  usedIds.set(s, n + 1);
  return n ? s + '-' + n : s;
}

export function plainText(nodes) {
  if (!nodes) return '';
  if (typeof nodes === 'string') return nodes;
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text': out += n.value; break;
      case 'code': out += n.value; break;
      case 'image': out += n.alt || ''; break;
      case 'hardbreak': out += ' '; break;
      default: if (n.children) out += plainText(n.children); break;
    }
  }
  return out;
}

/* ---------------- 行内解析 ---------------- */

const INLINE_RULES = [
  { name: 'escape', re: /\\([!-\/:-@\[-`{-~])/y },
  { name: 'code', re: /(`+)([\s\S]*?[^`])\1(?!`)/y },
  { name: 'image', re: /!\[([^\]]*)\]\(\s*(<[^<>\s]*>|[^\s()]*?)(?:\s+(["'])([\s\S]*?)\3)?\s*\)/y },
  { name: 'link', re: /\[([^\]]*)\]\(\s*(<[^<>\s]*>|[^\s()]*?)(?:\s+(["'])([\s\S]*?)\3)?\s*\)/y },
  { name: 'autolink', re: /<((?:https?:\/\/|mailto:)[^<>\s]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/y },
  { name: 'html', re: /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*?)?\/?>/y },
  { name: 'footnote', re: /\[\^([^\]\s]+)\]/y },
  { name: 'strongemStar', re: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/y },
  { name: 'strongemUnderscore', re: /(?<![\w])___(?=\S)([\s\S]*?\S)___(?![\w])/y },
  { name: 'strongStar', re: /\*\*(?=\S)([\s\S]*?\S)\*\*/y },
  { name: 'strongUnderscore', re: /(?<![\w])__(?=\S)([\s\S]*?\S)__(?![\w])/y },
  { name: 'del', re: /~~(?=\S)([\s\S]*?\S)~~/y },
  { name: 'emStar', re: /\*(?=\S)([\s\S]*?\S)\*/y },
  { name: 'emUnderscore', re: /(?<![\w])_(?=\S)([\s\S]*?\S)_(?![\w])/y },
  { name: 'barelink', re: /(?:https?:\/\/|www\.)[^\s<>()"'，。；：！？、）】」]+/y },
  { name: 'hardbreak', re: / {2,}\n/y },
  { name: 'newline', re: /\n/y }
];

function parseInline(text, state) {
  if (!text) return [];
  const nodes = [];
  let buf = '';
  let pos = 0;
  const flush = () => { if (buf) { nodes.push({ type: 'text', value: buf }); buf = ''; } };
  const lastChar = () => {
    if (buf) return buf[buf.length - 1];
    for (let k = nodes.length - 1; k >= 0; k--) {
      const n = nodes[k];
      if (n.type === 'text' || n.type === 'code') return n.value[n.value.length - 1] || '';
    }
    return '';
  };

  while (pos < text.length) {
    let hit = null;
    for (const rule of INLINE_RULES) {
      rule.re.lastIndex = pos;
      const m = rule.re.exec(text);
      if (m && m[0].length) { hit = { rule, m, end: rule.re.lastIndex }; break; }
    }
    if (!hit) { buf += text[pos]; pos++; continue; }

    const { rule, m, end } = hit;
    switch (rule.name) {
      case 'escape':
        buf += m[1];
        break;
      case 'code':
        flush();
        nodes.push({ type: 'code', value: stripCodePadding(m[2]) });
        break;
      case 'image':
        flush();
        nodes.push({ type: 'image', src: stripAngle(m[2]), alt: m[1], title: m[4] || '' });
        break;
      case 'link':
        flush();
        nodes.push({ type: 'link', href: stripAngle(m[2]), title: m[4] || '', children: parseInline(m[1], state) });
        break;
      case 'autolink': {
        flush();
        const url = m[1];
        nodes.push({
          type: 'link',
          href: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'mailto:' + url,
          title: '',
          children: [{ type: 'text', value: url }]
        });
        break;
      }
      case 'html':
        flush();
        nodes.push({ type: 'html', html: m[0] });
        break;
      case 'footnote': {
        flush();
        const id = m[1];
        if (state && !state.refOrder.includes(id)) state.refOrder.push(id);
        nodes.push({ type: 'footnoteRef', id });
        break;
      }
      case 'strongemStar':
      case 'strongemUnderscore':
        flush();
        nodes.push({ type: 'strong', children: [{ type: 'em', children: parseInline(m[1], state) }] });
        break;
      case 'strongStar':
      case 'strongUnderscore':
        flush();
        nodes.push({ type: 'strong', children: parseInline(m[1], state) });
        break;
      case 'del':
        flush();
        nodes.push({ type: 'del', children: parseInline(m[1], state) });
        break;
      case 'emStar':
      case 'emUnderscore':
        flush();
        nodes.push({ type: 'em', children: parseInline(m[1], state) });
        break;
      case 'barelink': {
        const trailing = m[0].length - m[0].replace(/[.,;:!?、，。]+$/, '').length;
        const url = m[0].slice(0, m[0].length - trailing);
        if (!url) { buf += text[pos]; pos++; continue; }
        flush();
        nodes.push({
          type: 'link',
          href: /^www\./i.test(url) ? 'http://' + url : url,
          title: '',
          children: [{ type: 'text', value: url }]
        });
        pos = end - trailing;
        continue;
      }
      case 'hardbreak':
        flush();
        nodes.push({ type: 'hardbreak' });
        break;
      case 'newline': {
        const prev = lastChar();
        const next = text[pos + 1] || '';
        if (!(RE_CJK.test(prev) && RE_CJK.test(next))) buf += ' ';
        break;
      }
    }
    pos = end;
  }
  flush();
  return nodes;
}

function stripCodePadding(s) {
  if (s.length > 2 && s.startsWith(' ') && s.endsWith(' ') && s.trim()) return s.slice(1, -1);
  return s;
}

function stripAngle(s) {
  return s && s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
}
