// Zero-dependency static site generator. Run with: node build.mjs
// Reads Markdown from content/, writes the finished site to dist/.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { renderMarkdown, parseFrontMatter, escapeHtml, plainText, slugify } from './lib/markdown.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const CONTENT = join(ROOT, 'content');
const DIST = join(ROOT, 'dist');
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');
const SHOW_DRAFTS = process.env.SHOW_DRAFTS === '1';

const site = JSON.parse(readFileSync(join(CONTENT, 'site.json'), 'utf8'));
const e = escapeHtml;
const url = (p) => `${BASE}${p}`;

// ---------- helpers ----------
const fmtDate = (d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
const fmtMonth = (d) => fmtDate(d, { month: 'short', year: 'numeric' });

function write(path, content) {
  const full = join(DIST, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

const ICONS = {
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  rocket: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  chart: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  bot: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>'
};
const icon = (name, size = 20) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- content loading ----------
function readMd(file) {
  const raw = readFileSync(file, 'utf8');
  return parseFrontMatter(raw);
}

function loadPosts() {
  const dir = join(CONTENT, 'blog');
  const posts = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const { data, body } = readMd(join(dir, f));
    if (data.draft && !SHOW_DRAFTS) continue;
    const slug = basename(f, '.md');
    const post = {
      slug,
      title: data.title || slug,
      date: String(data.date || '1970-01-01'),
      summary: data.summary || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      external: data.external || '',
      sample: !!data.sample,
      text: plainText(body)
    };
    if (!post.external) {
      const r = renderMarkdown(body);
      post.html = r.html;
      post.toc = r.toc;
      post.minutes = Math.max(1, Math.round(post.text.split(' ').length / 220));
    }
    post.href = post.external || url(`/blog/${slug}/`);
    posts.push(post);
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

function loadHandbooks() {
  const dir = join(CONTENT, 'handbooks');
  if (!existsSync(dir)) return [];
  const books = [];
  for (const d of readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory())) {
    const metaFile = join(dir, d, '_handbook.md');
    const meta = existsSync(metaFile) ? readMd(metaFile).data : {};
    const chapters = [];
    for (const f of readdirSync(join(dir, d)).filter((n) => n.endsWith('.md') && !n.startsWith('_'))) {
      const { data, body } = readMd(join(dir, d, f));
      if (data.draft && !SHOW_DRAFTS) continue;
      const r = renderMarkdown(body);
      chapters.push({
        file: f,
        slug: slugify(basename(f, '.md').replace(/^\d+[-_]?/, '')) || basename(f, '.md'),
        title: data.title || basename(f, '.md'),
        order: typeof data.order === 'number' ? data.order : 999,
        summary: data.summary || '',
        html: r.html,
        toc: r.toc,
        text: plainText(body)
      });
    }
    chapters.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
    if (!chapters.length) continue;
    books.push({
      slug: d,
      title: meta.title || d,
      description: meta.description || '',
      status: meta.status || '',
      chapters
    });
  }
  return books;
}

// ---------- layout ----------
const NAV = [
  { key: 'blog', label: 'blog', href: '/blog/' },
  { key: 'handbooks', label: 'handbooks', href: '/handbooks/' },
  { key: 'about', label: 'about', href: '/about/' }
];

function layout({ title, description, path, body, active = '', wide = false }) {
  const fullTitle = title === site.name ? site.title : `${title} · ${site.name}`;
  const desc = description || site.description;
  const canonical = `${site.url}${path}`;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(fullTitle)}</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="${e(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${e(fullTitle)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:url" content="${e(canonical)}">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/rss+xml" title="${e(site.name)} blog" href="${url('/feed.xml')}">
<link rel="icon" href="${url('/favicon.svg')}" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script>
(function () {
  var t = 'dark';
  try {
    var s = localStorage.getItem('theme');
    if (s === 'light' || s === 'dark') t = s;
    else if (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) t = 'light';
  } catch (e) {}
  document.documentElement.setAttribute('data-theme', t);
})();
</script>
<link rel="stylesheet" href="${url('/assets/style.css')}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${url('/')}" aria-label="${e(site.name)}, home"><span class="brand-user">${e(site.handle)}</span><span class="brand-at">@</span><span class="brand-host">${e(site.company.toLowerCase())}</span><span class="brand-path">:~$</span><span class="cursor" aria-hidden="true"></span></a>
    <nav class="nav" aria-label="Primary">
      ${NAV.map((n) => `<a href="${url(n.href)}"${active === n.key ? ' aria-current="page"' : ''}>${n.label}</a>`).join('')}
    </nav>
    <div class="tools">
      <button class="btn-icon" id="search-open" type="button" aria-label="Search (press /)">${icon('search', 18)}</button>
      <button class="btn-icon" id="theme-toggle" type="button" aria-label="Toggle light and dark theme"><span class="only-dark">${icon('sun', 18)}</span><span class="only-light">${icon('moon', 18)}</span></button>
    </div>
  </div>
</header>
<main id="main"${wide ? ' class="wide"' : ''}>
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <p>© ${new Date().getUTCFullYear()} ${e(site.name)} · Built with plain Markdown and a small Node script</p>
    <p class="footer-links">
      <a href="${e(site.links.github)}" rel="noopener">GitHub</a>
      <a href="${e(site.links.linkedin)}" rel="noopener">LinkedIn</a>
      <a href="${e(site.links.medium)}" rel="noopener">Medium</a>
      <a href="${url('/feed.xml')}">RSS</a>
    </p>
  </div>
</footer>
<dialog id="search-dialog" aria-label="Search">
  <form method="dialog" class="search-box">
    <label class="sr-only" for="search-input">Search posts and handbooks</label>
    <input id="search-input" type="search" placeholder="Search posts and handbooks…" autocomplete="off">
    <ul id="search-results" class="search-results" role="listbox"></ul>
    <p class="search-hint"><kbd>/</kbd> to open · <kbd>Esc</kbd> to close</p>
  </form>
</dialog>
<script>window.__BASE__ = ${JSON.stringify(BASE)};</script>
<script src="${url('/assets/app.js')}" defer></script>
</body>
</html>`;
}

// ---------- components ----------
const chip = ([name, slug]) => {
  const img = slug
    ? `<img class="only-dark" src="https://cdn.simpleicons.org/${slug}/c9d1d9" alt="" width="16" height="16" loading="lazy" onerror="this.remove()">` +
      `<img class="only-light" src="https://cdn.simpleicons.org/${slug}/1f2328" alt="" width="16" height="16" loading="lazy" onerror="this.remove()">`
    : '';
  return `<li class="chip">${img}<span>${e(name)}</span></li>`;
};

function postRow(p) {
  const meta = [fmtDate(p.date, { month: 'short', year: 'numeric' }), p.external ? 'Medium ↗' : `${p.minutes} min read`].join(' · ');
  return `<li class="post-row">
  <a class="post-link" href="${e(p.href)}"${p.external ? ' rel="noopener" target="_blank"' : ''}>
    <span class="post-meta mono">${meta}</span>
    <span class="post-title">${e(p.title)}</span>
    <span class="post-summary">${e(p.summary)}</span>
    ${p.tags.length ? `<span class="tags">${p.tags.map((t) => `<span class="tag">${e(t)}</span>`).join('')}</span>` : ''}
  </a>
</li>`;
}

// ---------- pages ----------
function homePage(posts, books) {
  const latest = posts.slice(0, 3);
  const body = `
<section class="hero wrap">
  <div class="hero-copy">
    <p class="eyebrow mono">${e(site.tagline)}</p>
    <h1>${e(site.name)}</h1>
    <p class="lead">${e(site.intro)}</p>
    <p class="hero-meta mono">${e(site.role)} at ${e(site.company)} · ${e(site.location)}</p>
    <div class="cta">
      <a class="btn btn-primary" href="${url('/handbooks/')}">${icon('book', 16)} Handbooks</a>
      <a class="btn" href="${url('/blog/')}">Read the blog</a>
      <a class="btn" href="${e(site.links.github)}" rel="noopener">GitHub</a>
      <a class="btn" href="${e(site.links.linkedin)}" rel="noopener">LinkedIn</a>
    </div>
  </div>
  <div class="terminal" role="img" aria-label="Terminal showing kubectl output with Nithin's role, experience and clouds">
    <div class="terminal-bar"><span></span><span></span><span></span><b class="mono">nithin@porter: ~</b></div>
<pre class="terminal-body mono"><span class="t-dim">$</span> kubectl config current-context
<span class="t-ok">porter/engineering-platform</span>

<span class="t-dim">$</span> kubectl get engineer nithin -o wide
<span class="t-head">NAME     ROLE                          EXPERIENCE   CLOUDS</span>
nithin   SDE 3, Engineering Platform   6+ years     GCP, AWS

<span class="t-dim">$</span> kubectl get deploy -n platform
<span class="t-head">NAME              READY   STRATEGY</span>
<span class="t-ok">gitops</span>            1/1     ArgoCD
<span class="t-ok">canary-rollouts</span>   1/1     Argo Rollouts
<span class="t-ok">helm-charts</span>       150+    umbrella chart
<span class="t-ok">code-security</span>     1/1     in-house platform

<span class="t-dim">$</span> <span class="cursor" aria-hidden="true"></span></pre>
  </div>
</section>

<section class="wrap section" id="highlights">
  <h2 class="section-title mono"><span class="t-dim">$</span> highlights</h2>
  <div class="cards">
    ${site.highlights
      .map(
        (h) => `<article class="card">
      <div class="card-icon">${icon(h.icon, 20)}</div>
      <h3>${e(h.title)}</h3>
      <p>${e(h.text)}</p>
    </article>`
      )
      .join('\n    ')}
  </div>
</section>

<section class="wrap section" id="stack">
  <h2 class="section-title mono"><span class="t-dim">$</span> stack</h2>
  <div class="stack">
    ${site.stack
      .map(
        (g) => `<div class="stack-group"><h3 class="mono">${e(g.group)}</h3><ul class="chips">${g.items.map(chip).join('')}</ul></div>`
      )
      .join('\n    ')}
  </div>
</section>

<section class="wrap section" id="writing">
  <h2 class="section-title mono"><span class="t-dim">$</span> ls ./blog</h2>
  <ul class="post-list">${latest.map(postRow).join('')}</ul>
  <p class="more"><a href="${url('/blog/')}">All posts →</a></p>
</section>

${
  books.length
    ? `<section class="wrap section" id="handbooks">
  <h2 class="section-title mono"><span class="t-dim">$</span> ls ./handbooks</h2>
  <div class="cards cards-2">
    ${books
      .map(
        (b) => `<a class="card card-link" href="${url(`/handbooks/${b.slug}/`)}">
      <div class="card-icon">${icon('book', 20)}</div>
      <h3>${e(b.title)}${b.status ? ` <span class="badge">${e(b.status)}</span>` : ''}</h3>
      <p>${e(b.description)}</p>
      <p class="card-foot mono">${b.chapters.length} chapter${b.chapters.length === 1 ? '' : 's'}</p>
    </a>`
      )
      .join('\n    ')}
  </div>
</section>`
    : ''
}
`;
  return layout({ title: site.name, path: '/', body, active: '' });
}

function aboutPage() {
  const body = `
<div class="wrap page">
  <h1>About</h1>
  <p class="lead">${e(site.intro)}</p>
  <p>I work in the ${e(site.company)} engineering platform team. Most of what I do is making it easy for application teams to ship safely: GitOps delivery, shared Helm charts, self-serve infrastructure, observability and an in-house security platform.</p>
  <h2 class="section-title mono"><span class="t-dim">$</span> kubectl get roles -A</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Role</th><th>Company</th><th>Period</th></tr></thead>
    <tbody>${site.experience.map((x) => `<tr><td>${e(x.role)}</td><td>${e(x.org)}</td><td>${e(x.period)}</td></tr>`).join('')}</tbody>
  </table></div>
  <h2 class="section-title mono"><span class="t-dim">$</span> ./connect.sh</h2>
  <ul class="plain">
    <li><a href="${e(site.links.linkedin)}" rel="noopener">LinkedIn</a></li>
    <li><a href="${e(site.links.github)}" rel="noopener">GitHub</a></li>
    <li><a href="${e(site.links.medium)}" rel="noopener">Medium</a></li>
  </ul>
</div>`;
  return layout({ title: 'About', description: `About ${site.name}: ${site.tagline}.`, path: '/about/', body, active: 'about' });
}

function blogIndex(posts) {
  const body = `
<div class="wrap page">
  <h1>Blog</h1>
  <p class="lead">Notes on platform engineering, Kubernetes, infrastructure and Linux.</p>
  <ul class="post-list">${posts.map(postRow).join('')}</ul>
  <p class="more"><a href="${url('/feed.xml')}">Subscribe via RSS</a></p>
</div>`;
  return layout({ title: 'Blog', description: 'Blog posts on platform engineering, Kubernetes, infrastructure and Linux.', path: '/blog/', body, active: 'blog' });
}

function tocHtml(toc) {
  if (toc.length < 2) return '';
  return `<nav class="toc" aria-label="On this page"><p class="toc-title mono">On this page</p><ul>${toc
    .map((t) => `<li class="toc-l${t.level}"><a href="#${t.id}">${e(t.text)}</a></li>`)
    .join('')}</ul></nav>`;
}

function postPage(p) {
  const body = `
<div class="wrap article-layout">
  <article class="article">
    <p class="crumb mono"><a href="${url('/blog/')}">← blog</a></p>
    <h1>${e(p.title)}</h1>
    <p class="post-meta mono">${fmtDate(p.date)} · ${p.minutes} min read${p.tags.length ? ' · ' + p.tags.map(e).join(', ') : ''}</p>
    ${p.sample ? '<div class="callout callout-note"><p class="callout-title">Sample</p><p>This is a sample post. Delete <code>content/blog/welcome-to-this-site.md</code> when you publish a real one.</p></div>' : ''}
    <div class="prose">${p.html}</div>
  </article>
  <aside class="article-side">${tocHtml(p.toc)}</aside>
</div>`;
  return layout({ title: p.title, description: p.summary, path: `/blog/${p.slug}/`, body, active: 'blog' });
}

function handbooksIndex(books) {
  const body = `
<div class="wrap page">
  <h1>Handbooks</h1>
  <p class="lead">Longer, structured engineering guides, written chapter by chapter.</p>
  <div class="cards cards-2">
    ${books
      .map(
        (b) => `<a class="card card-link" href="${url(`/handbooks/${b.slug}/`)}">
      <div class="card-icon">${icon('book', 20)}</div>
      <h3>${e(b.title)}${b.status ? ` <span class="badge">${e(b.status)}</span>` : ''}</h3>
      <p>${e(b.description)}</p>
      <p class="card-foot mono">${b.chapters.length} chapter${b.chapters.length === 1 ? '' : 's'}</p>
    </a>`
      )
      .join('\n    ')}
  </div>
</div>`;
  return layout({ title: 'Handbooks', description: 'Engineering handbooks on platform engineering and SRE.', path: '/handbooks/', body, active: 'handbooks' });
}

function sidebar(book, current) {
  return `<details class="side-details" id="side-details">
  <summary class="side-summary mono">${icon('menu', 16)} Chapters</summary>
  <nav class="side-nav" aria-label="${e(book.title)} chapters">
    <p class="side-title"><a href="${url(`/handbooks/${book.slug}/`)}">${e(book.title)}</a></p>
    <ol>${book.chapters
      .map(
        (c, i) =>
          `<li><a href="${url(`/handbooks/${book.slug}/${c.slug}/`)}"${current === c.slug ? ' aria-current="page"' : ''}><span class="mono num">${String(i + 1).padStart(2, '0')}</span> ${e(c.title)}</a></li>`
      )
      .join('')}</ol>
  </nav>
</details>`;
}

function handbookLanding(book) {
  const body = `
<div class="wrap book-layout">
  <aside class="book-side">${sidebar(book, '')}</aside>
  <article class="article">
    <p class="crumb mono"><a href="${url('/handbooks/')}">← handbooks</a></p>
    <h1>${e(book.title)}${book.status ? ` <span class="badge">${e(book.status)}</span>` : ''}</h1>
    <p class="lead">${e(book.description)}</p>
    <ol class="chapter-list">${book.chapters
      .map(
        (c, i) => `<li><a href="${url(`/handbooks/${book.slug}/${c.slug}/`)}"><span class="mono num">${String(i + 1).padStart(2, '0')}</span><span><strong>${e(c.title)}</strong><br><span class="muted">${e(c.summary)}</span></span></a></li>`
      )
      .join('')}</ol>
  </article>
</div>`;
  return layout({ title: book.title, description: book.description, path: `/handbooks/${book.slug}/`, body, active: 'handbooks' });
}

function chapterPage(book, idx) {
  const c = book.chapters[idx];
  const prev = book.chapters[idx - 1];
  const next = book.chapters[idx + 1];
  const link = (ch) => url(`/handbooks/${book.slug}/${ch.slug}/`);
  const body = `
<div class="wrap book-layout">
  <aside class="book-side">${sidebar(book, c.slug)}</aside>
  <article class="article">
    <p class="crumb mono"><a href="${url(`/handbooks/${book.slug}/`)}">← ${e(book.title)}</a></p>
    <h1>${e(c.title)}</h1>
    <div class="prose">${c.html}</div>
    <nav class="pager" aria-label="Chapter navigation">
      ${prev ? `<a class="pager-prev" href="${link(prev)}"><span class="mono">Previous</span><strong>${e(prev.title)}</strong></a>` : '<span></span>'}
      ${next ? `<a class="pager-next" href="${link(next)}"><span class="mono">Next</span><strong>${e(next.title)}</strong></a>` : '<span></span>'}
    </nav>
  </article>
  <aside class="article-side">${tocHtml(c.toc)}</aside>
</div>`;
  return layout({ title: `${c.title} · ${book.title}`, description: c.summary || book.description, path: `/handbooks/${book.slug}/${c.slug}/`, body, active: 'handbooks' });
}

function notFound() {
  const body = `<div class="wrap page"><h1>404</h1><p class="lead mono"><span class="t-dim">$</span> kubectl get page<br><span class="t-err">Error from server (NotFound): page not found</span></p><p><a href="${url('/')}">Go home</a></p></div>`;
  return layout({ title: 'Not found', path: '/404.html', body });
}

// ---------- feeds ----------
function rss(posts) {
  const items = posts
    .map(
      (p) => `  <item>
    <title>${e(p.title)}</title>
    <link>${e(p.external || site.url + p.href)}</link>
    <guid isPermaLink="false">${e(p.slug)}</guid>
    <pubDate>${new Date(`${p.date}T00:00:00Z`).toUTCString()}</pubDate>
    <description>${e(p.summary)}</description>
  </item>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${e(site.name)}</title>
  <link>${e(site.url)}</link>
  <description>${e(site.description)}</description>
${items}
</channel></rss>`;
}

function sitemap(paths) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${e(site.url + p)}</loc></url>`).join('\n')}
</urlset>`;
}

// ---------- build ----------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, 'static'), join(DIST, 'assets'), { recursive: true });
if (existsSync(join(ROOT, 'public'))) cpSync(join(ROOT, 'public'), DIST, { recursive: true });
writeFileSync(join(DIST, '.nojekyll'), '');

const posts = loadPosts();
const books = loadHandbooks();
const paths = ['/', '/about/', '/blog/', '/handbooks/'];
const searchIndex = [];

write('index.html', homePage(posts, books));
write('about/index.html', aboutPage());
write('blog/index.html', blogIndex(posts));
write('404.html', notFound());

for (const p of posts) {
  searchIndex.push({ t: p.title, u: p.href, k: p.external ? 'Post (Medium)' : 'Post', x: `${p.summary} ${p.tags.join(' ')} ${p.text}`.slice(0, 1200) });
  if (p.external) continue;
  write(`blog/${p.slug}/index.html`, postPage(p));
  paths.push(`/blog/${p.slug}/`);
}

if (books.length) write('handbooks/index.html', handbooksIndex(books));
for (const b of books) {
  write(`handbooks/${b.slug}/index.html`, handbookLanding(b));
  paths.push(`/handbooks/${b.slug}/`);
  searchIndex.push({ t: b.title, u: url(`/handbooks/${b.slug}/`), k: 'Handbook', x: b.description });
  b.chapters.forEach((c, i) => {
    write(`handbooks/${b.slug}/${c.slug}/index.html`, chapterPage(b, i));
    paths.push(`/handbooks/${b.slug}/${c.slug}/`);
    searchIndex.push({ t: `${c.title} · ${b.title}`, u: url(`/handbooks/${b.slug}/${c.slug}/`), k: 'Handbook chapter', x: `${c.summary} ${c.text}`.slice(0, 1500) });
  });
}

write('search.json', JSON.stringify(searchIndex));
write('feed.xml', rss(posts));
write('sitemap.xml', sitemap(paths));
write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`);
write(
  'favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0d1117"/><path d="M16 22l14 10-14 10" fill="none" stroke="#3fb950" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 44h14" stroke="#58a6ff" stroke-width="6" stroke-linecap="round"/></svg>`
);

console.log(`Built ${posts.length} posts, ${books.length} handbook(s), ${paths.length} pages -> dist/`);
