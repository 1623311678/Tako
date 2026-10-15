/**
 * 把大纲变成可播放的 HTML 演示文稿。
 *
 * 为什么是 HTML 而不是 .pptx：
 *   HTML 幻灯片零依赖、离线可生成、浏览器全屏即播、打印即 PDF。
 *   如果团队确实需要 .pptx，把这个脚本换成调用 pptx 库即可 ——
 *   清单、CLI、AI 工具定义一行都不用动。这正是能力包存在的意义：
 *   能力实现可以随便换，调用契约不变。
 *
 * 大纲语法：
 *   # 页面标题        → 新的一页
 *   ### 小标题        → 页内小标题
 *   - 要点 / * 要点   → 列表项
 *   其他非空行        → 普通段落
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export default function deckHtml({ params, root, log, readFile }) {
  const source = String(params.outline ?? '').trim();
  if (!source) throw new Error('outline 不能为空。用 "# 标题" 分页，"- 要点" 写要点。');

  const outline = source.startsWith('@') ? readFile(source.slice(1).trim()) : source;
  const slides = parseOutline(outline);
  if (slides.length === 0) throw new Error('没解析出任何内容，检查一下大纲格式。');

  const title = String(params.title ?? '').trim() || slides[0].title || '演示文稿';
  const outFile = path.resolve(root, String(params.out ?? 'deck.html'));

  mkdirSync(path.dirname(outFile), { recursive: true });
  const html = render(title, slides);
  writeFileSync(outFile, html, 'utf8');

  log(`生成 ${slides.length} 页 → ${outFile}`);

  return {
    file: path.relative(root, outFile) || outFile,
    absolutePath: outFile,
    title,
    slideCount: slides.length,
    bytes: Buffer.byteLength(html, 'utf8'),
    slides: slides.map((slide, index) => ({
      page: index + 1,
      title: slide.title,
      bullets: slide.blocks.filter((block) => block.type === 'bullet').length,
    })),
    hint: '浏览器打开后按 ←/→ 翻页，⌘P 可直接打印成 PDF',
  };
}

/* ── 大纲解析 ───────────────────────────────────────────── */

function parseOutline(text) {
  const lines = text.split('\n');
  const slides = [];
  let current = null;

  const push = (slide) => {
    if (slide && (slide.title || slide.blocks.length > 0)) slides.push(slide);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    if (line.startsWith('## ') || line.startsWith('# ')) {
      push(current);
      current = { title: line.replace(/^#+\s*/, '').trim(), blocks: [] };
      continue;
    }
    if (line.startsWith('### ')) {
      if (!current) current = { title: '', blocks: [] };
      current.blocks.push({ type: 'subtitle', text: line.slice(4).trim() });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!current) current = { title: '', blocks: [] };
      const depth = line.match(/^\s*/)[0].length >= 2 ? 1 : 0;
      current.blocks.push({ type: 'bullet', text: line.replace(/^\s*[-*]\s+/, '').trim(), depth });
      continue;
    }
    if (!current) current = { title: '', blocks: [] };
    current.blocks.push({ type: 'text', text: line.trim() });
  }
  push(current);

  // 没有用 # 分页时，按空行分组，每组首行当标题
  if (slides.length === 1 && slides[0].title === '' ) {
    const groups = text.split(/\n\s*\n/).map((group) => group.trim()).filter(Boolean);
    if (groups.length > 1) {
      return groups.map((group) => {
        const [first, ...rest] = group.split('\n');
        return {
          title: first.replace(/^#+\s*/, '').trim(),
          blocks: rest.map((line) => ({
            type: /^\s*[-*]\s+/.test(line) ? 'bullet' : 'text',
            text: line.replace(/^\s*[-*]\s+/, '').trim(),
            depth: 0,
          })),
        };
      });
    }
  }

  return slides;
}

/* ── HTML 渲染 ──────────────────────────────────────────── */

function render(title, slides) {
  const pages = slides
    .map(
      (slide, index) => `
    <section class="slide" id="s${index + 1}">
      <div class="inner">
        ${slide.title ? `<h1>${esc(slide.title)}</h1>` : ''}
        ${renderBlocks(slide.blocks)}
      </div>
    </section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8b98a5; --accent:#ff7a59; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .slide { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:8vh 8vw;
           border-bottom:1px solid #1b2530; }
  .inner { width:100%; max-width:1000px; }
  h1 { font-size:44px; line-height:1.25; margin:0 0 28px; letter-spacing:-.02em; }
  h1::after { content:""; display:block; width:64px; height:4px; background:var(--accent);
              margin-top:16px; border-radius:2px; }
  h2 { font-size:24px; color:var(--accent); margin:26px 0 10px; font-weight:600; }
  ul { margin:0; padding-left:0; list-style:none; }
  li { font-size:22px; line-height:1.7; margin:10px 0; padding-left:26px; position:relative; }
  li::before { content:""; position:absolute; left:4px; top:.72em; width:8px; height:8px;
               background:var(--accent); border-radius:2px; }
  li.d1 { margin-left:26px; font-size:19px; color:var(--muted); }
  li.d1::before { background:var(--muted); width:5px; height:5px; }
  p { font-size:21px; line-height:1.75; color:#c9d6e2; margin:14px 0; }
  .pager { position:fixed; right:22px; bottom:18px; font-size:13px; color:var(--muted);
           font-variant-numeric:tabular-nums; font-family:ui-monospace,Menlo,monospace; }
  @media print {
    .slide { min-height:auto; height:100vh; page-break-after:always; border:0; }
    .pager { display:none; }
    body { background:#fff; color:#111; }
    li::before { background:#d1492a; } h1::after { background:#d1492a; } h2 { color:#d1492a; }
    p { color:#333; } li.d1 { color:#666; }
  }
</style>
</head>
<body>
${pages}
<div class="pager"><span id="now">1</span> / ${slides.length}</div>
<script>
  var index = 0;
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var now = document.getElementById('now');

  function show(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    slides[index].scrollIntoView({ behavior: 'smooth' });
    now.textContent = String(index + 1);
  }
  document.addEventListener('keydown', function (event) {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].indexOf(event.key) !== -1) { event.preventDefault(); show(index + 1); }
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].indexOf(event.key) !== -1) { event.preventDefault(); show(index - 1); }
  });
</script>
</body>
</html>
`;
}

function renderBlocks(blocks) {
  const out = [];
  let openList = false;

  for (const block of blocks) {
    if (block.type === 'bullet') {
      if (!openList) {
        out.push('<ul>');
        openList = true;
      }
      out.push(`<li${block.depth ? ' class="d1"' : ''}>${esc(block.text)}</li>`);
      continue;
    }
    if (openList) {
      out.push('</ul>');
      openList = false;
    }
    out.push(block.type === 'subtitle' ? `<h2>${esc(block.text)}</h2>` : `<p>${esc(block.text)}</p>`);
  }
  if (openList) out.push('</ul>');
  return out.join('\n        ');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
