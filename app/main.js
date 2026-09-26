/* ============================================================
   app/main.js —— 路由 / 侧栏 / 大纲 / 主题 / 渲染 / 交互
   依赖：app/markdown.js（解析器）、app/style.css
   配置来源（后者覆盖前者）：
     内置默认值 ← 内容根/_config.json ← index.html 里的 window.MD_SITE（可选，换内容根用）
   本文件与 index.html 都不含任何具体项目的信息：换项目 = 换内容根那个目录。
   ============================================================ */
import { parse, plainText } from './markdown.js';

/* 内容根默认 docs/；root 必须在读 _config.json 之前定下来，所以它只能来自这里或外壳 */
const DEFAULTS = {
  name: '',                // 顶栏标题；留空则取清单里第一个文档的标题
  home: 'README.md',       // 首页文件（#/ 路由指向它）
  root: 'docs',            // 内容根：正文 / 图片 / 配置文件 / 清单都在它下面；'' = 与入口同级
  nav: '_sidebar.md',      // 左栏清单文件（相对内容根）；旧名 sidebar 仍然接受
  toc: [2, 3],             // 右栏大纲收录的标题级别；[] = 关闭
  sidebarExpanded: 'all',  // 左栏分类初始展开：'all' / 'none' / ['指南', '指南/写内容']
  cacheVersion: '',        // 破缓存版本号，会拼到所有内容请求上（配置文件自己不带）
  theme: 'auto'            // auto | light | dark
};
const OVERRIDE = window.MD_SITE || {};      // 外壳级覆盖：换内容根、测试夹具都靠它
const CFG = Object.assign({}, DEFAULTS, OVERRIDE);
const ALIAS = { sidebar: 'nav' };           // 旧名，别让老写法失效

/* 逐键并入配置：只认已知键（拼错的键要吭声），'_' 前缀的键当注释静默跳过，
   '' 也照收——显式清空是有意义的。fromFile 时 root 太晚了，只能忽略。 */
function applyKeys(src, fromFile) {
  for (const key of Object.keys(src || {})) {
    const v = src[key];
    if (key.startsWith('_') || v === undefined) continue;
    if (fromFile && key === 'root') {
      console.warn('[md-site] root 只能写在 index.html 的 window.MD_SITE 里，_config.json 里的已忽略');
      continue;
    }
    const name = ALIAS[key] || key;
    if (!(name in DEFAULTS)) {
      console.warn('[md-site] 不认识的配置键：' + key + '（可用键见 docs/指南/站点配置.md）');
      continue;
    }
    CFG[name] = v;
  }
}

/* 项目配置住在内容根里（默认 docs/_config.json），外壳与 app/ 对具体项目一无所知。
   读不到 / 不是合法 JSON → 退回默认值，站点照常跑，只在控制台留一条 warn。 */
async function loadConfig() {
  if (!CFG.root) return;                    // root: '' → 内容就在入口旁边，没有独立内容根
  const url = contentBase() + '_config.json';
  let file = null;
  try {
    const res = await fetch(url, { cache: 'no-store' });   // 版本号自己也在里面，不能拼 v=
    if (res.ok) file = JSON.parse(await res.text());       // 404 = 没这个文件，静默用默认值
  } catch (e) {
    console.warn('[md-site] ' + url + ' 读不了或不是合法 JSON，改用默认配置：', e.message);
  }
  if (file && typeof file === 'object') applyKeys(file, true);
  applyKeys(OVERRIDE, false);               // 外壳覆盖优先级最高
}

const THEME_KEY = 'md-site-theme';
const GROUP_KEY = 'md-site-group-state';

const state = {
  route: '',
  docPath: '',
  loaded: false,
  token: 0,
  cache: new Map(),
  headings: [],
  tocLinks: new Map(),
  sidebarItems: []
};

/* ---------------- 小工具 ---------------- */

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function splitHash(href) {
  const i = String(href).indexOf('#');
  if (i < 0) return [String(href), ''];
  return [String(href).slice(0, i), String(href).slice(i + 1)];
}

function dirname(path) {
  const clean = String(path).replace(/^\/+/, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? '' : clean.slice(0, i);
}

function anchorId(id) { return 'fn-' + String(id).replace(/[^\w\u4e00-\u9fff-]/g, '_'); }
function backRefId(id) { return 'fnref-' + String(id).replace(/[^\w\u4e00-\u9fff-]/g, '_'); }

function contentBase() {
  return CFG.root ? String(CFG.root).replace(/^\/+|\/+$/g, '') + '/' : '';
}

function topbarHeight() {
  const bar = $('#topbar');
  return bar ? (bar.offsetHeight || 60) : 60;
}

/* 给自动化测试用的可观测钩子：<html data-md-state="ready" data-md-doc="路径"> */
function markState(kind) {
  const root = document.documentElement;
  root.dataset.mdState = kind;
  root.dataset.mdDoc = state.docPath;
}

/* ---------------- 主题 ---------------- */

function themeMode() {
  return localStorage.getItem(THEME_KEY) || CFG.theme || 'auto';
}

function applyTheme(mode, persist) {
  const resolved = mode === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : (mode === 'dark' ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', resolved);
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = resolved === 'dark' ? '☀️' : '🌙';
    btn.title = resolved === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  }
  if (persist) localStorage.setItem(THEME_KEY, mode);
}

/* ---------------- 代码高亮（不引 Prism，够用即止） ---------------- */

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'Infinity']);

