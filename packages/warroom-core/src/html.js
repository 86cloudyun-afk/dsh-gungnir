// 报告 HTML 渲染（自包含单文件）：离线可读、不引外部 CDN。
// 输入是我们自己生成的 markdown 子集（标题/列表/表格/代码块/引用），因此用受限转换器而非引入依赖。
// mermaid 图同时以 <pre class="mermaid"> 与源码块存在：有渲染器的环境看到图，没网的环境照样读得懂。

/** 提取 h1-h3 生成目录条目（打印与小屏都用得上）。 */
export function buildToc(markdown) {
  const items = [];
  const used = new Map();
  for (const line of String(markdown).split('\n')) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].trim();
    const base = slugify(text);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    items.push({ level, text, id: n === 1 ? base : `${base}-${n}` });
  }
  return items;
}

/** 目录块（页内锚点跳转；打印时照样有目录页）。 */
function tocBlock(markdown) {
  const items = buildToc(markdown);
  if (items.length < 3) return '';   // 太短的报告不需要目录
  const lines = ['<nav class="toc"><div class="toc-title">目录</div><ul>'];
  for (const it of items) {
    lines.push(`<li class="lvl-${it.level}"><a href="#${esc(it.id)}">${esc(it.text)}</a></li>`);
  }
  lines.push('</ul></nav>');
  return lines.join('\n');
}

