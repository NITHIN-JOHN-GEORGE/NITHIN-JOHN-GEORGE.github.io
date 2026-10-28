// Small dependency-free Markdown converter. Supports what blog posts and handbooks need:
// headings (with ids and a TOC), paragraphs, fenced code, lists (nested), blockquotes,
// callouts ([!NOTE] etc.), tables, images, links, bold/italic/strikethrough, inline code.

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
    } else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+$/.test(v)) v = Number(v);
    else v = unquote(v);
    data[kv[1]] = v;
  }
  return { data, body: m[2] };
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function inline(text) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  // inline code first so nothing inside it is touched
  text = text.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${escapeHtml(c)}</code>`));
  text = escapeHtml(text);
  // images then links
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, src, title) =>
    keep(`<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const external = /^https?:\/\//.test(href);
    return keep(`<a href="${href}"${external ? ' rel="noopener" target="_blank"' : ''}>${label}</a>`);
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  text = text.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

const CALLOUTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', KEY: 'In one line' };

export function renderMarkdown(src) {
  const toc = [];
  const used = new Map();
  const uniqueId = (text) => {
    let base = slugify(text) || 'section';
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };

  function blocks(lines) {
    const out = [];
    let i = 0;
    const isBlank = (l) => /^\s*$/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      // fenced code
      const fence = line.match(/^(\s*)(```|~~~)\s*([\w+-]*)\s*$/);
      if (fence) {
        const lang = fence[3];
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${fence[2]}\\s*$`).test(lines[i])) {
          buf.push(lines[i].replace(new RegExp(`^ {0,${fence[1].length}}`), ''));
          i++;
        }
        i++;
        out.push(
          `<div class="code"><div class="code-bar"><span class="code-lang">${escapeHtml(lang || 'text')}</span>` +
            `<button class="code-copy" type="button" aria-label="Copy code">Copy</button></div>` +
            `<pre><code class="language-${escapeHtml(lang || 'text')}">${escapeHtml(buf.join('\n'))}</code></pre></div>`
        );
        continue;
      }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        const level = h[1].length;
        const id = uniqueId(h[2]);
        if (level === 2 || level === 3) toc.push({ level, id, text: h[2].replace(/`/g, '') });
        out.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inline(h[2])}</h${level}>`);
        i++;
        continue;
      }

      // hr
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // blockquote / callout
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*> ?/, '')); i++; }
        const first = buf[0] && buf[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|KEY)\]\s*$/);
        if (first) {
          const kind = first[1];
          out.push(`<div class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${CALLOUTS[kind]}</p>${blocks(buf.slice(1))}</div>`);
        } else {
          out.push(`<blockquote>${blocks(buf)}</blockquote>`);
        }
        continue;
      }

      // table
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && !isBlank(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
            `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        );
        continue;
      }

      // list (supports nesting by indentation)
      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        const baseIndent = li[1].length;
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
            items.push({ text: m[3], children: [] });
            i++;
          } else if (m && m[1].length > baseIndent && items.length) {
            const sub = [];
            while (i < lines.length && (isBlank(lines[i]) ? false : /^\s+/.test(lines[i]) && lines[i].match(/^(\s*)/)[1].length > baseIndent)) {
              sub.push(lines[i].slice(baseIndent + 2));
              i++;
            }
            items[items.length - 1].children.push(...sub);
          } else if (!isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i]) && items.length && !m) {
            items[items.length - 1].text += ' ' + lines[i].trim();
            i++;
          } else break;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(
          `<${tag}>${items.map((it) => `<li>${inline(it.text)}${it.children.length ? blocks(it.children) : ''}</li>`).join('')}</${tag}>`
        );
        continue;
      }

      // raw html block
      if (/^\s*<[a-zA-Z!\/]/.test(line)) {
        const buf = [];
        while (i < lines.length && !isBlank(lines[i])) { buf.push(lines[i]); i++; }
        out.push(buf.join('\n'));
        continue;
      }

      // paragraph
      const buf = [];
      while (
        i < lines.length && !isBlank(lines[i]) &&
        !/^(#{1,6}\s|```|~~~|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])
      ) { buf.push(lines[i].trim()); i++; }
      if (!buf.length) { buf.push(lines[i].trim()); i++; }
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
    return out.join('\n');
  }

  const html = blocks(src.replace(/\r\n/g, '\n').split('\n'));
  return { html, toc };
}

export function plainText(md) {
  return md
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|\-\[\]!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
