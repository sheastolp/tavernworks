/* Runs at the very start of tavernworks.dev pages inside the Rosin Android app, before the page's own scripts.
 *
 * Android's WebView has no working speech-to-text or text-to-speech of its own, so this hands both to the
 * phone (RosinNative, added by MainActivity): window.webkitSpeechRecognition and window.speechSynthesis
 * become thin wrappers around Android's SpeechRecognizer and TextToSpeech. The page (rosin-web.js) uses
 * them exactly as it uses the browser's, so the site itself doesn't change.
 *
 * It also skips the "Tap to wake Rosin" screen (the app may play sound without a tap) and reports Rosin's
 * face, status and last reply to the app, which shows them on the home screen widget.
 */
(() => {
  const N = window.RosinNative;
  if (!N || window.__rosinNative) return;
  const handlers = new Map();
  let nextId = 1;
  let voices = [];

  function fire(target, type, extra) {
    const e = new Event(type);
    if (extra) for (const [k, v] of Object.entries(extra)) { try { Object.defineProperty(e, k, { value: v }); } catch {} }
    try { const f = target["on" + type]; if (typeof f === "function") f.call(target, e); } catch (err) { console.error(err); }
    target.dispatchEvent(e);
  }

  // Native code calls these through evaluateJavascript.
  window.__rosinNative = {
    ev(id, type, data) { const h = handlers.get(id); if (h) h(type, data); },
    voices(list) {
      voices = (list || []).map((v, i) => ({ name: v.name, lang: v.lang, voiceURI: v.name, localService: !!v.local, default: i === 0 }));
      fire(synth, "voiceschanged");
    },
    run(js) { try { return (0, eval)(js); } catch (e) { console.error(e); } },
  };

  // ---------- text to speech ----------
  class Utterance extends EventTarget {
    constructor(text) {
      super();
      this.text = text == null ? "" : String(text);
      this.lang = ""; this.voice = null; this.rate = 1; this.pitch = 1; this.volume = 1;
      this.onstart = this.onend = this.onerror = this.onboundary = this.onpause = this.onresume = this.onmark = null;
    }
  }
  const synth = new EventTarget();
  Object.assign(synth, {
    speaking: false, pending: false, paused: false, onvoiceschanged: null,
    getVoices() { return voices.slice(); },
    speak(u) {
      const id = nextId++;
      handlers.set(id, (type, data) => {
        if (type === "start") { synth.speaking = true; fire(u, "start"); }
        else if (type === "boundary") fire(u, "boundary", { charIndex: data || 0, name: "word" });
        else {
          handlers.delete(id); synth.speaking = false;
          if (type === "end") fire(u, "end"); else fire(u, "error", { error: data || "synthesis-failed" });
        }
      });
      const vol = u.volume == null ? 1 : Number(u.volume);
      N.speak(id, String(u.text || ""), Number(u.rate) || 1, Number(u.pitch) || 1, isNaN(vol) ? 1 : vol, u.voice ? String(u.voice.name) : "");
    },
    cancel() { N.cancel(); },
    pause() {}, resume() {},
  });
  try {
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true, writable: true });
    window.SpeechSynthesisUtterance = Utterance;
  } catch (e) { console.error(e); }

  // ---------- speech to text ----------
  if (N.hasRecognizer()) {
    class Recognition extends EventTarget {
      constructor() {
        super();
        this.lang = ""; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1;
        this.onstart = this.onresult = this.onerror = this.onend = this.onspeechend = this.onaudiostart = null;
        this._id = 0;
      }
      start() {
        if (this._id) throw new DOMException("Recognition has already started.", "InvalidStateError");
        const id = this._id = nextId++;
        const results = [];
        let index = 0;
        handlers.set(id, (type, data) => {
          if (type === "start") fire(this, "start");
          else if (type === "partial" || type === "final") {
            const r = [{ transcript: String(data || ""), confidence: 1 }];
            r.isFinal = type === "final";
            results[index] = r;
            fire(this, "result", { resultIndex: index, results });
            if (r.isFinal) index++;
          } else if (type === "error") fire(this, "error", { error: data || "aborted" });
          else if (type === "end") { handlers.delete(id); this._id = 0; fire(this, "end"); }
        });
        N.listen(id, this.lang || navigator.language || "en-US", !!this.interimResults);
      }
      stop() { if (this._id) N.stopListening(this._id); }
      abort() { if (this._id) N.abortListening(this._id); }
    }
    window.SpeechRecognition = window.webkitSpeechRecognition = Recognition;
  } else {
    window.SpeechRecognition = window.webkitSpeechRecognition = undefined;   // the page then uses the laptop's Whisper
  }

  // ---------- once the page is up: no wake screen, and tell the widget what Rosin is doing ----------
  document.addEventListener("DOMContentLoaded", () => {
    const wake = document.getElementById("wake");
    if (wake) { try { window.Rosin?.audio(); } catch {} wake.remove(); }
    document.documentElement.classList.add("in-app");

    const plain = (t) => String(t || "").replace(/\[[^\]]*\]/g, " ").replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
    let last = "";
    setInterval(() => {
      const R = window.Rosin;
      if (!R) return;
      let reply = "";
      try {
        const h = JSON.parse(localStorage.getItem("rosin.web.history") || "[]");
        for (let i = h.length - 1; i >= 0; i--) if (h[i].role === "assistant") { reply = plain(h[i].content); break; }
      } catch {}
      const send = document.getElementById("send");
      const state = {
        face: R.expression || "normal",
        status: (document.getElementById("status")?.textContent || "").trim(),
        subs: (document.getElementById("subs")?.textContent || "").trim(),
        reply: reply.slice(0, 400),
        thinking: !!document.getElementById("rosin")?.classList.contains("thinking"),
        busy: send?.dataset.stop === "true",
        listening: !!document.getElementById("mic")?.classList.contains("live"),
      };
      const s = JSON.stringify(state);
      if (s !== last) { last = s; N.state(s); }
    }, 600);
  });
})();
