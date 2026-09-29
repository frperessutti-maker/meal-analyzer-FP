// Service worker for the installed app.
//
// The app is one large index.html, so the cache has to be handled carefully: caching the
// document aggressively would leave installed users on an old build after a deploy, which
// has already caused a stale copy to keep calling a dead API. So the document is fetched
// network-first and only falls back to the cache when offline, while the things that never
// change within a version — icons, CDN libraries, fonts — are served cache-first.
//
// API calls are never cached: a cached /quota or /sync would be worse than no answer.

const CACHE = "meal-analyzer-v1";
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"];
const API = /^\/(analyze|sync|quota|fetch-url)\b/;

self.addEventListener("install", (e) => {
  // addAll fails the whole install if any one entry 404s, so each is added on its own.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin === self.location.origin && API.test(url.pathname)) return;   // straight to network

  const isDocument = req.mode === "navigate" || (url.origin === self.location.origin && (url.pathname === "/" || url.pathname.endsWith(".html")));

  if (isDocument) {
    // Network first: a deploy is picked up on the next launch rather than days later.
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); }
        return res;
      }).catch(() => caches.match("/").then((r) => r || caches.match(req)))
    );
    return;
  }

  // Everything else is versioned or static: cache first, filling the cache as it goes.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // Opaque cross-origin responses are cached too — they are the CDN libraries and
      // fonts, and without them the app cannot start offline.
      if (res && (res.ok || res.type === "opaque")) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy).catch(() => {}));
      }
      return res;
    }).catch(() => caches.match(req)))
  );
});
