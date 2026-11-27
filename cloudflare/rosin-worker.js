// Cloudflare Worker for rosin.tavernworks.dev.
// Serves the Rosin demo page that lives at tavernworks.dev/rosin/ from its own
// subdomain: every request is fetched from /rosin/ on the main site and passed
// back, so the address bar stays on rosin.tavernworks.dev.
//
// Set up once in the Cloudflare dashboard (no DNS record needed by hand):
//   Workers & Pages -> Create -> Worker -> name it "rosin" -> paste this file -> Deploy.
//   Then the rosin Worker -> Settings -> Domains & Routes -> Add -> Custom domain
//   -> rosin.tavernworks.dev. Cloudflare adds the DNS record and certificate itself.
// The website Worker must not hold a *.tavernworks.dev wildcard (see bot-host/README.md, step 6).
const SITE = "https://tavernworks.dev";

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const url = new URL(request.url);
    const target = new URL("/rosin" + url.pathname + url.search, SITE);
    const upstream = await fetch(target, { method: request.method, headers: request.headers, redirect: "manual" });

    // Keep the site's own redirects (for example /rosin -> /rosin/) on this subdomain.
    const location = upstream.headers.get("Location");
    if (location) {
      const loc = new URL(location, SITE);
      if (loc.origin === SITE && loc.pathname.startsWith("/rosin")) {
        const headers = new Headers(upstream.headers);
        headers.set("Location", url.origin + (loc.pathname.slice("/rosin".length) || "/") + loc.search);
        return new Response(upstream.body, { status: upstream.status, headers });
      }
    }
    return upstream;
  },
};
