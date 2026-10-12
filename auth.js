/* Shared passphrase gate for the instructor pages on this site.
 *
 * One passphrase unlocks both /poll-admin/ and /class-console/. It is proved
 * by DECRYPTING a payload (PBKDF2-SHA256 -> AES-GCM), never by comparing a
 * stored hash: publishing an unsalted hash of a shared secret would hand an
 * attacker a cheap offline oracle for the passphrase that also protects the
 * attendance codes.
 *
 * The unlock is cached per browser under one origin-wide key, so unlocking
 * either page unlocks the other.
 */
window.CCGate = (function () {
  const KEY = "cc.pass";
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  async function decrypt(payload, pass) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey(
      "raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64(payload.salt),
        iterations: payload.iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64(payload.iv) }, key, b64(payload.ct));
    return JSON.parse(new TextDecoder().decode(clear));
  }

  // Ask Chrome's password manager to save it. Needs a real form with a
  // username field and autocomplete="current-password" -- autocomplete="off"
  // suppresses saving entirely, which is why the old gates were never offered.
  async function remember(pass) {
    store.set(KEY, pass);
    try {
      if (window.PasswordCredential && navigator.credentials) {
        await navigator.credentials.store(new PasswordCredential({
          id: "instructor", password: pass, name: "Instructor pages",
        }));
      }
    } catch (e) { /* user declined, or unsupported */ }
  }

  function mount({ payload, title, onUnlock }) {
    const host = document.createElement("div");
    host.id = "cc-gate";
    host.innerHTML = `
      <style>
        #cc-gate{position:fixed;inset:0;z-index:2147483000;display:none;
          align-items:center;justify-content:center;padding:24px;
          background:#faf7f2;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        @media(prefers-color-scheme:dark){#cc-gate{background:#16181d;color:#f2f0ec}}
        #cc-gate form{max-width:340px;width:100%;text-align:center}
        #cc-gate .t{font-weight:600;font-size:15px;margin-bottom:14px}
        #cc-gate input{width:100%;padding:10px;border:1px solid #d9d2c6;border-radius:8px;
          font-size:14px;background:#fff;color:#1b1b1f}
        #cc-gate input[name=username]{position:absolute;opacity:0;height:0;width:0;padding:0;border:0}
        #cc-gate button{width:100%;padding:10px;margin-top:10px;background:#7a1f2a;color:#fff;
          border:0;border-radius:8px;font:600 14px -apple-system,sans-serif;cursor:pointer}
        #cc-gate .m{color:#7a1f2a;font-size:13px;margin-top:10px;min-height:18px}
      </style>
      <form id="cc-form" method="post" action="#">
        <div class="t">${title}</div>
        <input type="text" name="username" autocomplete="username" value="instructor" readonly tabindex="-1">
        <input type="password" name="password" id="cc-pass" autocomplete="current-password"
               placeholder="Passphrase" required autofocus>
        <button type="submit">Unlock</button>
        <div class="m" id="cc-msg"></div>
      </form>`;
    document.body.appendChild(host);

    const msg = () => document.getElementById("cc-msg");
    const done = (data) => { host.remove(); onUnlock(data); };

    (async () => {
      const saved = (store.get(KEY) || "").trim();
      if (saved && window.crypto && crypto.subtle) {
        try { return done(await decrypt(payload, saved)); }
        catch (e) { store.del(KEY); }
      }
      host.style.display = "flex";
      document.getElementById("cc-pass").focus();
    })();

    document.getElementById("cc-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      // Trim: copying a passphrase out of a chat or doc often brings a
      // trailing space along, which is invisible and fails decryption.
      const v = document.getElementById("cc-pass").value.trim();
      if (!(window.crypto && crypto.subtle)) {
        msg().textContent = "This page needs https — open it at https://ryanpiao.github.io/econ-lectures/";
        return;
      }
      msg().textContent = "Checking…";
      let data;
      try {
        data = await decrypt(payload, v);
      } catch (err) {
        // AES-GCM reports a wrong key as OperationError. Anything else is a
        // browser problem, and saying "incorrect passphrase" would mislead.
        msg().textContent = err && err.name === "OperationError"
          ? "Incorrect passphrase."
          : "Could not unlock (" + (err && err.name) + ": " + (err && err.message) + ")";
        document.getElementById("cc-pass").select();
        return;
      }
      await remember(v);
      done(data);
    });
  }

  return { mount };
})();