const HL = {
  js: {
    comment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
    string: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/,
    kw: 'as async await break case catch class const continue default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield globalThis require'
  },
  json: {
    comment: /\/\/[^\n]*/,
    string: /"(?:[^"\\\n]|\\.)*"/,
    kw: ''
  },
  python: {
    comment: /#[^\n]*/,
    string: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/,
    kw: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self'
  },
  sh: {
    comment: /#[^\n]*/,
    string: /"(?:[^"\\]|\\.)*"|'[^']*'/,
    kw: 'if then else elif fi for while until do done case esac function return exit export local readonly declare set unset shift trap echo cd source alias sudo apt systemctl curl wget git npm docker'
  },
  java: {
    comment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
    string: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/,
    kw: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed'
  },
  go: {
    comment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
    string: /"(?:[^"\\\n]|\\.)*"|`[^`]*`/,
    kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil'
  },
  rust: {
    comment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
    string: /"(?:[^"\\\n]|\\.)*"/,
    kw: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while'
  },
  sql: {
    comment: /--[^\n]*|\/\*[\s\S]*?\*\//,
    string: /'(?:[^']|'')*'/,
    kw: 'select from where group by order having limit offset insert into values update set delete create table index view drop alter add column primary key foreign references not null default and or in like between as join left right inner outer on union all distinct case when then else end asc desc explain analyze'
  },
  yaml: {
    comment: /#[^\n]*/,
    string: /"(?:[^"\\\n]|\\.)*"|'[^']*'/,
    kw: ''
  },
  xml: {
    comment: /<!--[\s\S]*?-->/,
    string: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/,
    kw: ''
  },
  css: {
    comment: /\/\*[\s\S]*?\*\//,
    string: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/,
    kw: ''
  }
};
HL.ts = HL.js;
HL.typescript = HL.js;
HL.py = HL.python;
HL.bash = HL.sh;
HL.zsh = HL.sh;
HL.shell = HL.sh;
HL.console = HL.sh;
HL.html = HL.xml;
HL.yml = HL.yaml;

/* 把源码切成 span，尽量只做「不破坏源码」的高亮：文本拼接回去必须等于原文 */
function highlight(code, lang) {
  const frag = document.createDocumentFragment();
  const cfg = HL[String(lang || '').toLowerCase()];
  if (!cfg) { frag.appendChild(document.createTextNode(code)); return frag; }
  const kw = new Set(cfg.kw.split(/\s+/).filter(Boolean));
  const parts = [];
  if (cfg.comment) parts.push('(' + cfg.comment.source + ')');
  if (cfg.string) parts.push('(' + cfg.string.source + ')');
  parts.push('\\b\\d[\\w.]*\\b');
  parts.push('[A-Za-z_$][\\w$]*');
  const re = new RegExp(parts.join('|'), 'g');
  let last = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    if (m.index > last) frag.appendChild(document.createTextNode(code.slice(last, m.index)));
    const text = m[0];
    let cls = '';
    if (m[1] !== undefined) cls = 'tok-comment';
    else if (m[2] !== undefined) cls = 'tok-string';
    else if (/^\d/.test(text)) cls = 'tok-number';
    else if (LITERALS.has(text)) cls = 'tok-literal';
    else if (kw.has(text)) cls = 'tok-keyword';
    frag.appendChild(cls ? el('span', cls, text) : document.createTextNode(text));
    last = m.index + text.length;
  }
  if (last < code.length) frag.appendChild(document.createTextNode(code.slice(last)));
  return frag;
}

/* ---------------- 复制 / 图片浮层 / 抽屉 ---------------- */

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 继续降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function openLightbox(img) {
  const box = $('#lightbox');
  const big = box.querySelector('img');
  big.src = img.currentSrc || img.src;
  big.alt = img.alt || '';
  box.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const box = $('#lightbox');
  if (box.hidden) return;
  box.hidden = true;
  document.body.style.overflow = '';
}

function syncOverlay() {
  const on = $('#sidebar').classList.contains('drawer-open') || $('#toc').classList.contains('panel-open');
  $('#overlay').hidden = !on;
}
function openDrawer() { $('#sidebar').classList.add('drawer-open'); syncOverlay(); }
function closeDrawer() { $('#sidebar').classList.remove('drawer-open'); syncOverlay(); }
function toggleTocPanel() { $('#toc').classList.toggle('panel-open'); syncOverlay(); }
function closeTocPanel() { $('#toc').classList.remove('panel-open'); syncOverlay(); }

/* ---------------- 原始 HTML 透传（白名单清洗） ----------------
   唯一使用 innerHTML 的地方：先塞进 <template>（内容是惰性的，不会执行脚本、
   不会加载图片），再逐节点按白名单重建。Markdown 正文一律不走这里。
   ------------------------------------------------------------ */

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'br', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'mark',
  'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
]);
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input',
  'button', 'textarea', 'select', 'option', 'svg', 'math', 'video', 'audio', 'source',
  'track', 'template', 'noscript', 'frame', 'frameset', 'applet', 'canvas'
]);
const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan',
  'open', 'class', 'id', 'target', 'rel', 'loading', 'start'
]);
const URL_ATTRS = new Set(['href', 'src']);

function isDangerousUrl(value) {
  const v = String(value).replace(/[\u0000-\u0020]/g, '').toLowerCase();
  if (v.startsWith('javascript:') || v.startsWith('vbscript:')) return true;
  if (v.startsWith('data:') && !v.startsWith('data:image/')) return true;
  return false;
}

function sanitizeFragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  const frag = document.createDocumentFragment();
  for (const node of Array.from(tpl.content.childNodes)) frag.appendChild(cleanNode(node));
  return frag;
}

function cleanNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');
  const tag = node.tagName.toLowerCase();
  if (DROP_TAGS.has(tag)) return document.createTextNode('');
  if (!ALLOWED_TAGS.has(tag)) {
    const frag = document.createDocumentFragment();
    for (const child of Array.from(node.childNodes)) frag.appendChild(cleanNode(child));
    return frag;
  }
  const copy = document.createElement(tag);
  for (const attr of Array.from(node.attributes)) {
    const name = String(attr.name).toLowerCase();
    if (name.startsWith('on')) continue;
    if (!ALLOWED_ATTRS.has(name)) continue;
    if (URL_ATTRS.has(name) && isDangerousUrl(attr.value)) continue;
    try { copy.setAttribute(name, attr.value); } catch (e) { /* 非法属性名，忽略 */ }
  }
  for (const child of Array.from(node.childNodes)) copy.appendChild(cleanNode(child));
  return copy;
}

/* ---------------- 渲染：行内 ---------------- */

function appendInline(container, nodes, ctx) {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        container.appendChild(document.createTextNode(node.value));
        break;
      case 'code':
        container.appendChild(el('code', null, node.value));
        break;
      case 'strong': {
        const n = el('strong'); appendInline(n, node.children, ctx); container.appendChild(n); break;
      }
      case 'em': {
        const n = el('em'); appendInline(n, node.children, ctx); container.appendChild(n); break;
      }
      case 'del': {
        const n = el('del'); appendInline(n, node.children, ctx); container.appendChild(n); break;
      }
      case 'hardbreak':
        container.appendChild(el('br'));
        break;
      case 'html':
        container.appendChild(sanitizeFragment(node.html));
        break;
      case 'image':
        container.appendChild(renderImage(node, ctx));
        break;
      case 'link':
        container.appendChild(renderLink(node, ctx));
        break;
      case 'footnoteRef': {
        const item = ctx.footnoteMap.get(node.id);
        if (!item) { container.appendChild(document.createTextNode('[^' + node.id + ']')); break; }
        const sup = el('sup', 'footnote-ref');
        const a = el('a', null, String(item.index));
        a.href = ctx.hrefBase + '#' + anchorId(node.id);
        if (!ctx.footnoteRefSeen.has(node.id)) {
          ctx.footnoteRefSeen.add(node.id);
          a.id = backRefId(node.id);
        }
        sup.appendChild(a);
        container.appendChild(sup);
        break;
      }
      default:
        break;
    }
  }
  return container;
}

