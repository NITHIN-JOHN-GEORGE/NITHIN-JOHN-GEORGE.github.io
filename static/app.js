(function () {
  var root = document.documentElement;
  var BASE = window.__BASE__ || '';

  // theme toggle
  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  }

  // copy buttons on code blocks
  document.querySelectorAll('.code-copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.closest('.code').querySelector('code');
      var text = code ? code.textContent : '';
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { btn.textContent = 'Press Ctrl+C'; });
      } else { btn.textContent = 'Press Ctrl+C'; }
    });
  });

  // chapter sidebar: open on wide screens
  var side = document.getElementById('side-details');
  if (side && window.matchMedia('(min-width: 861px)').matches) side.open = true;

  // table of contents highlight
  var tocLinks = document.querySelectorAll('.toc a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var map = {};
    tocLinks.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          tocLinks.forEach(function (a) { a.classList.remove('active'); });
          var a = map[en.target.id];
          if (a) a.classList.add('active');
        }
      });
    }, { rootMargin: '-80px 0px -70% 0px' });
    Object.keys(map).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  }

  // search
  var dialog = document.getElementById('search-dialog');
  var input = document.getElementById('search-input');
  var list = document.getElementById('search-results');
  var openBtn = document.getElementById('search-open');
  var index = null, loading = false, sel = -1;

  function load(cb) {
    if (index) return cb();
    if (loading) return;
    loading = true;
    fetch(BASE + '/search.json').then(function (r) { return r.json(); }).then(function (j) { index = j; cb(); })
      .catch(function () { index = []; cb(); });
  }

  function score(item, terms) {
    var t = item.t.toLowerCase(), x = item.x.toLowerCase(), s = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      if (t.indexOf(term) > -1) s += 10;
      else if (x.indexOf(term) > -1) s += 1;
      else return 0;
    }
    return s;
  }

  function render() {
    var q = input.value.trim().toLowerCase();
    list.innerHTML = '';
    sel = -1;
    if (!q || !index) return;
    var terms = q.split(/\s+/);
    var hits = index.map(function (it) { return { it: it, s: score(it, terms) }; })
      .filter(function (h) { return h.s > 0; })
      .sort(function (a, b) { return b.s - a.s; }).slice(0, 8);
    if (!hits.length) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="search-hint" style="padding:8px 12px;display:block">No results</span>';
      list.appendChild(li);
      return;
    }
    hits.forEach(function (h) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = h.it.u;
      if (/^https?:/.test(h.it.u)) { a.target = '_blank'; a.rel = 'noopener'; }
      var small = document.createElement('small');
      small.textContent = h.it.k;
      var span = document.createElement('span');
      span.textContent = h.it.t;
      a.appendChild(small); a.appendChild(span);
      li.appendChild(a); list.appendChild(li);
    });
  }

  function openSearch() {
    if (!dialog || !dialog.showModal) return;
    if (!dialog.open) dialog.showModal();
    input.value = '';
    list.innerHTML = '';
    input.focus();
    load(render);
  }

  if (openBtn) openBtn.addEventListener('click', openSearch);
  if (input) {
    input.addEventListener('input', function () { load(render); });
    input.addEventListener('keydown', function (e) {
      var links = list.querySelectorAll('a');
      if (e.key === 'Escape') {
        e.preventDefault();
        dialog.close();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!links.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
        links.forEach(function (l, i) { l.classList.toggle('sel', i === sel); });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var target = links[sel >= 0 ? sel : 0];
        if (target) target.click();
      }
    });
  }
  if (dialog) {
    dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
  }
  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(tag) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      openSearch();
    }
  });
})();

