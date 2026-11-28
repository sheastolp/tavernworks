/* rosin-spotify.js: Rosin and Spotify (load after rosin-web.js).
 *
 * Sign in once per device with Spotify (PKCE: the page never holds a client secret, and the sign-in stays in this
 * browser only). Then:
 *   - 🎵 Music under ⋯ opens the player: what's playing, play/pause, skip, back, shuffle, repeat, like, volume,
 *     which device plays it, search (songs, albums, playlists, artists) with Play and Add to queue, what's up next,
 *     your playlists and what you played lately.
 *   - Say it to Rosin: "pause", "skip", "what's playing", "play Blinding Lights by The Weeknd", "queue Hotel California",
 *     "play my chill playlist", "turn it down", "like this song" happen at once (no wait for the laptop). Anything
 *     looser ("put on something mellow") goes to Rosin, which has Spotify tools for it.
 *   - Play music in Rosin: the page becomes a Spotify device of its own (Spotify's Web Playback SDK), so the sound comes
 *     out of Rosin itself. That needs Spotify Premium and a browser with DRM (Chrome, Edge, Firefox, Safari, and the
 *     Android app). Rosin's music dips while Rosin talks. Where it can't run, Rosin still runs Spotify on your other devices.
 *
 * Never in OBS (the stream overlay doesn't play or show Spotify: music on stream risks DMCA strikes) and never for
 * Twitch chat. URL: ?spotify=0 switches it off on this page.
 */