function renderLink(node, ctx) {
  const info = resolveHref(node.href, ctx);
  if (info.blocked) return el('span', 'link-blocked', plainText(node.children));
  const a = el('a');
  a.href = info.href;
  if (info.external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  if (node.title) a.title = node.title;
  appendInline(a, node.children, ctx);
  return a;
}

function renderImage(node, ctx) {
  const img = el('img');
  const src = String(node.src || '');
  img.src = (/^(?:https?:)?\/\//i.test(src) || /^data:/i.test(src)) ? src : assetUrl(src, ctx);
  img.alt = node.alt || '';
  img.loading = 'lazy';
  if (node.title) img.title = node.title;
  return img;
}

/* 图片按「内容根 + 当前文档目录」解析；Markdown 里的绝对路径同样落在内容根下 */
function assetUrl(src, ctx) {
  const clean = String(src).replace(/^\/+/, '');
  return contentBase() + (ctx.docDir ? ctx.docDir + '/' : '') + clean;
}

/* 站内链接一律转成路由；危险协议直接降级为纯文本 */
function resolveHref(href, ctx) {
  const raw = String(href == null ? '' : href).trim();
  if (!raw) return { href: '' };
  if (isDangerousUrl(raw)) return { blocked: true };
  if (/^(?:https?:)?\/\//i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return { href: raw, external: true };
  if (raw.startsWith('#')) return { href: ctx.hrefBase + '#' + safeDecode(raw.slice(1)) };
  const [pathPart, hashPart] = splitHash(raw);
  const file = resolvePath(ctx.docDir, safeDecode(pathPart));
  return { href: routeFromFile(file) + (hashPart ? '#' + safeDecode(hashPart) : '') };
}

function resolvePath(dir, ref) {
  if (!ref) return dir ? dir + '/' : '';
  if (ref.startsWith('/')) return ref.replace(/^\/+/, '');
  const out = dir ? dir.split('/') : [];
  for (const part of ref.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

/* 内容路径归一化：消掉 './' 与根内的 '../'。返回 null = 越出内容根（docPath 里保留原样、由 fetchText 判 404） */
function contentPath(path) {
  const raw = String(path == null ? '' : path);
  let depth = 0;
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (--depth < 0) return null; continue; }
    depth += 1;
  }
  return resolvePath('', raw);
}

function fileFromRoute(route) {
  if (!route) return CFG.home;
  const safe = contentPath(route);
  if (safe === null) return route;  // 越界：留在 docPath 里给 404 页回显
  if (route.endsWith('/')) return safe + '/README.md';
  return /\.md$/i.test(safe) ? safe : safe + '.md';
}

function routeFromFile(file) {
  const p = String(file || '').replace(/\.md$/i, '').replace(/^\/+/, '');
  const home = String(CFG.home || '').replace(/\.md$/i, '').replace(/^\/+/, '');
  return !p || p === home ? '#/' : '#/' + p;
}

function renderDocument(ast, ctx) {
  ctx.footnoteMap = new Map();
  ctx.footnoteRefSeen = new Set();
  for (const node of ast.children) {
    if (node.type === 'footnotes') for (const item of node.items) ctx.footnoteMap.set(item.id, item);
  }
  return renderBlocks(ast.children, ctx);
}

/* ---------------- 渲染：块级 ---------------- */

function renderBlocks(nodes, ctx) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) frag.appendChild(renderBlock(node, ctx));
  return frag;
}

function renderBlock(node, ctx) {
  switch (node.type) {
    case 'heading': {
      const h = el('h' + node.level);
      h.id = node.id;
      appendInline(h, node.inline, ctx);
      return h;
    }
    case 'paragraph': {
      const p = el('p');
      appendInline(p, node.inline, ctx);
      return p;
    }
    case 'code':
      return renderCode(node);
    case 'blockquote': {
      const q = el('blockquote');
      q.appendChild(renderBlocks(node.children, ctx));
      return q;
    }
    case 'container':
      return renderContainer(node, ctx);
    case 'list':
      return renderList(node, ctx);
    case 'table':
      return renderTable(node, ctx);
    case 'hr':
      return el('hr');
    case 'html':
      return sanitizeFragment(node.html);
    case 'footnotes':
      return renderFootnotes(node, ctx);
    default:
      return document.createTextNode('');
  }
}

/* 提示区块 ::: tip / info / warning / danger / details；没写标题时用类型名当标题（就是 VuePress 的样子） */
const CONTAINER_TITLES = { tip: '提示', info: '说明', warning: '警告', danger: '危险', details: '详情' };

function renderContainer(node, ctx) {
  if (node.kind === 'details') {                 // 折叠块：直接用原生 <details>
    const box = el('details', 'custom-details');
    box.appendChild(el('summary', null, plainText(node.title) || CONTAINER_TITLES.details));
    box.appendChild(renderBlocks(node.children, ctx));
    return box;
  }
  const box = el('div', 'custom-block custom-block-' + node.kind);
  const title = el('p', 'custom-block-title');
  if (node.title && node.title.length) appendInline(title, node.title, ctx);
  else title.textContent = CONTAINER_TITLES[node.kind] || node.label;
  box.appendChild(title);
  box.appendChild(renderBlocks(node.children, ctx));
  return box;
}

function renderCode(node) {
  const wrap = el('div', 'code-block');
  const head = el('div', 'code-head');
  head.appendChild(el('span', 'code-lang', node.lang || 'text'));
  const btn = el('button', 'copy-btn', '复制');
  btn.type = 'button';
  head.appendChild(btn);

  const pre = el('pre');
  const code = el('code');
  if (node.lang) code.className = 'language-' + node.lang;
  const body = highlight(node.code, node.lang);
  code.appendChild(node.hl && node.hl.length ? wrapCodeLines(body, node.hl) : body);
  pre.appendChild(code);

  wrap.appendChild(head);
  wrap.appendChild(pre);

  btn.addEventListener('click', async () => {
    const ok = await copyText(node.code);
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  });
  return wrap;
}

/* 行高亮：highlight() 只往文本里插 <span>、逐字保留原文，所以按换行切成行再逐行套 span 是安全的 */
function wrapCodeLines(frag, marks) {
  const set = new Set(marks);
  const lines = [[]];
  const cur = () => lines[lines.length - 1];
  const add = (parts, make) => {                 // 已按 \n 切开：除第一段外都另起一行
    parts.forEach((part, k) => {
      if (k) lines.push([]);
      if (part) cur().push(make(part));
    });
  };
  (function walk(parent) {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) {
        add(String(child.nodeValue).split('\n'), (text) => document.createTextNode(text));
      } else if (child.textContent.indexOf('\n') < 0) {
        cur().push(child.cloneNode(true));
      } else {
        add(child.textContent.split('\n'), (text) => el('span', child.className, text));   // 跨行 token（多行注释等）
      }
    }
  })(frag);

  const out = document.createDocumentFragment();
  lines.forEach((nodes, idx) => {
    if (idx) out.appendChild(document.createTextNode('\n'));
    const box = el('span', set.has(idx + 1) ? 'code-line hl' : 'code-line');
    for (const n of nodes) box.appendChild(n);
    out.appendChild(box);
  });
  return out;
}

function renderList(node, ctx) {
  const list = el(node.ordered ? 'ol' : 'ul');
  if (node.ordered && node.start !== 1) list.start = node.start;
  for (const item of node.items) {
    const li = el('li');
    const content = renderItemContent(item.children, ctx, node.tight);
    if (typeof item.task === 'boolean') {
      list.classList.add('task-list');
      li.className = 'task-list-item';
      const box = el('input');
      box.type = 'checkbox';
      box.disabled = true;
      box.checked = item.task;
      const span = el('span');
      span.appendChild(content);
      li.appendChild(box);
      li.appendChild(span);
    } else {
      li.appendChild(content);
    }
    list.appendChild(li);
  }
  return list;
}

function renderItemContent(children, ctx, tight) {
  const frag = document.createDocumentFragment();
  for (const child of children) {
    if (tight && child.type === 'paragraph') appendInline(frag, child.inline, ctx);
    else frag.appendChild(renderBlock(child, ctx));
  }
  return frag;
}

function applyAlign(cell, align) {
  if (align && align !== 'none') cell.style.textAlign = align;
}

