// Cloudflare Worker for hunt.tavernworks.dev.
// Serves the Wandering Clerk (Hunt & Hoard) val from our own domain without Val Town's
// paid custom-domain feature: every request is forwarded to the val and
// the response is passed back, so the address bar stays on tavernworks.dev.
const VAL_ORIGIN = "https://huntandhoardbot.val.run";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, VAL_ORIGIN);

    const upstream = await fetch(new Request(target, request), { redirect: "manual" });

    // Keep redirects that point back at the val on our domain. Redirects to
    // anywhere else (e.g. Twitch login) pass through untouched.
    const location = upstream.headers.get("Location");
    if (location) {
      const loc = new URL(location, VAL_ORIGIN);
      if (loc.origin === VAL_ORIGIN) {
        const headers = new Headers(upstream.headers);
        headers.set("Location", url.origin + loc.pathname + loc.search + loc.hash);
        return new Response(upstream.body, { status: upstream.status, headers });
      }
    }
    return upstream;
  },
};
