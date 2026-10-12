/* mock-cell.js -- Colab, Excel and a SQL console drawn inside a Reveal slide, with the code typed in
   front of the room and the real output arriving on the next click.

   Include once per deck, after Reveal.initialize (beside poll.js):
       <link rel="stylesheet" href="../../mock-cell.css">          (in <head>)
       <script src="../../mock-cell.js"></script>                  (after poll.js)

   A slide declares
       <div class="mock colab" data-src="cells/ch14.json" data-cell="7"></div>
   data-src   the runner's JSON (mock_cells.py run cells/ch14.py). The page loads ch14.json.js, the
              same object as a script, because a deck opened from disk cannot fetch() a file.
   data-cell  the cell's name in that JSON; cells copied from a notebook are named by their
              notebook cell index, which is also what the Live button runs.
   options    data-instant (no typing animation), data-rate="40" (characters a second),
              data-max="6" (longest typing time, seconds), data-size="14pt", data-parts="stream"
              (show only these output parts; the others are counted, not hidden in silence),
              data-img-height="220" (px), data-lines="1-3,9-14" (colab: type only these lines of the
              cell, 1-based; each run left out shows as one grey "... N lines not shown" line, so a long
              cell's figure fits; Live still runs the whole cell), data-live="off", data-step-notes="line 1 | line 2"
              (one plain-text speaker-view line per click; reveal reads data-notes on the shown fragment).
   per-click notes  <aside class="notes" data-sv="1" data-click="1">...</aside> (and data-click="2", "3")
              inside the .mock div: a full speaker-view note for that click, in the house format. The
              slide's own aside is click 0. Each one is moved into its click's fragment, where reveal's
              notes plugin reads an aside before data-notes, and stops counting it as a slide note.

   Clicks. colab and sql: (1) type the code, (2) run it: the output from the JSON. excel: (1) type
   the formula in the formula bar, (2) Enter fills the active cell, (3) fill-down fills the range
   if the cell has one; a ribbon cell instead: (1) its one button lights, (2) the result. Pressing
   "next" while the code is still typing finishes it at once: the escape that always works, from
   the speaker view too. "I" toggles instant typing for every mock (remembered per browser);
   ?instant in the URL does the same.

   Nothing here computes or types an output: every number on a mocked slide comes from the JSON,
   and `mock_cells.py check` fails when that JSON is older than its .py. */