function renderTable(node, ctx) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const thead = el('thead');
  const htr = el('tr');
  node.head.forEach((cell, i) => {
    const th = el('th');
    applyAlign(th, node.align[i]);
    appendInline(th, cell, ctx);
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of node.rows) {
    const tr = el('tr');
    row.forEach((cell, i) => {
      const td = el('td');
      applyAlign(td, node.align[i]);
      appendInline(td, cell, ctx);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderFootnotes(node, ctx) {
  const sec = el('section', 'footnotes');
  sec.appendChild(el('hr'));
  const ol = el('ol');
  for (const item of node.items) {
    const li = el('li');
    li.id = anchorId(item.id);
    const kids = item.children;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (i === kids.length - 1 && child.type === 'paragraph') {
        const p = el('p');
        appendInline(p, child.inline, ctx);
        const back = el('a', 'footnote-backref', '↩');
        back.href = ctx.hrefBase + '#' + backRefId(item.id);
        back.title = '回到引用处';
        p.appendChild(back);
        li.appendChild(p);
      } else {
        li.appendChild(renderBlock(child, ctx));
      }
    }
    ol.appendChild(li);
  }
  sec.appendChild(ol);
  return sec;
}

/* ---------------- 路由与加载 ---------------- */

function readRoute() {
  let hash = location.hash || '';
  if (hash.startsWith('#')) hash = hash.slice(1);
  let anchor = '';
  const q = hash.indexOf('?id=');
  if (q >= 0) { anchor = safeDecode(hash.slice(q + 4)); hash = hash.slice(0, q); }
  const h = hash.indexOf('#');
  if (h >= 0) {
    if (!anchor) anchor = safeDecode(hash.slice(h + 1));
    hash = hash.slice(0, h);
  }
  return { route: safeDecode(hash.replace(/^\/+/, '')), anchor };
}

function docUrl(path) {
  const url = contentBase() + String(path).replace(/^\/+/, '');
  if (!CFG.cacheVersion) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(CFG.cacheVersion);
}

async function fetchText(path) {
  const safe = contentPath(path);
  if (safe === null) {  // 越出内容根（失败模式 #48）：一律当 404，绝不渲染内容根之外的文件
    const err = new Error('HTTP 404 ' + docUrl(path) + '（越出内容根）');
    err.status = 404;
    throw err;
  }
  const res = await fetch(docUrl(safe));
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' ' + docUrl(safe));
    err.status = res.status;
    throw err;
  }
  return res.text();
}

function scrollToAnchor(anchor) {
  if (!anchor) return;
  const target = document.getElementById(safeDecode(anchor));
  if (!target) return;
  const top = target.getBoundingClientRect().top + window.scrollY - topbarHeight() - 12;
  window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
  setActiveToc(target.id);
}

async function route() {
  const { route: r, anchor } = readRoute();
  const path = fileFromRoute(r);
  state.token += 1;
  const token = state.token;

  if (state.loaded && r === state.route) {
    scrollToAnchor(anchor);
    closeDrawer();
    closeTocPanel();
    return;
  }

  state.route = r;
  state.docPath = path;
  const timer = setTimeout(() => { if (token === state.token) showLoading(); }, 200);

  try {
    let text = state.cache.get(path);
    if (text == null) {
      text = await fetchText(path);
      state.cache.set(path, text);
    }
    if (token !== state.token) return;
    renderDoc(text, anchor);
    state.loaded = true;
  } catch (err) {
    if (token !== state.token) return;
    renderError(err);
    state.loaded = true;
  } finally {
    clearTimeout(timer);
  }

  updateSidebarActive();
  closeDrawer();
  closeTocPanel();
}

function showLoading() {
  $('#content').replaceChildren(el('p', 'state-kv', '加载中…'));
  clearToc();
  markState('loading');
}

function renderDoc(text, anchor) {
  const ast = parse(text);
  for (const w of ast.warnings || []) console.warn('[md-site] ' + w);
  const article = $('#content');
  const ctx = { docDir: dirname(state.docPath), hrefBase: '#/' + state.route };
  article.replaceChildren(renderDocument(ast, ctx));

  const h1 = article.querySelector('h1');
  const heading = h1 ? h1.textContent.trim() : '';
  const title = heading || state.route || CFG.name || '文档';
  document.title = CFG.name ? title + ' · ' + CFG.name : title;

  buildToc(article);
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (anchor) requestAnimationFrame(() => scrollToAnchor(anchor));
  markState('ready');
}

function linkTo(href, text) {
  const a = el('a', null, text);
  a.href = href;
  return a;
}

function reportDoc() {
  const flat = [];
  const walk = (items) => {
    for (const item of items) {
      const href = String(item.href || '');
      if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        const r = href.replace(/^#\/?/, '').replace(/\.md$/i, '');
        flat.push({ label: item.label, file: fileFromRoute(r) });
      }
      walk(item.children);
    }
  };
  walk(state.sidebarItems);
  return flat;
}

function suggestDocs(route) {
  const flat = reportDoc();
  const segs = String(route).split('/').filter(Boolean);
  if (!segs.length) return flat.slice(0, 6);
  const hits = flat.filter((f) => segs.some((s) => {
    const low = s.toLowerCase();
    return f.file.toLowerCase().includes(low) || f.label.includes(s);
  }));
  return (hits.length ? hits : flat).slice(0, 6);
}

function renderError(err) {
  const article = $('#content');
  article.replaceChildren();
  const box = el('div', 'state-page');
  const notFound = !!(err && err.status === 404);
  box.appendChild(el('h1', null, notFound ? '找不到这篇文档（404）' : '加载失败'));
  box.appendChild(el('p', 'state-kv', docUrl(state.docPath)));

  const p = el('p');
  if (notFound) p.appendChild(document.createTextNode('请检查文件名，或 ' + CFG.nav + ' 里的路径是否正确。'));
  else p.appendChild(document.createTextNode('错误信息：' + ((err && err.message) || err) + '（若双击打开，请改用 HTTP 静态服务）'));
  p.appendChild(document.createTextNode(' '));
  p.appendChild(linkTo('#/', '回到首页'));
  box.appendChild(p);

  const suggests = suggestDocs(state.route);
  if (suggests.length) {
    box.appendChild(el('h2', null, '是不是要找：'));
    const ul = el('ul');
    for (const item of suggests) {
      const li = el('li');
      li.appendChild(linkTo(routeFromFile(item.file), item.label));
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  article.appendChild(box);
  document.title = (notFound ? '找不到文档' : '加载失败') + (CFG.name ? ' · ' + CFG.name : '');
  clearToc();
  window.scrollTo({ top: 0, behavior: 'auto' });
  markState(notFound ? 'missing' : 'error');
}

/* ---------------- 右栏大纲 + 滚动高亮 ---------------- */

function clearToc() {
  $('#toc').replaceChildren();
  state.headings = [];
  state.tocLinks = new Map();
}

function tocAnchorHref(id) {
  return (state.route ? '#/' + state.route : '#/') + '#' + id;
}

function buildToc(article) {
  clearToc();
  const levels = (CFG.toc || [])
    .map((n) => parseInt(n, 10))
    .filter((n) => n >= 1 && n <= 6);
  const toc = $('#toc');
  if (!levels.length) return;

  const heads = Array.from(article.querySelectorAll(levels.map((l) => 'h' + l).join(',')))
    .filter((h) => h.id);
  const ul = el('ul');
  for (const h of heads) {
    const li = el('li', 'toc-h' + h.tagName.charAt(1));
    li.appendChild(linkTo(tocAnchorHref(h.id), h.textContent.trim()));
    ul.appendChild(li);
    state.headings.push(h);
    state.tocLinks.set(h.id, li);
  }
  toc.appendChild(el('div', 'toc-title', '本页大纲'));
  toc.appendChild(heads.length ? ul : el('div', 'toc-empty', '本篇没有二级标题'));
  spy();
}

function setActiveToc(id) {
  state.tocLinks.forEach((li, key) => li.classList.toggle('active', key === id));
  const li = state.tocLinks.get(id);
  if (!li) return;
  const box = $('#toc');
  const r = li.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  // 只挪大纲自己的滚动条，别牵动页面
  if (r.top < br.top + 4) box.scrollTop -= (br.top + 4 - r.top);
  else if (r.bottom > br.bottom - 4) box.scrollTop += (r.bottom - (br.bottom - 4));
}

/* 取「最后一个已经越过顶栏的标题」作为当前小节，比 IntersectionObserver 更可预期 */
function spy() {
  if (!state.headings.length) return;
  const line = topbarHeight() + 24;
  let current = state.headings[0];
  for (const h of state.headings) {
    if (h.getBoundingClientRect().top <= line) current = h;
    else break;
  }
  setActiveToc(current.id);
}

let spyQueued = false;
function onScroll() {
  if (spyQueued) return;
  spyQueued = true;
  requestAnimationFrame(() => { spyQueued = false; spy(); });
}

/* ---------------- 左侧目录树 ---------------- */

/* 分类展开状态：{ key: 'open' | 'closed' }，内存缓存一份，避免每个分类都读一次 localStorage */
let groupCache = null;

function readGroupState() {
  if (groupCache) return groupCache;
  groupCache = {};
  try {
    const raw = JSON.parse(localStorage.getItem(GROUP_KEY) || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) groupCache = raw;
  } catch (e) { /* 隐私模式 / 脏数据：当作没有显式状态 */ }
  return groupCache;
}

function writeGroupState(key, value) {
  const map = readGroupState();
  if (value) map[key] = value;
  else delete map[key];
  try { localStorage.setItem(GROUP_KEY, JSON.stringify(map)); } catch (e) { /* 忽略 */ }
}

/* sidebarExpanded：'all'（默认，全展开）/ 'none'（全收起）/ ['目录名', '父/子', ...]（只展开点名的） */
let expandedCfg = null;

function expandedConfig() {
  if (expandedCfg) return expandedCfg;
  const value = CFG.sidebarExpanded;
  if (Array.isArray(value)) {
    const paths = new Set();
    const labels = new Set();
    const names = [];
    for (const raw of value) {
      const name = String(raw == null ? '' : raw).trim();
      if (!name) continue;
      names.push(name);
      (name.includes('/') ? paths : labels).add(name);
    }
    expandedCfg = { mode: 'list', paths, labels, names };
  } else if (value === 'none') {
    expandedCfg = { mode: 'none' };
  } else {
    if (value !== 'all' && value != null && value !== '') {
      console.warn('[md-site] sidebarExpanded 只认 \'all\' / \'none\' / 目录名数组，已按 \'all\' 处理：', value);
    }
    expandedCfg = { mode: 'all' };
  }
  return expandedCfg;
}

/* 把 key 自身连同它的每一层祖先都放进集合（父/子/孙 这种路径链） */
function addChain(key, target) {
  let k = key;
  while (k) {
    target.add(k);
    const i = k.lastIndexOf('/');
    if (i < 0) break;
    k = k.slice(0, i);
  }
}

let expandWarned = false;

/* 计算并套用所有分类的展开状态：
   可见性硬规则（当前文档路径 / 白名单命中及其祖先） > 用户显式操作 > sidebarExpanded 默认。
   硬规则只影响显示，不写回 localStorage。 */
function applyGroupStates() {
  const groups = Array.from(document.querySelectorAll('.sidebar-nav li.group'));
  if (!groups.length) return;
  const cfg = expandedConfig();
  const reveal = new Set();

  const active = document.querySelector('.sidebar-nav a.active');
  for (let node = active ? active.parentElement : null; node; node = node.parentElement) {
    if (node.dataset && node.dataset.key) reveal.add(node.dataset.key);
  }

  if (cfg.mode === 'list') {
    const matched = new Set();
    for (const li of groups) {
      const key = li.dataset.key || '';
      const label = li.dataset.label || '';
      if (cfg.paths.has(key)) { matched.add(key); addChain(key, reveal); }
      else if (cfg.labels.has(label)) { matched.add(label); addChain(key, reveal); }
    }
    if (!expandWarned) {
      expandWarned = true;
      for (const name of cfg.names) {
        if (!matched.has(name)) console.warn('[md-site] sidebarExpanded 里的目录名没匹配到任何分类：' + name);
      }
    }
  }

  const state = readGroupState();
  for (const li of groups) {
    const key = li.dataset.key || '';
    const explicit = state[key];
    let open;
    if (reveal.has(key)) open = true;
    else if (explicit) open = explicit === 'open';
    else open = cfg.mode === 'all';
    li.classList.toggle('open', open);
    const btn = li.querySelector(':scope > button.group-title');
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }
}

function toggleGroup(li, key) {
  const nowOpen = !li.classList.contains('open');
  li.classList.toggle('open', nowOpen);
  const btn = li.querySelector(':scope > button.group-title');
  if (btn) btn.setAttribute('aria-expanded', String(nowOpen));
  writeGroupState(key, nowOpen ? 'open' : 'closed');
}

function collectSidebar(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'list') out.push(...listToItems(node, ''));
    else if (node.type === 'paragraph') {
      const link = node.inline.find((n) => n.type === 'link');
      if (link) out.push({ label: plainText(link.children).trim(), href: link.href, children: [] });
    }
  }
  return out;
}

/* 分类的 key = 路径链（'指南/写内容'）：中段插入条目不会让已存状态错位到别的分类 */
function listToItems(list, prefix) {
  const items = [];
  const seen = new Map();
  for (const item of list.items) {
    let label = '';
    let href = null;
    const nested = [];
    for (const child of item.children) {
      if (child.type === 'list') { nested.push(child); continue; }
      if (child.type === 'paragraph' && !label) {
        const link = child.inline.find((n) => n.type === 'link');
        if (link) { href = link.href; label = plainText(link.children); }
        else label = plainText(child.inline);
      }
    }
    label = label.trim();
    if (!label && !nested.length) continue;
    const path = prefix ? prefix + '/' + (label || '（未命名分类）') : (label || '（未命名分类）');
    const n = (seen.get(path) || 0) + 1;
    seen.set(path, n);
    const key = n > 1 ? path + '#' + n : path;
    const children = [];
    for (const sub of nested) children.push(...listToItems(sub, key));
    items.push({ label, href, children, key });
  }
  return items;
}

function isExternalHref(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(href || '')) && !String(href).startsWith('#');
}

