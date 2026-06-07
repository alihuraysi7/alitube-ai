const CACHE_NAME = "ali-youtube-v1";

const PRECACHE_URLS = [
  "/",
  "/offline.html"
];

const STATIC_EXTENSIONS = new Set([
  ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp",
  ".ico", ".woff", ".woff2", ".ttf", ".otf"
]);

function isStaticAsset(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.includes(".")
      ? "." + pathname.split(".").pop().toLowerCase()
      : "";
    return STATIC_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function isApiCall(url) {
  try {
    return new URL(url).pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/* ── Install: pre-cache shell ── */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

/* ── Activate: evict old caches ── */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch ── */
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET
  if (request.method !== "GET") return;

  const url = request.url;

  // Skip API calls entirely — never intercept translation responses
  if (isApiCall(url)) return;

  // Navigation requests (HTML pages): network-first, offline fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match("/offline.html").then((r) => r || caches.match("/"))
        )
    );
    return;
  }

  // Static assets (JS, CSS, fonts, icons, images): cache-first, then network
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (!response || response.status !== 200 || response.type === "opaque") {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Everything else: network only
});