/** 封面块（纸面第一页）：谁的报告、什么视图、水位锚点。 */
function coverBlock(meta, title) {
  const rows = [
    ['战役', meta.engagement_id ?? '—'],
    ['视图', meta.audience === 'client' ? '客户版（攻击路径与修复建议）'
      : meta.audience === 'blue' ? '蓝队版（IOC 排查清单）' : '内部全量'],
    ['水位', meta.watermark ? `seq ${meta.watermark.seq} · ${String(meta.watermark.snapshot_id ?? '').slice(0, 16)}…` : '—'],
    ['生成时间', meta.generated_at ?? '—'],
  ];
  return `<section class="cover">
  <div class="kicker">GUNGNIR · 战役报告</div>
  <h1>${esc(title)}</h1>
  <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
</section>`;
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 行内 markdown（粗体/行内代码）→ HTML。 */
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** 生成锚点（中文标题也要能用：非字母数字一律折叠为短横线）。 */
export function slugify(text) {
  const base = String(text).trim().toLowerCase()
    .replace(/[`*_()\[\]{}"']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
}

/**
 * 受限 markdown → HTML 片段。
 * 支持：h1-h4、无序列表、表格、围栏代码块（含 mermaid）、引用块、水平线、普通段落。
 * 标题自动带 `id` 锚点（供目录跳转）；同名标题加序号避免撞车。
 */
export function markdownToHtml(md) {
  const lines = String(md).split('\n');
  const out = [];
  const usedSlugs = new Map();
  const anchor = (text) => {
    const base = slugify(text);
    const n = (usedSlugs.get(base) ?? 0) + 1;
    usedSlugs.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;   // 跳过结束围栏
      const body = esc(buf.join('\n'));
      if (lang === 'mermaid') {
        // 双份：可渲染的图 + 纯文本源码（离线/无渲染器时仍可读）
        out.push(`<pre class="mermaid">${body}</pre>`);
        out.push(`<details class="mermaid-source"><summary>mermaid 源码</summary><pre><code>${body}</code></pre></details>`);
      } else {
        out.push(`<pre><code class="lang-${esc(lang)}">${body}</code></pre>`);
      }
      continue;
    }

    // 表格
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i += 1;
      }
      // 表格包一层容器：窄屏靠容器横向滚动，而不是把列压扁到不可读
      out.push('<div class="table-wrap"><table><thead><tr>'
        + header.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const id = anchor(h[2]);
      out.push(`<h${lvl} id="${esc(id)}">${inline(h[2])}</h${lvl}>`);
      i += 1;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
      continue;
    }

    // 列表（含缩进二级项）
    if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const indent = /^(\s*)-/.exec(lines[i])[1].length;
        items.push({ indent, text: lines[i].replace(/^\s*-\s+/, '') });
        i += 1;
      }
      let html = '<ul>';
      for (let k = 0; k < items.length; k += 1) {
        const cur = items[k];
        const next = items[k + 1];
        html += `<li>${inline(cur.text)}`;
        if (next && next.indent > cur.indent) {
          html += '<ul>';
          while (k + 1 < items.length && items[k + 1].indent > cur.indent) {
            k += 1;
            html += `<li>${inline(items[k].text)}</li>`;
          }
          html += '</ul>';
        }
        html += '</li>';
      }
      html += '</ul>';
      out.push(html);
      continue;
    }

    if (/^---+$/.test(line)) { out.push('<hr>'); i += 1; continue; }
    if (line.trim() === '') { i += 1; continue; }
    out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }
  return out.join('\n');
}

/**
 * 自包含 HTML 外壳（无外部资源；mermaid 若本地有渲染器可选启用）。
 * @param {{markdown:string, title?:string, meta?:object}} p meta 用于封面（战役/受众/水位等）
 */
export function renderHtml({ markdown, title = 'GUNGNIR 战役报告', meta = null }) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --fg:#1c1f23; --muted:#5d6672; --bg:#fbfaf7; --line:#e3ded4; --accent:#8a5a12; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem; background:var(--bg); color:var(--fg);
         font: 16px/1.7 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:1.9rem; border-bottom:2px solid var(--line); padding-bottom:.5rem; }
  h2 { font-size:1.35rem; margin-top:2.2rem; border-left:4px solid var(--accent); padding-left:.6rem; }
  h3,h4 { font-size:1.05rem; margin-top:1.4rem; }
  code { background:#f1ece2; padding:.1rem .3rem; border-radius:3px; font-size:.92em; }
  pre { background:#23262b; color:#eae6dd; padding:.8rem 1rem; border-radius:6px; overflow-x:auto; }
  pre code { background:none; color:inherit; }
  table { border-collapse:collapse; width:100%; margin:1rem 0; }
  th,td { border:1px solid var(--line); padding:.4rem .6rem; text-align:left; font-size:.94rem; }
  blockquote { margin:1rem 0; padding:.6rem 1rem; border-left:3px solid var(--accent);
               background:#f6f1e7; color:var(--muted); }
  details.mermaid-source summary { cursor:pointer; color:var(--muted); font-size:.9rem; }
  ul { padding-left:1.3rem; }
</style>
<style>.mermaid { background:#f6f1e7; color:var(--fg); padding:1rem; border-radius:6px; }</style>
<style>
  /* 打印友好：白底、隐藏交互块、表格与代码块尽量不跨页、链接打印出 URL */
  @media print {
    :root { --bg:#fff; --fg:#000; --muted:#333; --line:#999; --accent:#000; }
    body { background:#fff; padding:0; font-size:11pt; }
    main { max-width:none; }
    details, .mermaid-source { display:none !important; }   /* 交互块不进纸面 */
    .cover { break-after:page; }
    h1 { break-after:avoid; }
    h2 { break-after:avoid; break-before:auto; }
    table, pre, blockquote, .mermaid { break-inside:avoid; }
    pre { white-space:pre-wrap; background:#f4f4f4; color:#000; border:1px solid var(--line); }
    a[href^="http"]::after { content:" (" attr(href) ")"; font-size:.85em; color:#333; }
    .print-footer { display:block; margin-top:2rem; border-top:1px solid var(--line);
                    padding-top:.5rem; color:#333; font-size:.85em; }
  }
  @media screen { .print-footer { display:none; } }
  .cover { border-bottom:2px solid var(--accent); padding-bottom:1rem; margin-bottom:2rem; }
  .cover .kicker { text-transform:uppercase; letter-spacing:.12em; font-size:.78rem; color:var(--muted); }
  .cover h1 { border:none; margin:.3rem 0 .5rem; }
  .cover dl { display:grid; grid-template-columns:max-content 1fr; gap:.2rem 1rem; margin:0; font-size:.92rem; }
  .cover dt { color:var(--muted); }
  /* 窄屏（手机/平板）：表格横向滚动、字号与留白收敛，避免整页缩成一团 */
  @media screen and (max-width: 720px) {
    body { padding:1.25rem .9rem; font-size:15px; }
    h1 { font-size:1.5rem; }
    h2 { font-size:1.2rem; }
    main { max-width:100%; }
    .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
    table { min-width:32rem; }
    pre { font-size:.86em; }
    .cover dl { grid-template-columns:1fr; gap:.1rem .2rem; }
    .cover dt { font-weight:600; }
    .toc li.lvl-3 { padding-left:1.2rem; }
  }
  .toc { border:1px solid var(--line); border-radius:6px; padding:.8rem 1.1rem; margin:0 0 2rem; background:#fff; }
  .toc-title { font-weight:600; letter-spacing:.04em; margin-bottom:.4rem; }
  .toc ul { list-style:none; padding-left:0; margin:0; }
  .toc li { margin:.15rem 0; }
  .toc li.lvl-2 { padding-left:1rem; }
  .toc li.lvl-3 { padding-left:2rem; font-size:.94em; color:var(--muted); }
  .toc a { text-decoration:none; color:var(--fg); }
  .toc a:hover { text-decoration:underline; }
  @media print { .toc { break-after:page; background:#fff; } h2, h3 { break-after:avoid; } }
</style>
</head>
<body>
<main>
${meta ? coverBlock(meta, title) : ''}
${tocBlock(markdown)}
${markdownToHtml(markdown)}
<div class="print-footer">${esc(meta?.generated_at ?? '')} · GUNGNIR · 本文件自包含（无外部资源），可离线留存与打印</div>
</main>
</body>
</html>
`;
}