/* ===== home: reveals, counters, background network, terminal ===== */
(function () {
  var root = document.documentElement;
  var reduce = root.classList.contains('no-motion');

  // scroll reveals
  var items = document.querySelectorAll('.reveal');
  if (!reduce && 'IntersectionObserver' in window) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); ro.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach(function (el, i) { el.style.transitionDelay = Math.min(i % 4, 3) * 60 + 'ms'; ro.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add('in'); });
  }

  // count-up numbers
  var counts = document.querySelectorAll('.count');
  function run(el) {
    var to = Number(el.getAttribute('data-to')) || 0, t0 = null, dur = 1200;
    function step(t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    }
    el.textContent = '0';
    requestAnimationFrame(step);
  }
  if (counts.length && !reduce && 'IntersectionObserver' in window) {
    var co = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { run(en.target); co.unobserve(en.target); } });
    });
    counts.forEach(function (c) { co.observe(c); });
  }

  // subtle background network
  var cv = document.getElementById('bg-net');
  if (cv && !reduce && cv.getContext) {
    var ctx = cv.getContext('2d'), dpr = Math.min(window.devicePixelRatio || 1, 2), W, H, pts = [], raf;
    function rgb() { return getComputedStyle(root).getPropertyValue('--net').trim() || '96,165,250'; }
    function size() {
      W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr;
      var n = Math.round(Math.min(70, (innerWidth * innerHeight) / 22000));
      pts = [];
      for (var i = 0; i < n; i++) pts.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.15 * dpr, vy: (Math.random() - 0.5) * 0.15 * dpr });
    }
    function draw() {
      var c = rgb(), max = 140 * dpr;
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
        ctx.fillStyle = 'rgba(' + c + ',0.55)';
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.4 * dpr, 0, 6.283); ctx.fill();
        for (var j = i + 1; j < pts.length; j++) {
          var q = pts[j], dx = p.x - q.x, dy = p.y - q.y, d = Math.sqrt(dx * dx + dy * dy);
          if (d < max) {
            ctx.strokeStyle = 'rgba(' + c + ',' + (0.14 * (1 - d / max)).toFixed(3) + ')';
            ctx.lineWidth = dpr;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    }
    size(); draw();
    addEventListener('resize', size);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) cancelAnimationFrame(raf); else draw();
    });
  }

  // interactive terminal: real shell commands, true answers only
  var dataEl = document.getElementById('term-data');
  var out = document.getElementById('term-out');
  var form = document.getElementById('term-form');
  var input = document.getElementById('term-in');
  if (!dataEl || !out || !form) return;
  var D = JSON.parse(dataEl.textContent);
  var prompt = '<span class="t-ok">' + D.user + '</span><span class="t-dim"> ~ %</span> ';
  var hist = [], hi = 0;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function link(href, text) { return '<a href="' + esc(href) + '"' + (/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : '') + '>' + esc(text) + '</a>'; }
  function print(html) { out.insertAdjacentHTML('beforeend', html + '\n'); out.scrollTop = out.scrollHeight; }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

  function yaml(obj) {
    var k = function (s) { return '<span class="t-head">' + esc(s) + '</span>:'; };
    return Object.keys(obj).map(function (key) {
      var v = obj[key];
      if (Array.isArray(v)) return k(key) + '\n' + v.map(function (x) { return '  <span class="t-dim">-</span> <span class="t-ok">' + esc(x) + '</span>'; }).join('\n');
      return k(key) + ' <span class="t-ok">' + esc(v) + '</span>';
    }).join('\n');
  }
  var files = {
    '/etc/motd': function () { return esc(D.motd); },
    '~/.about-me.yaml': function () { return D.aboutYaml ? yaml(D.aboutYaml) : esc(D.about); },
    '.about-me.yaml': function () { return files['~/.about-me.yaml'](); },
    'about.txt': function () { return esc(D.about); },
    'experience.log': function () {
      return D.experience.map(function (x) { return '<span class="t-dim">' + esc(pad(x.period, 22)) + '</span>' + esc(x.role) + ' <span class="t-head">@ ' + esc(x.org) + '</span>'; }).join('\n');
    },
    'contact.txt': function () {
      return 'linkedin  ' + link(D.links.linkedin, D.links.linkedin.replace(/^https:\/\/(www\.)?/, '')) + '\ngithub    ' + link(D.links.github, D.links.github.replace('https://', '')) + '\nmedium    ' + link(D.links.medium, D.links.medium.replace('https://', ''));
    }
  };
  var dirs = {
    'skills': function () { return D.skills.map(function (g) { return '<span class="t-head">' + esc(g.group) + '/</span>\n  ' + esc(g.items.join('  ')); }).join('\n'); },
    'blog': function () { return D.posts.map(function (p) { return '<span class="t-dim">' + esc(pad(p.date, 10)) + '</span>' + link(p.href, p.title); }).join('\n'); },
    'handbooks': function () { return D.handbooks.length ? D.handbooks.map(function (b) { return link(b.href, b.title) + ' <span class="t-dim">(' + b.chapters + ' chapters)</span>'; }).join('\n') : 'No handbooks published yet.'; }
  };

  var cmds = {
    help: function () {
      return 'Commands:\n' + [
        ['whoami', 'who I am'], ['cat /etc/motd', 'what I do'], ['cat ~/.about-me.yaml', 'the short version'], ['ls -a', 'list files'], ['ls skills', 'tools I work with'],
        ['cat experience.log', 'where I have worked'], ['ls blog', 'posts'], ['ls handbooks', 'engineering handbooks'],
        ['cat contact.txt', 'how to reach me'], ['history', 'commands you ran'], ['clear', 'clear the screen']
      ].map(function (r) { return '  <span class="t-ok">' + pad(r[0], 22) + '</span>' + r[1]; }).join('\n');
    },
    whoami: function () { return esc(D.name) + ' · ' + esc(D.role); },
    pwd: function () { return '/home/' + esc(D.user); },
    ls: function (args) {
      var all = args[0] === '-a' || args[0] === '-la' || args[0] === '-al';
      if (all) args = args.slice(1);
      var a = (args[0] || '').replace(/\/$/, '');
      if (!a || a === '.' || a === '~') return (all ? '.about-me.yaml  ' : '') + '<span class="t-head">skills/  blog/  handbooks/</span>  about.txt  experience.log  contact.txt';
      if (dirs[a]) return dirs[a]();
      return 'ls: ' + esc(a) + ': No such file or directory';
    },
    cat: function (args) {
      var f = args[0];
      if (!f) return 'usage: cat &lt;file&gt;';
      if (files[f]) return files[f]();
      if (dirs[f.replace(/\/$/, '')]) return 'cat: ' + esc(f) + ': Is a directory';
      return 'cat: ' + esc(f) + ': No such file or directory';
    },
    cd: function (args) { return args[0] && dirs[args[0].replace(/\/$/, '')] ? 'Tip: use <span class="t-ok">ls ' + esc(args[0].replace(/\/$/, '')) + '</span> to see what is inside.' : ''; },
    echo: function (args) { return esc(args.join(' ')); },
    date: function () { return esc(new Date().toString()); },
    history: function () { return hist.map(function (h, i) { return pad(i + 1, 5) + esc(h); }).join('\n'); },
    clear: function () { out.innerHTML = ''; return null; }
  };

  function exec(line, silent) {
    var raw = line.trim();
    if (!silent) print(prompt + esc(raw));
    if (!raw) return;
    hist.push(raw); hi = hist.length;
    var parts = raw.split(/\s+/), name = parts[0], args = parts.slice(1);
    if (name === 'sudo') { print('Nice try. This terminal runs with least privilege.'); return; }
    var fn = cmds[name];
    if (!fn) { print('zsh: command not found: ' + esc(name) + '\n<span class="term-hint">Type <span class="t-ok">help</span> to see what works here.</span>'); return; }
    var res = fn(args);
    if (res) print(res);
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); exec(input.value); input.value = ''; });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowUp') { if (hi > 0) { hi--; input.value = hist[hi]; } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { if (hi < hist.length - 1) { hi++; input.value = hist[hi]; } else { hi = hist.length; input.value = ''; } e.preventDefault(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      var all = Object.keys(cmds).concat(Object.keys(files), Object.keys(dirs));
      var words = input.value.split(' '), last = words.pop();
      var m = all.filter(function (w) { return last && w.indexOf(last) === 0; });
      if (m.length === 1) { words.push(m[0]); input.value = words.join(' ') + ' '; }
    }
  });
  document.getElementById('term').addEventListener('click', function (e) { if (e.target.tagName !== 'A') input.focus({ preventScroll: true }); });

  // short intro sequence, typed like a real session
  var script = ['whoami', 'cat /etc/motd', 'cat ~/.about-me.yaml'];
  if (reduce) {
    script.forEach(function (c) { exec(c); });
    print('<span class="term-hint">Type <span class="t-ok">help</span> and press Enter.</span>');
    return;
  }
  var si = 0;
  function typeNext() {
    if (si >= script.length) { print('<span class="term-hint">Your turn. Type <span class="t-ok">help</span> and press Enter.</span>'); return; }
    var cmd = script[si++], k = 0;
    var line = document.createElement('span');
    out.appendChild(line);
    (function tick() {
      line.innerHTML = prompt + esc(cmd.slice(0, k)) + '<span class="cursor"></span>';
      if (k++ < cmd.length) return setTimeout(tick, 55 + Math.random() * 40);
      line.remove();
      exec(cmd);
      setTimeout(typeNext, 500);
    })();
  }
  setTimeout(typeNext, 600);
})();

