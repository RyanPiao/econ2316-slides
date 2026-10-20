/* ============================================================
   wordcloud.js — opt-in one-word poll + word cloud (2316 Ch 9, 20 Oct 2026)
   Loaded ONLY by decks that include it, AFTER ../../poll.js. poll.js is not
   changed: this file uses its public API (Poll.ready, Poll.stamp, Poll.q,
   Poll.sessionKey) and the same poll_votes table, so a word counts for
   attendance like any other vote and one device answers once per session.

   vote:   <div class="poll-word" data-poll-id="ch09-econ2316-poll-6" data-poll-voting></div>
           students' phones: one text box + Send. The word is cleaned (first word,
           lower case, letters/digits/hyphen, at most 20 characters) and stored as
           the choice text.
   cloud:  <div class="poll-word-cloud" data-poll-id="..."></div>
           PROJECTOR: only "N words in" until the instructor shows the whole cloud with one press
           of the arrow (one hidden .wc-step fragment) or of the speaker-panel button.
           SPEAKER VIEW (reveal's current-slide frame, ?receiver): the full list with
           a tap-to-hide toggle per word, and a Reveal / Hide button. The choice is
           kept in localStorage (same origin, same laptop) and the projector follows
           it within ~1 s. Fallback with no speaker view: double-click the counter
           on the projector to reveal.
   Words on a short blocklist never show anywhere; the speaker list says how many.
   ============================================================ */
