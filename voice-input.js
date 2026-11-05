// Voice typing for a textarea, shared by Wake in Verrowen and the Local AI
// chat. It uses the browser's own speech recognition (Chrome, Edge, Safari),
// so there's nothing to run on the laptop. When the browser can recognise
// speech on the device itself, it does; otherwise the browser's speech
// service hears the audio. Browsers without it (Firefox) get no mic button.
//
//   const voice = VoiceInput.attach(button, textarea, { onStatus(text, isError) {} });
//   voice.stop();   // e.g. when the message is sent
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const ERRORS = {
    "not-allowed": "The microphone is blocked. Allow it for this site in the browser's address bar, then try again.",
    "service-not-allowed": "This browser won't do voice typing here. Try Chrome, Edge or Safari.",
    "audio-capture": "No microphone was found.",
    "network": "The browser's speech service couldn't be reached. Check your connection.",
    "language-not-supported": "Voice typing doesn't support this browser's language.",
  };

  // Ask once per page whether speech can stay on this device (newer Chrome).
  let localCheck = null;
  function canRunLocally(lang) {
    if (!localCheck) {
      localCheck = (SR && typeof SR.available === "function")
        ? SR.available({ langs: [lang], processLocally: true }).then((s) => s === "available").catch(() => false)
        : Promise.resolve(false);
    }
    return localCheck;
  }

  function attach(button, textarea, opts) {
    opts = opts || {};
    const status = opts.onStatus || function () {};
    if (!SR) { button.hidden = true; return { stop() {}, supported: false }; }

    const lang = opts.lang || document.documentElement.lang || navigator.language || "en-US";
    let rec = null, on = false, before = "", after = "";
    const idleTitle = button.title || "Voice typing";

    function show(listening) {
      on = listening;
      button.classList.toggle("listening", listening);
      button.setAttribute("aria-pressed", String(listening));
      button.title = listening ? "Stop voice typing" : idleTitle;
    }

    function write(text) {
      const gap = before && text && !/\s$/.test(before) ? " " : "";
      const tail = after && text && !/^\s/.test(after) ? " " : "";
      textarea.value = before + gap + text + tail + after;
      const caret = (before + gap + text).length;
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    async function start() {
      if (on) return;
      show(true);
      before = textarea.value.slice(0, textarea.selectionStart);
      after = textarea.value.slice(textarea.selectionEnd);
      rec = new SR();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      const local = "processLocally" in rec && await canRunLocally(lang);
      if (!on) return;   // stopped while checking
      if (local) rec.processLocally = true;
      let finalText = "", failed = false;
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += t; else interim += t;
        }
        write((finalText + interim).replace(/\s+/g, " ").trim());
      };
      rec.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") return;
        failed = true;
        status(ERRORS[e.error] || "Voice typing stopped (" + e.error + ").", true);
      };
      rec.onend = () => { rec = null; show(false); if (!failed) status(""); textarea.focus(); };
      try {
        rec.start();
        status(local ? "Listening… (on this device)" : "Listening… (through your browser's speech service)");
      } catch (err) {
        rec = null; show(false);
        status("Voice typing couldn't start.", true);
      }
    }

    function stop() {
      if (rec) { try { rec.stop(); } catch (e) {} }
      else show(false);
    }

    button.hidden = false;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => { if (on) stop(); else start(); });
    return { stop, supported: true, get listening() { return on; } };
  }

  window.VoiceInput = { attach, supported: !!SR };
})();
