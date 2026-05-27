// Shorts Studio service worker — minimal app-shell cache.
// Strategy:
//   - Network-first for navigations + API routes.
//   - Cache-first for static assets and the heavyweight ffmpeg/transformers
//     CDN bundles (they're versioned URLs, safe to cache aggressively).
const VERSION = "v1.0.0";
const SHELL_CACHE = `ss-shell-${VERSION}`;
const ASSET_CACHE = `ss-assets-${VERSION}`;

const SHELL_URLS = ["/", "/manifest.webmanifest"];
const STATIC_HOSTS = [
  "unpkg.com",
  "huggingface.co",
  "cdn.jsdelivr.net"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Bypass API + same-origin POST-like routes
  if (url.pathname.startsWith("/api/")) return;

  const isStaticHost = STATIC_HOSTS.some((h) => url.hostname.endsWith(h));
  if (isStaticHost || url.pathname.match(/\.(?:js|css|wasm|jpg|png|webp|svg|woff2?)$/)) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function networkFirst(req) {
  try {
    const resp = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}