(() => {
  const B = window.RosinBrain, H = B && B._hooks, R = window.Rosin;
  if (!H || !R) return;
  const OBS = !!R.OBS || document.body.classList.contains("obs") || /\bOBS\//.test(navigator.userAgent);
  if (OBS || R.params?.get("spotify") === "0") return;

  // The Spotify app's Client ID is not a secret (it's in every sign-in link). Put it here once the app exists, or
  // paste it under 🎵 Music on each device.
  const DEFAULT_CLIENT_ID = "";
  const ACCOUNTS = "https://accounts.spotify.com", API = "https://api.spotify.com/v1";
  const REDIRECT = location.origin + location.pathname.replace(/\/index\.html$/, "").replace(/\/?$/, "/");
  const SCOPES = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing", "streaming",
    "user-read-private", "user-read-email", "user-library-read", "user-library-modify", "playlist-read-private",
    "playlist-read-collaborative", "user-read-recently-played"];
  const SETUP_URL = "https://developer.spotify.com/dashboard";
  const store = H.store;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, label, cls) => { const b = el("button", cls, text); b.type = "button"; if (label) { b.setAttribute("aria-label", label); b.title = label; } return b; };
  const mmss = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const clientId = () => (store.get("spotify.clientId", "") || DEFAULT_CLIENT_ID).trim();

  // ---------- sign-in (PKCE) ----------
  let tok = store.get("spotify.token", null);   // { access, refresh, exp, scope }
  const connected = () => !!(tok && tok.refresh && clientId());
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const randomText = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a).slice(0, n); };

  async function signIn() {
    const id = clientId();
    if (!id) throw new Error("Paste your Spotify app's Client ID first.");
    if (!crypto.subtle) throw new Error("This page needs to be opened over https to sign in.");
    const verifier = randomText(64), state = randomText(24);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const back = new URL(location.href); for (const k of ["code", "state", "error"]) back.searchParams.delete(k);
    store.set("spotify.pending", { verifier, state, back: back.href, id, at: Date.now() });
    const u = new URL(ACCOUNTS + "/authorize");
    u.search = new URLSearchParams({ client_id: id, response_type: "code", redirect_uri: REDIRECT, code_challenge_method: "S256",
      code_challenge: challenge, state, scope: SCOPES.join(" ") }).toString();
    location.assign(u.href);
  }
  async function tokenCall(params) {
    const r = await fetch(ACCOUNTS + "/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(), cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error_description || j.error || "Spotify answered " + r.status); e.code = j.error; throw e; }
    return j;
  }
  const keep = (j, old) => {
    tok = { access: j.access_token, refresh: j.refresh_token || old?.refresh, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000, scope: j.scope || old?.scope || "" };
    store.set("spotify.token", tok);
  };
  // Back from Spotify's sign-in page: swap the code for tokens, then go back to the page as it was (the apps' ?app=… included).
  async function finishSignIn() {
    const q = new URLSearchParams(location.search), state = q.get("state");
    if (!state || (!q.get("code") && !q.get("error"))) return false;
    const p = store.get("spotify.pending", null);
    if (!p || p.state !== state) return false;
    store.set("spotify.pending", null);
    if (q.get("error")) { store.set("spotify.note", q.get("error") === "access_denied" ? "Spotify sign-in was cancelled." : "Spotify said: " + q.get("error")); location.replace(p.back); return true; }
    R.status("Finishing the Spotify sign-in…");
    try {
      keep(await tokenCall({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: REDIRECT, client_id: p.id, code_verifier: p.verifier }));
      store.set("spotify.note", "Spotify is connected.");
    } catch (e) { store.set("spotify.note", "Spotify sign-in didn't finish: " + e.message); }
    location.replace(p.back);
    return true;
  }
  let refreshing = null;
  async function accessToken() {
    if (!connected()) throw new Error("Spotify isn't connected on this device yet. Open 🎵 Music to connect it.");
    if (tok.access && Date.now() < tok.exp) return tok.access;
    refreshing ||= tokenCall({ grant_type: "refresh_token", refresh_token: tok.refresh, client_id: clientId() })
      .then((j) => { keep(j, tok); return tok.access; })
      .catch((e) => { if (e.code === "invalid_grant") signOut("Spotify signed this device out. Connect it again under 🎵 Music."); throw e; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  function signOut(note) {
    tok = null; store.set("spotify.token", null);
    try { player?.disconnect(); } catch {}
    player = null; rosinId = ""; sdk = { state: "off", note: "" };
    state = null; devices = []; me = null;
    setNote(note || "Disconnected. Rosin can't see your Spotify now.");
    drawAll();
  }

  // ---------- the Web API ----------
  class SpotifyError extends Error { constructor(msg, status, reason) { super(msg); this.status = status; this.reason = reason; } }
  async function api(method, path, { query, body, retried } = {}) {
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    const r = await fetch(url.href, { method, headers: { Authorization: "Bearer " + (await accessToken()), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    if (r.status === 401 && !retried) { tok.exp = 0; return api(method, path, { query, body, retried: true }); }
    if (r.status === 429 && !retried) { await new Promise((ok) => setTimeout(ok, Math.min(5, Number(r.headers.get("Retry-After")) || 1) * 1000)); return api(method, path, { query, body, retried: true }); }
    if (r.status === 204 || r.status === 202) return null;
    const text = await r.text(), j = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (!r.ok) {
      const reason = j?.error?.reason || "", m = j?.error?.message || "";
      const say = reason === "NO_ACTIVE_DEVICE" || /no active device/i.test(m) ? "No Spotify device is playing. Open Spotify on a device, or turn on Play music in Rosin."
        : reason === "PREMIUM_REQUIRED" ? "Spotify only lets apps control playback with Premium."
        : reason === "VOLUME_CONTROL_DISALLOW" ? "That device doesn't let apps change its volume."
        : r.status === 403 ? `Spotify said no${m ? ": " + m : ""}. If you just made the Spotify app, check its User Management has your account.`
        : m || "Spotify answered " + r.status;
      throw new SpotifyError(say, r.status, reason);
    }
    return j;
  }

  // ---------- what's playing, and where ----------
  let state = null, devices = [], me = null, stateAt = 0, queueNext = [], liked = null;
  async function refreshState() {
    if (!connected()) return null;
    try {
      state = await api("GET", "/me/player", { query: { additional_types: "episode" } }); stateAt = Date.now();
      liked = null;
      const uri = state?.item?.uri;
      if (uri && /^spotify:track:/.test(uri)) api("GET", "/me/library/contains", { query: { uris: uri } }).then((a) => { if (state?.item?.uri === uri && Array.isArray(a)) { liked = !!a[0]; drawNow(); } }).catch(() => {});
    } catch (e) { setNote(e.message); }
    drawNow();
    return state;
  }
  async function refreshDevices() {
    if (!connected()) return [];
    try { devices = (await api("GET", "/me/player/devices"))?.devices || []; } catch (e) { setNote(e.message); }
    drawDevices();
    return devices;
  }
  async function refreshQueue() {
    if (!connected()) return [];
    try { queueNext = ((await api("GET", "/me/player/queue"))?.queue || []).slice(0, 5); } catch { queueNext = []; }
    drawQueue();
    return queueNext;
  }
  const artistsOf = (it) => (it?.artists || []).map((a) => a.name).join(", ") || it?.show?.name || "";
  const describe = (it) => it ? `${it.name}${artistsOf(it) ? " by " + artistsOf(it) : ""}` : "";
  const progressNow = () => !state ? 0 : state.is_playing ? Math.min(state.item?.duration_ms || 0, (state.progress_ms || 0) + Date.now() - stateAt) : state.progress_ms || 0;
  const settle = (ms = 450) => new Promise((ok) => setTimeout(ok, ms));   // Spotify takes a moment before /me/player shows a change
  async function after(ms) { await settle(ms); await refreshState(); if (!music.hidden) refreshQueue(); }

  // Where a new song should play: the device the person named, else the one already playing, else Rosin itself, else any.
  async function pickDevice(where) {
    await refreshDevices();
    const want = String(where || "").toLowerCase().trim();
    if (/^(here|this|this device|rosin|in rosin|the app)$/.test(want)) { const id = await rosinDevice(); if (id) return id; throw new SpotifyError(sdkWhy() || "Rosin can't play music on this device."); }
    if (want) { const d = devices.find((x) => x.name.toLowerCase().includes(want) || x.type.toLowerCase() === want); if (d) return d.id; }
    const active = devices.find((d) => d.is_active);
    if (active) return active.id;
    const id = await rosinDevice(); if (id) return id;
    if (devices[0]) return devices[0].id;
    throw new SpotifyError("No Spotify device is on. Open Spotify on your phone or PC" + (inAppOn() ? ", or let Rosin play it once it's ready here." : ", or turn on Play music in Rosin under 🎵 Music."));
  }
  async function playOn(deviceId, body) {
    try { await api("PUT", "/me/player/play", { query: { device_id: deviceId }, body }); }
    catch (e) {   // a device that just woke up sometimes needs the music moved to it first
      if (e.status !== 404 && e.reason !== "NO_ACTIVE_DEVICE") throw e;
      await api("PUT", "/me/player", { body: { device_ids: [deviceId], play: false } }); await settle(600);
      await api("PUT", "/me/player/play", { query: { device_id: deviceId }, body });
    }
  }

  // ---------- doing things (the buttons, the quick commands and Rosin's tools all come through here) ----------
  const KINDS = { track: "track", song: "track", songs: "track", album: "album", albums: "album", playlist: "playlist", playlists: "playlist", artist: "artist", artists: "artist" };
  async function search(query, kind = "track", limit = 5) {
    kind = KINDS[kind] || "track";
    const j = await api("GET", "/search", { query: { q: query, type: kind, limit: Math.min(10, limit) } });
    return (j?.[kind + "s"]?.items || []).filter(Boolean).map((x) => ({
      kind, uri: x.uri, name: x.name, by: kind === "track" || kind === "album" ? artistsOf(x) : kind === "playlist" ? (x.owner?.display_name || "") : "",
      art: (x.album?.images || x.images || []).slice(-1)[0]?.url || "", ms: x.duration_ms || 0,
    }));
  }
  // "Blinding Lights by The Weeknd" searches as a song by that artist.
  function trackQuery(q) {
    const m = /^(.+?)\s+by\s+(.+)$/i.exec(q.trim());
    return m ? `track:${m[1].trim()} artist:${m[2].trim()}` : q.trim();
  }
  async function myPlaylist(name) {
    const want = name.toLowerCase().replace(/\bplaylist\b/g, "").trim();
    let all = [];
    for (let off = 0; off < 150; off += 50) {
      const j = await api("GET", "/me/playlists", { query: { limit: 50, offset: off } });
      all = all.concat((j?.items || []).filter(Boolean));
      if (!j?.next) break;
    }
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
    return all.find((p) => norm(p.name) === norm(want)) || all.find((p) => norm(p.name).includes(norm(want))) || all.find((p) => norm(want).includes(norm(p.name)) && norm(p.name).length > 2) || null;
  }
  async function find(query, kind) {
    kind = KINDS[kind] || "track";
    if (/^spotify:(track|album|playlist|artist|episode):/.test(query)) return { kind: query.split(":")[1], uri: query, name: "", by: "" };
    if (kind === "playlist") {
      const mine = await myPlaylist(query).catch(() => null);
      if (mine) return { kind, uri: mine.uri, name: mine.name, by: "your playlist" };
    }
    const hits = await search(kind === "track" ? trackQuery(query) : query, kind, 3);
    if (!hits.length && kind === "track" && /\bby\b/i.test(query)) return (await search(query.replace(/\bby\b/i, " "), kind, 3))[0] || null;
    return hits[0] || null;
  }
  const label = (hit) => hit.name ? `${hit.name}${hit.by ? (hit.kind === "playlist" ? ` (${hit.by})` : " by " + hit.by) : ""}` : "that";

  const act = {
    async play(query, kind, where) {
      if (!query) { await api("PUT", "/me/player/play", { query: { device_id: where ? await pickDevice(where) : undefined } }).catch(async (e) => { if (e.reason === "NO_ACTIVE_DEVICE" || e.status === 404) await playOn(await pickDevice(where), undefined); else throw e; }); after(); return "Playing."; }
      const hit = await find(query, kind);
      if (!hit) return `Spotify found nothing for "${query}".`;
      const dev = await pickDevice(where);
      await playOn(dev, hit.kind === "track" || hit.kind === "episode" ? { uris: [hit.uri] } : { context_uri: hit.uri });
      after(700);
      const d = devices.find((x) => x.id === dev);
      return `Playing ${label(hit)}${d && !d.is_active && d.id !== rosinId ? " on " + d.name : d && d.id === rosinId && devices.some((x) => x.is_active && x.id !== rosinId) ? " here in Rosin" : ""}.`;
    },
    async queue(query) {
      const hit = await find(query, "track");
      if (!hit) return `Spotify found nothing for "${query}".`;
      await api("POST", "/me/player/queue", { query: { uri: hit.uri } });
      after();
      return `Added ${label(hit)} to the queue.`;
    },
    async pause() { await api("PUT", "/me/player/pause"); after(); return "Paused."; },
    async resume() { return act.play("", "", ""); },
    async next() { await api("POST", "/me/player/next"); after(600); return "Skipped."; },
    async previous() { await api("POST", "/me/player/previous"); after(600); return "Back one."; },
    async restart() { await api("PUT", "/me/player/seek", { query: { position_ms: 0 } }); after(); return "From the top."; },
    async seek(sec) { await api("PUT", "/me/player/seek", { query: { position_ms: Math.max(0, Math.round(sec * 1000)) } }); after(); return `Jumped to ${mmss(sec * 1000)}.`; },
    async volume(v) {
      const cur = state?.device?.volume_percent ?? 50;
      const to = Math.max(0, Math.min(100, Math.round(typeof v === "string" ? (v === "up" ? cur + 15 : v === "down" ? cur - 15 : v === "mute" ? 0 : cur) : v)));
      if (state?.device?.id && state.device.id === rosinId && player) { await player.setVolume(to / 100); localVol = to / 100; }
      else await api("PUT", "/me/player/volume", { query: { volume_percent: to } });
      if (state?.device) state.device.volume_percent = to;
      drawNow();
      return to === 0 ? "Muted." : `Volume ${to}.`;
    },
    async shuffle(on) { await api("PUT", "/me/player/shuffle", { query: { state: !!on } }); after(); return on ? "Shuffle's on." : "Shuffle's off."; },
    async repeat(mode) { await api("PUT", "/me/player/repeat", { query: { state: mode } }); after(); return mode === "off" ? "Repeat's off." : mode === "track" ? "Repeating this song." : "Repeating this list."; },
    async like(on = true) {
      await refreshState();
      const it = state?.item; if (!it) return "Nothing's playing to like.";
      const body = { uris: [it.uri] };
      try { await api(on ? "PUT" : "DELETE", "/me/library", { body }); }
      catch (e) { if (e.status !== 400) throw e; await api(on ? "PUT" : "DELETE", "/me/library", { query: { uris: it.uri } }); }
      liked = on; drawNow();
      return on ? `Saved ${describe(it)} to your Liked Songs.` : `Took ${describe(it)} out of your Liked Songs.`;
    },
    async move(where) {
      const id = await pickDevice(where || "here");
      await api("PUT", "/me/player", { body: { device_ids: [id], play: true } });
      after(800);
      const d = devices.find((x) => x.id === id);
      return id === rosinId ? "Playing here in Rosin now." : `Moved it to ${d?.name || "that device"}.`;
    },
    async nowPlaying() {
      await refreshState();
      if (!state?.item) return "Nothing's playing on Spotify right now.";
      return `${state.is_playing ? "That's" : "Paused on"} ${describe(state.item)}${state.device?.name ? `, on ${state.device.id === rosinId ? "Rosin" : state.device.name}` : ""}.`;
    },
  };

  // ---------- quick commands: done at once, before Rosin thinks ----------
  const WORDS = "(?:the |my |this |that )?(?:music|song|track|tune|spotify|it|this|that)";
  function parse(raw) {
    let t = String(raw).toLowerCase().replace(/[“”"]/g, "").replace(/[.!?…]+$/g, "").replace(/\s+/g, " ").trim();
    t = t.replace(/^(?:hey |ok |okay |yo )?rosin[,:]?\s+/, "").replace(/^(?:please |can you |could you |would you |will you |go ahead and )+/, "").replace(/\s*(?:,?\s*please|,?\s*thanks|,?\s*rosin)$/, "").trim();
    let m;
    if (/^(?:pause|pause (?:the |my |this )?(?:music|song|track|spotify|it|this))$/.test(t)) return { a: "pause" };
    if (new RegExp(`^(?:stop|hold|kill|cut) ${WORDS}$`).test(t) || /^(?:stop|shh|quiet) (?:the )?(?:music|spotify)$/.test(t)) return { a: "pause" };
    if (/^(?:stop|hold on|hold up)$/.test(t)) return { a: "pause", onlyIfPlaying: true };
    if (/^(?:play|resume|unpause|un-pause)(?: (?:the |my )?(?:music|song|spotify|it|that))?(?: again| back)?$/.test(t) || /^(?:keep playing|continue|start) (?:the |my )?(?:music|song|spotify)$/.test(t)) return { a: "resume" };
    if (/^(?:skip|next)(?: (?:this|the|that))?(?: (?:song|track|one|it))?$/.test(t) || /^(?:play the )?next (?:song|track|one)$/.test(t) || /^(?:skip|next) (?:please|it)$/.test(t)) return { a: "next" };
    if (/^(?:previous|prev)(?: (?:song|track|one))?$/.test(t) || /^(?:go )?back (?:a|one|to the (?:last|previous)) (?:song|track)$/.test(t) || /^(?:play the )?(?:previous|last) (?:song|track|one)$/.test(t)) return { a: "previous" };
    if (/^(?:restart|replay|start over)(?: (?:the |this )?(?:song|track))?$/.test(t) || /^(?:play (?:it|this|that) )?from the (?:top|start|beginning)$/.test(t)) return { a: "restart" };
    if ((m = /^(?:set (?:the )?)?volume(?: (?:to|at))? (\d{1,3}) ?(?:%|percent)?$/.exec(t))) return { a: "volume", v: Number(m[1]) };
    if (/^(?:volume up|turn (?:it|the music|spotify|this|that) up|turn up (?:the )?(?:music|volume|spotify)|louder|crank it(?: up)?)$/.test(t)) return { a: "volume", v: "up" };
    if (/^(?:volume down|turn (?:it|the music|spotify|this|that) down|turn down (?:the )?(?:music|volume|spotify)|quieter|softer|lower (?:the )?(?:music|volume))$/.test(t)) return { a: "volume", v: "down" };
    if (/^mute (?:the )?(?:music|spotify|song)$/.test(t)) return { a: "volume", v: "mute" };
    if ((m = /^(?:turn |put |switch )?shuffle (on|off)$/.exec(t) || /^(?:turn|switch) (on|off) shuffle$/.exec(t))) return { a: "shuffle", on: m[1] === "on" };
    if (/^shuffle(?: (?:it|this|the music|my music|the playlist|this playlist))?$/.test(t)) return { a: "shuffle", on: true };
    if (/^(?:repeat|loop) (?:this|the|this one|it)(?: song| track| one)?$/.test(t)) return { a: "repeat", mode: "track" };
    if ((m = /^(?:turn |switch )?(?:repeat|loop)(?:ing)? (off|on)$/.exec(t) || /^(?:turn|switch) (off|on) (?:repeat|loop)$/.exec(t))) return { a: "repeat", mode: m[1] === "on" ? "context" : "off" };
    if (/^(?:what'?s|what is|whats) (?:playing|this song|this track|the song|this|on|that song)(?: called| right now| now)?$/.test(t) || /^what (?:song|track) is (?:this|playing|that|on)$/.test(t) || /^(?:who (?:sings|is singing|'?s singing|made) (?:this|that))$/.test(t) || /^(?:name (?:of )?(?:this|the) song)$/.test(t)) return { a: "nowPlaying" };
    if (/^(?:like|save|heart|love)(?: (?:this|the|that))? (?:song|track|one)(?: to my (?:library|liked songs))?$/.test(t) || /^add (?:this|the|that) (?:song|track) to (?:my )?(?:library|liked songs|likes)$/.test(t)) return { a: "like", on: true };
    if (/^(?:unlike|unsave|unheart|remove (?:this|the) (?:song|track) from (?:my )?(?:library|liked songs))(?: (?:this|the|that) (?:song|track))?$/.test(t)) return { a: "like", on: false };
    if (/^(?:play|move|switch|put|send) (?:it|the music|spotify|music|this) (?:here|on this(?: device)?|in rosin|on rosin|to rosin|to this(?: device)?)$/.test(t) || /^play (?:here|in rosin|on rosin)$/.test(t)) return { a: "move", where: "here" };
    if ((m = /^(?:move|switch|send|put|play) (?:it|the music|spotify|music|this) (?:to|on|over to) (?:my )?(.{2,40})$/.exec(t))) return { a: "move", where: m[1] };
    if ((m = /^(?:queue|queue up)\s+(.{2,120})$/.exec(t) || /^add (.{2,120}?) to (?:the |my )?(?:queue|up next)$/.exec(t) || /^play (.{2,120}?) (?:next|after this(?: one| song)?)$/.exec(t))) return { a: "queue", q: m[1] };
    // "play …" only when it's plainly music; the rest ("play a game") goes to Rosin.
    if ((m = /^(?:play|put on|throw on) (?:the |my )?(?:song|track) (.{2,120})$/.exec(t))) return { a: "play", q: m[1], kind: "track" };
    if ((m = /^(?:play|put on|throw on) (?:the )?album (.{2,120})$/.exec(t))) return { a: "play", q: m[1], kind: "album" };
    if ((m = /^(?:play|put on|throw on) (?:the |my )?playlist (.{2,120})$/.exec(t) || /^(?:play|put on|throw on) (?:my |the )?(.{2,80}?) playlist$/.exec(t))) return { a: "play", q: m[1], kind: "playlist" };
    if ((m = /^(?:play|put on|throw on) (.{2,120}?) on spotify$/.exec(t))) return { a: "play", q: m[1], kind: "track" };
    if ((m = /^(?:play|put on|throw on) (?!a |an |with |me |us |along|around|nice|dead|it |some music$)(.{2,80}? by .{2,60})$/.exec(t))) return { a: "play", q: m[1], kind: "track" };
    if ((m = /^(?:play|put on|throw on) (?:some|more) (?!music$|songs$|tunes$)(.{2,60})$/.exec(t))) return { a: "playSome", q: m[1] };
    return null;
  }
  async function playSome(q) {   // "play some Drake": the artist if Spotify knows one by that name, else a playlist for it
    const a = (await search(q, "artist", 1))[0];
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (a && norm(a.name) === norm(q)) return act.play(a.uri, "artist");
    return act.play(q, "playlist");
  }
  const FACE = { pause: "neutral", resume: "happy", next: "happy", previous: "happy", restart: "happy", volume: "neutral", shuffle: "happy", repeat: "happy", nowPlaying: "happy", like: "happy", move: "happy", queue: "happy", play: "happy", playSome: "happy" };
  H.instant?.push(async (text) => {
    const c = parse(text);
    if (!c) return null;
    if (!connected()) {
      if (c.onlyIfPlaying || c.a === "play" || c.a === "playSome" || c.a === "move") return null;   // could be about anything else; Rosin answers
      return { reply: "[confused] Spotify isn't connected on this device yet. Open 🎵 Music under ⋯ to connect it.", bad: true };
    }
    if (c.onlyIfPlaying) { await refreshState(); if (!state?.is_playing) return null; }
    R.status("Spotify…");
    let line;
    try {
      line = c.a === "volume" ? await act.volume(c.v) : c.a === "shuffle" ? await act.shuffle(c.on) : c.a === "repeat" ? await act.repeat(c.mode)
        : c.a === "like" ? await act.like(c.on) : c.a === "move" ? await act.move(c.where) : c.a === "queue" ? await act.queue(c.q)
        : c.a === "play" ? await act.play(c.q, c.kind) : c.a === "playSome" ? await playSome(c.q) : await act[c.a]();
    } catch (e) { return { reply: "[confused] " + e.message, bad: true }; }
    setNote("");
    return { reply: `[${FACE[c.a] || "happy"}] ${line}`, status: "♪ " + line };
  });

  // ---------- Rosin's tools, for anything the quick commands don't catch ----------
  const fn = (name, description, properties, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
  const str = (description, extra) => ({ type: "string", description, ...extra });
  const KIND = str("What to look for", { enum: ["track", "album", "playlist", "artist"] });
  const live = () => connected() && !H.noTools();
  const tools = [
    { on: live, def: fn("spotify_play", "Play music on Sheamus's Spotify right now. Give what to play (words to search, or a spotify: uri from spotify_search) and what kind it is. With no query it just resumes. kind playlist looks in his own playlists first.",
        { query: str("Song, album, playlist or artist to play, e.g. 'Blinding Lights by The Weeknd' or 'lofi chill'"), kind: KIND, device: str("Only if he named one: a device name, or 'here' for this Rosin") }),
      run: (a) => act.play(String(a.query || "").trim(), a.kind || "track", a.device) },
    { on: live, def: fn("spotify_queue", "Add a song to the end of Sheamus's Spotify queue (up next).", { query: str("The song, e.g. 'Hotel California by Eagles', or a spotify:track: uri") }, ["query"]),
      run: (a) => act.queue(String(a.query || "").trim()) },
    { on: live, def: fn("spotify_control", "Control Spotify: pause, resume, next, previous, restart the song, shuffle, repeat, like or unlike the current song, set the volume or jump to a time.",
        { action: str("What to do", { enum: ["pause", "resume", "next", "previous", "restart", "shuffle_on", "shuffle_off", "repeat_off", "repeat_song", "repeat_list", "like", "unlike", "volume", "seek"] }),
          volume: { type: "number", description: "0 to 100, for action volume" }, seconds: { type: "number", description: "Where to jump to, for action seek" } }, ["action"]),
      run: (a) => {
        const x = String(a.action || "");
        if (x === "volume") return act.volume(Number(a.volume ?? 50));
        if (x === "seek") return act.seek(Number(a.seconds || 0));
        if (x.startsWith("shuffle")) return act.shuffle(x === "shuffle_on");
        if (x.startsWith("repeat")) return act.repeat(x === "repeat_song" ? "track" : x === "repeat_list" ? "context" : "off");
        if (x === "like" || x === "unlike") return act.like(x === "like");
        if (act[x]) return act[x]();
        return "Error: unknown action " + x;
      } },
    { on: live, def: fn("spotify_search", "Search Spotify without playing anything, to pick or suggest music. Returns names and spotify: uris.", { query: str("Words to search"), kind: KIND }, ["query"]),
      run: async (a) => { const r = await search(String(a.query || ""), a.kind || "track", 6); return r.length ? r.map((h, i) => `${i + 1}. ${label(h)} (${h.uri})`).join("\n") : "Nothing found."; } },
    { on: live, def: fn("spotify_status", "What's playing on Sheamus's Spotify, on which device, what's up next in the queue, his devices and playlists, or what he played lately.",
        { include: str("What to include", { enum: ["now", "queue", "devices", "playlists", "recent"] }) }),
      run: async (a) => {
        const what = a.include || "now";
        if (what === "queue") { const q = await refreshQueue(); return q.length ? "Up next:\n" + q.map((x, i) => `${i + 1}. ${describe(x)}`).join("\n") : "Nothing queued."; }
        if (what === "devices") { const d = await refreshDevices(); return d.length ? d.map((x) => `${x.name} (${x.type})${x.is_active ? ", playing" : ""}${x.id === rosinId ? ", this is Rosin" : ""}`).join("\n") : "No Spotify devices are on right now."; }
        if (what === "playlists") { const j = await api("GET", "/me/playlists", { query: { limit: 30 } }); return (j?.items || []).filter(Boolean).map((p) => `${p.name} (${p.uri})`).join("\n") || "No playlists."; }
        if (what === "recent") { const j = await api("GET", "/me/player/recently-played", { query: { limit: 10 } }); return (j?.items || []).map((x) => describe(x.track)).join("\n") || "Nothing played lately."; }
        const s = await refreshState();
        return s?.item ? `${s.is_playing ? "Playing" : "Paused"}: ${describe(s.item)} (${mmss(progressNow())} of ${mmss(s.item.duration_ms)}) on ${s.device?.id === rosinId ? "Rosin" : s.device?.name || "a device"}, volume ${s.device?.volume_percent ?? "?"}, shuffle ${s.shuffle_state ? "on" : "off"}, repeat ${s.repeat_state}.` : "Nothing is playing on Spotify right now.";
      } },
    { on: live, def: fn("spotify_device", "Move Spotify playback to another of Sheamus's devices, or to 'here' (Rosin itself).", { device: str("Device name, or 'here'") }, ["device"]),
      run: (a) => act.move(String(a.device || "here")) },
  ];
  H.extraTools.push(...tools);
  // When he talks about music, Rosin gets what's playing first, so it never guesses.
  const MUSICY = /\b(spotify|music|song|songs|track|playlist|album|playing|tune|tunes|vibe|queue|dj)\b/i;
  H.extraContext?.push(async (text) => {
    if (!MUSICY.test(text)) return "";
    if (!connected()) return "[App: Spotify, NOT connected on this device]\nIf he wants music, tell him to open 🎵 Music under ⋯ and connect Spotify. Don't pretend to play anything.";
    try {
      const s = await refreshState();
      return `[App: Spotify, checked just now]\n${s?.item ? `${s.is_playing ? "Playing" : "Paused"}: ${describe(s.item)} on ${s.device?.id === rosinId ? "Rosin" : s.device?.name || "a device"}.` : "Nothing is playing."}`;
    } catch (e) { return `[App: Spotify]\nCouldn't check Spotify (${e.message}).`; }
  });
  H.extraPrompt.push(() => connected() && !H.noTools() ? "You can run Sheamus's Spotify with the spotify_ tools: play, queue, pause, skip, volume, shuffle, like, move it between devices. Use them when he asks for music; pick the kind (track, album, playlist, artist) that fits. Only say something is playing or queued when a tool result says so, and say the song's name back in a few words." : "");

  // ---------- playing inside Rosin (Spotify's Web Playback SDK) ----------
  let player = null, rosinId = "", sdk = { state: "off", note: "" }, localVol = store.get("spotify.vol", 0.7), ducked = false;
  const inAppOn = () => store.get("spotify.inApp", true) && !document.documentElement.classList.contains("buddy");
  const sdkWhy = () => sdk.state === "error" ? sdk.note : sdk.state === "loading" ? "Rosin's player is still starting." : !inAppOn() ? "Play music in Rosin is off." : "";
  const DEVICE_LABEL = { "android-app": "Android", "android-widget": "Android", phone: "phone", tablet: "tablet", "windows-app": "Windows", handheld: "handheld", desktop: "PC" };
  const playerName = () => `Rosin (${(B.settings?.deviceName || "").trim() || DEVICE_LABEL[H.device?.()] || "browser"})`;
  function startPlayer() {
    if (player || sdk.state === "loading" || !connected() || !inAppOn()) return;
    if (!window.isSecureContext || !navigator.requestMediaKeySystemAccess) { sdk = { state: "error", note: "This browser can't play Spotify (it has no DRM support). Rosin still runs Spotify on your other devices." }; drawNow(); return; }
    sdk = { state: "loading", note: "" }; drawNow();
    const boot = () => {
      try {
        player = new window.Spotify.Player({ name: playerName(), volume: localVol, getOAuthToken: (cb) => accessToken().then(cb).catch(() => {}) });
      } catch (e) { sdk = { state: "error", note: "Rosin's player didn't start: " + e.message }; drawNow(); return; }
      const fail = (why) => ({ message }) => { sdk = { state: "error", note: why + (message ? ` (${message})` : "") }; rosinId = ""; drawNow(); };
      player.addListener("ready", ({ device_id }) => { rosinId = device_id; sdk = { state: "ready", note: "" }; drawNow(); refreshDevices(); });
      player.addListener("not_ready", () => { rosinId = ""; sdk = { state: "loading", note: "" }; drawNow(); });
      player.addListener("initialization_error", fail("This browser or app can't play Spotify itself (no DRM support). Rosin still runs Spotify on your other devices."));
      player.addListener("authentication_error", fail("Spotify turned down Rosin's player. Disconnect and connect again."));
      player.addListener("account_error", fail("Playing music inside Rosin needs Spotify Premium."));
      player.addListener("playback_error", ({ message }) => setNote("Spotify couldn't play that here" + (message ? `: ${message}` : ".")));
      player.addListener("player_state_changed", (s) => { if (s) { stateAt = Date.now(); clearTimeout(startPlayer.t); startPlayer.t = setTimeout(refreshState, 300); } });
      player.connect().then((ok) => { if (!ok) fail("Rosin's player couldn't connect to Spotify.")({}); });
    };
    if (window.Spotify?.Player) { boot(); return; }
    window.onSpotifyWebPlaybackSDKReady = boot;
    const s = document.createElement("script"); s.src = "https://sdk.scdn.co/spotify-player.js"; s.async = true;
    s.onerror = () => { sdk = { state: "error", note: "Couldn't load Spotify's player (no connection to sdk.scdn.co)." }; drawNow(); };
    document.head.append(s);
  }
  // Phones only play sound after a tap: the first tap after the player is ready wakes it up.
  document.addEventListener("pointerdown", () => { try { player?.activateElement?.(); } catch {} }, { capture: true });
  // The music dips while Rosin talks (only when it's playing inside Rosin; other devices are left alone).
  const talking = R.talking?.bind(R);
  if (talking) R.talking = (on) => {
    talking(on);
    if (!player || !rosinId || state?.device?.id !== rosinId || !store.get("spotify.duck", true)) return;
    if (on && !ducked) { ducked = true; player.setVolume(localVol * 0.25).catch(() => {}); }
    else if (!on && ducked) { clearTimeout(R.talking.t); R.talking.t = setTimeout(() => { if (ducked) { ducked = false; player?.setVolume(localVol).catch(() => {}); } }, 600); }
  };

  // ---------- the 🎵 Music panel ----------
  const music = el("div", "tray"); music.id = "music"; music.hidden = true; music.setAttribute("aria-label", "Spotify");
  document.getElementById("controls").insertBefore(music, document.getElementById("say"));
  const open = btn("🎵 Music", "Spotify: what's playing, search and controls"); open.id = "btn-music";
  open.setAttribute("aria-expanded", "false"); open.setAttribute("aria-controls", "music");
  H.quick.append(open);
  open.addEventListener("click", () => {
    const show = music.hidden; music.hidden = !show; open.setAttribute("aria-expanded", String(show));
    if (show) {
      for (const id of ["more", "compass", "changes", "log"]) {
        const t = document.getElementById(id);
        if (t && !t.hidden) { t.hidden = true; document.querySelector(`[aria-controls="${id}"]`)?.setAttribute("aria-expanded", "false"); }
      }
      drawAll();
      if (connected()) { refreshState(); refreshDevices(); refreshQueue(); startPlayer(); }
    }
    H.fit();
  });

  // Not connected: how to set it up.
  const setup = el("div", "sp-setup");
  const idIn = Object.assign(el("input"), { type: "text", placeholder: "Client ID from your Spotify app", value: store.get("spotify.clientId", ""), autocomplete: "off", spellcheck: false, autocapitalize: "off" });
  idIn.setAttribute("aria-label", "Spotify Client ID");
  idIn.addEventListener("change", () => { store.set("spotify.clientId", idIn.value.trim()); drawAll(); });
  const connectBtn = btn("Connect Spotify", "", "sp-primary");
  connectBtn.addEventListener("click", async () => { store.set("spotify.clientId", idIn.value.trim()); try { await signIn(); } catch (e) { setNote(e.message); } });
  const steps = el("ol", "sp-steps");
  for (const s of [`Sign in at ${SETUP_URL.replace("https://", "")} and tap Create app (any name).`,
    `Redirect URI: ${REDIRECT}`, "Tick Web API and Web Playback SDK, agree and save.", "Open the app's settings, copy its Client ID here, and tap Connect."]) steps.append(el("li", "", s));
  const setupHead = el("p", "sp-head", "Connect Spotify");
  const setupNote = el("p", "sp-small", "Your Spotify account needs Premium for apps to control it. The sign-in stays on this device.");
  const idWrap = el("div", "sp-row"); idWrap.append(idIn, connectBtn);
  setup.append(setupHead, steps, idWrap, setupNote);

  // Connected: the player.
  const playerBox = el("div", "sp-player");
  const now = el("div", "sp-now");
  const art = Object.assign(el("img", "sp-art"), { alt: "" });
  const nowText = el("div", "sp-now-text"), nowTitle = el("p", "sp-title"), nowBy = el("p", "sp-by"), nowWhere = el("p", "sp-where");
  nowText.append(nowTitle, nowBy, nowWhere); now.append(art, nowText);
  const bar = Object.assign(el("input", "sp-bar"), { type: "range", min: 0, max: 1000, value: 0 }); bar.setAttribute("aria-label", "Position in the song");
  const times = el("p", "sp-times");
  const ctl = el("div", "sp-ctl");
  const bShuffle = btn("🔀", "Shuffle"), bPrev = btn("⏮", "Previous song"), bPlay = btn("▶", "Play", "sp-primary"), bNext = btn("⏭", "Next song"), bRepeat = btn("🔁", "Repeat"), bLike = btn("♡", "Save to Liked Songs");
  ctl.append(bShuffle, bPrev, bPlay, bNext, bRepeat, bLike);
  const vol = Object.assign(el("input"), { type: "range", min: 0, max: 100, step: 1, value: 50 }); vol.setAttribute("aria-label", "Volume");
  const devSel = el("select"); devSel.setAttribute("aria-label", "Which device plays it");
  const volWrap = H.field("Volume", vol), devWrap = H.field("Plays on", devSel);
  const settingsRow = el("div", "sp-row sp-grow"); settingsRow.append(devWrap, volWrap);

  const findRow = el("form", "sp-row sp-find");
  const qIn = Object.assign(el("input"), { type: "search", placeholder: "Search Spotify", enterKeyHint: "search", autocomplete: "off" }); qIn.setAttribute("aria-label", "Search Spotify");
  const kindSel = el("select"); kindSel.setAttribute("aria-label", "What to search for");
  for (const [v, t] of [["track", "Songs"], ["album", "Albums"], ["playlist", "Playlists"], ["artist", "Artists"]]) kindSel.append(new Option(t, v));
  const goBtn = btn("Search"); goBtn.type = "submit";
  findRow.append(qIn, kindSel, goBtn);
  const listHead = el("p", "sp-head sp-list-head");
  const list = el("ul", "sp-list");
  const tabs = el("div", "sp-tabs");
  const tNext = btn("Up next"), tLists = btn("My playlists"), tRecent = btn("Played lately");
  tabs.append(tNext, tLists, tRecent);
  const noteEl = el("p", "sp-note"); noteEl.setAttribute("role", "status");
  const foot = el("div", "sp-foot");
  const [inAppChk, inAppBox] = H.check("Play music in Rosin");
  inAppBox.checked = store.get("spotify.inApp", true);
  const [duckChk, duckBox] = H.check("Lower the music while Rosin talks");
  duckBox.checked = store.get("spotify.duck", true);
  const who = el("p", "sp-small");
  const outBtn = btn("Disconnect Spotify");
  foot.append(inAppChk, duckChk, who, outBtn);
  playerBox.append(now, bar, times, ctl, settingsRow, findRow, tabs, listHead, list, foot);
  const closeBtn = btn("Close", "Close the music panel", "sp-close");
  music.append(setup, playerBox, noteEl, closeBtn);
  closeBtn.addEventListener("click", () => { music.hidden = true; open.setAttribute("aria-expanded", "false"); H.fit(); open.focus(); });

  function setNote(t, bad) { noteEl.textContent = t || ""; noteEl.classList.toggle("bad", !!bad); if (t && !music.hidden) H.fit(); }
  const run = (f) => async () => { try { const line = await f(); if (line) setNote(line); } catch (e) { setNote(e.message, true); } };
  bPlay.addEventListener("click", run(() => state?.is_playing ? act.pause() : act.resume()));
  bNext.addEventListener("click", run(act.next)); bPrev.addEventListener("click", run(act.previous));
  bShuffle.addEventListener("click", run(() => act.shuffle(!state?.shuffle_state)));
  bRepeat.addEventListener("click", run(() => act.repeat(state?.repeat_state === "off" ? "context" : state?.repeat_state === "context" ? "track" : "off")));
  bLike.addEventListener("click", run(() => act.like(!liked)));
  let volT = 0;
  vol.addEventListener("input", () => { clearTimeout(volT); volT = setTimeout(run(() => act.volume(Number(vol.value))), 250); });
  let seeking = false;
  bar.addEventListener("input", () => { seeking = true; const d = state?.item?.duration_ms || 0; times.textContent = `${mmss(d * bar.value / 1000)} / ${mmss(d)}`; });
  bar.addEventListener("change", () => { seeking = false; const d = state?.item?.duration_ms || 0; if (d) run(() => act.seek(d * bar.value / 1000000))(); });
  devSel.addEventListener("change", run(async () => {
    const id = devSel.value; if (!id) return "";
    if (id === "rosin") { startPlayer(); return act.move("here"); }
    await api("PUT", "/me/player", { body: { device_ids: [id], play: !!state?.is_playing } }); after(800);
    return "Moved to " + (devices.find((d) => d.id === id)?.name || "that device") + ".";
  }));
  findRow.addEventListener("submit", (e) => { e.preventDefault(); const q = qIn.value.trim(); if (q) showResults(q, kindSel.value); qIn.blur(); });
  tNext.addEventListener("click", async () => { await refreshQueue(); showList("Up next", queueNext.map(asRow), "Nothing queued. Search and tap ＋ to add a song."); });
  tLists.addEventListener("click", run(async () => {
    const j = await api("GET", "/me/playlists", { query: { limit: 30 } });
    showList("My playlists", (j?.items || []).filter(Boolean).map((p) => ({ kind: "playlist", uri: p.uri, name: p.name, by: `${p.items?.total ?? p.tracks?.total ?? ""} songs`.replace(/^ songs$/, ""), art: (p.images || []).slice(-1)[0]?.url || "" })), "No playlists.");
    return "";
  }));
  tRecent.addEventListener("click", run(async () => {
    const j = await api("GET", "/me/player/recently-played", { query: { limit: 10 } });
    showList("Played lately", (j?.items || []).map((x) => asRow(x.track)), "Nothing played lately.");
    return "";
  }));
  inAppBox.addEventListener("change", () => {
    store.set("spotify.inApp", inAppBox.checked);
    if (inAppBox.checked) startPlayer(); else { try { player?.disconnect(); } catch {} player = null; rosinId = ""; sdk = { state: "off", note: "" }; refreshDevices(); }
    drawNow();
  });
  duckBox.addEventListener("change", () => store.set("spotify.duck", duckBox.checked));
  outBtn.addEventListener("click", () => signOut());

  const asRow = (it) => ({ kind: it?.type === "episode" ? "episode" : "track", uri: it?.uri, name: it?.name || "", by: artistsOf(it), art: (it?.album?.images || it?.images || []).slice(-1)[0]?.url || "" });
  async function showResults(q, kind) {
    listHead.textContent = "Searching…"; list.replaceChildren();
    try { const r = await search(q, kind, 10); showList(`Results for “${q}”`, r, "Spotify found nothing for that."); }
    catch (e) { listHead.textContent = ""; setNote(e.message, true); }
  }
  function showList(title, rows, empty) {
    listHead.textContent = title;
    list.replaceChildren(...(rows.length ? rows.filter((r) => r.uri).map((r) => {
      const li = el("li", "sp-item");
      const im = Object.assign(el("img", "sp-thumb"), { alt: "", loading: "lazy" }); if (r.art) im.src = r.art; else im.style.visibility = "hidden";
      const tx = el("div", "sp-item-text"); tx.append(el("p", "sp-item-name", r.name), el("p", "sp-item-by", r.by || r.kind));
      const play = btn("▶", `Play ${r.name}`);
      play.addEventListener("click", run(() => act.play(r.uri, r.kind)));
      li.append(im, tx, play);
      if (r.kind === "track") { const add = btn("＋", `Add ${r.name} to the queue`); add.addEventListener("click", run(() => act.queue(r.uri).then((t) => t.replace("Added that", "Added " + r.name)))); li.append(add); }
      return li;
    }) : [el("li", "sp-empty", empty)]));
    H.fit();
  }
  function drawQueue() { if (listHead.textContent === "Up next") showList("Up next", queueNext.map(asRow), "Nothing queued. Search and tap ＋ to add a song."); }
  function drawDevices() {
    const opts = [];
    const seen = new Set();
    for (const d of devices) { seen.add(d.id); opts.push(new Option(d.id === rosinId ? `This Rosin${d.is_active ? " (playing)" : ""}` : `${d.name} (${d.type.toLowerCase()})${d.is_active ? ", playing" : ""}`, d.id === rosinId ? "rosin" : d.id)); }
    if (inAppOn() && !seen.has(rosinId)) opts.push(new Option(sdk.state === "error" ? "This Rosin (can't play here)" : sdk.state === "ready" ? "This Rosin" : "This Rosin (starting…)", "rosin"));
    if (!opts.length) opts.push(new Option("No device on", ""));
    devSel.replaceChildren(...opts);
    const active = devices.find((d) => d.is_active);
    devSel.value = active ? (active.id === rosinId ? "rosin" : active.id) : "";
    const rOpt = [...devSel.options].find((o) => o.value === "rosin"); if (rOpt) rOpt.disabled = sdk.state === "error";
  }
  function drawNow() {
    const it = state?.item;
    art.hidden = !it; const img = (it?.album?.images || it?.images || [])[1] || (it?.album?.images || it?.images || [])[0];
    if (img) art.src = img.url;
    nowTitle.textContent = it ? it.name : "Nothing playing";
    nowBy.textContent = it ? artistsOf(it) : "Search below, or say “play …” to Rosin.";
    const here = state?.device?.id && state.device.id === rosinId;
    nowWhere.textContent = state?.device ? `${state.is_playing ? "Playing" : "Paused"} on ${here ? "this Rosin" : state.device.name}` : sdk.state === "ready" ? "Ready to play here" : "";
    bPlay.textContent = state?.is_playing ? "⏸" : "▶"; bPlay.setAttribute("aria-label", state?.is_playing ? "Pause" : "Play"); bPlay.title = bPlay.getAttribute("aria-label");
    bShuffle.setAttribute("aria-pressed", String(!!state?.shuffle_state));
    bRepeat.setAttribute("aria-pressed", String(!!state && state.repeat_state !== "off")); bRepeat.textContent = state?.repeat_state === "track" ? "🔂" : "🔁";
    bRepeat.title = state?.repeat_state === "track" ? "Repeat: this song" : state?.repeat_state === "context" ? "Repeat: this list" : "Repeat: off";
    bLike.textContent = liked ? "♥" : "♡"; bLike.setAttribute("aria-pressed", String(!!liked)); bLike.title = liked ? "In your Liked Songs (tap to remove)" : "Save to Liked Songs";
    if (state?.device && typeof state.device.volume_percent === "number" && document.activeElement !== vol) vol.value = state.device.volume_percent;
    volWrap.hidden = !!state?.device && state.device.supports_volume === false;
    drawBar();
    who.textContent = (me ? `Signed in as ${me.display_name || me.id}. ` : "") + (sdk.state === "ready" ? "Rosin can play music on this device." : sdk.state === "loading" ? "Rosin's player is starting…" : sdk.state === "error" ? sdk.note : inAppOn() ? "" : "Rosin runs Spotify on your other devices.");
    drawDevices();
  }
  function drawBar() {
    const d = state?.item?.duration_ms || 0, p = progressNow();
    bar.disabled = !d;
    if (!seeking) { bar.value = d ? Math.round((p / d) * 1000) : 0; times.textContent = d ? `${mmss(p)} / ${mmss(d)}` : ""; }
  }
  function drawAll() {
    const on = connected();
    setup.hidden = on; playerBox.hidden = !on;
    idIn.value = store.get("spotify.clientId", "") || "";
    if (!on && !clientId()) connectBtn.disabled = false;
    if (on) drawNow();
    if (!music.hidden) H.fit();
  }

  // ---------- keeping it up to date ----------
  H.tick(1000, () => { if (!music.hidden && state?.is_playing) drawBar(); });
  H.tick(5000, () => { if (!music.hidden && connected() && !document.hidden) refreshState(); });
  H.tick(60000, () => { if (connected() && !music.hidden) refreshDevices(); });

  // ---------- start ----------
  (async () => {
    if (await finishSignIn()) return;
    const n = store.get("spotify.note", ""); if (n) { store.set("spotify.note", ""); setNote(n, /didn't|cancel|said/i.test(n)); R.status(n); }
    drawAll();
    if (connected()) {
      api("GET", "/me").then((j) => { me = j; drawNow(); }).catch(() => {});
      refreshState();
      startPlayer();
    }
  })();

  B.spotify = { act, parse, search, connected, refreshState, state: () => state, devices: () => devices.slice(), rosinDevice: () => rosinId, sdk: () => ({ ...sdk }), signIn, signOut, tools };
  async function rosinDevice() {
    if (!inAppOn()) return "";
    startPlayer();
    for (let i = 0; i < 20 && sdk.state === "loading"; i++) await settle(250);
    return sdk.state === "ready" ? rosinId : "";
  }
})();
