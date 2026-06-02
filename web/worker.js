// context-mode.com router — Context Mode Platform · Insights at /, OSS at /oss.
//
// Routes:
//   /          → web/insights.html    (Context Mode Platform · Insights — the GTM landing)
//   /insights  → web/insights.html    (alias for / — same content, canonical anchor)
//   /oss       → web/index.html       (Context Mode OSS plugin landing)
//   everything else → static asset binding (favicons, images, etc.)
//
// Brand:
//   - Context Mode Platform · Insights (the managed Solution, primary)
//   - Context Mode (the open-source plugin, /oss)
//
// Deploy: `npx wrangler deploy` from web/ directory.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/insights") {
      return env.ASSETS.fetch(new Request(new URL("/insights.html", url), req));
    }
    if (path === "/oss") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), req));
    }
    return env.ASSETS.fetch(req);
  }
};
