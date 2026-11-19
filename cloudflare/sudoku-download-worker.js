// Cloudflare Worker for downloads.tavernworks.dev.
// Hands out the paid Sudoku on Stream offline download to people with a key
// whose plan includes it (Supporter bundle or Offline download).
//
// The licensing service isn't ours, so this only uses its public client API,
// the same way the game does:
//   1. POST /activate with the key and a throwaway fingerprint (labelled
//      "Download (tavernworks.dev)"), which returns a signed licence token;
//   2. check the token's Ed25519 signature, product, fingerprint and expiry,
//      and that its features include "offline";
//   3. POST /deactivate straight away, so the seat is freed again;
//   4. stream the zip from a private R2 bucket.
// The zip never has a public URL, and a refunded or revoked key stops
// working at once because every download asks the licensing service.
// Nothing about the request is stored here.
//
// Setup (Cloudflare dashboard): see "Delivering the zip" in NumbersOnStream's
// LICENSING.md. Bindings and variables:
//   ZIPS          R2 bucket binding holding sudoku-on-stream.zip (private)
//   LSVC_API      e.g. https://licensing.example/wp-json/lsvc/v1
//   LSVC_KEYS     JSON {"<kid>": "<base64 public key>"} from LSVC_API/public-keys
//   LSVC_ISSUER   the licensing site's host name (tokens' "iss"); optional
//   ALLOW_ORIGIN  https://tavernworks.dev
const PRODUCT = 'sudoku-on-stream';
const FEATURE = 'offline';
const OBJECT = 'sudoku-on-stream.zip';

const MESSAGES = {
  invalid_license: "That key isn't valid for Sudoku on Stream.",
  license_expired: 'That licence has ended.',
  license_suspended: 'That licence is suspended (a payment needs fixing).',
  license_revoked: 'That licence was refunded or cancelled.',
  activation_limit: 'That key is in use on its maximum number of setups. Free one up on your account page, then try again.',
  rate_limited: 'Too many tries just now. Wait a minute and try again.',
  no_download: "That key doesn't include the offline download (Cosmetics keys are looks only).",
  bad_request: 'Enter your licence key.',
  unavailable: "Downloads aren't available right now. Please try again later.",
};

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || 'https://tavernworks.dev';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Expose-Headers': 'Content-Disposition', Vary: 'Origin' };
    const fail = (code, status) => new Response(JSON.stringify({ code, message: MESSAGES[code] || MESSAGES.unavailable }), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    const url = new URL(request.url);
    if (url.pathname !== '/sudoku') return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

    let key = '';
    try { key = String((await request.json()).key || '').trim().replace(/\s+/g, '').toUpperCase(); } catch {}
    if (!/^[A-Z0-9-]{8,80}$/.test(key)) return fail('bad_request', 400);
    if (!env.LSVC_API || !env.ZIPS) return fail('unavailable', 503);

    const api = env.LSVC_API.replace(/\/+$/, '');
    const fingerprint = 'lsvc-dl:' + crypto.randomUUID().replace(/-/g, '');
    const call = async (endpoint, body) => {
      try {
        const res = await fetch(api + '/' + endpoint, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'tavernworks-download/1' }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
      } catch { return { status: 0, body: null }; }
    };

    const act = await call('activate', { key, product: PRODUCT, fingerprint, label: 'Download (tavernworks.dev)', app_version: 'sudoku-on-stream-download/1' });
    const activated = !!(act.body && act.body.ok === true);
    try {
      if (!activated) {
        const code = act.body && typeof act.body.code === 'string' ? act.body.code : '';
        if (MESSAGES[code]) return fail(code, act.status === 429 ? 429 : 403);
        return fail('unavailable', 503);
      }
      const claims = await verifyToken(act.body.token, fingerprint, env);
      if (!claims) return fail('unavailable', 503);
      if (!claims.features.includes(FEATURE)) return fail('no_download', 403);

      const zip = await env.ZIPS.get(OBJECT);
      if (!zip) return fail('unavailable', 503);
      return new Response(zip.body, {
        headers: { ...cors, 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="sudoku-on-stream.zip"', 'Cache-Control': 'private, no-store' },
      });
    } finally {
      if (activated) await call('deactivate', { key, fingerprint });
    }
  },
};

// Checks a licence token (docs/TOKEN.md in the licensing service). Returns its claims, or null.
async function verifyToken(token, fingerprint, env) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const b64u = (s) => { try { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)); } catch { return null; } };
  const body = b64u(parts[0]), sig = b64u(parts[1]);
  if (!body || !sig || sig.length !== 64) return null;
  let c;
  try { c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return null; }
  let keys = {};
  try { keys = typeof env.LSVC_KEYS === 'string' ? JSON.parse(env.LSVC_KEYS) : env.LSVC_KEYS || {}; } catch {}
  if (!c || typeof c.kid !== 'string' || !Object.prototype.hasOwnProperty.call(keys, c.kid)) return null;
  const pub = b64u(String(keys[c.kid]).replace(/=+$/, ''));
  if (!pub || pub.length !== 32) return null;
  let ok = false;
  try {
    const k = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, k, sig, new TextEncoder().encode(parts[0]));
  } catch {
    // Older Workers runtimes name it NODE-ED25519.
    try {
      const k = await crypto.subtle.importKey('raw', pub, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
      ok = await crypto.subtle.verify({ name: 'NODE-ED25519' }, k, sig, new TextEncoder().encode(parts[0]));
    } catch { ok = false; }
  }
  if (!ok || c.v !== 1 || c.product !== PRODUCT || !Array.isArray(c.features)) return null;
  if (env.LSVC_ISSUER && c.iss !== env.LSVC_ISSUER) return null;
  const fp = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (c.fp !== fp || !(Math.floor(Date.now() / 1000) < c.valid_until)) return null;
  return c;
}