function sidebarEntry(item) {
  const href = String(item.href || '');
  const a = el('a', null, item.label);
  if (isExternalHref(href)) {
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.classList.add('ext');
    return a;
  }
  const route = href.replace(/^#\/?/, '').replace(/^\/+/, '');
  const [pathPart, hashPart] = splitHash(route);
  const file = fileFromRoute(pathPart.replace(/\.md$/i, ''));
  a.href = routeFromFile(file) + (hashPart ? '#' + hashPart : '');
  a.dataset.path = file;
  if (hashPart) a.dataset.anchor = hashPart;
  return a;
}

function buildSidebarTree(items) {
  const ul = el('ul');
  for (const item of items) {
    const li = el('li');
    if (item.children.length) {
      li.className = 'group';
      const key = item.key || item.label;
      li.dataset.key = key;
      li.dataset.label = item.label || '（未命名分类）';
      const btn = el('button', 'group-title');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.appendChild(el('span', 'caret', '▶'));
      btn.appendChild(el('span', null, item.label || '（未命名分类）'));
      btn.addEventListener('click', () => toggleGroup(li, key));
      li.appendChild(btn);
      // 分类自己带链接时，把该链接作为组内第一项，避免分类标题不可点
      const kids = item.href
        ? [{ label: item.label, href: item.href, children: [] }].concat(item.children)
        : item.children;
      li.appendChild(buildSidebarTree(kids));
    } else {
      li.className = 'doc';
      li.appendChild(sidebarEntry(item));
    }
    ul.appendChild(li);
  }
  return ul;
}

function firstDocLabel(items) {
  for (const item of items) {
    if (item.href && !isExternalHref(item.href)) return item.label;
    const sub = firstDocLabel(item.children);
    if (sub) return sub;
  }
  return '';
}

async function loadSidebar() {
  const nav = document.querySelector('.sidebar-nav');
  let text = '';
  try { text = await fetchText(CFG.nav); } catch (e) { text = ''; }
  state.sidebarItems = text.trim() ? collectSidebar(parse(text).children) : [];

  $('#site-name').textContent = CFG.name || firstDocLabel(state.sidebarItems) || '文档';

  nav.replaceChildren();
  if (!state.sidebarItems.length) nav.appendChild(el('div', 'sidebar-empty', '未能加载 ' + CFG.nav));
  else nav.appendChild(buildSidebarTree(state.sidebarItems));
  applyGroupStates();
}

function updateSidebarActive() {
  const links = Array.from(document.querySelectorAll('.sidebar-nav a[data-path]'));
  for (const a of links) a.classList.remove('active');
  const hit = links.find((a) => a.dataset.path === state.docPath);
  if (hit) hit.classList.add('active');
  // 祖先分类的展开由 applyGroupStates 的可见性硬规则负责（只影响显示，不写存储）
  applyGroupStates();
}

/* ---------------- 侧栏长标题提示 ----------------
   左栏宽度固定（320px），长标题会被省略号截断。气泡挂在 body 上并 fixed 定位：
   #sidebar 有 overflow-y:auto（横向会跟着裁），气泡塞在条目里会被裁掉、还会被
   手机端抽屉的 transform 破坏定位。只有真的被截断时才弹（短标题不打扰），
   触屏没有悬停，直接不介入。默认弹在鼠标（条目）上方，不挡条目本身。 */

let tipNode = null;
let tipAnchor = null;

function tipElement() {
  if (!tipNode) {
    tipNode = el('div', 'sidebar-tip', '');
    tipNode.id = 'sidebar-tip';
    tipNode.hidden = true;
    document.body.appendChild(tipNode);
  }
  return tipNode;
}

/* 省略号是否真的吃掉了文字：block + nowrap + overflow:hidden 下比 scroll/client 即可 */
function isClipped(node) {
  return node.scrollWidth - node.clientWidth > 1;
}

/* pointer 是鼠标位置（键盘聚焦时没有，退化成按条目定位） */
function showTip(anchor, pointer) {
  const tip = tipElement();
  tip.textContent = (anchor.textContent || '').trim();
  if (!tip.textContent) { hideTip(); return; }
  tip.hidden = false;                       // 先可见才能量到宽高
  const r = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 6;
  /* 指针若停在条目下缘，取 min 后仍贴在条目前——气泡永远不压住正在看的条目 */
  const base = pointer ? Math.min(pointer.y, r.top) : r.top;
  let top = base - gap - t.height;                                  // 默认：鼠标（条目）上方
  if (top < 8) top = Math.max(r.bottom, pointer ? pointer.y : r.bottom) + gap;   // 上方放不下就翻到下方
  top = Math.max(8, Math.min(top, window.innerHeight - t.height - 8));
  const left = Math.max(8, Math.min(r.left, window.innerWidth - t.width - 8));
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
  tipAnchor = anchor;
}

function hideTip() {
  tipAnchor = null;
  if (tipNode) tipNode.hidden = true;
}

/* 只在条目上弹（分类标题自己会换行，不会截断，无需提示） */
function tipTargetOf(event) {
  const node = event.target;
  const a = node && node.closest ? node.closest('.sidebar-nav a[data-path]') : null;
  return a;
}

function bindSidebarTips() {
  if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;
  const nav = document.querySelector('.sidebar-nav');
  nav.addEventListener('mouseover', (e) => {
    const a = tipTargetOf(e);
    if (!a) { hideTip(); return; }          // 移到空白处 / 分类标题上
    if (a === tipAnchor) return;            // 同一个条目，不必重算
    if (!isClipped(a)) { hideTip(); return; }   // 没被截断就不打扰
    showTip(a, { x: e.clientX, y: e.clientY });  // 记住鼠标位置，气泡弹在它上方
  });
  nav.addEventListener('mouseleave', hideTip);
  nav.addEventListener('click', hideTip);                 // 选中文档后立刻收起
  nav.addEventListener('focusin', (e) => {                // Tab 聚焦同样看得到全名
    const a = tipTargetOf(e);
    if (a && isClipped(a)) showTip(a);
  });
  nav.addEventListener('focusout', hideTip);
  const box = $('#sidebar');
  if (box) box.addEventListener('scroll', hideTip, { passive: true });   // 滚动后位置失效
  window.addEventListener('resize', hideTip);
  window.addEventListener('scroll', hideTip, { passive: true });
}

/* ---------------- 事件绑定与启动 ---------------- */

function bindEvents() {
  window.addEventListener('hashchange', () => { route(); });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  $('#theme-btn').addEventListener('click', () => {
    const resolved = document.documentElement.getAttribute('data-theme');
    applyTheme(resolved === 'dark' ? 'light' : 'dark', true);
  });
  $('#menu-btn').addEventListener('click', openDrawer);
  $('#toc-toggle').addEventListener('click', toggleTocPanel);
  $('#overlay').addEventListener('click', () => { closeDrawer(); closeTocPanel(); });
  $('#lightbox').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeLightbox(); closeDrawer(); closeTocPanel(); }
  });
  $('#content').addEventListener('click', (e) => {
    const img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (img) openLightbox(img);
  });
  bindSidebarTips();
  document.querySelector('.sidebar-nav').addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) closeDrawer();
  });
  $('#toc').addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) closeTocPanel();
  });

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => { if (themeMode() === 'auto') applyTheme('auto', false); };
  if (mq.addEventListener) mq.addEventListener('change', onScheme);
  else if (mq.addListener) mq.addListener(onScheme);
}

async function init() {
  applyTheme(themeMode(), false);       // 先按 localStorage / 默认上色，避免主题白闪
  await loadConfig();                   // 项目配置住在内容根里（多一次小请求，no-store）
  applyTheme(themeMode(), false);       // 配置里指定了 theme 且 localStorage 为空时补一次
  $('#site-name').textContent = CFG.name || '文档';
  if (CFG.name) document.title = CFG.name;   // 正文渲染前标签页先显示站点名
  bindEvents();
  await loadSidebar();
  await route();
}

init();