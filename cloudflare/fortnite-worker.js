// Cloudflare Worker for fortnite.tavernworks.dev.
// The Fortnite Tracker (/assistants/fortnite/) looks players up by name only.
// fortnite-api.com needs an API key for stats, so this worker holds ours as a
// secret and adds it to each stats request. Visitors never see or need a key.
//
// Setup (Cloudflare dashboard):
//   1. Workers & Pages → Create → Worker, paste this file, deploy.
//   2. Settings → Variables and Secrets → add a Secret named FORTNITE_API_KEY
//      with the key from https://dash.fortnite-api.com (sign in with Discord).
//   3. Settings → Domains & Routes → add the custom domain fortnite.tavernworks.dev.
//
// Only the stats endpoint is forwarded, only GET, and only for pages on
// tavernworks.dev (plus localhost for testing). Answers are cached at the edge
// for a minute, so many visitors looking up the same player, or the tracker's
// auto-check, don't eat into the key's rate limit.
const UPSTREAM = "https://fortnite-api.com";
const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*tavernworks\.dev$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const CACHE_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN.test(origin) ? origin : "https://tavernworks.dev",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    const json = (status, body, extra) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors, ...extra } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Max-Age": "86400" } });
    if (request.method !== "GET") return json(405, { status: 405, error: "Only GET is supported." });
    // Browsers send Origin on cross-site fetches; refuse other sites using our key.
    if (origin && !ALLOWED_ORIGIN.test(origin)) return json(403, { status: 403, error: "This service only answers the Tavernworks Fortnite Tracker." });

    if (!/^\/v2\/stats\/br\/v2\/?$/.test(url.pathname)) return json(404, { status: 404, error: "Not found." });
    const name = (url.searchParams.get("name") || "").trim();
    const accountType = url.searchParams.get("accountType") || "epic";
    const timeWindow = url.searchParams.get("timeWindow") || "lifetime";
    if (!name || name.length > 32) return json(400, { status: 400, error: "Enter a player name." });
    if (!["epic", "psn", "xbl"].includes(accountType) || !["lifetime", "season"].includes(timeWindow))
      return json(400, { status: 400, error: "Unknown platform or time window." });
    if (!env.FORTNITE_API_KEY) return json(503, { status: 503, error: "The stats service isn't set up yet." });

    // Rebuild the query ourselves so only these parameters reach fortnite-api.com.
    const target = new URL("/v2/stats/br/v2", UPSTREAM);
    target.search = new URLSearchParams({ name, accountType, timeWindow, image: "none" }).toString();

    const cache = caches.default, cacheKey = new Request(target.toString());
    let upstream = await cache.match(cacheKey);
    if (!upstream) {
      upstream = await fetch(target, { headers: { Authorization: env.FORTNITE_API_KEY } });
      if (upstream.ok) {
        const copy = new Response(upstream.clone().body, upstream);
        copy.headers.set("Cache-Control", "public, max-age=" + CACHE_SECONDS);
        ctx.waitUntil(cache.put(cacheKey, copy));
      }
    }
    // A key problem upstream is ours to fix, not the visitor's.
    if (upstream.status === 401) return json(503, { status: 503, error: "The stats service is having trouble right now. Try again later." });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + CACHE_SECONDS, ...cors },
    });
  },
};
