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
  network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
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
  { key: 'home', label: 'Home', href: '/' },
  { key: 'about', label: 'About', href: '/#about' },
  { key: 'skills', label: 'Skills', href: '/#skills' },
  { key: 'writing', label: 'Blogs', href: '/blog/' },
  { key: 'projects', label: 'Projects', href: '/#projects' },
  { key: 'certifications', label: 'Certifications', href: '/#certifications' },
  { key: 'contact', label: 'Contact', href: '/#contact' }
];

function layout({ title, description, path, body, active = '', wide = false, home = false }) {
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
  document.documentElement.classList.add('js');
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) document.documentElement.classList.add('no-motion');
})();
</script>
<link rel="stylesheet" href="${url('/assets/style.css')}">
</head>
<body${home ? ' class="home"' : ''}>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${url('/')}" aria-label="${e(site.name)}, home"><span class="brand-user">${e(site.handle)}</span><span class="brand-path">&nbsp;~ %</span><span class="cursor" aria-hidden="true"></span></a>
    <button class="btn-icon nav-toggle" id="nav-toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="primary-nav">${icon('menu', 18)}</button>
    <nav class="nav" id="primary-nav" aria-label="Primary">
      ${NAV.map((n) => `<a href="${url(n.href)}" data-nav="${n.key}"${active === n.key ? ' aria-current="page"' : ''}>${n.label}</a>`).join('')}
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

function expTimeline() {
  return `<ol class="xtl">
    ${site.experience
      .map((x) => {
        const current = /present/i.test(x.period);
        const [from, to] = x.period.split(/\s+to\s+/);
        return `<li class="xtl-item reveal${current ? ' current' : ''}">
      <div class="xtl-date mono"><span>${e(from)}</span><span class="xtl-to">${e(to || '')}</span></div>
      <div class="xtl-node" aria-hidden="true"></div>
      <div class="glass xtl-card"><h3>${e(x.role)}</h3><p class="xtl-org">${e(x.org)}${current ? ' <span class="xtl-now mono">current</span>' : ''}</p></div>
    </li>`;
      })
      .join('\n    ')}
  </ol>`;
}



function brandBadge([name, slug, color]) {
  const hex = (color || '#30363d').replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), bl = parseInt(hex.slice(4, 6), 16);
  const light = (0.299 * r + 0.587 * g + 0.114 * bl) > 170;
  const fg = light ? '1f2328' : 'ffffff';
  const img = slug ? `<img src="https://cdn.simpleicons.org/${slug}/${fg}" alt="" width="16" height="16" loading="lazy" onerror="this.remove()">` : '';
  return `<li class="skx-badge" style="--bg:#${hex};--fg:#${fg}">${img}<span>${e(name)}</span></li>`;
}

function allSkills() {
  return site.stack.flatMap((g, gi) => g.items.map(([name, slug]) => ({ name, slug, group: g.group, gi: 'g' + gi })));
}
function coreSkills() {
  const all = allSkills();
  return (site.coreSkills || []).map((n) => all.find((s) => s.name === n)).filter(Boolean);
}
function skLogo(s, size) {
  const mono = s.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const img = s.slug
    ? `<img class="only-dark" src="https://cdn.simpleicons.org/${s.slug}/c9d1d9" alt="" width="${size}" height="${size}" loading="lazy" onerror="this.remove()"><img class="only-light" src="https://cdn.simpleicons.org/${s.slug}/1f2328" alt="" width="${size}" height="${size}" loading="lazy" onerror="this.remove()">`
    : '';
  return `<span class="sk-logo" style="--s:${size}px"><span class="sk-mono mono" aria-hidden="true">${e(mono)}</span>${img}</span>`;
}

