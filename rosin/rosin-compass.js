/* rosin-compass.js: Rosin's mood compass, on top of rosin-web.js (load it right after).
 *
 * - Mood over time: while "Mood follows the chat" is on, each conversation leaves a reading (Rosin's automatic mood
 *   and what it was about: gaming, streaming, work…). Kept on this device only, for 60 days.
 * - Insights: when you're usually liveliest or calmest, and which kinds of chats lift or lower the mood.
 * - Your schedule: the phone's own calendar in the Android app (it asks first), or a calendar's iCal link (read
 *   through the laptop's gate) or an .ics file anywhere. Works without one too.
 * - Suggestions: now and then, when you've been around and it's gone quiet, Rosin suggests what to do with the time
 *   (focused work, something creative, a break) from your energy and your next event, in its own voice.
 * - Heads-ups: a short reminder about 10 minutes before a calendar event.
 * Each part has its own switch under ⋯ → Compass. Nothing private is said in OBS or while Rosin answers Twitch chat.
 */
(() => {
  const B = window.RosinBrain, H = B && B._hooks, R = window.Rosin;
  if (!H || !R) return;
  const { store } = H;
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  // ---------- settings (this device only) ----------
  const C = {
    track: store.get("compass.track", true),
    suggest: store.get("compass.suggest", true),
    pace: store.get("compass.pace", "sometimes"),   // rarely: every 4 h at most, sometimes: every 2 h
    remind: store.get("compass.remind", true),
    things: store.get("compass.things", ""),
    calUrl: store.get("compass.calUrl", ""),
    calPhone: store.get("compass.calPhone", false),
  };
  const save = (k) => store.set("compass." + k, C[k]);
  const PACE = { rarely: 4 * HOUR, sometimes: 2 * HOUR };

  // ---------- mood over time ----------
  const ACTS = [
    ["gaming", /\b(games?|gaming|play(ing|ed)?|baldur'?s?|steam|xbox|ps5|nintendo|switch|boss|level(ing)?|ranked)\b/i],
    ["streaming", /\b(stream(ing|ed)?|twitch|obs|viewers?|raid|vod)\b/i],
    ["coding", /\b(cod(e|ing)|bugs?|deploy|repo|github|scripts?|bots?|apps?|server)\b/i],
    ["work", /\b(work(ing)?|job|shift|boss|meetings?|deadlines?|emails?|clients?|office)\b/i],
    ["music", /\b(music|songs?|guitar|playlist|album|band|beats?)\b/i],
    ["exercise", /\b(walk(ing)?|run(ning)?|jog(ging)?|gym|workout|hike|bike)\b/i],
    ["food", /\b(food|eat(ing)?|ate|cook(ing)?|dinner|lunch|breakfast|pizza|snacks?|munchies)\b/i],
    ["rest", /\b(sleep(ing)?|nap|tired|bed|rest(ing)?|chill(ing)?|relax(ing)?)\b/i],
    ["D&D", /(d&d|\bdnd\b|\bdungeons\b|\bcampaign\b|\bsession zero\b|\bdm\b|\bdice\b)/i],
    ["friends and family", /\b(friends?|mom|dad|family|brother|sister|kids?|hang(ing)? out|party)\b/i],
    ["shows and movies", /\b(movies?|shows?|episodes?|series|anime|netflix|youtube)\b/i],
    ["making things", /\b(draw(ing)?|art|paint(ing)?|writ(e|ing)|edit(ing)?|clips?|design(ing)?|crafts?)\b/i],
  ];
  let log = store.get("compass.log", []);   // [{ t, m, k: "gaming,streaming" }]
  const saveLog = () => { const cut = Date.now() - 60 * DAY; log = log.filter((e) => e.t >= cut).slice(-4000); store.set("compass.log", log); };
  let pending = null;   // what the latest conversation was about, until its reading is taken
  window.addEventListener("rosin-turn", (e) => {
    const text = String(e.detail?.text || "");
    const kinds = ACTS.filter(([, re]) => re.test(text)).map(([k]) => k);
    pending = { at: Date.now(), kinds: new Set([...(pending?.kinds || []), ...kinds]) };
  });
  function takeReading() {
    // Read after Rosin has answered, so the reading includes how the reply went.
    if (!pending || !C.track || !H.moodAuto() || H.busy() || Date.now() - pending.at < 4000) return;
    const now = Date.now(), m = Math.round(H.mood() * 100) / 100, kinds = [...pending.kinds];
    pending = null;
    const last = log[log.length - 1];
    if (last && now - last.t < 3 * MIN) {   // one reading per few minutes: a quick back-and-forth counts once
      last.m = Math.round(((last.m + m) / 2) * 100) / 100; last.t = now;
      last.k = [...new Set([...(last.k ? last.k.split(",") : []), ...kinds])].join(",");
    } else log.push({ t: now, m, k: kinds.join(",") });
    saveLog();
    if (!panel.hidden) draw();
  }

  const PARTS = ["morning", "afternoon", "evening", "late night"];
  const partOf = (t) => { const h = new Date(t).getHours(); return h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "late night"; };
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const avgOf = (list) => (list.length ? list.reduce((a, e) => a + e.m, 0) / list.length : NaN);
  function stats() {
    const all = log, overall = avgOf(all);
    const byPart = Object.fromEntries(PARTS.map((p) => { const l = all.filter((e) => partOf(e.t) === p); return [p, { n: l.length, avg: avgOf(l) }]; }));
    const byAct = {};
    for (const e of all) for (const k of (e.k ? e.k.split(",") : [])) (byAct[k] ||= []).push(e);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const l = all.filter((e) => dayKey(e.t) === dayKey(d.getTime()));
      days.push({ label: d.toLocaleDateString([], { weekday: "short" }), n: l.length, avg: avgOf(l) });
    }
    return { overall, byPart, byAct: Object.fromEntries(Object.entries(byAct).map(([k, l]) => [k, { n: l.length, avg: avgOf(l) }])), days, dayCount: new Set(all.map((e) => dayKey(e.t))).size };
  }
  const moodName = (m) => (m < 0.35 ? "calm" : m < 0.62 ? "easy-going" : "lively");
  function insights(st = stats()) {
    if (log.length < 8 || st.dayCount < 2) return [];
    const out = [];
    const parts = PARTS.filter((p) => st.byPart[p].n >= 3).sort((a, b) => st.byPart[b].avg - st.byPart[a].avg);
    if (parts.length >= 2 && st.byPart[parts[0]].avg - st.byPart[parts.at(-1)].avg >= 0.08)
      out.push(`You're usually liveliest in the ${parts[0]} and calmest in the ${parts.at(-1)}.`);
    const acts = Object.entries(st.byAct).filter(([, v]) => v.n >= 3).map(([k, v]) => [k, v.avg - st.overall]).sort((a, b) => b[1] - a[1]);
    if (acts.length && acts[0][1] >= 0.06) out.push(`Chats about ${acts[0][0]} tend to lift the mood.`);
    if (acts.length && acts.at(-1)[1] <= -0.06) out.push(`Chats about ${acts.at(-1)[0]} tend to bring it down a little.`);
    const recent = log.filter((e) => e.t > Date.now() - 3 * DAY), before = log.filter((e) => e.t <= Date.now() - 3 * DAY && e.t > Date.now() - 10 * DAY);
    if (recent.length >= 4 && before.length >= 4) {
      const d = avgOf(recent) - avgOf(before);
      if (Math.abs(d) >= 0.07) out.push(d > 0 ? "The last few days have been livelier than the week before." : "The last few days have been calmer than the week before.");
    }
    return out;
  }
  // How much go there is right now: the current mood, leaning on how this time of day usually goes.
  function energyNow() {
    const m = H.mood(), usual = stats().byPart[partOf(Date.now())];
    return usual.n >= 5 ? 0.6 * m + 0.4 * usual.avg : m;
  }
  const energyWord = (e) => (e < 0.4 ? "low" : e > 0.62 ? "high" : "steady");

  // ---------- the schedule ----------
  // Events: { title, start, end, allDay } in ms. From the phone's calendar (Android app), an iCal link, or an .ics file.
  let events = [], calNote = "";
  const PHONE = window.RosinCalendar;   // added by the Android app
  const icsText = { link: store.get("compass.calText", ""), linkAt: store.get("compass.calTextAt", 0), file: store.get("compass.calFile", "") };

  function unfold(text) { return String(text || "").replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, ""); }
  const unescape = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
  function tzOffset(t, tz) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
    const g = (k) => +p.find((x) => x.type === k).value;
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - t;
  }
  // Wall-clock time in a time zone (or this device's, or UTC) to ms.
  function wall(y, mo, d, h, mi, s, tz) {
    if (tz === "UTC") return Date.UTC(y, mo - 1, d, h, mi, s);
    if (tz) {
      try {
        const guess = Date.UTC(y, mo - 1, d, h, mi, s), off = tzOffset(guess, tz);
        let t = guess - off; const off2 = tzOffset(t, tz); if (off2 !== off) t = guess - off2;
        return t;
      } catch { /* a zone name the browser doesn't know (Outlook's "Eastern Standard Time"): use this device's */ }
    }
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  // "20261127T190000Z", "20261127T190000" (with TZID or floating) or "20261127" (all day).
  function parseWhen(v, params) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(String(v).trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    const allDay = !h || /VALUE=DATE(?!-)/i.test(params || "");
    const tz = z ? "UTC" : (/TZID=("?)([^";:]+)\1/i.exec(params || "") || [])[2];
    return { allDay, parts: [+y, +mo, +d, +(h || 0), +(mi || 0), +(s || 0)], tz: allDay ? "" : tz || "", ms: allDay ? new Date(+y, +mo - 1, +d).getTime() : wall(+y, +mo, +d, +(h || 0), +(mi || 0), +(s || 0), tz) };
  }
  function parseDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || "").trim());
    if (!m) return null;
    return (m[1] === "-" ? -1 : 1) * ((+m[2] || 0) * 7 * DAY + (+m[3] || 0) * DAY + (+m[4] || 0) * HOUR + (+m[5] || 0) * MIN + (+m[6] || 0) * 1000);
  }
  function parseICS(text) {
    const out = [];
    let cur = null;
    for (const line of unfold(text).split("\n")) {
      if (/^BEGIN:VEVENT/i.test(line)) { cur = { ex: [] }; continue; }
      if (/^END:VEVENT/i.test(line)) { if (cur && cur.start) out.push(cur); cur = null; continue; }
      if (!cur) continue;
      const i = line.indexOf(":"); if (i < 0) continue;
      const head = line.slice(0, i), value = line.slice(i + 1), name = head.split(";")[0].toUpperCase(), params = head.slice(name.length);
      if (name === "SUMMARY") cur.title = unescape(value).trim();
      else if (name === "DTSTART") cur.start = parseWhen(value, params);
      else if (name === "DTEND") cur.end = parseWhen(value, params);
      else if (name === "DURATION") cur.dur = parseDuration(value);
      else if (name === "RRULE") cur.rrule = Object.fromEntries(value.split(";").map((p) => p.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
      else if (name === "EXDATE") for (const v of value.split(",")) { const w = parseWhen(v, params); if (w) cur.ex.push(w.ms); }
      else if (name === "RECURRENCE-ID") cur.recId = parseWhen(value, params);
      else if (name === "UID") cur.uid = value.trim();
      else if (name === "STATUS") cur.cancelled = /CANCELLED/i.test(value);
    }
    return out;
  }
  const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  // Every start of a repeating event between from and to (the common rules: daily, weekly, monthly, yearly).
  function occurrences(ev, from, to) {
    const s = ev.start, r = ev.rrule;
    if (!r) return [s.ms];
    const [y0, mo0, d0, h, mi, sec] = s.parts, interval = Math.max(1, +r.INTERVAL || 1);
    const until = r.UNTIL ? parseWhen(r.UNTIL, "")?.ms ?? Infinity : Infinity, count = r.COUNT ? +r.COUNT : Infinity;
    const at = (y, mo, d) => (s.allDay ? new Date(y, mo - 1, d).getTime() : wall(y, mo, d, h, mi, sec, s.tz));
    const out = []; let n = 0;
    const take = (t) => { if (t < s.ms) return true; if (t > until || n >= count) return false; n++; if (t >= from && t <= to) out.push(t); return t <= to; };
    const byday = (r.BYDAY || "").split(",").filter(Boolean).map((x) => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(x); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2].toUpperCase()] } : null; }).filter(Boolean);
    const dim = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const wdOf = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const freq = String(r.FREQ || "").toUpperCase();
    for (let i = 0, guard = 0; guard < 20000; i += interval, guard++) {
      let days = [];
      if (freq === "DAILY") { const d = new Date(Date.UTC(y0, mo0 - 1, d0 + i)); days = [[d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]]; }
      else if (freq === "WEEKLY") {
        const monday = d0 - ((wdOf(y0, mo0, d0) + 6) % 7) + i * 7;
        const wds = byday.length ? byday.map((b) => b.wd) : [wdOf(y0, mo0, d0)];
        days = [...new Set(wds)].map((wd) => (wd + 6) % 7).sort((a, b) => a - b).map((off) => { const d = new Date(Date.UTC(y0, mo0 - 1, monday + off)); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; });
      } else if (freq === "MONTHLY") {
        const base = new Date(Date.UTC(y0, mo0 - 1 + i, 1)), y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, len = dim(y, mo);
        let ds = [];
        if (r.BYMONTHDAY) ds = r.BYMONTHDAY.split(",").map(Number).map((x) => (x < 0 ? len + 1 + x : x));
        else if (byday.length) for (const b of byday) {
          const all = []; for (let d = 1; d <= len; d++) if (wdOf(y, mo, d) === b.wd) all.push(d);
          if (b.n > 0) all[b.n - 1] && ds.push(all[b.n - 1]); else if (b.n < 0) all.at(b.n) && ds.push(all.at(b.n)); else ds.push(...all);
        } else ds = [d0];
        days = ds.filter((d) => d >= 1 && d <= len).sort((a, b) => a - b).map((d) => [y, mo, d]);
      } else if (freq === "YEARLY") { const y = y0 + i; if (d0 <= dim(y, mo0)) days = [[y, mo0, d0]]; }
      else return [s.ms];
      let more = true;
      for (const [y, mo, d] of days) { if (!take(at(y, mo, d))) { more = false; break; } }
      if (!more) break;
    }
    return out;
  }
  function expandICS(text, from, to) {
    const list = parseICS(text), moved = new Set(list.filter((e) => e.recId && e.uid).map((e) => e.uid + "@" + e.recId.ms)), out = [];
    for (const ev of list) {
      if (ev.cancelled) continue;
      const len = ev.end ? ev.end.ms - ev.start.ms : ev.dur ?? (ev.start.allDay ? DAY : 0);
      for (const t of occurrences(ev, from - Math.max(len, 0), to)) {
        if (ev.ex.includes(t) || (!ev.recId && ev.uid && moved.has(ev.uid + "@" + t))) continue;
        if (t + len < from) continue;
        out.push({ title: ev.title || "Busy", start: t, end: t + Math.max(len, 0), allDay: ev.start.allDay });
      }
    }
    return out;
  }
  function phoneEvents(from, to) {
    try {
      if (!C.calPhone || !PHONE || PHONE.status?.() !== "granted") return [];
      const raw = PHONE.events(from, to), list = typeof raw === "string" ? JSON.parse(raw) : raw;
      return (Array.isArray(list) ? list : []).map((e) => ({ title: String(e.title || "Busy"), start: +e.start, end: +e.end || +e.start, allDay: !!e.allDay })).filter((e) => e.start > 0);
    } catch { return []; }
  }
  function refreshEvents() {
    const from = Date.now() - DAY, to = Date.now() + 8 * DAY;
    const list = [...phoneEvents(from, to)];
    for (const t of [C.calUrl ? icsText.link : "", icsText.file]) if (t) { try { list.push(...expandICS(t, from, to)); } catch {} }
    const seen = new Set();
    events = list.filter((e) => { const k = e.title + "@" + e.start; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.start - b.start);
  }
  async function fetchLink(force) {
    if (!C.calUrl || (!force && Date.now() - icsText.linkAt < 30 * MIN)) return;
    const url = C.calUrl.trim().replace(/^webcal:/i, "https:");
    let text = "";
    try { const r = await fetch(url, { signal: H.timeout(15000), cache: "no-store" }); if (r.ok) text = await r.text(); } catch { /* most calendars don't let a page read them: ask the laptop */ }
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      try {
        const r = await fetch(H.GATE + "/api/ics?url=" + encodeURIComponent(url), H.gopts({ signal: H.timeout(25000) }));
        if (r.ok) text = await r.text();
        else { const j = await r.json().catch(() => ({})); calNote = r.status === 404 ? "The laptop's gate needs its update to read calendar links (steps: tavernworks.dev/local-ai/). An .ics file works now." : j.error || "Couldn't read that calendar link."; }
      } catch { calNote = "Couldn't reach the laptop to read the calendar link. I'll try again later."; }
    }
    if (/BEGIN:VCALENDAR/i.test(text)) {
      icsText.link = text.length < 1500000 ? text : ""; icsText.linkAt = Date.now(); calNote = "";
      store.set("compass.calText", icsText.link); store.set("compass.calTextAt", icsText.linkAt);
    }
    refreshEvents(); if (!panel.hidden) draw();
  }

  const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const whenOf = (t) => {
    const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / DAY);
    return (days === 0 ? "today" : days === 1 ? "tomorrow" : d.toLocaleDateString([], { weekday: "long" })) + " at " + timeOf(t);
  };
  const span = (ms) => { const m = Math.round(ms / MIN); return m < 60 ? `${m} minutes` : m < 120 ? "about an hour" + (m % 60 >= 20 ? " and a half" : "") : `about ${Math.round(m / 60)} hours`; };
  const cleanTitle = (t) => String(t).replace(/[\[\]{}<>()"]/g, "").replace(/\s+/g, " ").trim().slice(0, 70) || "something";
  const timed = () => events.filter((e) => !e.allDay);
  const nowEvent = (now) => timed().find((e) => e.start <= now && e.end > now);
  const nextEvent = (now) => timed().find((e) => e.start > now);

  // ---------- what Rosin says ----------
  const things = () => C.things.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 12);
  function suggestionCue() {
    const now = Date.now(), e = energyNow(), word = energyWord(e), h = new Date().getHours();
    if (nowEvent(now)) return "";   // they're in the middle of something
    const next = nextEvent(now), free = next && next.start - now < 18 * HOUR ? next.start - now : Infinity;
    if (free < 40 * MIN) return "";  // the heads-up covers it
    const late = h >= 23 || h < 6, usual = stats().byPart[partOf(now)];
    let idea;
    if (late) idea = "winding down: something restful, or getting some sleep if they're fading";
    else if (word === "high" && free >= 60 * MIN) idea = "using the energy for some focused work on something that matters to them";
    else if (word === "low") idea = "a proper break: a snack, some water, a stretch or a short walk";
    else idea = "something creative or a hobby they enjoy";
    const list = things();
    const pick = list.length ? list.sort(() => Math.random() - 0.5).slice(0, 3).map(cleanTitle) : [];
    return `Mood compass: it's ${timeOf(now)}. They seem to have ${word} energy right now` +
      (usual.n >= 5 ? ` (they're usually ${moodName(usual.avg)} in the ${partOf(now)})` : "") + ". " +
      (Number.isFinite(free) ? `Their next thing is "${cleanTitle(next.title)}" ${whenOf(next.start)}, so they have ${span(free)} free. ` : "Nothing's on their calendar for a while. ") +
      `Gently suggest ${idea}` + (pick.length ? `, maybe one of these: ${pick.join("; ")}` : "") +
      ". One or two short, friendly sentences, an idea and not an order. Don't read their schedule back to them.";
  }
  function insightCue() {
    const list = insights(); if (!list.length) return "";
    const one = list[Math.floor(Math.random() * list.length)];
    return `Mood compass: share one small thing you've noticed about their moods lately, in your own words: ${one} One or two warm sentences, no lecture, and no advice unless it's tiny.`;
  }
  function reminderCue(ev) {
    const mins = Math.max(1, Math.round((ev.start - Date.now()) / MIN));
    const isCoffee = (ev.title && ev.title.toLowerCase().includes("coffee")) || (mins < 30 && mins > 5);
    const message = isCoffee ? `their calendar has a "virtual coffee tray" brewing soon` : `their calendar has "${cleanTitle(ev.title)}"`;
    return `Mood compass: ${message} at ${timeOf(ev.start)}, in about ${mins} minutes. Give them a short, friendly heads-up in one sentence, maybe with a tiny tip to get ready.`;
  }
  let reminded = store.get("compass.reminded", {});
  let lastNudge = store.get("compass.lastNudge", 0), lastInsight = store.get("compass.lastInsight", 0);
  let speaking = false;
  async function say(cue, onCall) {
    if (!cue || speaking) return false;
    speaking = true;
    try { return await H.speakUp(cue, { onCall }); } finally { speaking = false; }
  }
  // Checks every 30 seconds. Reminders come first; suggestions only when someone's been around and it's gone quiet.
  async function check() {
    takeReading();
    if (speaking || !H.ready() || H.onAir()) return;
    const now = Date.now();
    if (C.remind) {
      refreshEvents();
      const ev = timed().find((e) => e.start - now <= 11 * MIN && e.start - now > 60000 && !reminded[e.title + "@" + e.start]);
      if (ev && !(H.busy() && !H.onCall())) {
        reminded[ev.title + "@" + ev.start] = now;
        for (const [k, t] of Object.entries(reminded)) if (now - t > 2 * DAY) delete reminded[k];
        store.set("compass.reminded", reminded);
        if (await say(reminderCue(ev), true)) return;
      }
    }
    if (!C.suggest || H.busy() || H.onCall()) return;
    const around = now - H.lastTurnAt() < 60 * MIN, quiet = H.quietFor() > 4 * MIN;
    if (!around || !quiet || now - lastNudge < (PACE[C.pace] || PACE.sometimes)) return;
    const insightDue = now - lastInsight > DAY && insights().length && Math.random() < 0.4;
    const cue = insightDue ? insightCue() : suggestionCue();
    lastNudge = now; store.set("compass.lastNudge", now);
    if (insightDue) { lastInsight = now; store.set("compass.lastInsight", now); }
    await say(cue, false);
  }
  H.tick(30000, check);
  H.tick(5 * MIN, () => { fetchLink(false); });
  fetchLink(false); refreshEvents();
  window.addEventListener("rosin-calendar", () => { refreshEvents(); draw(); });

  // ---------- the Compass panel (⋯ → Compass) ----------
  const panel = document.createElement("div"); panel.id = "compass"; panel.className = "tray"; panel.hidden = true;
  panel.setAttribute("aria-label", "Mood compass");
  document.getElementById("controls").insertBefore(panel, document.getElementById("say"));
  const btn = Object.assign(document.createElement("button"), { type: "button", id: "btn-compass", textContent: "Compass" });
  btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "compass");
  H.quick.append(btn);
  btn.addEventListener("click", () => {
    const open = panel.hidden; panel.hidden = !open; btn.setAttribute("aria-expanded", String(open));
    if (open) {
      for (const id of ["more", "changes"]) {   // one tray at a time keeps a phone screen usable
        const t = document.getElementById(id);
        if (t && !t.hidden) { t.hidden = true; document.querySelector(`[aria-controls="${id}"]`)?.setAttribute("aria-expanded", "false"); }
      }
      refreshEvents(); draw(); fetchLink(false);
    }
    H.fit();
  });

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const now = el("p", "cmp-now"), chart = el("div", "cmp-chart"), tips = el("ul", "cmp-tips"), soon = el("div", "cmp-soon");
  chart.setAttribute("role", "img");
  function bars(title, items) {
    const box = el("div", "cmp-bars"); box.append(el("b", "", title));
    const row = el("div", "cmp-row");
    for (const it of items) {
      const col = el("div", "cmp-col"), bar = el("i"), has = it.n > 0;
      bar.style.height = has ? `${Math.round(12 + it.avg * 88)}%` : "4%";
      if (!has) bar.className = "empty";
      col.title = has ? `${it.label}: ${moodName(it.avg)} (${it.n})` : `${it.label}: no chats`;
      col.append(bar, el("span", "", it.label));
      row.append(col);
    }
    box.append(row);
    return box;
  }
  function draw() {
    if (panel.hidden) return;
    const st = stats(), t = Date.now(), e = energyWord(energyNow()), next = nextEvent(t), cur = nowEvent(t);
    now.textContent = `Right now: ${e} energy` + (cur ? ` · in "${cleanTitle(cur.title)}" until ${timeOf(cur.end)}` : next && next.start - t < 18 * HOUR ? ` · free until "${cleanTitle(next.title)}" ${whenOf(next.start)}` : "");
    chart.replaceChildren(
      bars("Last 7 days", st.days),
      bars("Time of day", PARTS.map((p) => ({ label: p === "late night" ? "night" : p.slice(0, 3) === "aft" ? "aftn" : p.slice(0, 4), ...st.byPart[p] }))),
    );
    chart.setAttribute("aria-label", `Mood over the last 7 days: ${st.days.map((d) => d.n ? `${d.label} ${moodName(d.avg)}` : `${d.label} none`).join(", ")}`);
    const list = insights(st);
    tips.replaceChildren(...(list.length ? list : [!H.moodAuto() ? "Mood tracking pauses while you set the mood by hand. Tick \"Mood follows the chat\" to track it again." : log.length ? "Keep chatting: insights show up after a few days of readings." : "No readings yet. Chat with Rosin and they'll start showing up here."]).map((x) => el("li", "", x)));
    const up = events.filter((x) => x.end > t).slice(0, 4);
    soon.replaceChildren(el("b", "", "Coming up"), ...(up.length ? up.map((x) => el("div", "", `${cleanTitle(x.title)} · ${x.allDay ? new Date(x.start).toLocaleDateString([], { weekday: "short" }) + ", all day" : whenOf(x.start)}`))
      : [el("div", "cmp-dim", C.calPhone || C.calUrl || icsText.file ? "Nothing in the next week." : "No calendar added yet. Rosin works without one.")]));
    if (calNote) soon.append(el("div", "cmp-note", calNote));
    phoneBtn.textContent = !PHONE ? "" : C.calPhone && PHONE.status?.() === "granted" ? "Phone calendar: on (tap to turn off)" : "Use this phone's calendar";
    fileBtn.textContent = icsText.file ? "Remove calendar file" : "Add a calendar file (.ics)";
    paceSel.closest(".field").hidden = !C.suggest;
  }

  // Switches, each part on its own.
  const [trackChk, trackBox] = H.check("Track my mood over time");
  const [sugChk, sugBox] = H.check("Suggest what to do with my time");
  const [remChk, remBox] = H.check("Heads-up before calendar events");
  const paceSel = document.createElement("select");
  paceSel.append(new Option("Rarely (at most every 4 hours)", "rarely"), new Option("Sometimes (at most every 2 hours)", "sometimes"));
  const thingsIn = Object.assign(document.createElement("textarea"), { rows: 3, placeholder: "One per line, e.g. edit stream clips, guitar, D&D prep, a walk" });
  const urlIn = Object.assign(document.createElement("input"), { type: "url", placeholder: "Calendar link (iCal / webcal)", autocomplete: "off", spellcheck: false });
  const phoneBtn = Object.assign(document.createElement("button"), { type: "button" });
  const fileBtn = Object.assign(document.createElement("button"), { type: "button" });
  const fileIn = Object.assign(document.createElement("input"), { type: "file", accept: ".ics,text/calendar", hidden: true });
  const clearBtn = Object.assign(document.createElement("button"), { type: "button", textContent: "Clear mood history" });
  const closeBtn = Object.assign(document.createElement("button"), { type: "button", textContent: "Close", className: "cmp-close" });
  closeBtn.addEventListener("click", () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); H.fit(); btn.focus(); });
  const note = el("p", "cmp-dim", "All of this stays on this device. Rosin keeps your calendar and moods to itself in OBS and while it answers Twitch chat. For Google Calendar, paste its \"Secret address in iCal format\" (calendar settings) above.");
  phoneBtn.hidden = !PHONE;
  panel.append(now, chart, tips, soon, trackChk, sugChk, H.field("How often", paceSel), remChk, H.field("Things you like doing or want to get to", thingsIn),
    phoneBtn, H.field("Calendar link", urlIn), fileBtn, fileIn, note, clearBtn, closeBtn);
  trackBox.checked = C.track; sugBox.checked = C.suggest; remBox.checked = C.remind; paceSel.value = PACE[C.pace] ? C.pace : "sometimes";
  thingsIn.value = C.things; urlIn.value = C.calUrl;
  trackBox.addEventListener("change", () => { C.track = trackBox.checked; save("track"); });
  sugBox.addEventListener("change", () => { C.suggest = sugBox.checked; save("suggest"); draw(); H.fit(); });
  remBox.addEventListener("change", () => { C.remind = remBox.checked; save("remind"); });
  paceSel.addEventListener("change", () => { C.pace = paceSel.value; save("pace"); });
  thingsIn.addEventListener("change", () => { C.things = thingsIn.value.slice(0, 1500); save("things"); });
  urlIn.addEventListener("change", () => {
    C.calUrl = urlIn.value.trim(); save("calUrl"); icsText.link = ""; icsText.linkAt = 0; calNote = "";
    store.set("compass.calText", "");
    if (C.calUrl) { calNote = "Reading the calendar…"; draw(); fetchLink(true); } else { refreshEvents(); draw(); }
  });
  phoneBtn.addEventListener("click", () => {
    if (!PHONE) return;
    if (C.calPhone && PHONE.status?.() === "granted") { C.calPhone = false; save("calPhone"); refreshEvents(); draw(); return; }
    C.calPhone = true; save("calPhone");
    if (PHONE.status?.() !== "granted") PHONE.request?.();   // the app asks, then fires "rosin-calendar"
    refreshEvents(); draw();
  });
  fileBtn.addEventListener("click", () => {
    if (icsText.file) { icsText.file = ""; store.set("compass.calFile", ""); refreshEvents(); draw(); return; }
    fileIn.click();
  });
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0]; fileIn.value = "";
    if (!f) return;
    if (f.size > 1500000) { calNote = "That calendar file is too big for this device. A calendar link works for big calendars."; draw(); return; }
    const text = await f.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) { calNote = "That isn't a calendar (.ics) file."; draw(); return; }
    icsText.file = text; calNote = "";
    store.set("compass.calFile", text);
    if (store.get("compass.calFile", "") !== text) calNote = "This device ran out of room to keep that calendar, so it only lasts until the page closes.";
    refreshEvents(); draw();
  });
  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear Rosin's mood history on this device?")) return;
    log = []; saveLog(); draw();
  });

  B.compass = { check, stats, insights, energyNow, events: () => events.slice(), parseICS, expandICS, suggestionCue, insightCue, reminderCue, draw, settings: C };
})();