/* ===== writing page filters ===== */
(function () {
  var chips = document.querySelectorAll('.wr-chip');
  if (!chips.length) return;
  var books = document.querySelectorAll('[data-kind="handbook"]');
  var posts = document.querySelectorAll('[data-kind="post"]');
  var secBook = document.querySelector('[data-section="handbook"]');
  var secPost = document.querySelector('[data-section="post"]');
  var empty = document.querySelector('.wr-empty');
  function apply(f) {
    chips.forEach(function (c) { var on = c.getAttribute('data-filter') === f; c.classList.toggle('on', on); c.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    var tag = f.indexOf('tag:') === 0 ? f.slice(4) : null;
    var showBooks = f === 'all' || f === 'handbook';
    if (secBook) secBook.classList.toggle('is-hidden', !showBooks);
    var shown = 0;
    posts.forEach(function (p) {
      var ok = f === 'all' || f === 'post' || (tag && (' ' + p.getAttribute('data-tags') + ' ').indexOf(' ' + tag + ' ') > -1);
      p.classList.toggle('is-hidden', !ok);
      if (ok) { shown++; p.classList.add('in'); }
    });
    if (secPost) secPost.classList.toggle('is-hidden', f === 'handbook');
    if (empty) empty.hidden = shown > 0 || f === 'handbook';
  }
  chips.forEach(function (c) { c.addEventListener('click', function () { apply(c.getAttribute('data-filter')); }); });
})();

/* ===== mobile menu and section highlighting ===== */
(function () {
  var btn = document.getElementById('nav-toggle');
  var nav = document.getElementById('primary-nav');
  if (btn && nav) {
    btn.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
    });
  }
  // on the home page, highlight the menu item for the section in view
  if (!document.body.classList.contains('home') || !document.getElementById('skills') || !('IntersectionObserver' in window)) return;
  var ids = ['skills', 'projects', 'certifications', 'contact'];
  var links = {};
  ids.forEach(function (id) { links[id] = document.querySelector('.nav a[data-nav="' + id + '"]'); });
  var homeLink = document.querySelector('.nav a[data-nav="home"]');
  var lockUntil = 0;
  function setActive(a) {
    Object.keys(links).forEach(function (k) { if (links[k]) links[k].classList.remove('active'); });
    if (a) a.classList.add('active');
    if (homeLink) homeLink.removeAttribute('aria-current');
  }
  Object.keys(links).forEach(function (k) {
    if (links[k]) links[k].addEventListener('click', function () { setActive(links[k]); lockUntil = Infinity; });
  });
  ['wheel', 'touchmove', 'keydown'].forEach(function (ev) { window.addEventListener(ev, function () { lockUntil = 0; }, { passive: true }); });
  var io = new IntersectionObserver(function (entries) {
    if (Date.now() < lockUntil) return;
    entries.forEach(function (en) {
      var a = links[en.target.id];
      if (!a) return;
      if (en.isIntersecting) {
        Object.keys(links).forEach(function (k) { if (links[k]) links[k].classList.remove('active'); });
        a.classList.add('active');
        if (homeLink) homeLink.removeAttribute('aria-current');
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  ids.forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  window.addEventListener('scroll', function () {
    if (window.scrollY < 300 && Date.now() >= lockUntil) {
      Object.keys(links).forEach(function (k) { if (links[k]) links[k].classList.remove('active'); });
      if (homeLink) homeLink.setAttribute('aria-current', 'page');
    }
  }, { passive: true });
})();
