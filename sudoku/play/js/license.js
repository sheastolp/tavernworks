// Paid extras: who has unlocked what.
//
// Paying never changes how the game plays. A licence key can unlock only:
//   - the offline download (the zip), and
//   - cosmetics: board themes, solve celebrations, digit styles.
// Everything else, including every gameplay option, is free and needs no key.
//
// The key is checked against the Tavernworks licensing service. Fill in
// LICENSE_CONFIG below once that service is live; while `api` is empty the
// paid extras show as "coming soon" and nothing else changes. The API this
// expects is described in LICENSING.md.
(() => {
  const LICENSE_CONFIG = {
    // Base URL of the licensing service, e.g. "https://straconis.dev/wp-json/licensing".
    api: '',
    // Product IDs on the licensing service.
    products: {
      offline: 'sudoku-on-stream-offline', // the offline download only
      supporter: 'sudoku-on-stream-supporter', // offline download + every cosmetic
    },
    // Where people buy each product (checkout pages), and the price to show.
    store: {
      offline: { url: '', price: '' },
      supporter: { url: '', price: '' },
    },
    // How long a key that checked out keeps working while the licensing
    // service can't be reached, so an outage never strips a look mid-stream.
    graceDays: 14,
  };

  const LS_KEY = 'numbersonstream.license';
  const DAY = 86400000;
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; } },
    set(v) { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch {} },
    clear() { try { localStorage.removeItem(LS_KEY); } catch {} },
  };

  const cleanKey = (k) => String(k || '').trim().replace(/\s+/g, '');

  // What a list of product IDs unlocks.
  function unlocks(products) {
    const p = new Set(products || []);
    const supporter = p.has(LICENSE_CONFIG.products.supporter);
    return { download: supporter || p.has(LICENSE_CONFIG.products.offline), cosmetics: supporter };
  }

  // Checks a key with the licensing service.
  // Resolves to { status, products, unlocks } where status is one of:
  //   'none'      no key given
  //   'offline'   licensing isn't set up yet (LICENSE_CONFIG.api is empty)
  //   'valid'     the key is good; `products` lists what it covers
  //   'invalid'   the service said no (unknown, refunded, expired or revoked)
  //   'cached'    the service couldn't be reached; using a recent good answer
  //   'error'     the service couldn't be reached and there's no recent answer
  async function check(key) {
    key = cleanKey(key);
    const result = (status, products = [], message = '') => ({ status, products, message, unlocks: unlocks(products) });
    if (!key) return result('none');
    if (!LICENSE_CONFIG.api) return result('offline');

    const cached = store.get();
    const fromCache = () =>
      cached && cached.key === key && Date.now() - cached.checkedAt < LICENSE_CONFIG.graceDays * DAY
        ? result('cached', cached.products)
        : result('error', [], "Couldn't reach the licensing server.");

    let res;
    try {
      res = await fetch(LICENSE_CONFIG.api.replace(/\/$/, '') + '/v1/licenses/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: key, products: Object.values(LICENSE_CONFIG.products) }),
      });
    } catch {
      return fromCache();
    }
    if (res.status >= 500 || res.status === 429) return fromCache();

    let body = {};
    try { body = await res.json(); } catch {}
    const known = new Set(Object.values(LICENSE_CONFIG.products));
    const products = Array.isArray(body.products) ? body.products.filter((p) => known.has(p)) : [];
    if (!res.ok || !body.valid || !products.length) {
      if (cached && cached.key === key) store.clear();
      return result('invalid', [], body.message || "That key isn't valid for Sudoku on Stream.");
    }
    store.set({ key, products, checkedAt: Date.now() });
    return result('valid', products);
  }

  // The last good answer for a key, if it's recent enough to trust while a
  // fresh check runs. Lets a reloaded browser source keep its look instantly.
  function cachedUnlocks(key) {
    key = cleanKey(key);
    const c = store.get();
    if (!key || !c || c.key !== key || Date.now() - c.checkedAt > LICENSE_CONFIG.graceDays * DAY) return unlocks([]);
    return unlocks(c.products);
  }

  // Asks the licensing service for a fresh download link for the zip.
  // Resolves to { url } or { error }.
  async function downloadLink(key) {
    key = cleanKey(key);
    if (!LICENSE_CONFIG.api) return { error: "Downloads aren't open yet." };
    if (!key) return { error: 'Enter your licence key.' };
    try {
      const res = await fetch(LICENSE_CONFIG.api.replace(/\/$/, '') + '/v1/downloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: key, products: [LICENSE_CONFIG.products.offline, LICENSE_CONFIG.products.supporter] }),
      });
      let body = {};
      try { body = await res.json(); } catch {}
      if (res.ok && body.url) return { url: body.url };
      return { error: body.message || (res.status >= 500 ? "Couldn't reach the licensing server. Try again in a minute." : "That key doesn't include the offline download.") };
    } catch {
      return { error: "Couldn't reach the licensing server. Check your connection and try again." };
    }
  }

  window.License = {
    config: LICENSE_CONFIG,
    enabled: () => !!LICENSE_CONFIG.api,
    cleanKey,
    unlocks,
    check,
    cachedUnlocks,
    downloadLink,
  };
})();
