// Paid extras: who has unlocked what.
//
// Paying never changes how the game plays. A licence key can unlock only:
//   - the offline download (the zip), and
//   - cosmetics: board themes, solve celebrations, digit styles.
// Everything else, including every gameplay option, is free and needs no key.
//
// Keys come from the Tavernworks licensing service (the licensing-service
// WordPress plugin). This is a browser client for its API, following the
// same contract as its other client libraries (clients/SPEC.md there):
// a key is activated once per browser, the server returns a signed token,
// and the token is checked here and re-used until it's due for a refresh,
// so a short outage never strips a look mid-stream.
//
// Fill in LICENSE_CONFIG below once the service is live; while `api` is
// empty the paid extras show as "coming soon" and nothing else changes.
// Setup notes are in LICENSING.md. Needs js/vendor/nacl-fast.min.js loaded first.
(() => {
  const LICENSE_CONFIG = {
    // The site's API base, e.g. "https://tavernworks.example/wp-json/lsvc/v1".
    api: '',
    // Product slug on the licensing service, and the plan features that unlock things.
    product: 'sudoku-on-stream',
    features: { download: 'offline', cosmetics: 'looks' },
    // Signing keys from the service's GET /public-keys, as { kid: "base64 public key" }.
    // If left empty, they're fetched from the service (fine to start, but
    // building them in here is what the service recommends).
    publicKeys: {},
    // The site's host name, as in the tokens' "iss" claim (optional check).
    issuer: '',
    // Where people buy each plan: cosmetics = every ★ look (no download),
        // supporter = the download + every ★ look, offline = the download only. (the page with the [lsvc_buy] button), and the price to show.
    store: {
      offline: { url: '', price: '' },
      cosmetics: { url: '', price: '' },
          supporter: { url: '', price: '' },
    },
    // The customer account page (the [lsvc_account] shortcode): keys, machines, billing.
    accountUrl: '',
  };

  const APP_VERSION = 'sudoku-on-stream-web/1.1.0';
  const LS_LICENSE = 'numbersonstream.license'; // { key, token }
  const LS_DEVICE = 'numbersonstream.device'; // random id for this browser / OBS
  const TRANSIENT = new Set(['network_error', 'server_error', 'rate_limited']);

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const api = () => LICENSE_CONFIG.api.replace(/\/+$/, '');
  const now = () => Math.floor(Date.now() / 1000);
  const cleanKey = (k) => String(k || '').trim().replace(/\s+/g, '').toUpperCase();

  // ---------- This browser's fingerprint ----------
  // A browser can't read a machine id, so each browser profile (each OBS,
  // each web browser) gets a random id the first time, kept in local storage.
  function fingerprint() {
    let id = ls.get(LS_DEVICE);
    if (typeof id !== 'string' || id.length < 16) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      id = 'lsvc-web:' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      ls.set(LS_DEVICE, id);
    }
    return id;
  }
  // Shown to the customer on their account page next to each activation.
  function label() {
    const where = location.protocol === 'file:' ? 'offline copy' : location.host;
    return (window.obsstudio ? 'OBS' : 'Browser') + ' (' + where + ')';
  }

  // ---------- Token checks (TOKEN.md, clients/SPEC.md verify_token) ----------
  const B64URL = /^[A-Za-z0-9_-]+$/;
  function b64urlBytes(s) {
    if (!B64URL.test(s) || s.length % 4 === 1) return null;
    const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    let bin;
    try { bin = atob(pad); } catch { return null; }
    const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    // Canonical encoding only: re-encoding must give the same text.
    const back = btoa(String.fromCharCode(...out)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return back === s ? out : null;
  }
  const b64Bytes = (s) => { try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; } };
  async function sha256hex(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const isInt = (n) => Number.isSafeInteger(n);

  let fetchedKeys = null;
  async function publicKeys() {
    if (Object.keys(LICENSE_CONFIG.publicKeys).length) return LICENSE_CONFIG.publicKeys;
    if (fetchedKeys) return fetchedKeys;
    try {
      const res = await fetch(api() + '/public-keys', { headers: { Accept: 'application/json' } });
      const body = await res.json();
      fetchedKeys = Object.fromEntries((body.keys || []).map((k) => [k.kid, k.public_key]));
    } catch { return {}; }
    return fetchedKeys;
  }

  // Resolves to { valid, error, claims }.
  async function verifyToken(token, fp, t = now()) {
    const fail = (error) => ({ valid: false, error, claims: null });
    if (typeof token !== 'string') return fail('malformed');
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return fail('malformed');
    const body = b64urlBytes(parts[0]), sig = b64urlBytes(parts[1]);
    if (!body || !sig || sig.length !== 64) return fail('malformed');
    let c;
    try { c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return fail('malformed'); }
    if (!c || typeof c !== 'object' || Array.isArray(c)) return fail('malformed');
    const keys = await publicKeys();
    if (typeof c.kid !== 'string' || !Object.prototype.hasOwnProperty.call(keys, c.kid)) return fail('unknown_key');
    const pub = b64Bytes(keys[c.kid]);
    if (!pub || pub.length !== 32 || !window.nacl || !nacl.sign.detached.verify(new TextEncoder().encode(parts[0]), sig, pub)) return fail('bad_signature');
    if (typeof c.v !== 'number') return fail('malformed');
    if (c.v !== 1) return fail('unsupported_version');
    if (typeof c.lic !== 'string' || typeof c.iss !== 'string' || typeof c.product !== 'string' || typeof c.fp !== 'string'
      || !Array.isArray(c.features) || !c.features.every((f) => typeof f === 'string') || typeof c.trial !== 'boolean'
      || !isInt(c.refresh_after) || !isInt(c.valid_until) || ('remind' in c && typeof c.remind !== 'boolean')) return fail('malformed');
    if (c.fp !== (await sha256hex(fp))) return fail('wrong_machine');
    if (c.product !== LICENSE_CONFIG.product) return fail('wrong_product');
    if (LICENSE_CONFIG.issuer && c.iss !== LICENSE_CONFIG.issuer) return fail('wrong_issuer');
    if (!(t < c.valid_until)) return fail('expired');
    return { valid: true, error: null, claims: c };
  }

  // ---------- API calls ----------
  // Resolves to { ok: true, token, license } or { ok: false, error, message }.
  async function post(endpoint, data) {
    let res;
    try {
      res = await fetch(api() + '/' + endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
    } catch {
      return { ok: false, error: 'network_error', message: "Couldn't reach the licensing server." };
    }
    let body = null;
    try { body = await res.json(); } catch {}
    if (body && body.ok === true && (endpoint === 'deactivate' || typeof body.token === 'string')) return body;
    if (body && typeof body.code === 'string') return { ok: false, error: body.code, message: body.message || '' };
    return { ok: false, error: 'server_error', message: 'The licensing server sent an unexpected answer.' };
  }

  const MESSAGES = {
    invalid_license: "That key isn't valid for Sudoku on Stream.",
    license_expired: 'That licence has ended.',
    license_suspended: 'That licence is suspended (a payment needs fixing).',
    license_revoked: 'That licence was refunded or cancelled.',
    activation_limit: 'That key is already in use on its maximum number of setups. Free one up from your account page.',
    rate_limited: 'Too many checks just now. Try again in a minute.',
    network_error: "Couldn't reach the licensing server.",
    server_error: 'The licensing server had a problem.',
  };

  // ---------- Result shape used by the game and the setup pages ----------
  function unlocksOf(features) {
    const f = new Set(features || []);
    return { download: f.has(LICENSE_CONFIG.features.download), cosmetics: f.has(LICENSE_CONFIG.features.cosmetics) };
  }
  // status: 'none' (no key), 'offline' (licensing not set up), 'valid' (checked now),
  // 'cached' (server unreachable, recent token still good), 'invalid' (refused), 'error' (unreachable, nothing cached)
  function result(status, claims, error, message) {
    const features = claims ? claims.features : [];
    return { status, error: error || null, message: message || (error && MESSAGES[error]) || '', features, unlocks: unlocksOf(features), claims: claims || null };
  }

  async function activate(key, fp) {
    const r = await post('activate', { key, product: LICENSE_CONFIG.product, fingerprint: fp, label: label(), app_version: APP_VERSION });
    if (!r.ok) return { r };
    const v = await verifyToken(r.token, fp);
    if (!v.valid) return { r: { ok: false, error: v.error, message: 'The licensing server sent a token this page could not verify (' + v.error + ').' } };
    const k = (r.license && r.license.key) || key;
    ls.set(LS_LICENSE, { key: k, token: r.token });
    return { r, v };
  }

  // What the game calls on start: re-uses the saved token until it's due for
  // a refresh, then checks in with the service. (clients/SPEC.md check())
  async function check(rawKey) {
    const key = cleanKey(rawKey);
    if (!key) return result('none');
    if (!LICENSE_CONFIG.api) return result('offline');
    const fp = fingerprint();
    let saved = ls.get(LS_LICENSE);
    if (!saved || cleanKey(saved.key) !== key) saved = null;

    const cached = saved && saved.token ? await verifyToken(saved.token, fp) : null;
    if (cached && cached.valid && now() < cached.claims.refresh_after) return result('valid', cached.claims);

    // Due for a refresh, or never activated in this browser.
    let r = saved && saved.token ? await post('refresh', { key, fingerprint: fp, app_version: APP_VERSION }) : null;
    if (!r || r.error === 'not_activated') {
      // First use in this browser, or the activation was removed: activate
      // (this uses one of the key's activations, if the plan limits them).
      const a = await activate(key, fp);
      if (a.v) return result('valid', a.v.claims);
      r = a.r;
    } else if (r.ok) {
      const v = await verifyToken(r.token, fp);
      if (v.valid) { ls.set(LS_LICENSE, { key, token: r.token }); return result('valid', v.claims); }
      r = { ok: false, error: v.error };
    }
    if (TRANSIENT.has(r.error)) {
      return cached && cached.valid ? result('cached', cached.claims) : result('error', null, r.error, r.message);
    }
    // Refused: forget the token (keep the key).
    if (saved) ls.set(LS_LICENSE, { key: saved.key });
    return result('invalid', null, r.error, r.message);
  }

  // Quick synchronous look at the saved token, so a reloaded browser source
  // shows its looks straight away. check() does the real verification.
  function cachedUnlocks(rawKey) {
    const saved = ls.get(LS_LICENSE);
    if (!saved || !saved.token || cleanKey(saved.key) !== cleanKey(rawKey)) return unlocksOf([]);
    try {
      const c = JSON.parse(new TextDecoder().decode(b64urlBytes(saved.token.split('.')[0])));
      return now() < c.valid_until ? unlocksOf(c.features) : unlocksOf([]);
    } catch { return unlocksOf([]); }
  }

  // For setup pages: says what a key unlocks without keeping an activation
  // for this browser (activates, then frees it again), unless this browser
  // already runs the game with the key.
  async function lookup(rawKey) {
    const key = cleanKey(rawKey);
    if (!key) return result('none');
    if (!LICENSE_CONFIG.api) return result('offline');
    const saved = ls.get(LS_LICENSE);
    if (saved && saved.token && cleanKey(saved.key) === key) return check(key);
    const fp = fingerprint();
    const a = await activate(key, fp);
    if (!a.v) return TRANSIENT.has(a.r.error) ? result('error', null, a.r.error, a.r.message) : result('invalid', null, a.r.error, a.r.message);
    await post('deactivate', { key, fingerprint: fp });
    if (saved && saved.token) ls.set(LS_LICENSE, saved); else ls.del(LS_LICENSE);
    return result('valid', a.v.claims);
  }

  // Frees this browser's activation (e.g. before moving to another PC).
  async function deactivate() {
    const saved = ls.get(LS_LICENSE);
    if (!saved || !saved.key || !LICENSE_CONFIG.api) return false;
    const r = await post('deactivate', { key: cleanKey(saved.key), fingerprint: fingerprint() });
    if (TRANSIENT.has(r.error)) return false;
    ls.del(LS_LICENSE);
    return true;
  }

  window.License = {
    config: LICENSE_CONFIG,
    enabled: () => !!LICENSE_CONFIG.api,
    cleanKey,
    check,
    lookup,
    cachedUnlocks,
    deactivate,
    verifyToken, // exposed for tests
  };
})();