(function () {
  "use strict";
  var SU = "https://dpntbrsorgbivmntwmod.supabase.co";
  var Q = location.search, qs = new URLSearchParams(Q);
  var RECEIVER = /[?&]receiver(&|$)/.test(Q);
  var PROJECTOR = /[?&]presenter(&|=|$)/.test(Q) && !RECEIVER;
  var SPEAKER = RECEIVER || qs.has("instructor");
  var IS_FILE = location.protocol === "file:";
  var BLOCK = ["fuck", "shit", "bitch", "cunt", "dick", "cock", "pussy", "asshole", "bastard", "slut", "whore",
               "nigg", "fag", "retard", "rape", "penis", "vagina", "porn", "nazi", "hitler", "sex", "tits", "boob",
               "cum", "anal", "piss", "wank", "twat", "kill", "die"];
  var PALETTE = ["#2f6f8f", "#c06a2b", "#3d7f4f", "#a33b3b", "#6d3f7a", "#9a7b12"];

  function anonKey() {
    // poll.js keeps the anon key private; read it from its own <script> text would need a
    // fetch, so the key is passed in by the deck instead (data-k on the script tag) or,
    // failing that, taken from window.__EC_SK set by the deck.
    var s = document.currentScript || document.querySelector('script[src*="wordcloud.js"]');
    return (s && s.getAttribute("data-k")) || window.__EC_SK || "";
  }
  var SK = anonKey();
  function sf(method, path, body) {
    var o = { method: method, headers: { "apikey": SK, "Authorization": "Bearer " + SK,
              "Content-Type": "application/json", "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" } };
    if (body) o.body = JSON.stringify(body);
    return fetch(SU + "/rest/v1/" + path, o);
  }
  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function clean(raw) {
    var w = String(raw || "").trim().toLowerCase().split(/\s+/)[0] || "";
    w = w.replace(/[^a-z0-9\-]/g, "").replace(/^-+|-+$/g, "").slice(0, 20);
    return w;
  }
  function blocked(w) { for (var i = 0; i < BLOCK.length; i++) if (w.indexOf(BLOCK[i]) !== -1) return true; return false; }
  function sess() { return window.Poll ? Poll.sessionKey() : "local"; }
  function stateKey(pid) { return "ec_wc|" + pid + "|" + sess(); }
  function getState(pid) {
    try { return JSON.parse(ls(stateKey(pid)) || "{}"); } catch (e) { return {}; }
  }
  function setState(pid, st) { ls(stateKey(pid), JSON.stringify(st)); }

  var local = {};   // file:// rehearsal rows
  // DEMO: add ?wcdemo to the deck URL to fill the cloud with sample words (nothing is fetched or written).
  var DEMO = qs.has("wcdemo") ? ("corn corn corn corn corn corn corn corn corn gasoline gasoline gasoline gasoline gasoline gasoline eggs eggs eggs eggs " +
             "water water water wheat wheat wheat gold gold salt salt milk milk oil shit").split(" ").map(function (w, i) { return { choice: w, voter_id: "demo" + i }; }) : null;
  function fetchWords(pid) {
    if (DEMO) return Promise.resolve(DEMO.slice());
    if (IS_FILE) return Promise.resolve((local[pid] || []).slice());
    var q = window.Poll ? Poll.q() : "";
    return sf("GET", "poll_votes?poll_id=eq." + encodeURIComponent(pid) + "&select=choice,voter_id" + q)
      .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
  }
  function count(rows) {
    var seen = {}, ct = {}, n = 0, nb = 0;
    rows.forEach(function (r) {
      if (!r || seen[r.voter_id]) return; seen[r.voter_id] = 1;
      var w = clean(r.choice); if (!w) return;
      n++; if (blocked(w)) { nb++; return; }
      ct[w] = (ct[w] || 0) + 1;
    });
    return { ct: ct, n: n, blocked: nb };
  }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

  /* ---------- students: the box ---------- */
  function mountVote(el) {
    if (el.__wc) return; el.__wc = 1;
    var pid = el.getAttribute("data-poll-id"), room = PROJECTOR || SPEAKER;
    el.innerHTML = '<div style="display:flex; gap:10px; justify-content:center; align-items:center;">' +
      '<input class="wc-in" type="text" autocomplete="off" autocapitalize="off" maxlength="30" placeholder="' + (room ? "typed on phones" : "one word") + '"' +
      (room ? " disabled" : "") + ' style="font-size:15pt; padding:8px 14px; border:2px solid #cbd5e1; border-radius:8px; width:260px;">' +
      '<button class="wc-go" type="button"' + (room ? " disabled" : "") + ' style="font-size:14pt; padding:8px 18px; border-radius:8px; border:none; background:var(--secondary-color,#2f6f8f); color:#fff; font-weight:700; cursor:pointer;">Send</button></div>' +
      '<div class="wc-status" style="text-align:center; font-size:12pt; color:#6b7280; margin-top:6px; min-height:1.2em;"></div>';
    var input = el.querySelector(".wc-in"), btn = el.querySelector(".wc-go"), st = el.querySelector(".wc-status"), sent = false;
    ["keydown", "keypress", "keyup"].forEach(function (ev) {
      input.addEventListener(ev, function (e) { if (ev === "keydown" && e.key === "Enter") { e.preventDefault(); go(); } e.stopPropagation(); });
    });
    var k = "ec_wc_sent|" + pid + "|" + sess(), prev = ls(k);
    if (prev) { sent = true; input.value = prev; input.disabled = btn.disabled = true; st.innerHTML = "In: <strong>" + esc(prev) + "</strong>. Thanks."; }
    function submit() {
      if (sent) return;
      var w = clean(input.value);
      if (!w) { st.textContent = "Type one word (letters or numbers)."; input.focus(); return; }
      sent = true; input.disabled = btn.disabled = true; input.blur();
      if (IS_FILE) { (local[pid] = local[pid] || []).push({ choice: w, voter_id: "local" + Math.random() }); ls(k, w); st.innerHTML = "In (this computer only): <strong>" + esc(w) + "</strong>"; return; }
      st.textContent = "Sending…";
      var row = window.Poll ? Poll.stamp(pid, w) : { poll_id: pid, choice: w };
      sf("POST", "poll_votes", row).then(function (r) {
        if (r.ok) { ls(k, w); st.innerHTML = "In: <strong>" + esc(w) + "</strong>. Thanks."; return; }
        if (r.status === 409) { ls(k, w); st.textContent = "You already answered from this device."; return; }
        st.textContent = "Could not send — try once more."; sent = false; input.disabled = btn.disabled = false;
      }).catch(function () { st.textContent = "Could not reach the server."; sent = false; input.disabled = btn.disabled = false; });
    }
    function go() { if (sent || room) return; if (window.Poll && Poll.ready) Poll.ready(pid, submit); else submit(); }
    btn.addEventListener("click", go);
  }

  /* ---------- projector + speaker: the cloud ---------- */
  function drawCloud(box, c, hidden, cap) {
    var words = Object.keys(c.ct).filter(function (w) { return !hidden[w]; });
    if (!words.length) { box.querySelector(".wc-cloud").innerHTML = '<p style="color:#9ca3af; font-size:14pt;">No words to show yet.</p>'; return; }
    var mx = Math.max.apply(null, words.map(function (w) { return c.ct[w]; }));
    words.sort(function (a, b) { return (c.ct[b] - c.ct[a]) || (hash(a) - hash(b)); });
    words = words.slice(0, cap || 40);
    // put the biggest words in the middle
    var order = []; words.forEach(function (w, i) { if (i % 2) order.push(w); else order.unshift(w); });
    box.querySelector(".wc-cloud").innerHTML = order.map(function (w) {
      var f = 15 + Math.round(34 * Math.sqrt(c.ct[w] / mx));
      return '<span style="font-size:' + f + 'px; font-weight:' + (c.ct[w] === mx ? 800 : 600) + '; color:' + PALETTE[hash(w) % PALETTE.length] +
             '; margin:2px 9px; line-height:1.15; display:inline-block;">' + esc(w) + "</span>";
    }).join("");
  }
  function mountCloud(box) {
    if (box.__wc) return; box.__wc = 1;
    var pid = box.getAttribute("data-poll-id");
    box.innerHTML = '<div class="wc-count" style="text-align:center; font-size:13pt; color:#374151; font-weight:700; cursor:default; user-select:none;"></div>' +
      '<div class="wc-cloud" style="display:none; text-align:center; padding:6px 10px; min-height:120px;"></div>' +
      (SPEAKER ? '<div class="wc-mod" style="margin-top:6px; text-align:center;"></div>' : "");
    var countEl = box.querySelector(".wc-count"), cloudEl = box.querySelector(".wc-cloud"), mod = box.querySelector(".wc-mod");
    var last = { ct: {}, n: 0, blocked: 0 };
    // 0 = count only, 1 = the whole cloud (max 40 words). Ryan, 20 Oct: "first take words, then I press to show the word cloud".
    // A step comes from the slide's hidden .wc-step fragments (one per press of the arrow in
    // speaker view) or from the speaker panel's button; the room sees the larger of the two.
    var CAPS = [0, 40], LABEL = ["", "the word cloud"];
    function fragLevel() { var sec = box.closest("section"); return sec ? sec.querySelectorAll(".wc-step.visible").length : 0; }
    function level(st) { return Math.min(1, Math.max(fragLevel(), st.level || (st.revealed ? 1 : 0))); }
    function render() {
      var st = getState(pid), hidden = {}; (st.hidden || []).forEach(function (w) { hidden[w] = 1; });
      var lv = level(st);
      countEl.innerHTML = last.n + (last.n === 1 ? " word" : " words") + " in" +
        (lv ? " &middot; showing " + LABEL[lv] : (SPEAKER ? " &middot; <span style='color:#b45309'>hidden from the room</span>" : ""));
      if (SPEAKER) { cloudEl.style.display = "block"; drawCloud(box, last, {}, 40); }
      else if (lv) { cloudEl.style.display = "block"; drawCloud(box, last, hidden, CAPS[lv]); }
      else cloudEl.style.display = "none";
      if (SPEAKER && mod) {
        var words = Object.keys(last.ct).sort(function (a, b) { return last.ct[b] - last.ct[a]; });
        mod.innerHTML = (lv < 1 ? '<button class="wc-rev" type="button" style="font-size:12pt; padding:5px 14px; border-radius:8px; border:none; color:#fff; font-weight:700; cursor:pointer; background:#16a34a;">Show the room the word cloud</button> ' : "") +
          (lv > 0 ? '<button class="wc-hide" type="button" style="font-size:12pt; padding:5px 14px; border-radius:8px; border:none; color:#fff; font-weight:700; cursor:pointer; background:#6b7280;">Hide from the room</button>' : "") +
          '<div style="margin-top:6px; font-size:11pt;">' + words.map(function (w) {
            return '<span class="wc-chip" data-w="' + esc(w) + '" style="display:inline-block; margin:2px 3px; padding:1px 8px; border-radius:10px; cursor:pointer; background:' +
              (hidden[w] ? "#fee2e2; text-decoration:line-through; color:#991b1b" : "#e5e7eb; color:#111827") + ';">' + esc(w) + " &times;" + last.ct[w] + "</span>";
          }).join("") + (last.blocked ? '<span style="color:#991b1b; margin-left:6px;">(' + last.blocked + " blocked)</span>" : "") +
          '</div><div style="font-size:10pt; color:#6b7280;">Tap a word to keep it off the projector.</div>';
        if (SPEAKER) {   // the speaker frame previews what the ROOM will see: struck words greyed
          [].forEach.call(cloudEl.querySelectorAll("span"), function (sp) { if (hidden[sp.textContent]) sp.style.opacity = "0.25"; });
        }
      }
    }
    if (mod) mod.addEventListener("click", function (e) {
      var st = getState(pid); st.hidden = st.hidden || [];
      var chip = e.target.closest(".wc-chip"), rev = e.target.closest(".wc-rev"), hide = e.target.closest(".wc-hide");
      if (chip) { var w = chip.getAttribute("data-w"), i = st.hidden.indexOf(w); if (i < 0) st.hidden.push(w); else st.hidden.splice(i, 1); }
      else if (rev) { st.level = 1; delete st.revealed; }
      else if (hide) { st.level = 0; delete st.revealed; } else return;
      setState(pid, st); render(); e.stopPropagation();
    });
    if (PROJECTOR) countEl.addEventListener("dblclick", function () { var st = getState(pid); st.level = level(st) ? 0 : 1; delete st.revealed; setState(pid, st); render(); });
    if (window.Reveal && Reveal.on) ["fragmentshown", "fragmenthidden", "slidechanged"].forEach(function (ev) { Reveal.on(ev, render); });
    window.addEventListener("storage", function (e) { if (e.key === stateKey(pid)) render(); });
    function tick() {
      var sec = box.closest("section");
      var onSlide = !window.Reveal || !Reveal.getCurrentSlide || Reveal.getCurrentSlide() === sec;
      if (onSlide) fetchWords(pid).then(function (rows) { last = count(rows); render(); });
      else render();
    }
    tick(); setInterval(tick, (PROJECTOR || SPEAKER) ? 3000 : 20000);
    setInterval(render, 1000);
  }

  function mountAll() {
    [].forEach.call(document.querySelectorAll(".poll-word[data-poll-id]"), mountVote);
    [].forEach.call(document.querySelectorAll(".poll-word-cloud[data-poll-id]"), mountCloud);
  }
  window.WordCloud = { clean: clean, blocked: blocked, count: count, mount: mountAll,
                       // rehearsal: render rows you hand it (no vote is written)
                       show: function (pid, rows) { local[pid] = rows.slice(); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll); else mountAll();
})();