(function () {
  'use strict';
  if (window.__mockCell) return; window.__mockCell = 1;

  var MC = window.MockCells = window.MockCells || { q: [] };
  var loaded = {}, waiting = {}, mocks = [];
  var RATE = 40, MAXS = 6, RUN_MS = 650;

  function abs(u) { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } }
  function drain() {
    while (MC.q.length) {
      var it = Array.prototype.shift.call(MC.q), url = abs(it[0] || ''), d = it[1];
      loaded[url] = d; (waiting[url] || []).forEach(function (cb) { cb(d); }); delete waiting[url];
    }
  }
  MC.q.push = function (it) { Array.prototype.push.call(MC.q, it); drain(); return MC.q.length; };
  drain();

  function load(src, cb) {
    var url = abs(src + '.js');
    if (loaded[url]) return cb(loaded[url]);
    var first = !waiting[url]; (waiting[url] = waiting[url] || []).push(cb);
    if (!first) return;
    var s = document.createElement('script'); s.src = url;
    s.onerror = function () { (waiting[url] || []).forEach(function (f) { f(null); }); delete waiting[url]; };
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------ instant mode
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  MC.instant = /[?&]instant\b/.test(location.search) || lsGet('mk-instant') === '1';
  var toastEl;
  function toast(t) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'mk-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = t; toastEl.classList.add('on');
    clearTimeout(toast.t); toast.t = setTimeout(function () { toastEl.classList.remove('on'); }, 1400);
  }
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'i' && e.key !== 'I')) return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if (!document.querySelector('.mock')) return;
    MC.instant = !MC.instant; lsSet('mk-instant', MC.instant ? '1' : '0');
    toast(MC.instant ? 'Mock cells: instant' : 'Mock cells: typing');
    if (MC.instant) mocks.forEach(finishTyping);
  });
  window.addEventListener('storage', function (e) { if (e.key === 'mk-instant') MC.instant = e.newValue === '1'; });

  // ------------------------------------------------------------ helpers
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function plain(tokens) { return tokens.map(function (t) { return t[1]; }).join(''); }
  // the first n characters of the code, coloured; the rest kept as invisible text so the box
  // already has its final size and nothing below it moves while it types
  function typed(tokens, n, refColours) {
    var out = '', used = 0, refs = 0, caret = '<span class="mk-caret"></span>', placed = false;
    tokens.forEach(function (t) {
      var cls = t[0], s = t[1];
      if (cls === 'ref' && refColours) { refs++; cls = 'ref' + (refs % 4 === 1 ? '' : (refs - 1) % 4 + 1); }
      var c = cls ? ' class="t-' + cls + '"' : '';
      if (used >= n) { if (!placed) { out += caret; placed = true; } out += '<span class="mk-ghost">' + esc(s) + '</span>'; }
      else if (used + s.length <= n) { out += '<span' + c + '>' + esc(s) + '</span>'; }
      else {
        var k = n - used;
        out += '<span' + c + '>' + esc(s.slice(0, k)) + '</span>' + caret + '<span class="mk-ghost">' + esc(s.slice(k)) + '</span>';
        placed = true;
      }
      used += s.length;
    });
    if (!placed) out += caret;
    return out;
  }
  function colIndex(L) { var n = 0; for (var i = 0; i < L.length; i++) n = n * 26 + (L.charCodeAt(i) - 64); return n - 1; }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function addr(a) { var m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(a || 'A1'); return { c: colIndex(m[1]), r: +m[2] }; }
  function range(a) { var p = (a || '').split(':'), x = addr(p[0]), y = addr(p[1] || p[0]); return { c0: x.c, r0: x.r, c1: y.c, r1: y.r }; }
  function isNum(s) { return /^-?[\d,]*\.?\d+(e[-+]?\d+)?%?$/i.test(String(s).trim()); }

  // ------------------------------------------------------------ build one mock
  function setup(m) {
    if (m.__mk) return; m.__mk = { k: 0, steps: [], notes: {} };
    // taken out before the build empties the mock; addSteps puts each inside its click's fragment
    [].slice.call(m.querySelectorAll('aside.notes[data-click]')).forEach(function (a) {
      m.__mk.notes[a.getAttribute('data-click')] = a; a.parentNode.removeChild(a);
    });
    var src = m.getAttribute('data-src'), name = m.getAttribute('data-cell');
    load(src, function (data) {
      if (!data) { m.innerHTML = '<div style="color:#b00020;font:13pt sans-serif">mock-cell: could not load ' + esc(src) + '.js</div>'; return; }
      var cell = null;
      (data.cells || []).forEach(function (c) { if (String(c.name) === String(name)) cell = c; });
      if (!cell && /^\d+$/.test(name || '')) cell = (data.cells || [])[+name];
      if (!cell) { m.innerHTML = '<div style="color:#b00020;font:13pt sans-serif">mock-cell: no cell "' + esc(name) + '" in ' + esc(src) + '</div>'; return; }
      var st = m.__mk; st.cell = cell; st.data = data;
      st.base = abs(src).replace(/[^/]*$/, '');
      if (m.getAttribute('data-size')) m.style.setProperty('--mk-size', m.getAttribute('data-size'));
      var skin = m.classList.contains('excel') ? 'excel' : m.classList.contains('sql') ? 'sql' : 'colab';
      st.skin = skin;
      if (skin === 'colab') buildColab(m, st);
      else if (skin === 'excel') buildExcel(m, st);
      else buildSql(m, st);
      addSteps(m, st);
      render(m, 0);
      mocks.push(m);
      var R = window.Reveal;
      if (R && R.isReady && R.isReady()) { try { R.syncFragments(); } catch (e) {} sync(R.getCurrentSlide()); }
    });
  }

  function addSteps(m, st) {
    var notes = (m.getAttribute('data-step-notes') || '').split('|').map(function (s) { return s.trim(); });
    st.steps.forEach(function (s, i) {
      var f = el('span', 'fragment mk-step'); f.setAttribute('data-mk', s);
      if (st.notes[i + 1]) f.appendChild(st.notes[i + 1]);
      else if (notes[i]) f.setAttribute('data-notes', notes[i]);
      m.appendChild(f);
    });
  }

  // colab ------------------------------------------------------------
  function buildColab(m, st) {
    var c = st.cell;
    st.tokens = c.tokens || [['', c.code]];
    if (m.getAttribute('data-lines')) st.tokens = someLines(st.tokens, m.getAttribute('data-lines'));
    st.steps = ['type', 'run'];
    var cell = el('div', 'mk-cell');
    var gut = el('div', 'mk-gut', '<div class="mk-run"></div><div class="mk-count mk-mono">[' + (c.count != null ? c.count : ' ') + ']</div>');
    var body = el('div', 'mk-body');
    st.codeEl = el('pre', 'mk-code'); st.codeEl.innerHTML = '<code></code>';
    st.outEl = el('div', 'mk-out mk-mono');
    body.appendChild(st.codeEl); body.appendChild(st.outEl);
    cell.appendChild(gut); cell.appendChild(body);
    m.innerHTML = ''; m.appendChild(cell);
    st.outEl.innerHTML = colabOutput(m, st);
    var nb = m.getAttribute('data-nb') || (c.nb != null ? String(c.nb) : '');
    var notebook = m.getAttribute('data-notebook') || st.data.notebook || '';
    if (nb && notebook && m.getAttribute('data-live') !== 'off') {
      m.setAttribute('data-live-nb', nb); m.setAttribute('data-live-notebook', notebook);
      m.setAttribute('data-live-line', (c.code.split('\n').filter(function (l) { return l.trim(); })[1] || c.code.split('\n')[0] || '').trim());
      var b = el('button', 'mk-live' + (bridgeOn ? ' on' : ''), 'Live');
      b.title = 'Run cell ' + nb + ' in the open Colab tab (the bridge extension); the bridge key brings you back';
      b.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); live(m); });
      m.appendChild(b); st.liveBtn = b;
    }
  }

  // data-lines="1-3,9-14": the cell's tokens cut to those lines, with one marker line per gap
  function someLines(tokens, spec) {
    var lines = [[]], keep = {}, out = [], gap = 0;
    tokens.forEach(function (t) {
      t[1].split('\n').forEach(function (s, i) { if (i) lines.push([]); if (s) lines[lines.length - 1].push([t[0], s]); });
    });
    spec.split(',').forEach(function (r) {
      var ab = r.trim().split('-'), a = +ab[0], b = +(ab[1] || ab[0]);
      for (var i = a; i <= b; i++) keep[i] = 1;
    });
    function mark() {
      if (!gap) return;
      if (out.length) out.push(['', '\n']);
      out.push(['omit', '\u22ef ' + gap + ' line' + (gap > 1 ? 's' : '') + ' not shown']); gap = 0;
    }
    lines.forEach(function (ln, i) {
      if (!keep[i + 1]) { gap++; return; }
      mark();
      if (out.length) out.push(['', '\n']);
      out.push.apply(out, ln);
    });
    mark();
    return out;
  }

  function colabOutput(m, st) {
    var c = st.cell, parts = c.parts || [{ type: 'stream', text: c.stdout || '' }];
    var only = (m.getAttribute('data-parts') || '').split(/[\s,]+/).filter(Boolean);
    var imgH = m.getAttribute('data-img-height'), html = '', omitted = {};
    parts.forEach(function (p) {
      if (only.length && only.indexOf(p.type) < 0) { omitted[p.type] = (omitted[p.type] || 0) + 1; return; }
      if (p.type === 'stream' || p.type === 'value') html += '<pre>' + esc(p.text.replace(/\n$/, '')) + '</pre>';
      else if (p.type === 'stderr') html += '<pre class="mk-stderr">' + esc(p.text.replace(/\n$/, '')) + '</pre>';
      else if (p.type === 'table') html += '<div class="mk-df">' + p.html + '</div>';
      else if (p.type === 'image') {
        var w = p.width, h = p.height, sty = '';
        if (imgH && h) { sty = 'height:' + imgH + 'px;width:auto;'; }
        else if (w) sty = 'width:' + w + 'px;';
        html += '<img alt="" src="' + esc(st.base + p.src) + '" style="' + sty + '">';
      } else if (p.type === 'error') {
        var tb = (p.traceback || '').replace(/\n+$/, '').split('\n'), last = tb.pop() || p.ename;
        var mm = /^(\w+)(.*)$/.exec(last) || ['', last, ''];
        html += '<pre class="mk-err">' + esc(tb.slice(-6).join('\n')) + (tb.length ? '\n' : '') +
          '<span class="mk-ename">' + esc(mm[1]) + '</span>' + esc(mm[2]) + '</pre>';
      }
    });
    var said = Object.keys(omitted).map(function (k) {
      var n = omitted[k], w = { image: 'figure', table: 'table', stream: 'printed block', value: 'value', stderr: 'warning', error: 'error' }[k] || k;
      return n + ' ' + w + (n > 1 ? 's' : '');
    });
    if (said.length) html += '<div class="mk-omit">+ ' + said.join(', ') + ' in the notebook, not shown here</div>';
    return html;
  }

  // excel ------------------------------------------------------------
  var RIBBON = {
    Home: [['Paste', 'fa-paste'], ['Conditional Formatting', 'fa-table-cells-large'], ['Format as Table', 'fa-table-list'], ['AutoSum', null, 'Σ'], ['Sort & Filter', 'fa-arrow-down-wide-short'], ['Find & Select', 'fa-magnifying-glass']],
    Insert: [['PivotTable', 'fa-table-cells'], ['Recommended PivotTables', 'fa-table-cells-large'], ['Table', 'fa-table'], ['Pictures', 'fa-image'], ['Recommended Charts', 'fa-chart-simple'], ['Column', 'fa-chart-column'], ['Line', 'fa-chart-line'], ['Scatter', 'fa-braille'], ['PivotChart', 'fa-chart-pie']],
    Formulas: [['Insert Function', null, 'fx'], ['AutoSum', null, 'Σ'], ['Recently Used', 'fa-star'], ['Financial', 'fa-coins'], ['Logical', 'fa-code-branch'], ['Lookup & Reference', 'fa-magnifying-glass']],
    Data: [['Get Data', 'fa-database'], ['Refresh All', 'fa-rotate'], ['Sort', 'fa-arrow-down-a-z'], ['Filter', 'fa-filter'], ['Text to Columns', 'fa-table-columns'], ['What-If Analysis', 'fa-circle-question'], ['Data Analysis', 'fa-chart-line']],
    Review: [['Spelling', 'fa-spell-check'], ['Comments', 'fa-comment']],
    View: [['Freeze Panes', 'fa-snowflake'], ['Zoom', 'fa-magnifying-glass-plus']]
  };
  var TABS = ['File', 'Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View'];

  function ribbonHTML(rb) {
    var ti = TABS.indexOf(rb.tab); if (ti < 0) ti = 0;
    var tabs = TABS.slice(Math.max(0, ti - 2), ti + 3).map(function (t) {
      return '<span class="xl-tab' + (t === rb.tab ? ' on' : '') + '">' + esc(t) + '</span>';
    }).join('');
    var list = RIBBON[rb.tab] || [[rb.button, null]];
    var bi = -1; list.forEach(function (b, i) { if (b[0] === rb.button) bi = i; });
    if (bi < 0) { list = list.concat([[rb.button, null]]); bi = list.length - 1; }
    var btns = list.slice(Math.max(0, bi - 2), bi + 3).map(function (b) {
      var g = b[1] ? '<i class="fa-solid ' + b[1] + '"></i>' : '<span class="xl-glyph">' + esc(b[2] || '▦') + '</span>';
      return '<span class="xl-btn' + (b[0] === rb.button ? ' on' : '') + '">' + g + '<span>' + esc(b[0]) + '</span></span>';
    }).join('');
    return '<div class="xl-tabs">' + tabs + '</div><div class="xl-btns">' + btns + '</div>';
  }

  function buildExcel(m, st) {
    var c = st.cell;
    st.tokens = c.tokens || [['', c.code || '']];
    st.ribbon = c.ribbon || null;
    st.steps = st.ribbon ? ['press', 'apply'] : ['type', 'enter'].concat(c.fill ? ['fill'] : []);
    st.act = addr((c.active || 'A1').split(':')[0]);
    st.fill = c.fill ? range(c.fill) : null;
    m.innerHTML = '';
    if (st.ribbon) { st.ribbonEl = el('div', 'xl-ribbon', ribbonHTML(st.ribbon)); m.appendChild(st.ribbonEl); }
    var fb = el('div', 'xl-fbar', '<span class="xl-name"></span><span class="xl-fx">fx</span><span class="xl-formula mk-mono"></span>');
    m.appendChild(fb); st.nameEl = fb.children[0]; st.fEl = fb.children[2];
    st.gridWrap = el('div', 'xl-gridwrap'); m.appendChild(st.gridWrap);
    st.resEl = el('div', 'xl-result'); m.appendChild(st.resEl);
  }

  // the sheet as a 2-D array of display strings, row 1 = the header
  function sheetRows(g) { return [g.header.slice()].concat(g.rows.map(function (r) { return r.slice(); })); }

  function drawGrid(m, st, rows, opts) {
    opts = opts || {};
    var ncol = 0; rows.forEach(function (r) { ncol = Math.max(ncol, r.length); });
    ncol = Math.max(ncol, st.act.c + 1, st.fill ? st.fill.c1 + 1 : 0);
    var nrow = Math.max(rows.length, st.act.r, st.fill ? st.fill.r1 : 0) + (opts.extraRows != null ? opts.extraRows : 1);
    var maxRows = +(m.getAttribute('data-rows') || 0); if (maxRows) nrow = Math.min(nrow, maxRows);
    var actCol = opts.act ? opts.act.c : -1, actRow = opts.act ? opts.act.r : -1;
    var h = '<table class="xl-grid"><thead><tr><th class="xl-corner"></th>';
    for (var j = 0; j < ncol; j++) h += '<th' + (j === actCol ? ' class="on"' : '') + '>' + colName(j) + '</th>';
    h += '</tr></thead><tbody>';
    for (var r = 1; r <= nrow; r++) {
      h += '<tr><th' + (r === actRow ? ' class="on"' : '') + '>' + r + '</th>';
      for (var j2 = 0; j2 < ncol; j2++) {
        var v = (rows[r - 1] || [])[j2]; v = v == null ? '' : v;
        var cls = [];
        if (r === 1) cls.push('xl-hdr');
        else if (isNum(v)) cls.push('num');
        if (opts.act && r === actRow && j2 === actCol) cls.push('xl-act');
        if (opts.edit && r === actRow && j2 === actCol) { cls.push('xl-edit'); cls = cls.filter(function (x) { return x !== 'num'; }); }
        if (opts.rng && r >= opts.rng.r0 && r <= opts.rng.r1 && j2 >= opts.rng.c0 && j2 <= opts.rng.c1) cls.push('xl-rng');
        if (opts.fresh && opts.fresh[r + ':' + j2]) cls.push('xl-new');
        var inner = (opts.edit && r === actRow && j2 === actCol) ? opts.edit : esc(v);
        h += '<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' + inner + '</td>';
      }
      h += '</tr>';
    }
    st.gridWrap.innerHTML = h + '</tbody></table>';
  }

  // sql ------------------------------------------------------------
  function buildSql(m, st) {
    var c = st.cell;
    st.tokens = c.tokens || [['', c.code]];
    st.steps = ['type', 'run'];
    m.innerHTML = '<div class="sq-bar"><b style="background:#ff5f57"></b><b style="background:#febc2e"></b><b style="background:#28c840"></b> duckdb</div>' +
      '<div class="sq-body mk-mono"><pre class="sq-in"></pre><pre class="sq-out"></pre></div>';
    st.inEl = m.querySelector('.sq-in'); st.outEl = m.querySelector('.sq-out');
    st.outEl.textContent = (c.output || c.error || '').replace(/\n$/, '');
  }
  // DuckDB's CLI prompt is "D " and a continuation line starts with "‣ "
  function sqlTyped(st, n) {
    var html = typed(st.tokens, n);
    var lines = html.split('\n');
    return lines.map(function (l, i) { return '<span class="sq-prompt">' + (i ? '‣ ' : 'D ') + '</span>' + l; }).join('\n');
  }

  // ------------------------------------------------------------ state
  // k = how many of this mock's clicks have been shown; animate only a single step forward
  function render(m, k) {
    var st = m.__mk; if (!st || !st.cell) return;
    stopTimers(st);
    var n = plain(st.tokens).length;
    st.k = k;
    m.classList.remove('mk-ran', 'mk-running', 'mk-applied', 'mk-press', 'mk-done');
    if (st.skin === 'colab') {
      setCode(st, k >= 1 ? n : 0);
      m.classList.toggle('mk-focused', k >= 1);
      if (k >= 2) { m.classList.add('mk-ran', 'mk-done'); }
    } else if (st.skin === 'sql') {
      st.inEl.innerHTML = sqlTyped(st, k >= 1 ? n : 0);
      if (k >= 2) m.classList.add('mk-ran', 'mk-done');
    } else excelState(m, st, k, false);
  }

  function setCode(st, n) { st.codeEl.firstChild.innerHTML = typed(st.tokens, n); st.shown = n; }

  function stopTimers(st) { if (st.raf) cancelAnimationFrame(st.raf); st.raf = null; clearTimeout(st.tm); st.tm = null; st.typing = false; }

  function typeOut(m, st, paint, done) {
    var n = plain(st.tokens).length;
    var inst = MC.instant || m.hasAttribute('data-instant');
    if (inst || !n) { paint(n); return done && done(); }
    var rate = Math.max(+(m.getAttribute('data-rate') || RATE), n / +(m.getAttribute('data-max') || MAXS));
    var t0 = performance.now(); st.typing = true; st.finish = function () { stopTimers(st); paint(n); if (done) done(); };
    (function tick() {
      var k = Math.min(n, Math.floor((performance.now() - t0) / 1000 * rate));
      paint(k);
      if (k >= n) { st.typing = false; st.raf = null; if (done) done(); return; }
      st.raf = requestAnimationFrame(tick);
    })();
  }
  function finishTyping(m) { var st = m.__mk; if (st && st.typing && st.finish) st.finish(); }

  function step(m, k) {
    var st = m.__mk; if (!st || !st.cell) return;
    var was = st.k;
    if (k !== was + 1) return render(m, k);
    if (st.typing) { st.finish(); }          // "next" while typing: finish the typing at once
    stopTimers(st); st.k = k;
    var name = st.steps[k - 1], n = plain(st.tokens).length;
    if (st.skin === 'colab' || st.skin === 'sql') {
      var paint = st.skin === 'colab' ? function (i) { setCode(st, i); } : function (i) { st.inEl.innerHTML = sqlTyped(st, i); };
      if (name === 'type') { m.classList.add('mk-focused'); typeOut(m, st, paint); }
      else if (name === 'run') {
        paint(n);
        var inst = MC.instant || m.hasAttribute('data-instant');
        m.classList.add('mk-running');
        st.tm = setTimeout(function () { m.classList.remove('mk-running'); m.classList.add('mk-ran', 'mk-done'); }, inst ? 0 : RUN_MS);
      }
    } else excelState(m, st, k, true);
  }

  function excelState(m, st, k, animate) {
    var c = st.cell, rows = sheetRows(c.grid), A = st.act;
    var actName = colName(A.c) + A.r, n = plain(st.tokens).length;
    if (st.ribbon) {
      st.nameEl.textContent = c.active || actName;
      st.fEl.innerHTML = '';
      var rng = c.active && c.active.indexOf(':') > 0 ? range(c.active) : null;
      if (k >= 2) {
        if (c.kind === 'table' && c.output && c.output.header) {   // the sheet after (a sort, say)
          var after = sheetRows(c.output), fresh = {};
          for (var r = 2; r <= after.length; r++) for (var j = 0; j < after[r - 1].length; j++) if ((rows[r - 1] || [])[j] !== after[r - 1][j]) fresh[r + ':' + j] = 1;
          drawGrid(m, st, after, { act: A, rng: rng, fresh: animate ? fresh : null });
        } else {
          drawGrid(m, st, rows, { act: A, rng: rng });
          st.resEl.innerHTML = resultHTML(c);
          m.classList.add('mk-applied');
        }
        m.classList.add('mk-done');
      } else {
        drawGrid(m, st, rows, { act: A, rng: rng });
        st.resEl.innerHTML = '';
        if (k >= 1) { m.classList.remove('mk-press'); void m.offsetWidth; m.classList.add('mk-press'); }
      }
      return;
    }
    st.nameEl.textContent = actName;
    var vals = Array.isArray(c.output) ? c.output : [c.output];
    var put = function (rows2, upto) {         // values into the active cell and, past it, the fill range
      if (!st.fill || upto === 1) { rows2[A.r - 1] = rows2[A.r - 1] || []; rows2[A.r - 1][A.c] = vals[0]; return; }
      var i = 0;
      for (var r = st.fill.r0; r <= st.fill.r1; r++) for (var j = st.fill.c0; j <= st.fill.c1; j++) {
        rows2[r - 1] = rows2[r - 1] || []; rows2[r - 1][j] = vals[i++] != null ? vals[i - 1] : '';
      }
    };
    if (k === 0) { st.fEl.innerHTML = ''; drawGrid(m, st, rows, { act: A }); return; }
    if (k === 1) {
      var paint = function (i) {
        var t = typed(st.tokens, i, true);
        st.fEl.innerHTML = t;
        drawGrid(m, st, rows, { act: A, edit: '<span class="mk-mono">' + t + '</span>' });
      };
      if (animate) typeOut(m, st, paint); else paint(n);
      return;
    }
    st.fEl.innerHTML = typed(st.tokens, n, true).replace('<span class="mk-caret"></span>', '');
    if (k === 2) { put(rows, 1); var f1 = {}; f1[A.r + ':' + A.c] = 1; drawGrid(m, st, rows, { act: A, fresh: animate ? f1 : null }); }
    else {
      put(rows, 2); var fr = {};
      if (animate) for (var r2 = st.fill.r0; r2 <= st.fill.r1; r2++) for (var j2 = st.fill.c0; j2 <= st.fill.c1; j2++) if (!(r2 === A.r && j2 === A.c)) fr[r2 + ':' + j2] = 1;
      drawGrid(m, st, rows, { act: A, rng: st.fill, fresh: fr });
    }
    m.classList.add('mk-done');
  }

  function resultHTML(c) {
    var o = c.output;
    if (o && o.columns) {
      return '<div class="mk-df"><table><thead><tr>' + o.columns.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + o.rows.map(function (r) { return '<tr>' + r.map(function (v) { return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    }
    return '<pre>' + esc(Array.isArray(o) ? o.join('\n') : o) + '</pre>';
  }

  // ------------------------------------------------------------ Reveal wiring
  function shownSteps(m) { return m.querySelectorAll('.mk-step.visible').length; }
  function sync(slide) {
    if (!slide) return;
    slide.querySelectorAll('.mock').forEach(function (m) { if (m.__mk && m.__mk.cell) render(m, shownSteps(m)); });
  }
  function onFragment(e) {
    var fs = e.fragments && e.fragments.length ? e.fragments : [e.fragment], seen = [];
    fs.forEach(function (f) {
      if (!f || !f.classList || !f.classList.contains('mk-step')) return;
      var m = f.closest('.mock'); if (seen.indexOf(m) < 0) seen.push(m);
    });
    seen.forEach(function (m) { step(m, shownSteps(m)); });
  }
  function wire() {
    var R = window.Reveal; if (!R || !R.on) return setTimeout(wire, 100);
    R.on('fragmentshown', onFragment);
    R.on('fragmenthidden', onFragment);
    R.on('slidechanged', function (e) { sync(e.currentSlide); });
    R.on('ready', function (e) { sync(e.currentSlide || R.getCurrentSlide()); });
  }

  // ------------------------------------------------------------ Live (through the colab bridge)
  var bridgeOn = false;
  function live(m) {
    var b = m.__mk && m.__mk.liveBtn;
    var msg = { source: 'mock-cell', t: 'live', notebook: m.getAttribute('data-live-notebook'),
      cell: +m.getAttribute('data-live-nb'), line: m.getAttribute('data-live-line') };
    if (!bridgeOn) {
      // no extension on this browser: open the notebook, so the cell is at least one scroll away
      window.open(msg.notebook, 'colab-' + (msg.notebook.split('/').pop() || 'lab'));
      if (b) say(b, 'bridge off: opened the notebook');
      return;
    }
    if (b) say(b, 'running cell ' + msg.cell + '…');
    window.postMessage(msg, '*');
  }
  function say(b, t) {
    var s = b.querySelector('.mk-live-msg'); if (!s) { s = el('span', 'mk-live-msg'); b.appendChild(s); }
    s.textContent = t; clearTimeout(b.__t); b.__t = setTimeout(function () { s.textContent = ''; }, 4000);
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'colab-bridge') return;
    if (e.data.t === 'linked' || e.data.t === 'deck-linked') {
      bridgeOn = true;
      document.querySelectorAll('.mock .mk-live').forEach(function (b) { b.classList.add('on'); });
    }
    if (e.data.t === 'live-result') {
      document.querySelectorAll('.mock[data-live-nb="' + e.data.cell + '"] .mk-live').forEach(function (b) {
        say(b, e.data.ok ? 'ran in Colab (' + (e.data.how || 'run') + ')' : (e.data.why || 'did not run'));
      });
    }
  });
  window.postMessage({ source: 'mock-cell', t: 'hello' }, '*');

  // ------------------------------------------------------------ start
  function start() {
    if (/[?&]receiver\b/.test(location.search)) { var rv = document.querySelector('.reveal'); if (rv) rv.setAttribute('data-receiver', ''); }
    document.querySelectorAll('.mock[data-src]').forEach(setup);
    wire();
  }
  MC.render = render; MC.step = step; MC.mocks = mocks;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