function homePage(posts, books) {
  const latest = posts.slice(0, 3);
  const termData = {
    user: site.handle,
    name: site.name,
    role: `${site.role} at ${site.company}`,
    location: site.location,
    about: site.intro,
    motd: site.motd || site.intro,
    aboutYaml: site.aboutYaml || null,
    skills: site.stack.map((g) => ({ group: g.group, items: g.items.map((i) => i[0]) })),
    experience: site.experience,
    posts: posts.map((p) => ({ title: p.title, date: fmtMonth(p.date), href: p.href })),
    handbooks: books.map((b) => ({ title: b.title, href: url(`/handbooks/${b.slug}/`), chapters: b.chapters.length })),
    links: site.links
  };
  const firstName = site.name.split(' ')[0];
  const rest = site.name.slice(firstName.length).trim();
  const body = `
<canvas id="bg-net" aria-hidden="true"></canvas>
<section class="hero2 wrap">
  <div class="hero2-copy">
    <p class="eyebrow mono reveal">${e(site.headline)}</p>
    <h1 class="hero2-title reveal">Hi, I'm <span class="grad">${e(firstName)} ${e(rest)}</span></h1>
    <p class="lead reveal">${e(site.heroLine || site.intro)}</p>
    <dl class="stats reveal">
      ${site.stats
        .map(
          (s) => `<div class="stat"><dt class="stat-num mono">${s.text ? e(s.text) : `${e(s.prefix || '')}<span class="count" data-to="${s.value}">${s.value}</span>${e(s.suffix || '')}`}</dt><dd>${e(s.label)}</dd></div>`
        )
        .join('')}
    </dl>
    <div class="cta reveal">
      <a class="btn btn-grad" href="${url('/blog/')}">${icon('book', 16)} Read the blog</a>
      <a class="btn btn-ghost" href="${e(site.links.linkedin)}" rel="noopener">LinkedIn</a>
      <a class="btn btn-ghost" href="${e(site.links.github)}" rel="noopener">GitHub</a>
    </div>
  </div>
  <div class="term reveal" id="term" aria-label="Interactive terminal. Type help for commands.">
    <div class="terminal-bar"><span></span><span></span><span></span><b class="mono">${e(site.handle)} — zsh</b></div>
    <div class="term-body mono" id="term-out" role="log" aria-live="polite"></div>
    <form class="term-line mono" id="term-form" autocomplete="off">
      <label for="term-in"><span class="t-ok">${e(site.handle)}</span><span class="t-dim"> ~ %</span></label>
      <input id="term-in" type="text" spellcheck="false" autocapitalize="off" aria-label="Terminal command">
    </form>
  </div>
</section>

${aboutSections()}

<section class="wrap section" id="skills">
  <div class="section-head reveal">
    <h2 class="section-h">Skills</h2>
    <p class="muted">${allSkills().length} tools I use to run, ship and secure the platform.</p>
  </div>
  <div class="skx">
    ${site.stack
      .map(
        (g) => `<div class="skx-group reveal">
      <h3 class="skx-h mono">${icon(g.icon || 'layers', 15)}${e(g.group)}</h3>
      <ul class="skx-badges">${g.items.map(brandBadge).join('')}</ul>
    </div>`
      )
      .join('\n    ')}
  </div>
</section>

<section class="wrap section" id="projects">
  <div class="section-head reveal">
    <h2 class="section-h">Projects</h2>
    <p class="muted">Platform work I've built and run at Porter, from delivery to security.</p>
  </div>
  <div class="pj-grid">
    ${site.highlights
      .map(
        (h) => `<article class="pj reveal" style="--ac:${e(h.accent || '#58a6ff')}">
      <div class="pj-top"><span class="pj-icon">${icon(h.icon, 22)}</span>${h.tag ? `<span class="pj-tag mono">${e(h.tag)}</span>` : ''}</div>
      <h3>${e(h.title)}</h3>
      <p>${e(h.text)}</p>
      ${h.tech && h.tech.length ? `<ul class="pj-tech">${h.tech.map((t) => `<li>${e(t)}</li>`).join('')}</ul>` : ''}
    </article>`
      )
      .join('\n    ')}
  </div>
</section>

<section class="wrap section" id="writing">
  <div class="section-head reveal"><h2 class="section-h">Blog &amp; handbooks</h2><p class="muted">Blog posts and long-form handbooks.</p></div>
  <ul class="post-list reveal">${latest.map(postRow).join('')}</ul>
  <p class="more reveal"><a href="${url('/blog/')}">All posts →</a></p>
  ${
    books.length
      ? `<div class="cards cards-2 reveal" style="margin-top:28px">${books
          .map(
            (b) => `<a class="glass card-link" href="${url(`/handbooks/${b.slug}/`)}">
      <div class="glass-icon">${icon('book', 20)}</div>
      <h3>${e(b.title)}${b.status ? ` <span class="badge">${e(b.status)}</span>` : ''}</h3>
      <p class="muted">${e(b.description)}</p>
    </a>`
          )
          .join('')}</div>`
      : ''
  }
</section>


<section class="wrap section contact reveal" id="contact">
  <h2 class="section-h">Let's talk platform engineering</h2>
  <p class="muted">The easiest way to reach me is LinkedIn.</p>
  <div class="cta" style="justify-content:center"><a class="btn btn-grad" href="${e(site.links.linkedin)}" rel="noopener">Message me on LinkedIn</a></div>
</section>
<script id="term-data" type="application/json">${JSON.stringify(termData).replace(/</g, '\\u003c')}</script>
`;
  return layout({ title: site.name, path: '/', body, active: 'home', home: true });
}

