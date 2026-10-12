/* ============================================================
   econ-lectures — shared poll identity / attendance layer
   Loaded by every deck as  <script src="../../poll.js"></script>

   Owns: device id, NUID check-in, session namespacing, voting
   windows. Does NOT own rendering — each deck keeps its own
   chart code and calls into this.

   SAFETY CONTRACT (matters, read before editing):
     * If this file fails to load, every deck still works — all
       call sites are written as  window.Poll ? new : old.
     * If poll-schema.sql has NOT been run yet, this degrades to
       exactly the old behaviour instead of erroring. It probes
       for the session_key column once and omits it if absent,
       and treats a missing poll_windows table as "open".

   TYPED-NUMBER POLLS (11 Oct 2026). Each student types one number.
     vote:    <div class="poll-number" data-poll-id="ch08-econ3916-poll-5" data-poll-voting
                   data-min="0" data-max="240" data-unit="min" [data-step="1"]
                   [data-arm="nuid-parity"]></div>
              poll.js draws the box and the Send button. Same check-in (Poll.ready), same
              table and the same unique index as the A-D polls, so one vote per device per
              poll per session, and any vote counts for attendance. The number is stored as
              the choice text: "12", or "o:12" / "e:12" with data-arm ("o*:" = device parity,
              a student who skipped the check-in). No schema change: choice is text.
     reveal:  <div class="poll-number-results" data-poll-id="..." data-min data-max data-unit
                   [data-arm="nuid-parity"] [data-ref="0" data-ref-label="..."]
                   [data-label-odd="Odd NUID" data-label-even="Even NUID"]></div>
              histogram on shared bins; median and MAD first, mean and SD second, n; with
              data-arm two panels on one scale and odd minus even for medians and means.
     tally:   <div class="poll-choice-tally" data-poll-id="<an A-D poll>" data-choices="A=Higher|B=Lower">
              one bar per option, e.g. the room's guess drawn beside the test that answers it.
     numbers: <span data-poll-fill="<poll id>" data-key="welch.t"></span> anywhere in the deck.
              keys: n, n.odd, n.even, {mean,sd,median,mad}.{odd,even,all}, diff.mean,
              diff.median, welch.se, welch.t, welch.df, welch.p, welch.decision, cohen.sp,
              cohen.d, device, dropped. Welch = scipy ttest_ind(equal_var=False), odd minus
              even; d uses the n-1 pooled SD (Lab 8 Steps 6-7). Event "pollnumbers" on document.
   ARMS: <div data-arm="nuid-parity"> holding [data-arm-version="room|pending|odd|even"]
     children shows one of them: a student's device the odd or even block by the NUID's last
     digit; no NUID yet, the pending block (a [data-arm-checkin] button in it opens the
     check-in; Cancel falls back to the parity of a hash of the device id); the projector
     only room; speaker view and ?instructor both odd and even. Sets data-arm-assigned and
     data-arm-source (nuid|device) on the box. Poll.arm(), Poll.armSource().
   ============================================================ */
