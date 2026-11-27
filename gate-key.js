/* gate-key.js: the key that unlocks the Local AI gate on Sheamus's FX705.
 * Shared by tavernworks.dev/local-ai/chat/ and tavernworks.dev/rosin/, so a key entered on either page
 * works on both. It lives only in this browser (localStorage) and goes only to the gate, in an X-Gate-Key header.
 *
 *   GateKey.get() / .set(key) / .clear()
 *   GateKey.opts(fetchOptions)   adds the header when a key is saved
 *   GateKey.fetch(url, options)
 *
 * A link ending in #key=… (from the laptop, or a QR code) saves the key after asking, then drops it from the address bar.
 *
 *   GateKey.stream(gate, body, { signal, onLine })
 *     Asks the gate for a chat reply and calls onLine(text) for each NDJSON line. If the connection drops
 *     (a phone locking, the tab put to sleep, Wi-Fi blinking), it waits until the page is back and online and
 *     picks the reply up where it left off: the laptop keeps writing it meanwhile. Aborting the signal stops
 *     the reply on the laptop too. Throws Error("HTTP <status>: <message>") when the gate says no.
 */
(() => {
  const STORE = "tavernworks.gateKey";
  const VALID = /^[A-Za-z0-9_-]{16,128}$/;
  const get = () => { try { return localStorage.getItem(STORE) || ""; } catch { return ""; } };
  const set = (key) => {
    key = String(key || "").trim();
    try { if (key) localStorage.setItem(STORE, key); else localStorage.removeItem(STORE); } catch { return false; }
    window.dispatchEvent(new Event("gatekeychange"));
    return true;
  };
  const opts = (o = {}) => {
    const key = get();
    return key ? { ...o, headers: { ...(o.headers || {}), "X-Gate-Key": key } } : o;
  };
  let fromLink = false;
  const m = location.hash.match(/^#key=([^&]*)/);
  if (m) {
    history.replaceState(null, "", location.pathname + location.search);
    const key = decodeURIComponent(m[1]);
    if (!VALID.test(key)) alert("That link doesn't hold a laptop key.");
    else if (key === get() || confirm("Save the laptop key from this link on this device?\n\nOnly say yes to a link you made yourself on the FX705.")) { set(key); fromLink = true; }
  }
  // Another tab saved or cleared the key: let this page know too.
  window.addEventListener("storage", (e) => { if (e.key === STORE) window.dispatchEvent(new Event("gatekeychange")); });

  const sleep = (ms, signal) => new Promise((ok, no) => {
    const t = setTimeout(ok, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); no(new DOMException("Stopped", "AbortError")); }, { once: true });
  });
  // Resolves once the tab is showing and the device is online (straight away if it already is).
  const backInFront = (signal) => new Promise((ok, no) => {
    const ready = () => document.visibilityState === "visible" && navigator.onLine !== false;
    if (ready()) return ok();
    const check = () => { if (ready()) { off(); ok(); } };
    const off = () => { document.removeEventListener("visibilitychange", check); window.removeEventListener("online", check); };
    document.addEventListener("visibilitychange", check); window.addEventListener("online", check);
    signal?.addEventListener("abort", () => { off(); no(new DOMException("Stopped", "AbortError")); }, { once: true });
  });
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join("");
  async function httpError(res) {
    let detail = ""; try { detail = (await res.json()).error || ""; } catch {}
    return new Error(`HTTP ${res.status}${detail ? ": " + detail : ""}`);
  }

  async function stream(gate, body, { signal, onLine } = {}) {
    const id = newId();
    // An error from onLine (say, the reply itself carried an error) ends the stream; it isn't a dropped connection.
    const give = (line) => { try { onLine?.(line); } catch (err) { if (err && typeof err === "object") err.fromReply = true; throw err; } };
    let got = 0, first = true, tries = 0, firstError = null;
    const stopOnLaptop = () => { try { fetch(`${gate}/api/stop?id=${id}`, opts({ method: "POST", keepalive: true })).catch(() => {}); } catch {} };
    signal?.addEventListener("abort", stopOnLaptop, { once: true });
    try {
      for (;;) {
        let res;
        try {
          res = first
            ? await fetch(gate + "/api/chat", opts({ method: "POST", headers: { "Content-Type": "application/json", "X-Reply-Id": id }, body: JSON.stringify(body), signal }))
            : await fetch(`${gate}/api/reply?id=${id}&from=${got}`, opts({ signal, cache: "no-store" }));
        } catch (e) {
          if (signal?.aborted) throw e;
          if (first) { firstError = e; first = false; await backInFront(signal); continue; }   // maybe it got there: once back, ask for the reply to find out
          if (firstError) throw firstError;                          // the laptop isn't answering at all
          if (++tries > 40) throw e;
          await backInFront(signal); await sleep(Math.min(10000, 500 * 2 ** Math.min(tries, 5)), signal);
          continue;
        }
        if (!res.ok || !res.body) {
          if (!first && res.status === 404) throw got === 0 && firstError ? firstError : new Error("HTTP 404: The laptop lost that reply. Send it again.");
          throw await httpError(res);
        }
        first = false; firstError = null;
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (signal?.aborted) { reader.cancel().catch(() => {}); throw new DOMException("Stopped", "AbortError"); }
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
              if (line) { got++; give(line); }
            }
          }
          const rest = (buf + dec.decode()).trim();
          if (rest) { got++; give(rest); }
          return;                                   // the whole reply is in
        } catch (e) {
          if (signal?.aborted || e?.fromReply) throw e;
          if (++tries > 40) throw e;                // dropped partway: wait to be back, then pick it up
          await backInFront(signal); await sleep(Math.min(10000, 500 * 2 ** Math.min(tries, 5)), signal);
        }
      }
    } finally { signal?.removeEventListener("abort", stopOnLaptop); }
  }

  window.GateKey = { get, set, clear: () => set(""), opts, fetch: (url, o) => fetch(url, opts(o)), valid: (k) => VALID.test(String(k || "").trim()), fromLink, stream };
})();