function aboutSections() {
  const y = site.aboutYaml || {};
  const glance = [
    ['Role', y.role || site.role],
    ['Company', y.company || site.company],
    ['Based in', y['i-am-based-in'] || site.location],
    ['Experience', '6+ years']
  ];
  return `<section class="wrap section" id="about">
  <div class="ab-hero">
    <div>
      <p class="eyebrow mono reveal">~/about</p>
      <h2 class="ab-title reveal">I build the platform <span class="grad">other engineers ship on</span></h2>
      <p class="lead reveal">I work in the ${e(site.company)} engineering platform team. Most of what I do is making it easy for application teams to ship safely: GitOps delivery, shared Helm charts, self-serve infrastructure, observability and an in-house code security platform. I care about developer velocity without compromising on security.</p>
    </div>
    <aside class="glass ab-card reveal" aria-label="At a glance">
      <p class="ab-card-title mono">At a glance</p>
      <dl class="ab-glance">${glance.map(([k, v]) => `<div><dt class="mono">${e(k)}</dt><dd>${e(v)}</dd></div>`).join('')}</dl>
    </aside>
  </div>
</section>

<section class="wrap section" id="experience">
  <div class="section-head reveal"><h2 class="section-h">Experience</h2><p class="muted">From system administration to platform engineering.</p></div>
  ${expTimeline()}
</section>

<section class="wrap section" id="certifications">
  <div class="section-head reveal"><h2 class="section-h">Certifications</h2></div>
  <ol class="xtl xtl-cert">
    ${(site.certifications || [])
      .map((c) => {
        const logo = c.logo
          ? `<img class="only-dark" src="https://cdn.simpleicons.org/${c.logo}/c9d1d9" alt="" width="18" height="18" loading="lazy" onerror="this.remove()"><img class="only-light" src="https://cdn.simpleicons.org/${c.logo}/1f2328" alt="" width="18" height="18" loading="lazy" onerror="this.remove()">`
          : '';
        const expired = /expired/i.test(c.status || '');
        return `<li class="xtl-item reveal${expired ? ' expired' : ' current'}">
      <div class="xtl-date mono"><span class="cert-issuer">${logo}${e(c.issuer)}</span></div>
      <div class="xtl-node" aria-hidden="true"></div>
      <div class="glass xtl-card"><h3>${e(c.name)}</h3><p class="xtl-org">${e(c.issuer)}${c.status ? ` <span class="cert-pill mono${expired ? ' is-expired' : ''}">${e(c.status)}</span>` : ''}</p></div>
    </li>`;
      })
      .join('\n    ')}
  </ol>
</section>`;
}

function aboutPage() {
  const target = url('/#about');
  const body = `<div class="wrap page"><p class="lead">This page has moved. <a href="${target}">Go to About →</a></p></div>
<script>location.replace(${JSON.stringify(target)});</script>`;
  return layout({ title: 'About', description: `About ${site.name}: ${site.tagline}.`, path: '/about/', body, active: 'about' }).replace('<head>', `<head>\n<meta http-equiv="refresh" content="0; url=${target}">`);
}