(function () {
  "use strict";

  var SU = "https://dpntbrsorgbivmntwmod.supabase.co";
  var SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRwbnRicnNvcmdiaXZtbnR3bW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4NjY5NzksImV4cCI6MjA5MTQ0Mjk3OX0.7__ja5Sq2AB__iFXhj-CKZJ0l7SjUerf8mpGQlo2bxI";

  var K_DEVICE = "ec_device_id";
  var K_NUID   = "ec_nuid";
  var K_SYNCED = "ec_nuid_synced";   // "<nuid>|<device>" once the server has CONFIRMED the link

  /* ---------- identity check-in is OPT-IN, per deck ---------- */
  // A deck that wants the NUID check-in asks for it, either with
  //     <script>window.POLL_CHECKIN = true;</script>   (before poll.js)
  // or  <script src="../../poll.js" data-checkin></script>
  //
  // Default OFF. A course that has not asked can never prompt a student for
  // an identifier, even if it calls Poll.ready().
  //
  // WHO IS ON, as of 2026-09-27 -- check this list, not your memory of it:
  //   2316  on since 2026-09-23. The deck check-in IS the participation record.
  //   5200  on since 088f8db, "every poll click now goes through the NUID check-in".
  //   3916  on since 2026-09-27. It briefly kept the code-gated Canvas quiz as a
  //         fallback; Ryan dropped that the same night and 3916 now follows 2316 --
  //         the deck check-in IS the record. Canvas course 261878 has Topic 1-4's
  //         graded quizzes still published and everything from Topic 5 unpublished.
  //         First real capture is 2026-09-28; nothing earlier has identity data.
  //   1116  OFF, and nothing has asked for it.
  //
  // The line this replaces recorded Ryan's 2026-09-23 decision that 3916, 5200 and
  // 1116 must stay off. Two of the three have since been switched on deliberately,
  // and the stale comment was quoted as authority on 2026-09-27 before anyone
  // checked the decks. If you change a course, change this list in the same commit.
  var CHECKIN = (function () {
    if (window.POLL_CHECKIN === true) return true;
    var s = document.currentScript ||
            document.querySelector('script[src*="poll.js"]');
    return !!(s && s.hasAttribute("data-checkin"));
  })();

  var IS_FILE = (window.location.protocol === "file:");
  var qs      = new URLSearchParams(window.location.search);

  // Which window are we? Mirrors presenter-gate v5's detection exactly.
  //   PROJECTOR — the deck the room sees (?presenter). Owns auto open/close.
  //   SPEAKER   — the current-slide preview INSIDE reveal's speaker view.
  //               Renders the status bar and the manual overrides.
  //   A student's deck is neither, so it never loads the secret and never
  //   touches a window.
  var Q          = location.search;
  var PROJECTOR  = /[?&]presenter(&|=|$)/.test(Q);
  var SPEAKER    = /[?&]receiver(&|$)/.test(Q) && /postMessageEvents=true/.test(Q);
  var INSTRUCTOR = PROJECTOR || SPEAKER || qs.has("instructor");

  var GRACE_MS = 20000;   // keep a poll open this long after leaving its slide

  // ---------- Results-refresh throttle (2026-09-29) ----------
  // Every deck re-GETs poll_votes every 5 s per device while a poll slide is
  // on screen: ~35 student devices = ~420 requests/min, each one egress AND a
  // log line against the Supabase free tier (egress hit 113% in Sep 2026).
  // Student devices now reuse a result for STUDENT_RESULTS_MS; the projector
  // and speaker view (INSTRUCTOR) stay live at 5 s, so the room's chart is
  // unchanged. Any non-GET to poll_votes (this device voting) drops the cache,
  // so a voter sees their own vote at once. Fails open: on any error the real
  // fetch runs. Done here, once, instead of editing the loop in ~90 decks.
  var STUDENT_RESULTS_MS = 20000;
  if (!INSTRUCTOR && !IS_FILE && window.fetch && window.Response &&
      !window.__pollFetchThrottled) {
    window.__pollFetchThrottled = true;
    var realFetch = window.fetch.bind(window);
    var resultCache = {};   // url -> {at, status, body, ctype}
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.indexOf("/rest/v1/poll_votes") !== -1) {
          var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
          if (method !== "GET") { resultCache = {}; return realFetch(input, init); }
          var hit = resultCache[url];
          if (hit && Date.now() - hit.at < STUDENT_RESULTS_MS) {
            return Promise.resolve(new Response(hit.body,
              { status: hit.status, headers: { "Content-Type": hit.ctype } }));
          }
          return realFetch(input, init).then(function (r) {
            if (r.ok) {
              r.clone().text().then(function (b) {
                resultCache[url] = { at: Date.now(), status: r.status, body: b,
                  ctype: r.headers.get("Content-Type") || "application/json" };
              }).catch(function () {});
            }
            return r;
          });
        }
      } catch (e) { /* fall through to the real fetch */ }
      return realFetch(input, init);
    };
  }

  // Feature probes — resolved once, then cached for the session.
  var hasSessionKey = null;   // null = unknown, true/false once probed
  var windowCache   = {};     // pollId -> {open:bool, at:ms}

  /* ---------- tiny helpers ---------- */

  function ls(k, v) {
    try {
      if (v === undefined) return window.localStorage.getItem(k);
      window.localStorage.setItem(k, v);
      return v;
    } catch (e) { return null; }   // private mode / blocked storage
  }

  function sf(method, path, body) {
    var o = {
      method: method,
      headers: {
        "apikey": SK,
        "Authorization": "Bearer " + SK,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache"
      }
    };
    if (body) o.body = JSON.stringify(body);
    return fetch(SU + "/rest/v1/" + path, o);
  }

  function rpc(fn, args) {
    return sf("POST", "rpc/" + fn, args);
  }

  /* ---------- identity ---------- */

  function deviceId() {
    var d = ls(K_DEVICE);
    if (!d) {
      d = "d_" + Math.random().toString(36).slice(2, 10) +
                 Math.random().toString(36).slice(2, 10);
      ls(K_DEVICE, d);
    }
    return d;
  }

  function nuid() {
    var n = ls(K_NUID);
    return (n && /^[0-9]{9}$/.test(n)) ? n : null;
  }

  // Record the device -> NUID link server-side. The anon key can write this
  // but can never read it back (see poll-schema.sql), and votes carry only the
  // device id, so this row is the ONLY thing that credits a student's votes.
  // It used to be one fire-and-forget POST at check-in: if that one request
  // failed (bad wifi at that moment), the student saw "checked in" on every
  // later deck while none of their votes were credited. Now the link is sent
  // again on every page load until a 2xx confirms it. A failure here must
  // still never block a student from voting.
  function syncIdentity(n) {
    if (IS_FILE || !CHECKIN || !n || PROJECTOR || SPEAKER) return;
    var tag = n + "|" + deviceId();
    if (ls(K_SYNCED) === tag) return;
    sf("POST", "poll_identities", { device_id: deviceId(), nuid: n })
      .then(function (r) { if (r && r.ok) ls(K_SYNCED, tag); })
      .catch(function () {});
  }

  function setNuid(n) {
    ls(K_NUID, n);
    ls(K_SYNCED, "");        // a fresh check-in always writes, even back to an earlier NUID
    syncIdentity(n);
    paintChip();
    applyArms();
  }

  /* ---------- session key: 2026-09-23-am ---------- */

  // The course this deck belongs to: econ2316, econ5200, ... Taken from the
  // URL path first, since every deck lives under /<course>/ (or, for a course in
  // its own repository since Oct 2026, /<course>-slides/), and from the poll
  // id only as a fallback (they are namespaced chNN-econXXXX-poll-N).
  function courseToken() {
    var m = location.pathname.match(/\/(econ\d{3,4})(?:-slides)?\//i);
    if (m) return m[1].toLowerCase();
    var g = document.querySelector("[data-poll-id]");
    var id = g && g.getAttribute("data-poll-id");
    var n = id && id.match(/(econ\d{3,4})/i);
    return n ? n[1].toLowerCase() : "deck";
  }

  // MUST include the course. It did not, and that was a real outage waiting to
  // happen: session_key was date+half only, shared by every course, while
  // isOpen() treats "any window row exists for this session" as "windows are
  // in use" and therefore "a poll with no row of its own is closed". One 2316
  // window opened at 12:19 under 2026-09-23-pm would have closed every 5200
  // poll that afternoon -- students tapping and being told voting is not open.
  // Invisible until a second course ran the check-in in the same half-day.
  // Found by the 5200 Producer with Supabase writes intercepted, before it hit
  // a class.
  function sessionKey() {
    var forced = qs.get("sec");                      // ?sec=am / ?sec=pm
    var now = new Date();
    var half = forced ? forced.toLowerCase()
                      : (now.getHours() < 12 ? "am" : "pm");
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return now.getFullYear() + "-" + p(now.getMonth() + 1) + "-" +
           p(now.getDate()) + "-" + half + "-" + courseToken();
  }

  // Belt and braces on top of the key: never let a row that plainly belongs to
  // another course influence this one, even if a key collides again.
  function ownCourse(pollId) {
    var m = String(pollId).match(/(econ\d{3,4})/i);
    return !m || m[1].toLowerCase() === courseToken();
  }

  /* ---------- session_key column probe ---------- */
  // Runs once. Until it resolves we behave as if the column is absent,
  // which is the old behaviour and always safe.

  function probeSessionKey() {
    if (IS_FILE) { hasSessionKey = false; return Promise.resolve(false); }
    return sf("GET", "poll_votes?select=session_key&limit=1")
      .then(function (r) { hasSessionKey = r.ok; return r.ok; })
      .catch(function () { hasSessionKey = false; return false; });
  }

  /* ---------- public: read filter + write payload ---------- */

  // Appended to a PostgREST select so a section only ever reads its own votes.
  function q() {
    return hasSessionKey ? "&session_key=eq." + encodeURIComponent(sessionKey()) : "";
  }

  function stamp(pollId, choice) {
    var row = { poll_id: pollId, choice: choice, voter_id: deviceId() };
    if (hasSessionKey) row.session_key = sessionKey();
    return row;
  }

  /* ---------- voting windows ---------- */
  // Fails OPEN: a missing table, a network blip or an un-run migration
  // must never stop a class from voting. Enforcement that actually counts
  // happens in the export, not here.

  function isOpen(pollId) {
    if (IS_FILE || !hasSessionKey) return Promise.resolve(true);
    var c = windowCache[pollId];
    if (c && (Date.now() - c.at) < 3000) return Promise.resolve(c.open);
    // Query every window for this SESSION, not just this poll. If the
    // instructor has not opened a single poll yet this session, windows are
    // simply not in use and voting stays open -- forgetting to press Open can
    // never silently kill a class. Once any poll has been opened this session,
    // windows are in use and an unopened poll is treated as closed.
    return sf("GET", "poll_windows?session_key=eq." + encodeURIComponent(sessionKey()) +
                     "&select=poll_id,opened_at,closed_at")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (rows === null)  return true;          // table absent -> open
        rows = rows.filter(function (w) { return ownCourse(w.poll_id); });
        if (!rows.length)   return true;          // windows unused today -> open
        var mine = rows.filter(function (w) { return w.poll_id === pollId; })[0];
        var open = !!mine && !!mine.opened_at && !mine.closed_at;
        windowCache[pollId] = { open: open, at: Date.now() };
        return open;
      })
      .catch(function () { return true; });
  }

  // "none"   -> no window row for this session: voting is open by default,
  //             because you have not taken control of any poll yet
  // "open"   -> you opened it
  // "closed" -> it was opened and has since closed, or others were opened and
  //             this one never was
  function windowState(pollId) {
    if (IS_FILE || !hasSessionKey) return Promise.resolve("none");
    return sf("GET", "poll_windows?session_key=eq." + encodeURIComponent(sessionKey()) +
                     "&select=poll_id,opened_at,closed_at")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        rows = (rows || []).filter(function (w) { return ownCourse(w.poll_id); });
        if (!rows.length) return "none";
        var mine = rows.filter(function (w) { return w.poll_id === pollId; })[0];
        if (!mine) return "closed";
        return (mine.opened_at && !mine.closed_at) ? "open" : "closed";
      })
      .catch(function () { return "none"; });
  }

  function openPoll(pollId)  { return windowRpc("open_poll",  pollId); }
  function closePoll(pollId) { return windowRpc("close_poll", pollId); }

  /* ---------- instructor secret, via the shared CCGate passphrase ---------- */
  // The Supabase secret is a random machine string nobody types. It lives
  // encrypted in poll-secret.js under the SAME passphrase that unlocks
  // /poll-admin/ and /class-console/, and CCGate caches that passphrase
  // origin-wide as "cc.pass". So unlocking any instructor page in this
  // browser makes this silent forever after.
  //
  // Silent-only on the PROJECTOR: mounting CCGate's full-screen gate there
  // would cover the slide in front of the room. The gate is only ever shown
  // in speaker view.

  var secretPromise = null;

  function b64(str) { return Uint8Array.from(atob(str), function (c) { return c.charCodeAt(0); }); }

  function ccDecrypt(payload, pass) {
    var enc = new TextEncoder();
    return crypto.subtle
      .importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: b64(payload.salt), iterations: payload.iter, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      })
      .then(function (key) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(payload.iv) }, key, b64(payload.ct));
      })
      .then(function (clear) { return JSON.parse(new TextDecoder().decode(clear)); });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = src; el.onload = resolve; el.onerror = reject;
      document.head.appendChild(el);
    });
  }

  function base() {   // poll.js sits at the repo root, two levels above a deck
    var tag = document.querySelector('script[src$="poll.js"]');
    return tag ? tag.getAttribute("src").replace(/poll\.js$/, "") : "../../";
  }

  // Fetched, never <script src>. A script tag is cached by the browser, so
  // after a passphrase rotation the page keeps the OLD payload and the correct
  // passphrase can never open it -- silently, because the projector suppresses
  // every message. no-store is the whole point of this function.
  function loadPayload() {
    return fetch(base() + "poll-secret.js", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (t) {
        if (!t) return null;
        var m = t.match(/=\s*(\{[\s\S]*?\})\s*;/);
        return m ? JSON.parse(m[1]) : null;
      })
      .catch(function () { return null; });
  }

  function instructorSecret() {
    if (secretPromise) return secretPromise;
    secretPromise = new Promise(function (resolve) {
      if (!INSTRUCTOR || IS_FILE || !(window.crypto && crypto.subtle)) return resolve(null);
      loadPayload()
        .then(function (pl) {
          if (!pl) return resolve(null);
          var cached = ls("cc.pass");
          if (cached) {
            return ccDecrypt(pl, cached.trim())
              .then(function (d) { resolve(d && d.poll_secret || null); })
              .catch(function () { gate(pl, resolve); });      // stale passphrase
          }
          gate(pl, resolve);
        })
        .catch(function () { resolve(null); });     // no poll-secret.js yet
    });
    return secretPromise;
  }

  // Only reachable from speaker view / ?instructor, never from the projector.
  function gate(payload, resolve) {
    if (!SPEAKER && !qs.has("instructor")) return resolve(null);
    loadScript(base() + "auth.js")
      .then(function () {
        if (!window.CCGate) return resolve(null);
        window.CCGate.mount({
          payload: payload,
          title: "Instructor passphrase (same one as poll-admin)",
          onUnlock: function (d) { resolve(d && d.poll_secret || null); }
        });
      })
      .catch(function () { resolve(null); });
  }

  function windowRpc(fn, pollId) {
    return instructorSecret().then(function (secret) {
      // Anything that goes wrong here must stay off the projected screen.
      // Only speaker view is allowed to say a word about it, and the fallback
      // is always "windows unused" -> voting open, never a dead room.
      var say = SPEAKER ? toast : function () {};
      if (!secret) { say("No instructor secret on this device."); return false; }
      return rpc(fn, { p_poll_id: pollId, p_session_key: sessionKey(), p_pass: secret })
        .then(function (r) {
          if (!r.ok) { secretPromise = null; say("Server rejected the instructor secret."); return false; }
          windowCache[pollId] = null;
          paintSpeakerBar();
          return true;
        })
        .catch(function () { say("Could not reach the server."); return false; });
    });
  }

  /* ---------- check-in UI ---------- */

  function modal(onDone) {
    if (document.getElementById("ec-checkin")) return;
    var wrap = document.createElement("div");
    wrap.id = "ec-checkin";
    wrap.innerHTML =
      '<div class="ec-ci-card">' +
        '<h3>Check in</h3>' +
        '<p>Enter your <strong>9-digit NUID</strong> once. This device will remember it ' +
           'for every class for the rest of the term.</p>' +
        '<input id="ec-ci-input" inputmode="numeric" autocomplete="off" ' +
               'maxlength="9" placeholder="00#######">' +
        '<div id="ec-ci-err"></div>' +
        '<div class="ec-ci-row">' +
          '<button id="ec-ci-cancel" type="button">Cancel</button>' +
          '<button id="ec-ci-go" type="button">Check in</button>' +
        '</div>' +
        '<p class="ec-ci-skip">Cancel (or Esc) still records your vote in the class ' +
           'result \u2014 it just will not count toward your participation credit.</p>' +
      '</div>';
    document.body.appendChild(wrap);

    var input = wrap.querySelector("#ec-ci-input");
    var err   = wrap.querySelector("#ec-ci-err");

    // Reveal.js swallows keystrokes and will navigate slides while a student
    // types digits. This is mandatory, not defensive.
    ["keydown", "keypress", "keyup"].forEach(function (ev) {
      input.addEventListener(ev, function (e) { e.stopPropagation(); });
    });

    function close(ok) {
      wrap.remove();
      if (onDone) onDone(ok);
    }

    function submit() {
      var v = (input.value || "").replace(/[^0-9]/g, "");
      if (!/^[0-9]{9}$/.test(v)) {
        err.textContent = "That should be exactly 9 digits.";
        input.focus();
        return;
      }
      setNuid(v);
      close(true);
    }

    wrap.querySelector("#ec-ci-go").addEventListener("click", submit);
    wrap.querySelector("#ec-ci-cancel").addEventListener("click", function () { close(false); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") close(false);
    });
    setTimeout(function () { input.focus(); }, 50);
  }

  function paintChip() {
    if (!CHECKIN) return;
    // Not on the instructor's own windows. Two reasons, both seen on a real
    // projector: it sat on top of the gate's home and full-screen buttons at
    // bottom-left, and it put "checked in ....1111" on the projected screen --
    // Ryan's own demo check-in, shown to the room for the whole lecture. The
    // explicit "?instructor" flag is deliberately NOT included, so there is
    // still a way to demonstrate the check-in flow on purpose.
    if (PROJECTOR || SPEAKER) {
      var old = document.getElementById("ec-chip");
      if (old) old.remove();
      return;
    }
    var chip = document.getElementById("ec-chip");
    var n = nuid();
    if (!n) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "ec-chip";
      document.body.appendChild(chip);
      chip.addEventListener("click", function () {
        ls(K_NUID, "");
        modal(null);
      });
    }
    chip.innerHTML = '<span>&#10003; checked in</span> &middot;&#8226;&#8226;&#8226;&#8226;' +
                     n.slice(-4) + ' <em>change</em>';
    placeChip(chip);
  }

  // The chip is the one piece of this that STUDENTS see on their own phones and
  // laptops, and it sat at a fixed bottom-left where it could land on the
  // slide's own content. Same rule as the badge: take the letterbox if there is
  // one, because that can cover nothing at all; otherwise the least-covered
  // corner of the slide, measured against real glyphs.
  function placeChip(el) {
    var slides = document.querySelector(".reveal .slides");
    if (!slides) return;
    var r = slides.getBoundingClientRect();
    var H = window.innerHeight, W = window.innerWidth;
    var w = el.offsetWidth || 150, h = el.offsetHeight || 26, M = 8;
    if (!w || !window.innerWidth) return;
    var set = function (x, y) {
      el.style.left = Math.round(x) + "px";
      el.style.top = Math.round(y) + "px";
      el.style.bottom = "auto";
    };
    // Preferred home: immediately LEFT of reveal's own page number, on the same
    // line. That is the deck's existing "status" row, it is outside the slide
    // whenever there is a letterbox, and it keeps the bottom-LEFT corner free --
    // which now holds the home / full-screen / pen buttons on a student's device
    // too, not just the projector.
    var num = document.querySelector(".reveal .slide-number");
    if (num && getComputedStyle(num).display !== "none") {
      var nr = num.getBoundingClientRect();
      if (nr.width > 1) {
        var nx = nr.left - w - 10;
        var ny = nr.top + (nr.height - h) / 2;
        if (nx >= M) {
          el.dataset.self = "1";
          var nb = inkRects(currentSlide());
          delete el.dataset.self;
          if (overlapAt(nx, ny, w, h, nb) === 0) { set(nx, ny); return; }
        }
      }
    }
    var below = H - r.bottom;
    if (below >= h + M) { set(Math.max(M, r.right - w - M), r.bottom + (below - h) / 2); return; }
    if (r.top >= h + M) { set(Math.max(M, r.right - w - M), (r.top - h) / 2); return; }
    el.dataset.self = "1";
    var boxes = inkRects(currentSlide());
    delete el.dataset.self;
    // same near-miss candidates as the badge, for the same reason
    var cands = [[W - w - 2, H - h - 2], [r.right - w - M, r.bottom - h - M],
                 [W - w - 2, 2], [r.right - w - M, r.top + M],
                 [M, H - h - 2], [r.left + M, r.bottom - h - M],
                 [M, 2], [r.left + M, r.top + M]];
    var score = function (cw, ch) {
      var b = null;
      cands.forEach(function (c) {
        var x = Math.max(2, Math.min(W - cw - 2, c[0]));
        var y = Math.max(2, Math.min(H - ch - 2, c[1]));
        var o = overlapAt(x, y, cw, ch, boxes);
        if (!b || o < b.o) b = { x: x, y: y, o: o };
      });
      return b;
    };
    var best = score(w, h);
    if (best.o > 0) {
      // Nothing is free at full size. This happens on a dense slide in an
      // exactly-16:9 window, where the top strip is the title and the bottom
      // strip is reveal's own navigation -- on ch02 the enabled down-arrow sits
      // dead centre at the bottom and costs more to cover (1620px) than
      // clipping a corner of text (608px). Rather than pick the least-bad
      // collision, drop the "press G" hint and keep the number: the compact
      // badge drops the hint line and fits where the full one cannot. (Sizes
      // shift with the label -- the full badge was 226x59 before it carried a
      // "Ch 5" / "Topic 6" prefix and is 218-258x59 now, the compact one 142x43
      // before. Everything here scores the badge as measured, so the numbers
      // are context, not thresholds.)
      // The number is the part the room needs; the hint is a courtesy.
      el.className = "compact";
      var cw = el.offsetWidth, ch2 = el.offsetHeight;
      var alt = score(cw, ch2);
      if (alt.o < best.o) { set(alt.x, alt.y); return; }
      el.className = "";                    // compact was no better; keep the hint
    } else if (el.className === "compact") {
      el.className = "";
    }
    set(best.x, best.y);
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "ec-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  /* ---------- the gate every vote passes through ---------- */

  function ready(pollId, go) {
    var proceed = function () {
      isOpen(pollId).then(function (open) {
        if (!open) { toast("Voting isn't open for this question yet."); return; }
        go();
      });
    };
    // Never on the instructor's own windows. A vote clicked in speaker view is
    // replayed on the projector (presenter gate v21), and a 9-digit prompt there
    // would be typed into a window the keyboard is not in, in front of the room.
    // The instructor's own vote needs no participation credit.
    if (!CHECKIN || nuid() || PROJECTOR || SPEAKER) { proceed(); return; }
    modal(function () { proceed(); });   // skipping still votes, just uncredited
  }

  /* ---------- auto open/close, driven by the slide ---------- */
  // The point of this block: you never have to remember anything. Walking
  // onto a poll slide opens voting; walking off it closes voting after a
  // grace period, so a student mid-tap is not cut off. Speaker view shows
  // the state and can override it.

  var openIds = {};        // pollId -> true while we believe it is open
  var closeTimers = {};    // pollId -> timeout id

  // Reveal's own answer, NOT document.querySelector("section.present").
  // On a vertical sub-slide the OUTER stack also carries .present and comes
  // first in document order, so the querySelector version returned the stack --
  // which still contains the question's voting grid. Advancing from a poll to
  // its answer sub-slide therefore looked like "still on the poll", and voting
  // stayed open while the correct answer was projected.
  function currentSlide() {
    if (window.Reveal && Reveal.getCurrentSlide) {
      var s = Reveal.getCurrentSlide();
      if (s) return s;
    }
    return document.querySelector("section.present");
  }

  function pollIdsOnCurrentSlide() {
    var sec = currentSlide();
    if (!sec) return [];
    var out = [];
    [].forEach.call(sec.querySelectorAll("[data-poll-id]"), function (e) {
      var id = e.getAttribute("data-poll-id");
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }

  // Polls whose VOTING GRID is on screen. Deliberately narrower than
  // pollIdsOnCurrentSlide(): the answer/reveal sub-slide also carries
  // data-poll-id (on its results chart), and treating that as "still here"
  // kept voting open while the correct answer was projected. Advancing to the
  // reveal must close the poll.
  function votingPollsHere() {
    var sec = currentSlide();
    if (!sec) return [];
    var out = [];
    // ".poll-grid" covers the ordinary A/B/C/D polls. "[data-poll-voting]" is
    // the escape hatch for a live activity that is not a choice grid at all --
    // ch04's Cobb-Douglas form, where the students type two goods and drag a
    // slider. Without it that slide had no poll id on it, so the speaker bar
    // hid itself and "t" did nothing: there was no way to open or close it.
    [].forEach.call(sec.querySelectorAll(".poll-grid[data-poll-id], .poll-number[data-poll-id], [data-poll-voting][data-poll-id]"), function (e) {
      var id = e.getAttribute("data-poll-id");
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }

  function scheduleClosesFor(here) {
    if (IS_FILE || !hasSessionKey) return;
    sf("GET", "poll_windows?session_key=eq." + encodeURIComponent(sessionKey()) +
              "&select=poll_id,opened_at,closed_at")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        rows.forEach(function (w) {
          var id = w.poll_id;
          if (!ownCourse(id)) return;                      // another course's row
          if (!w.opened_at || w.closed_at) return;        // not currently open
          if (here.indexOf(id) >= 0) return;              // its grid is on screen
          if (closeTimers[id]) return;                    // already counting down
          closeTimers[id] = setTimeout(function () {
            delete closeTimers[id];
            if (votingPollsHere().indexOf(id) >= 0) return;   // walked back onto it
            delete openIds[id];
            closePoll(id);
          }, GRACE_MS);
        });
        paintSpeakerBar();
      })
      .catch(function () {});
  }

  function onSlideChanged() {
    var here = votingPollsHere();

    // Arriving at a poll slide does NOT open it. You open it when you are
    // ready -- press "t", or the button in speaker view.
    //
    // Deliberately NOT cancelling pending closes here. Reveal fires a transient
    // slidechanged during vertical moves in which the poll is briefly current
    // again, and cancelling on arrival let that transient wipe the close that
    // had just been scheduled -- so advancing to the answer sub-slide never
    // closed voting, with the correct answer on screen. The timer re-checks the
    // current slide before it closes anything, so stepping back onto a poll
    // within the grace still keeps it open. That check is the only thing that
    // should decide.

    // Leaving closes whatever is open, after a grace so a student mid-tap still
    // lands. Driven by the SERVER's window rows, not by what this page happens
    // to remember: reloading the deck mid-class wipes local state, and an
    // openIds-only version then left earlier polls open for the rest of the
    // lecture. Forgetting to close is the easy mistake and it must not depend
    // on the tab surviving.
    scheduleClosesFor(here);
    paintSpeakerBar();
  }

  /* ---------- manual open / close ---------- */

  function openHere() {
    pollIdsOnCurrentSlide().forEach(function (id) {
      if (closeTimers[id]) { clearTimeout(closeTimers[id]); delete closeTimers[id]; }
      if (openIds[id] === true) return;
      openIds[id] = "pending";
      openPoll(id).then(function (ok) {
        if (ok) openIds[id] = true; else delete openIds[id];
        paintSpeakerBar();
      });
    });
    paintSpeakerBar();
  }

  function closeHere() {
    pollIdsOnCurrentSlide().forEach(function (id) {
      if (closeTimers[id]) { clearTimeout(closeTimers[id]); delete closeTimers[id]; }
      delete openIds[id];
      closePoll(id);
    });
    paintSpeakerBar();
  }

  function toggleHere() {
    var ids = pollIdsOnCurrentSlide();
    if (!ids.length) return;
    // Must ask windowState, not isOpen. isOpen() answers "can a student vote",
    // which is TRUE in the default state where no window exists at all -- so
    // toggling on isOpen made the first press try to CLOSE a poll that had
    // never been opened. Only an actually-open window should toggle shut.
    windowState(ids[0]).then(function (w) { (w === "open" ? closeHere : openHere)(); });
  }

  /* ---------- page number, readable from the back of the room ----------
     Reveal's own slide number sits in the bottom corner, small, and on at
     least one lecture-hall projector it lands on the screen's black bar. On a
     poll slide the room needs it: it is how a student says which question
     they are answering. So it is MIRRORED to the top -- the text is copied
     from reveal's own element rather than re-derived, so the two numbers
     cannot drift apart, and if the deck has slide numbers switched off
     nothing is invented. Poll slides only; every other slide is untouched. */

  // Bound to reveal's events INSTEAD of paintPageNo: reveal writes its slide
  // number after dispatching the event, so painting inside the handler reads
  // the old value. Two frames puts this safely after reveal's own update.
  // Late content is the rule, not the exception: poll bars fill from the
  // network, KaTeX typesets, images decode. A paint at +80ms or even +520ms
  // measures a slide that is not finished. This watches the slide itself and
  // re-checks, debounced; placePageNo then decides whether anything needs to
  // move. Nothing here mutates the slide, so it cannot feed itself.
  var slideWatch = null, watchT = null;
  function watchSlide() {
    if (!window.MutationObserver) return;
    var sec = currentSlide();
    if (slideWatch) slideWatch.disconnect();
    if (!sec) return;
    slideWatch = new MutationObserver(function () {
      clearTimeout(watchT);
      watchT = setTimeout(function () { paintPageNo(); paintChip(); }, 160);
    });
    slideWatch.observe(sec, { childList: true, subtree: true, characterData: true });
  }

  function schedulePageNo() {
    watchSlide();
    requestAnimationFrame(function () { requestAnimationFrame(paintPageNo); });
    requestAnimationFrame(function () { requestAnimationFrame(paintChip); });
    // requestAnimationFrame does NOT run while the tab is hidden, and a deck
    // often IS hidden at the moment it changes slide -- speaker view opened in
    // front of it, or the projector window behind something. Without this
    // backstop the badge never appears until the next navigation after the
    // window is revealed. paintPageNo is idempotent, so running twice is free.
    setTimeout(paintPageNo, 80);
    setTimeout(paintChip, 90);
    // backstop for decks whose transition does not fire the event
    setTimeout(paintPageNo, 520);
    setTimeout(paintChip, 530);
  }

  // Which deck, not just which slide. The jump hint alone is ambiguous in a
  // week where the same room sees three courses: "type 5" means a different
  // picture in each. The number is in the folder name, so read it off the path
  // rather than the deck body -- only SOME 3916/5200 decks carry "Topic N" in
  // <title>, so the body is not a reliable source. Both layouts are covered:
  // econ2316/ch05-... in the clone that Pages serves, and
  // econ2316-micro-theory/ch05-econ2316-... in the authoring copy Ryan views
  // over file://. 2316 calls these chapters; 3916 and 5200 call the same
  // ch05 folder Topic 5 -- no offset, verified against "ECON 3916 Topic 5" and
  // "ECON 5200 Topic 6" in those decks' own titles. 1116 does not load this
  // file today, but would be a chapter if it ever did. An unrecognised course
  // or an unnumbered folder degrades to no prefix, never to a wrong number.
  function deckLabel() {
    var p = location.pathname;
    var c = p.match(/econ(1116|2316|3916|5200)/);
    var n = p.match(/\/ch0*(\d+)/);
    if (!c || !n) return "";
    var word = (c[1] === "3916" || c[1] === "5200") ? "Topic " : "Ch ";
    return word + n[1] + " \u00b7 ";
  }

  function paintPageNo() {
    var el = document.getElementById("ec-pageno");
    var src = document.querySelector(".reveal .slide-number");
    // The MAJOR number only. Reveal renders "28 . 1" as three spans; the
    // sub-slide part is noise to a student -- reveal's own jump-to-slide takes
    // "28" and lands on 28.1, so printing the ".1" only invites them to type
    // something longer that does the same thing. Read the span rather than
    // splitting the text, so a deck configured to a different slideNumber
    // format degrades to "no badge" instead of to a wrong number.
    var a = src && src.querySelector(".slide-number-a");
    var txt = a ? a.textContent.replace(/\s+/g, "")
                : (src ? src.textContent.replace(/\s+/g, "") : "");
    // Reveal writes .slide-number AFTER it dispatches "slidechanged", so a
    // handler bound to that event mirrors the PREVIOUS slide's number. This was
    // off by one on EVERY horizontal arrival -- "Slide 27" while standing on 28
    // -- which made the badge's own "press G, type 27" hint send the room to
    // the wrong slide. schedulePageNo() fixes the ordering; this is the belt to
    // that braces. In reveal's "h.v"/"all" formats the major number IS h+1 by
    // definition, so any disagreement means we just read a stale DOM.
    if (a && window.Reveal && Reveal.getIndices) {
      var h1 = String((Reveal.getIndices().h || 0) + 1);
      if (txt !== h1) txt = h1;
    }
    if (!/^\d+$/.test(txt) || !pollIdsOnCurrentSlide().length) {
      if (el) el.style.display = "none";
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "ec-pageno";
      if (SPEAKER) el.className = "below-bar";   // the status bar owns top:0
      document.body.appendChild(el);
    }
    // Verified against reveal 5.1.0: "g" opens .jump-to-slide-input and "28"
    // lands on 28.1. The hint is only printed because that was tested.
    el.innerHTML = '<b>' + deckLabel() + 'Slide ' + txt + '</b>' +
                   '<i>press <kbd>G</kbd> \u2192 type <kbd>' + txt + '</kbd> \u2192 Enter</i>';
    el.style.display = "block";
    placePageNo(el);
  }

  // Where the badge goes is measured, never assumed. A fixed top-centre badge
  // covered the title on 3916 ch04 -- decks differ, and sweeping three of them
  // and generalising was the mistake. Order of preference:
  //   1. the letterbox above the slide, then below it -- reveal scales the
  //      slide to fit, so on most windows there is dead space that cannot
  //      cover anything at all;
  //   2. failing that, whichever position over the slide hides the least,
  //      measured against what is actually drawn on THIS slide.
  // Shared by the badge and the check-in chip.
  function inkRects(sec) {
    var out = [], i, r, qs, n;
    if (sec) {
      var w = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT, null, false);
      while ((n = w.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        if (!n.parentElement || n.parentElement.closest("aside.notes")) continue;
        r = document.createRange(); r.selectNodeContents(n);
        qs = r.getClientRects();
        for (i = 0; i < qs.length; i++) if (qs[i].width > 1 && qs[i].height > 1) out.push(qs[i]);
      }
      [].forEach.call(sec.querySelectorAll("img,svg,canvas,video,iframe,input,button,select,textarea"),
        function (e) {
          if (e.closest("aside.notes")) return;
          var q = e.getBoundingClientRect();
          if (q.width > 1 && q.height > 1) out.push(q);
        });
    }
    // Chrome counts too, and it is INJECTED AT RUNTIME by the presenter gate --
    // grepping a deck's HTML for these finds nothing, so they have to be read
    // from the live DOM at paint time, never from a static scan.
    ["#ti-home", "#ti-fs", "#ti-pen", "#ti-ink-bar", "#ec-spk", "#ec-pageno", "#ec-chip",
     ".reveal .slide-number", ".navigate-left", ".navigate-right",
     ".navigate-up", ".navigate-down"].forEach(function (s) {
      [].forEach.call(document.querySelectorAll(s), function (e) {
        if (e.dataset && e.dataset.self) return;               // the element being placed
        if (getComputedStyle(e).display === "none" || getComputedStyle(e).visibility === "hidden") return;
        var q = e.getBoundingClientRect();
        if (q.width > 1 && q.height > 1) out.push(q);
      });
    });
    return out;
  }

  // Score a fixed-position box against everything on screen; 0 means clear.
  function overlapAt(x, y, w, h, boxes) {
    var o = 0, i, b;
    for (i = 0; i < boxes.length; i++) {
      b = boxes[i];
      o += Math.max(0, Math.min(x + w, b.right) - Math.max(x, b.left)) *
           Math.max(0, Math.min(y + h, b.bottom) - Math.max(y, b.top));
    }
    return o;
  }

  function placePageNo(el) {
    var slides = document.querySelector(".reveal .slides");
    var sec = currentSlide();
    if (!slides || !sec) return;
    var r = slides.getBoundingClientRect();
    var W = window.innerWidth, H = window.innerHeight;
    var w = el.offsetWidth || 220, h = el.offsetHeight || 60;
    var M = 8;
    var barBottom = 0;                       // speaker view's status bar owns the top
    var bar = document.getElementById("ec-spk");
    if (bar && bar.style.display !== "none") {
      var br = bar.getBoundingClientRect();
      if (br.height) barBottom = br.bottom;
    }
    var set = function (left, top) {
      el.style.left = Math.round(left) + "px";
      el.style.top = Math.round(top) + "px";
      el.style.bottom = "auto";
      el.style.transform = "none";
    };
    var cx = Math.max(M, Math.min(W - w - M, (W - w) / 2));

    var above = r.top - barBottom;
    if (above >= h + M) { set(cx, barBottom + (above - h) / 2); return; }
    var below = H - r.bottom;
    if (below >= h + M) { set(cx, r.bottom + (below - h) / 2); return; }

    // Over the slide: score every candidate against what is actually DRAWN
    // here -- glyph extents, not element boxes. A reveal <h2> box spans the
    // full content width whatever the title says (measured: ink stops near
    // x=810 while the box runs to 1220), so a box-based score gives every top
    // candidate the same number and the choice between them becomes noise.
    el.dataset.self = "1";                 // inkRects skips anything marked self
    var boxes = inkRects(sec);
    delete el.dataset.self;

    // Poll results arrive over the network and keep changing while the class
    // votes, so the content under the badge is not settled when it is first
    // placed. Re-running the whole search on every change would make the badge
    // hop around mid-question, so it only moves when the spot it is actually
    // in has stopped being clear -- and it always re-searches on a new slide.
    var here = Reveal.getIndices ? (Reveal.getIndices().h + "." + (Reveal.getIndices().v || 0)) : "";
    var cur = el.getBoundingClientRect();
    if (el.dataset.at === here && cur.width &&
        overlapAt(cur.left, cur.top, cur.width, cur.height, boxes) === 0) return;
    el.dataset.at = here;
    // A laptop gives a letterbox that is real but a few px too small: 47px on a
    // 1512x945 screen against a badge 59px tall, so the full-clearance branch
    // above rejects it and the badge lands over the slide. Rather than a second
    // arithmetic rule, offer the near-miss as a CANDIDATE and let the same glyph
    // test judge it -- hugging the viewport edge overlaps only the slide's outer
    // few px, which is padding on every deck checked. Scaling the badge with
    // Reveal.getScale() would have made this worse, not better: at 1512x945 the
    // scale is 1.18, so the badge would grow to ~70px against a 47px gap.
    var hugTop = Math.max(barBottom + 2, 2);
    var hugBot = H - h - 2;
    var top1 = Math.max(barBottom + M, r.top + M);
    var bot1 = Math.min(H - h - M, r.bottom - h - M);
    // Centre-hug alone is not enough when there is NO letterbox at all (an
    // exactly-16:9 window): dead centre at the top edge is precisely where the
    // title sits. The edge CORNERS are the positions that survive a dense
    // slide, so they are offered too. Order is preference; the first candidate
    // scoring zero wins, so the centred ones are still taken when they are free.
    var lx = Math.max(2, r.left + 2), rx = Math.min(W - w - 2, r.right - w - 2);
    var cands = [[cx, hugTop], [cx, hugBot],
                 [rx, hugTop], [lx, hugTop], [rx, hugBot], [lx, hugBot],
                 [cx, top1], [r.right - w - M, top1], [r.left + M, top1],
                 [cx, bot1], [r.right - w - M, bot1], [r.left + M, bot1]];
    var best = null;
    cands.forEach(function (c) {
      var L = c[0], T = c[1], area = 0;
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        area += Math.max(0, Math.min(L + w, b.right) - Math.max(L, b.left)) *
                Math.max(0, Math.min(T + h, b.bottom) - Math.max(T, b.top));
      }
      if (!best || area < best.area) best = { l: L, t: T, area: area };
    });
    set(best.l, best.t);
  }

  /* ---------- speaker-view status bar ---------- */
  // Rendered ONLY inside reveal's speaker-view preview. The projected deck
  // never shows it, so the room never sees the controls.

  function mountSpeakerBar() {
    if (!SPEAKER) return;
    var bar = document.createElement("div");
    bar.id = "ec-spk";
    bar.innerHTML =
      '<span id="ec-spk-dot"></span>' +
      '<span id="ec-spk-state">—</span>' +
      '<span id="ec-spk-count"></span>' +
      '<span id="ec-spk-grow"></span>' +
      '<button data-a="open"  type="button">Open voting &nbsp;(t)</button>' +
      '<button data-a="close" type="button">Close now</button>';
    document.body.appendChild(bar);

    bar.addEventListener("click", function (e) {
      var a = e.target.getAttribute && e.target.getAttribute("data-a");
      if (a === "open")  openHere();
      if (a === "close") closeHere();
    });

    setInterval(paintSpeakerBar, 3000);
    paintSpeakerBar();
  }

  function paintSpeakerBar() {
    var bar = document.getElementById("ec-spk");
    if (!bar) return;
    var ids = pollIdsOnCurrentSlide();
    if (!ids.length) { bar.style.display = "none"; return; }
    bar.style.display = "flex";

    var id = ids[0];
    var dot = bar.querySelector("#ec-spk-dot");
    var st  = bar.querySelector("#ec-spk-state");
    var ct  = bar.querySelector("#ec-spk-count");
    var openBtn = bar.querySelector('[data-a="open"]');

    windowState(id).then(function (w) {
      var closing = !!closeTimers[id];
      if (closing)            { dot.className = "amber"; st.textContent = "CLOSING\u2026"; }
      else if (w === "open")  { dot.className = "green"; st.textContent = "VOTING OPEN"; }
      else if (w === "none")  { dot.className = "grey";
                                st.textContent = "open by default \u2014 press t to take control"; }
      else                    { dot.className = "red";
                                st.textContent = "CLOSED \u2014 press t to open"; }
      // Guarded: this lookup went stale once when the button was renamed from
      // "pin" to "open", and the resulting null threw inside this promise on
      // every repaint -- 124 unhandled rejections on a single deck load.
      if (openBtn) {
        var canOpen = (w !== "open");
        openBtn.style.opacity = canOpen ? "1" : ".45";
        openBtn.className     = canOpen ? "on" : "";
      }
    }).catch(function () {});

    if (!IS_FILE) {
      sf("GET", "poll_votes?poll_id=eq." + encodeURIComponent(id) + "&select=choice" + q())
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (rows) {
          ct.textContent = rows.length + (rows.length === 1 ? " vote" : " votes");
        })
        .catch(function () {});
    }
  }

  /* ---------- arms: which half of the room is this device in? ---------- */
  // NUID parity: last digit odd -> "odd", even -> "even". Without a NUID the
  // fallback is the parity of a fixed hash of the device id ("device"), so a
  // student who skips the check-in still lands in exactly one arm. The NUID
  // never leaves this device: a typed-number vote carries only o/e (one bit).
  var armDevice = !CHECKIN;   // CHECKIN off: there is no NUID to wait for

  function parityOf(digit) { return (digit % 2) ? "odd" : "even"; }
  function deviceArm() {
    var d = deviceId(), h = 0;
    for (var i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0;
    return parityOf(h);
  }
  function armSource() {
    if (nuid()) return "nuid";
    return armDevice ? "device" : null;
  }
  function arm() {
    var n = nuid();
    if (n) return parityOf(+n.charAt(8));
    return armDevice ? deviceArm() : null;
  }

  // <div data-arm="nuid-parity"> with [data-arm-version=room|pending|odd|even]
  // children: show the one this window should see (see the header comment).
  function applyArms() {
    var boxes = document.querySelectorAll('[data-arm="nuid-parity"]');
    [].forEach.call(boxes, function (box) {
      if (box.classList.contains("poll-number") ||
          box.classList.contains("poll-number-results")) return;
      var kids = box.querySelectorAll("[data-arm-version]");
      if (!kids.length) return;
      var show;
      // Receiver first: reveal's speaker-view frames (current AND upcoming) keep the
      // projector's ?presenter in their URL, so PROJECTOR alone would show them [room].
      if (SPEAKER || /[?&]receiver(&|$)/.test(Q) || qs.has("instructor"))
                                     { show = { odd: 1, even: 1 };  box.setAttribute("data-arm-view", "both"); }
      else if (PROJECTOR)            { show = { room: 1 };          box.setAttribute("data-arm-view", "room"); }
      else {
        var a = arm();
        show = {}; show[a || "pending"] = 1;
        box.setAttribute("data-arm-view", a ? "one" : "pending");
        if (a) { box.setAttribute("data-arm-assigned", a); box.setAttribute("data-arm-source", armSource()); }
        else   { box.removeAttribute("data-arm-assigned"); box.removeAttribute("data-arm-source"); }
      }
      [].forEach.call(kids, function (k) {
        var on = !!show[k.getAttribute("data-arm-version")];
        if (on) { k.removeAttribute("hidden"); k.style.display = ""; }
        else    { k.setAttribute("hidden", ""); k.style.display = "none"; }
      });
      [].forEach.call(box.querySelectorAll("[data-arm-checkin]"), function (b) {
        if (b.__ecArm) return;
        b.__ecArm = 1;
        b.addEventListener("click", function (e) {
          e.preventDefault(); e.stopPropagation();
          if (!CHECKIN) { armDevice = true; applyArms(); return; }
          modal(function (ok) { if (!ok) armDevice = true; applyArms(); });
        });
      });
    });
  }

  /* ---------- typed-number polls: one number per student ---------- */
  // Stored in poll_votes exactly like a choice vote (Poll.stamp), with the
  // number as the choice text: "12" plain, or "o:12" / "e:12" when the poll
  // splits the room by NUID parity ("o*:12" = parity of the device id, for a
  // student who skipped the check-in). One vote per device per poll per
  // session is the database's own unique index; a second send gets a 409.
  var numLocal = {};          // file:// only -- pollId -> rows, so a deck opened from disk still works
  var numCache = {};          // pollId -> last parsed data, for Poll.numberData()
  var probeP = null;          // the session_key probe, so reads wait for it

  function attr(el, k, d) { var v = el.getAttribute(k); return (v === null || v === "") ? d : v; }
  function numOpts(el) {
    return {
      min: +attr(el, "data-min", 0), max: +attr(el, "data-max", 1e9),
      unit: attr(el, "data-unit", ""), step: attr(el, "data-step", ""),
      arms: el.getAttribute("data-arm") === "nuid-parity"
    };
  }
  function fmtNum(x, dp) {
    if (x === null || x === undefined || !isFinite(x)) return "—";
    var s = (dp === undefined) ? String(Math.round(x * 100) / 100) : x.toFixed(dp);
    return s.replace(/^-/, "−");
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function mountNumber(el) {
    if (el.__ecNum) return;
    el.__ecNum = 1;
    var o = numOpts(el), pid = el.getAttribute("data-poll-id");
    var room = PROJECTOR || SPEAKER;
    el.innerHTML =
      '<div class="ec-num-row">' +
        '<input class="ec-num-in" type="text" inputmode="decimal" autocomplete="off" maxlength="9"' +
          ' placeholder="' + esc(attr(el, "data-placeholder", room ? "typed on phones" : "")) + '"' +
          (room ? " disabled" : "") + ">" +
        (o.unit ? '<span class="ec-num-unit">' + esc(o.unit) + "</span>" : "") +
        '<button class="ec-num-go" type="button"' + (room ? " disabled" : "") + ">Send</button>" +
      "</div>" +
      '<div class="ec-num-status"></div>';
    var input = el.querySelector(".ec-num-in"), btn = el.querySelector(".ec-num-go"),
        st = el.querySelector(".ec-num-status"), sent = false;
    // Reveal swallows keystrokes; without this a student typing "5" jumps slides.
    ["keydown", "keypress", "keyup"].forEach(function (ev) {
      input.addEventListener(ev, function (e) {
        if (ev === "keydown" && e.key === "Enter") { e.preventDefault(); go(); }
        e.stopPropagation();
      });
    });
    var key = "ec_num|" + pid + "|" + sessionKey();
    var prev = ls(key);
    function lock(on) { input.disabled = on || room; btn.disabled = on || room; }
    if (prev !== null && prev !== "") {
      sent = true; lock(true); input.value = prev;
      st.innerHTML = "In: <strong>" + esc(prev) + (o.unit ? " " + esc(o.unit) : "") + "</strong>. Thanks.";
    }
    function submit() {
      if (sent) return;
      var raw = String(input.value).replace(/[,\s]/g, "");
      var n = Number(raw);
      if (raw === "" || !isFinite(n) || n < o.min || n > o.max) {
        st.textContent = "Type one number from " + fmtNum(o.min) + " to " + fmtNum(o.max) +
                         (o.unit ? " " + o.unit : "") + ".";
        input.focus(); return;
      }
      if (o.step === "1") n = Math.round(n);
      var val = String(Math.round(n * 100) / 100);
      var choice = val;
      if (o.arms) {
        if (!nuid() && !armDevice) { armDevice = true; applyArms(); }   // ready() has run: no NUID = skipped
        choice = arm().charAt(0) + (nuid() ? "" : "*") + ":" + val;
      }
      sent = true; lock(true); input.blur();
      if (IS_FILE) {
        (numLocal[pid] = numLocal[pid] || []).push({ choice: choice, voter_id: deviceId(),
                                                      created_at: new Date().toISOString() });
        ls(key, val);
        st.textContent = "Recorded on this computer only (file://): " + val;
        refreshNumbers(pid); return;
      }
      st.textContent = "Sending…";
      sf("POST", "poll_votes", stamp(pid, choice)).then(function (r) {
        if (r.ok) {
          ls(key, val);
          st.innerHTML = "In: <strong>" + esc(val) + (o.unit ? " " + esc(o.unit) : "") + "</strong>. Thanks.";
          refreshNumbers(pid); return;
        }
        if (r.status === 409) { ls(key, val); st.textContent = "You already answered from this device."; return; }
        st.textContent = "Could not send — try once more."; sent = false; lock(false);
      }).catch(function () { st.textContent = "Could not reach the server."; sent = false; lock(false); });
    }
    function go() { if (sent || room) return; ready(pid, submit); }
    btn.addEventListener("click", go);
  }

  /* ----- statistics, all from the parsed votes; nothing is typed ----- */
  function sorted(a) { return a.slice().sort(function (x, y) { return x - y; }); }
  function median(a) {
    if (!a.length) return null;
    var s = sorted(a), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(a) { if (!a.length) return null; var t = 0; a.forEach(function (x) { t += x; }); return t / a.length; }
  function sd(a) {                                   // sample SD, n - 1, as ddof=1
    if (a.length < 2) return null;
    var m = mean(a), ss = 0; a.forEach(function (x) { ss += (x - m) * (x - m); });
    return Math.sqrt(ss / (a.length - 1));
  }
  function mad(a) {                                  // median |x - median|, unscaled (Topic 4)
    if (!a.length) return null;
    var md = median(a); return median(a.map(function (x) { return Math.abs(x - md); }));
  }
  function describe(a) { return { n: a.length, median: median(a), mad: mad(a), mean: mean(a), sd: sd(a) }; }

  // Student-t two-sided p from the regularised incomplete beta (Numerical Recipes 6.4).
  function lgamma(x) {
    var c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t);
    var s = 1.000000000190015;
    for (var j = 0; j < 6; j++) s += c[j] / ++y;
    return -t + Math.log(2.5066282746310005 * s / x);
  }
  function betacf(a, b, x) {
    var MAXIT = 300, EPS = 3e-16, FPMIN = 1e-300;
    var qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; var h = d;
    for (var m = 1; m <= MAXIT; m++) {
      var m2 = 2 * m, aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
      var del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function ibeta(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return (x < (a + 1) / (a + b + 2)) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  function tTwoSided(t, df) { return ibeta(df / (df + t * t), df / 2, 0.5); }

  // Welch's t (scipy.stats.ttest_ind(a, b, equal_var=False)) and Cohen's d with
  // the pooled SD weighted by n - 1, exactly as Lab 8 Steps 6 and 7. a minus b.
  function welch(a, b) {
    var A = describe(a), B = describe(b);
    var out = { a: A, b: B, diffMean: null, diffMedian: null, se: null, t: null, df: null, p: null, d: null, sp: null };
    if (A.n && B.n) { out.diffMean = A.mean - B.mean; out.diffMedian = A.median - B.median; }
    if (A.n < 2 || B.n < 2) return out;
    var va = A.sd * A.sd / A.n, vb = B.sd * B.sd / B.n;
    out.sp = Math.sqrt(((A.n - 1) * A.sd * A.sd + (B.n - 1) * B.sd * B.sd) / (A.n + B.n - 2));
    out.d = out.sp > 0 ? out.diffMean / out.sp : null;
    out.se = Math.sqrt(va + vb);
    if (!(out.se > 0)) return out;
    out.t = out.diffMean / out.se;
    out.df = (va + vb) * (va + vb) / (va * va / (A.n - 1) + vb * vb / (B.n - 1));
    out.p = tTwoSided(out.t, out.df);
    return out;
  }

  // rows -> {all, odd, even, device, dropped, from}. One row per voter_id, the first.
  var NUM_RE = /^\s*(?:([oe])(\*?):)?\s*(-?\d+(?:\.\d+)?)\s*$/;
  function parseNumberRows(rows, o) {
    var seen = {}, d = { all: [], odd: [], even: [], device: 0, dropped: 0 };
    (rows || []).forEach(function (r) {
      if (!r || seen[r.voter_id]) return;
      seen[r.voter_id] = 1;
      var m = NUM_RE.exec(String(r.choice));
      if (!m) { d.dropped++; return; }
      var v = +m[3];
      if (o && (v < o.min || v > o.max)) { d.dropped++; return; }
      d.all.push(v);
      if (m[1] === "o") d.odd.push(v);
      if (m[1] === "e") d.even.push(v);
      if (m[2]) d.device++;
    });
    return d;
  }

  // Today's rows for this poll. If today has none (a rehearsal, or a student
  // reading the deck after class), the latest meeting that has any, labelled.
  function fetchNumberRows(pid) {
    if (IS_FILE) return Promise.resolve({ rows: (numLocal[pid] || []).slice(), from: null });
    var base = "poll_votes?poll_id=eq." + encodeURIComponent(pid) + "&select=choice,voter_id,created_at";
    return (probeP || Promise.resolve()).then(function () {
      return sf("GET", base + q() + "&order=created_at.asc")
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (rows) {
          if (rows.length || !hasSessionKey) return { rows: rows, from: null };
          return sf("GET", base + ",session_key&order=created_at.asc")
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (all) {
              var keys = all.map(function (x) { return x.session_key; }).filter(Boolean).sort();
              var last = keys[keys.length - 1];
              return { rows: last ? all.filter(function (x) { return x.session_key === last; }) : [], from: last || null };
            });
        });
    });
  }

  function niceStep(span, target) {
    var raw = span / target, p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), best = p;
    [1, 2, 2.5, 5, 10].forEach(function (k) { if (Math.abs(k * p - raw) < Math.abs(best - raw)) best = k * p; });
    return best;
  }
  // Shared edges for every panel, so two arms are drawn on one scale.
  function binsFor(vals, ref) {
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (ref !== null && isFinite(ref)) { lo = Math.min(lo, ref); hi = Math.max(hi, ref); }
    var span = hi - lo; if (!(span > 0)) span = Math.max(1, Math.abs(hi) || 1);
    var ints = vals.every(function (v) { return v === Math.round(v); });
    var step = niceStep(span, 12), start = 0, k = 1;   // room data piles up near one end: fine bins
    if (ints && step < 1) step = 1;
    for (var g = 0; g < 30; g++) {                   // 15 bars at most
      start = Math.floor(lo / step) * step;
      k = Math.floor((hi - start) / step + 1e-9) + 1;
      if (k <= 15) break;
      step *= 2;
    }
    return { start: start, step: step, k: k };
  }
  function binOf(v, B) { return Math.min(B.k - 1, Math.max(0, Math.floor((v - B.start) / B.step + 1e-9))); }
  function maxCount(vals, B) {
    var c = {}, m = 0;
    vals.forEach(function (v) { var j = binOf(v, B); c[j] = (c[j] || 0) + 1; if (c[j] > m) m = c[j]; });
    return Math.max(1, m);
  }

  function histSVG(vals, B, ymax, colour, ref, refLabel, unit) {
    var W = 520, H = 200, L = 34, R = 10, T = 26, Bt = 34, pw = W - L - R, ph = H - T - Bt;
    var ct = []; for (var i = 0; i < B.k; i++) ct.push(0);
    vals.forEach(function (v) { ct[binOf(v, B)]++; });
    var x = function (v) { return L + (v - B.start) / (B.k * B.step) * pw; };
    var y = function (c) { return T + ph - c / ymax * ph; };
    var s = '<svg class="ec-num-svg" viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" aria-label="histogram">';
    for (i = 0; i < B.k; i++) {
      if (!ct[i]) continue;
      s += '<rect x="' + (x(B.start + i * B.step) + 1.5).toFixed(1) + '" y="' + y(ct[i]).toFixed(1) +
           '" width="' + (pw / B.k - 3).toFixed(1) + '" height="' + (T + ph - y(ct[i])).toFixed(1) +
           '" fill="' + colour + '" rx="2"/>' +
           '<text x="' + (x(B.start + (i + 0.5) * B.step)).toFixed(1) + '" y="' + (y(ct[i]) - 3).toFixed(1) +
           '" font-size="13" text-anchor="middle" fill="#3A3632" font-weight="700">' + ct[i] + "</text>";
    }
    s += '<line x1="' + L + '" y1="' + (T + ph) + '" x2="' + (W - R) + '" y2="' + (T + ph) + '" stroke="#8C8580"/>';
    var every = B.k > 8 ? 2 : 1;
    for (i = 0; i <= B.k; i += every) {
      s += '<text x="' + x(B.start + i * B.step).toFixed(1) + '" y="' + (T + ph + 17) +
           '" font-size="13" text-anchor="middle" fill="#6B6B6B">' + fmtNum(B.start + i * B.step) + "</text>";
    }
    if (unit) s += '<text x="' + (W - R) + '" y="' + (H - 2) + '" font-size="12" text-anchor="end" fill="#8C8580">' + esc(unit) + "</text>";
    var md = median(vals), mn = mean(vals);
    if (md !== null) s += '<line x1="' + x(md).toFixed(1) + '" y1="' + T + '" x2="' + x(md).toFixed(1) + '" y2="' + (T + ph) + '" stroke="#1F2A44" stroke-width="3"/>';
    if (mn !== null) s += '<line x1="' + x(mn).toFixed(1) + '" y1="' + T + '" x2="' + x(mn).toFixed(1) + '" y2="' + (T + ph) + '" stroke="#1F2A44" stroke-width="2" stroke-dasharray="5 4"/>';
    if (ref !== null && isFinite(ref)) {
      s += '<line x1="' + x(ref).toFixed(1) + '" y1="' + (T - 10) + '" x2="' + x(ref).toFixed(1) + '" y2="' + (T + ph) + '" stroke="#b4463c" stroke-width="2"/>';
      if (refLabel) s += '<text x="' + (x(ref) + 5).toFixed(1) + '" y="' + (T - 12) + '" font-size="13" fill="#b4463c">' + esc(refLabel) + "</text>";
    }
    return s + "</svg>";
  }

  function panelHTML(title, vals, B, ymax, colour, ref, refLabel, unit) {
    var D = describe(vals), u = unit ? " " + esc(unit) : "";
    return '<div class="ec-num-panel">' +
      (title ? '<div class="ec-num-title" style="color:' + colour + '">' + esc(title) + " &middot; n = " + D.n + "</div>" : "") +
      histSVG(vals, B, ymax, colour, ref, refLabel, unit) +
      '<div class="ec-num-head">median <b>' + fmtNum(D.median, 1) + "</b>" + u + " &middot; MAD <b>" + fmtNum(D.mad, 1) + "</b></div>" +
      '<div class="ec-num-sub">mean ' + fmtNum(D.mean, 1) + " &middot; SD " + fmtNum(D.sd, 1) +
        (title ? "" : " &middot; n = " + D.n) + "</div>" +
      "</div>";
  }

  var FILL = {
    "n": function (d) { return d.all.length; },
    "n.odd": function (d, w) { return w.a.n; },          "n.even": function (d, w) { return w.b.n; },
    "mean.odd": function (d, w) { return fmtNum(w.a.mean, 1); }, "mean.even": function (d, w) { return fmtNum(w.b.mean, 1); },
    "sd.odd": function (d, w) { return fmtNum(w.a.sd, 1); },     "sd.even": function (d, w) { return fmtNum(w.b.sd, 1); },
    "median.odd": function (d, w) { return fmtNum(w.a.median, 1); }, "median.even": function (d, w) { return fmtNum(w.b.median, 1); },
    "mad.odd": function (d, w) { return fmtNum(w.a.mad, 1); },   "mad.even": function (d, w) { return fmtNum(w.b.mad, 1); },
    "mean.all": function (d) { return fmtNum(mean(d.all), 1); },  "sd.all": function (d) { return fmtNum(sd(d.all), 1); },
    "median.all": function (d) { return fmtNum(median(d.all), 1); }, "mad.all": function (d) { return fmtNum(mad(d.all), 1); },
    "diff.mean": function (d, w) { return fmtNum(w.diffMean, 1); }, "diff.median": function (d, w) { return fmtNum(w.diffMedian, 1); },
    "welch.se": function (d, w) { return fmtNum(w.se, 2); },     "welch.t": function (d, w) { return fmtNum(w.t, 2); },
    "welch.df": function (d, w) { return fmtNum(w.df, 1); },
    "welch.p": function (d, w) { return w.p === null ? "—" : (w.p < 0.001 ? "< 0.001" : fmtNum(w.p, 3)); },
    "welch.decision": function (d, w) {
      return w.p === null ? "needs two votes in each group" :
             (w.p < 0.05 ? "p < 0.05: reject H₀ at α = 0.05" : "p ≥ 0.05: fail to reject H₀ at α = 0.05");
    },
    "cohen.sp": function (d, w) { return fmtNum(w.sp, 1); },     "cohen.d": function (d, w) { return fmtNum(w.d, 2); },
    "device": function (d) { return d.device; },               "dropped": function (d) { return d.dropped; }
  };

  function renderNumber(pid, d, from) {
    var w = welch(d.odd, d.even);
    numCache[pid] = { data: d, welch: w, from: from };
    [].forEach.call(document.querySelectorAll('.poll-number-results[data-poll-id="' + pid + '"]'), function (el) {
      var o = numOpts(el), ref = el.hasAttribute("data-ref") ? +el.getAttribute("data-ref") : null;
      var refLabel = attr(el, "data-ref-label", "");
      if (!d.all.length) {
        el.innerHTML = '<div class="ec-num-wait">' + esc(attr(el, "data-waiting", "Waiting for votes — this slide runs on the room’s own numbers.")) + "</div>";
        return;
      }
      var B = binsFor(d.all, ref), html;
      var note = (from ? "Votes from " + esc(from.slice(0, 10)) + " (none yet today). " : "") +
                 (d.dropped ? d.dropped + " outside " + fmtNum(o.min) + "–" + fmtNum(o.max) + " left out. " : "") +
                 (o.arms && d.device ? d.device + " placed by device (no check-in). " : "") +
                 (o.arms && d.all.length - d.odd.length - d.even.length ? (d.all.length - d.odd.length - d.even.length) + " without a group. " : "");
      if (o.arms) {
        var ymax = Math.max(maxCount(d.odd, B), maxCount(d.even, B));
        html = '<div class="ec-num-two">' +
          panelHTML(attr(el, "data-label-odd", "Odd NUID"), d.odd, B, ymax, attr(el, "data-colour-odd", "#C47B5A"), ref, refLabel, o.unit) +
          panelHTML(attr(el, "data-label-even", "Even NUID"), d.even, B, ymax, attr(el, "data-colour-even", "#6B8BA4"), ref, refLabel, o.unit) +
          "</div>" +
          '<div class="ec-num-diff">' + esc(attr(el, "data-label-odd", "Odd NUID")) + " minus " + esc(attr(el, "data-label-even", "Even NUID")) +
            ": medians <b>" + fmtNum(w.diffMedian, 1) + "</b>, means <b>" + fmtNum(w.diffMean, 1) + "</b>" +
            (o.unit ? " " + esc(o.unit) : "") + " &middot; n = " + w.a.n + " and " + w.b.n + "</div>";
      } else {
        html = panelHTML("", d.all, B, maxCount(d.all, B), attr(el, "data-colour", "#2F6F8F"), ref, refLabel, o.unit);
      }
      el.innerHTML = html + (note ? '<div class="ec-num-note">' + note + "</div>" : "") +
        '<div class="ec-num-key">solid line median &middot; dashed line mean</div>';
    });
    [].forEach.call(document.querySelectorAll('[data-poll-fill="' + pid + '"]'), function (el) {
      var f = FILL[el.getAttribute("data-key")];
      el.textContent = f ? f(d, w) : "?";
    });
    try { document.dispatchEvent(new CustomEvent("pollnumbers", { detail: { pollId: pid, data: d, welch: w, from: from } })); } catch (e) {}
  }

  function refreshNumbers(pid) {
    var el = document.querySelector('.poll-number-results[data-poll-id="' + pid + '"], .poll-number[data-poll-id="' + pid + '"]');
    var o = el ? numOpts(el) : null;
    return fetchNumberRows(pid).then(function (got) {
      renderNumber(pid, parseNumberRows(got.rows, o), got.from);
    }).catch(function () {});
  }

  function numberIdsWanted(all) {
    var out = [], scope = all ? document : currentSlide();
    if (!scope) return out;
    [].forEach.call(scope.querySelectorAll(".poll-number-results[data-poll-id], [data-poll-fill]"), function (e) {
      var id = e.getAttribute("data-poll-id") || e.getAttribute("data-poll-fill");
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }

  /* ----- choice tally: one bar per option of an A-D poll, drawn anywhere (e.g. a
     guess beside the test that answers it). data-choices="A=Higher|B=Lower|C=About the same" */
  function tallyIdsWanted(all) {
    var out = [], scope = all ? document : currentSlide();
    if (!scope) return out;
    [].forEach.call(scope.querySelectorAll(".poll-choice-tally[data-poll-id]"), function (e) {
      var id = e.getAttribute("data-poll-id");
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }
  function refreshTally(pid) {
    var els = document.querySelectorAll('.poll-choice-tally[data-poll-id="' + pid + '"]');
    if (!els.length) return Promise.resolve();
    var get = IS_FILE ? Promise.resolve([]) : (probeP || Promise.resolve()).then(function () {
      return sf("GET", "poll_votes?poll_id=eq." + encodeURIComponent(pid) + "&select=choice,voter_id" + q())
        .then(function (r) { return r.ok ? r.json() : []; });
    });
    return get.then(function (rows) {
      var seen = {}, ct = {}, n = 0;
      (rows || []).forEach(function (r) {
        if (seen[r.voter_id]) return; seen[r.voter_id] = 1; ct[r.choice] = (ct[r.choice] || 0) + 1; n++;
      });
      [].forEach.call(els, function (el) {
        var opts = attr(el, "data-choices", "A=A|B=B|C=C|D=D").split("|").map(function (x) {
          var i = x.indexOf("="); return [x.slice(0, i), x.slice(i + 1)];
        });
        var mx = Math.max.apply(null, [1].concat(opts.map(function (o) { return ct[o[0]] || 0; })));
        el.innerHTML = opts.map(function (o) {
          var c = ct[o[0]] || 0;
          return '<div class="ec-tally-row"><span class="ec-tally-lab">' + esc(o[1]) + '</span>' +
                 '<span class="ec-tally-track"><span class="ec-tally-bar" style="width:' + (c / mx * 100).toFixed(0) + '%"></span></span>' +
                 '<b class="ec-tally-c">' + c + "</b></div>";
        }).join("") + '<div class="ec-tally-n">' + n + (n === 1 ? " answer" : " answers") + "</div>";
      });
    }).catch(function () {});
  }

  function refreshWanted(all) {
    numberIdsWanted(all).forEach(refreshNumbers);
    tallyIdsWanted(all).forEach(refreshTally);
  }

  function bootNumbers() {
    [].forEach.call(document.querySelectorAll(".poll-number[data-poll-id]"), mountNumber);
    refreshWanted(true);                                  // every results slide drawn once at load
    setInterval(function () {
      if (document.hidden) return;
      // Only what is on screen. Students reuse a result for 20 s (the throttle
      // above); the projector and speaker view refresh every 5 s.
      refreshWanted(!window.Reveal);
    }, 5000);
    if (window.Reveal && Reveal.addEventListener) {
      Reveal.addEventListener("slidechanged", function () { refreshWanted(false); });
    }
  }

  /* ---------- styles ---------- */

  var css = document.createElement("style");
  css.textContent =
    "#ec-checkin{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.72);" +
      "display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif}" +
    ".ec-ci-card{background:#fff;border-radius:16px;padding:26px 30px;max-width:430px;width:90%;" +
      "box-shadow:0 20px 60px rgba(0,0,0,.35);text-align:center;color:#1f2937}" +
    ".ec-ci-card h3{margin:0 0 8px;font-size:22px;color:#1e3a8a}" +
    ".ec-ci-card p{margin:0 0 14px;font-size:14px;line-height:1.5;color:#4b5563}" +
    "#ec-ci-input{width:100%;box-sizing:border-box;font-size:26px;letter-spacing:5px;text-align:center;" +
      "padding:10px;border:2px solid #cbd5e1;border-radius:10px;font-family:ui-monospace,monospace}" +
    "#ec-ci-input:focus{outline:none;border-color:#2563eb}" +
    "#ec-ci-err{color:#dc2626;font-size:13px;min-height:18px;margin:6px 0}" +
    ".ec-ci-row{display:flex;gap:10px}" +
    ".ec-ci-row button{flex:1;padding:12px;font-size:16px;font-weight:700;border:0;" +
      "border-radius:10px;cursor:pointer}" +
    "#ec-ci-go{color:#fff;background:#2563eb;flex:2}" +
    "#ec-ci-cancel{color:#475569;background:#e2e8f0}" +
    "#ec-ci-cancel:hover{background:#cbd5e1}" +
    "#ec-ci-go:hover{background:#1d4ed8}" +
    ".ec-ci-skip{font-size:11.5px!important;color:#9ca3af!important;margin:12px 0 0!important}" +
    "#ec-chip{position:fixed;left:10px;bottom:10px;z-index:9998;background:rgba(30,58,138,.92);color:#fff;" +
      "font:600 11px/1 system-ui,sans-serif;padding:7px 10px;border-radius:999px;cursor:pointer;opacity:.75}" +
    "#ec-chip:hover{opacity:1}" +
    "#ec-chip em{font-style:normal;text-decoration:underline;opacity:.8}" +
    ".ec-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:99999;" +
      "background:rgba(17,24,39,.94);color:#fff;font:600 14px/1.3 system-ui,sans-serif;" +
      "padding:11px 18px;border-radius:10px}" +
    "#ec-pageno{position:fixed;top:8px;left:0;z-index:9997;" +
    "display:none;text-align:center;background:rgba(30,58,138,.93);color:#fff;" +
    "border-radius:14px;padding:7px 20px 8px;font-family:system-ui,sans-serif;" +
    "pointer-events:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)}" +
    "#ec-pageno b{display:block;font-size:27px;font-weight:700;line-height:1.05;" +
    "letter-spacing:.01em}" +
    "#ec-pageno i{display:block;font-style:normal;font-size:13px;font-weight:500;" +
    "opacity:.85;margin-top:3px}" +
    "#ec-pageno.compact i{display:none}" +
    "#ec-pageno.compact{padding:6px 14px 7px}" +
    "#ec-pageno kbd{font:inherit;font-weight:700;background:rgba(255,255,255,.22);" +
    "border-radius:4px;padding:0 5px}" +
    "#ec-spk{position:fixed;top:0;left:0;right:0;z-index:9998;display:none;gap:10px;" +
      "align-items:center;padding:7px 12px;background:#111827;color:#fff;" +
      "font:600 13px/1 system-ui,-apple-system,sans-serif}" +
    "#ec-spk-dot{width:11px;height:11px;border-radius:50%;background:#6b7280;flex:none}" +
    "#ec-spk-dot.green{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.25)}" +
    "#ec-spk-dot.amber{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.25)}" +
    "#ec-spk-dot.red{background:#ef4444}" +
    "#ec-spk-dot.grey{background:#9ca3af}" +
    "#ec-spk-count{color:#9ca3af;font-weight:500}" +
    "#ec-spk-grow{flex:1}" +
    "#ec-spk button{font:600 11px system-ui,sans-serif;padding:5px 10px;border:0;" +
      "border-radius:6px;cursor:pointer;background:#374151;color:#e5e7eb}" +
    "#ec-spk button:hover{background:#4b5563}" +
    "#ec-spk button.on{background:#f59e0b;color:#111827}" +
    ".ec-num-row{display:flex;align-items:center;justify-content:center;gap:12px}" +
    ".ec-num-in{width:6.5em;font:600 30px/1.1 system-ui,sans-serif;text-align:center;padding:10px 12px;" +
      "border:3px solid #cbd5e1;border-radius:10px;background:#fff;color:#1f2937}" +
    ".ec-num-in:focus{outline:none;border-color:#2563eb}" +
    ".ec-num-in:disabled{background:#f1f5f9;color:#475569}" +
    ".ec-num-unit{font:600 24px system-ui,sans-serif;color:#475569}" +
    ".ec-num-go{font:700 22px system-ui,sans-serif;padding:12px 26px;border:0;border-radius:10px;" +
      "background:#2563eb;color:#fff;cursor:pointer}" +
    ".ec-num-go:disabled{opacity:.5;cursor:default}" +
    ".ec-num-status{min-height:1.4em;margin-top:10px;text-align:center;font:500 16px system-ui,sans-serif;color:#374151}" +
    ".poll-number-results{font-family:system-ui,-apple-system,sans-serif}" +
    ".ec-num-two{display:grid;grid-template-columns:1fr 1fr;gap:22px}" +
    ".ec-num-title{font-size:15px;font-weight:700;margin-bottom:2px}" +
    ".ec-num-svg{display:block}" +
    ".ec-num-head{font-size:19px;color:#1f2937;margin-top:2px}" +
    ".ec-num-sub{font-size:14.5px;color:#6b6b6b;margin-top:2px}" +
    ".ec-num-diff{font-size:16px;color:#1f2937;margin-top:10px;text-align:center}" +
    ".ec-num-note{font-size:12.5px;color:#8C8580;margin-top:6px;text-align:center}" +
    ".ec-num-key{font-size:11.5px;color:#9ca3af;margin-top:2px;text-align:center}" +
    ".ec-num-wait{font-size:17px;color:#888;text-align:center;padding:40px 0}" +
    ".poll-choice-tally{font-family:system-ui,-apple-system,sans-serif}" +
    ".ec-tally-row{display:grid;grid-template-columns:auto 1fr 2em;align-items:center;gap:8px;margin:5px 0;font-size:15px;color:#1f2937}" +
    ".ec-tally-track{height:16px;background:#eef2f6;border-radius:4px;overflow:hidden}" +
    ".ec-tally-bar{display:block;height:100%;background:#5E8C61;border-radius:4px}" +
    ".ec-tally-c{text-align:right}" +
    ".ec-tally-n{font-size:12px;color:#8C8580;margin-top:2px}" +
    "[data-arm-view=both]>[data-arm-version]{outline:2px dashed #cbd5e1;outline-offset:4px;margin-bottom:10px}" +
    "[data-arm-view=both]>[data-arm-version=odd]::before{content:'ODD NUIDs see';display:block;font:700 11px system-ui,sans-serif;color:#b4463c;letter-spacing:.06em}" +
    "[data-arm-view=both]>[data-arm-version=even]::before{content:'EVEN NUIDs see';display:block;font:700 11px system-ui,sans-serif;color:#2F6F8F;letter-spacing:.06em}";
  document.head.appendChild(css);

  /* ---------- boot ---------- */

  window.Poll = {
    deviceId:   deviceId,
    nuid:       nuid,
    sessionKey: sessionKey,
    q:          q,
    stamp:      stamp,
    ready:      ready,
    isOpen:     isOpen,
    openPoll:   openPoll,
    openHere:   openHere,
    closeHere:  closeHere,
    closePoll:  closePoll,
    checkIn:    function () { if (CHECKIN) modal(null); },
    pollIdsHere: pollIdsOnCurrentSlide,
    toast:      toast,
    arm:        arm,
    armSource:  armSource,
    numberData: function (pid) { return numCache[pid] || null; },
    refreshNumbers: refreshNumbers,
    refreshTally: refreshTally,
    stats:      { describe: describe, welch: welch, parse: parseNumberRows, bins: binsFor, tTwoSided: tTwoSided }
  };

  function boot() {
    probeP = probeSessionKey();
    syncIdentity(nuid());
    paintChip();
    mountSpeakerBar();
    applyArms();
    bootNumbers();
    if (INSTRUCTOR) {
      document.addEventListener("keydown", function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var t = e.target, tag = t && t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
        // Reveal 5.1.0 binds, at least: n p space arrows home end f s b . o
        // Esc ? and the vim pair h j k l, plus "g" for jump-to-slide. The decks
        // add digits 1-9 (timer badges) and r (results). "t" is free.
        //
        // TWO earlier picks were wrong because the probe was wrong, not the
        // key: "o" silently also toggled overview, and "g" hijacked
        // jump-to-slide -- the way Ryan actually navigates. A probe that only
        // asks "did getIndices() change immediately" cannot see either: "g"
        // opens an input and waits for digits. Verify by asserting that focus
        // did NOT land on an INPUT and that a following "2","8",Enter does NOT
        // move the deck. "k" passes a naive probe too and is still Reveal's
        // "up" -- it only looks free on a slide with nothing above it.
        if (e.key !== "t" && e.key !== "T") return;

        // Scope the interception to slides that actually have a poll. On every
        // other slide the key is left entirely alone, so even a future
        // collision costs nothing on 72 of 73 slides.
        if (!pollIdsOnCurrentSlide().length) return;
        e.preventDefault();
        e.stopPropagation();
        toggleHere();
      });
    }
    // Everyone sees the mirrored page number, not just the instructor: the
    // projector is what the room reads, and a student on their own phone is
    // on their own slide and needs their own number.
    if (window.Reveal && Reveal.addEventListener) {
      // "slidetransitionend" matters as much as "slidechanged": the first paint
      // lands ~80ms in, while reveal is still animating the incoming slide, so
      // the glyph rectangles it measures are mid-flight and a position scored
      // clear can be covered once everything settles. Re-place when it stops.
      ["ready", "slidechanged", "slidetransitionend", "fragmentshown",
       "fragmenthidden", "overviewhidden"]
        .forEach(function (ev) { Reveal.addEventListener(ev, schedulePageNo); });
    }
    // same reason: bringing the window forward must repaint, because every
    // slide change that happened while it was hidden painted nothing.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { paintPageNo(); paintChip(); }
    });
    paintPageNo();

    if (PROJECTOR || SPEAKER) {
      if (window.Reveal && Reveal.addEventListener) {
        Reveal.addEventListener("slidechanged", function () {
          // only the projector drives the windows; speaker view just redraws
          if (PROJECTOR) onSlideChanged(); else paintSpeakerBar();
        });
      }
      if (PROJECTOR) onSlideChanged();
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else { boot(); }
})();
