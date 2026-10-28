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