function blogIndex(posts, books) {
  const tags = [...new Set(posts.flatMap((p) => p.tags))].sort();
  const bookCard = (b) => `<article class="glass wr-book reveal" data-kind="handbook">
    <div class="wr-book-main">
      <p class="wr-kicker mono">Handbook${b.status ? ` · <span class="wr-status">${e(b.status)}</span>` : ''}</p>
      <h2><a href="${url(`/handbooks/${b.slug}/`)}">${e(b.title)}</a></h2>
      <p class="muted">${e(b.description)}</p>
      <a class="btn btn-grad wr-start" href="${url(`/handbooks/${b.slug}/${b.chapters[0].slug}/`)}">Start reading →</a>
    </div>
    <ol class="wr-chapters">
      ${b.chapters
        .slice(0, 6)
        .map((c, i) => `<li><a href="${url(`/handbooks/${b.slug}/${c.slug}/`)}"><span class="mono num">${String(i + 1).padStart(2, '0')}</span><span>${e(c.title)}</span></a></li>`)
        .join('')}
      ${b.chapters.length > 6 ? `<li class="muted mono" style="padding:6px 10px">+ ${b.chapters.length - 6} more</li>` : ''}
    </ol>
  </article>`;
  const postCard = (p) => `<a class="glass wr-post reveal" data-kind="post" data-tags="${e(p.tags.join(' '))}" href="${e(p.href)}"${p.external ? ' target="_blank" rel="noopener"' : ''}>
    <div class="wr-meta mono"><span>${fmtDate(p.date, { month: 'short', year: 'numeric' })}</span><span class="wr-src${p.external ? ' ext' : ''}">${p.external ? 'Medium ↗' : `${p.minutes} min read`}</span></div>
    <h3>${e(p.title)}</h3>
    <p>${e(p.summary)}</p>
    ${p.tags.length ? `<div class="tags">${p.tags.map((t) => `<span class="tag">${e(t)}</span>`).join('')}</div>` : ''}
  </a>`;
  const body = `
<canvas id="bg-net" aria-hidden="true"></canvas>
<div class="wrap wr">
  <header class="wr-head">
    <p class="eyebrow mono reveal">~/blog</p>
    <h1 class="reveal">Notes from <span class="grad">running platforms</span></h1>
    <p class="lead reveal">Engineering handbooks and blog posts on platform engineering, Kubernetes, infrastructure and Linux.</p>
    <p class="wr-count mono reveal">${books.length ? `${books.length} handbook${books.length === 1 ? '' : 's'} · ` : ''}${posts.length} post${posts.length === 1 ? '' : 's'} · <a href="${url('/feed.xml')}">RSS</a></p>
  </header>

  <div class="wr-filters reveal" role="group" aria-label="Filter posts and handbooks">
    <button type="button" class="wr-chip on" data-filter="all" aria-pressed="true">All</button>
    ${books.length ? '<button type="button" class="wr-chip" data-filter="handbook" aria-pressed="false">Handbooks</button>' : ''}
    <button type="button" class="wr-chip" data-filter="post" aria-pressed="false">Posts</button>
    ${tags.map((t) => `<button type="button" class="wr-chip wr-tag" data-filter="tag:${e(t)}" aria-pressed="false">#${e(t)}</button>`).join('')}
  </div>

  ${books.length ? `<section class="wr-section" data-section="handbook"><h2 class="wr-h mono">Handbooks</h2>${books.map(bookCard).join('')}</section>` : ''}

  <section class="wr-section" data-section="post">
    <h2 class="wr-h mono">Posts</h2>
    <div class="wr-grid">${posts.map(postCard).join('')}</div>
    <p class="wr-empty muted" hidden>Nothing matches this filter yet.</p>
  </section>
</div>`;
  return layout({ title: 'Blog', description: 'Engineering handbooks and blog posts on platform engineering, Kubernetes, infrastructure and Linux.', path: '/blog/', body, active: 'writing', home: true });
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
  return layout({ title: p.title, description: p.summary, path: `/blog/${p.slug}/`, body, active: 'writing' });
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
  return layout({ title: 'Handbooks', description: 'Engineering handbooks on platform engineering and SRE.', path: '/handbooks/', body, active: 'writing' });
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
    <p class="crumb mono"><a href="${url('/blog/')}">← blog</a></p>
    <h1>${e(book.title)}${book.status ? ` <span class="badge">${e(book.status)}</span>` : ''}</h1>
    <p class="lead">${e(book.description)}</p>
    <ol class="chapter-list">${book.chapters
      .map(
        (c, i) => `<li><a href="${url(`/handbooks/${book.slug}/${c.slug}/`)}"><span class="mono num">${String(i + 1).padStart(2, '0')}</span><span><strong>${e(c.title)}</strong><br><span class="muted">${e(c.summary)}</span></span></a></li>`
      )
      .join('')}</ol>
  </article>
</div>`;
  return layout({ title: book.title, description: book.description, path: `/handbooks/${book.slug}/`, body, active: 'writing' });
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
  return layout({ title: `${c.title} · ${book.title}`, description: c.summary || book.description, path: `/handbooks/${book.slug}/${c.slug}/`, body, active: 'writing' });
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
write('blog/index.html', blogIndex(posts, books));
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
