// Bump this whenever the app shell changes so an old cache cannot keep serving
// deployment-specific Next.js chunks after a frontend redeploy.
// Bump on every frontend deployment so cached JS cannot retain stale
// deployment-time environment values such as the Supabase public key.
const CACHE = "propai-v17";
const STATIC_ASSETS = [
  "/offline.html",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/pwa-192x192-maskable.png",
  "/pwa-512x512-maskable.png",
  "/propai-logo.svg",
  "/favicon.ico",
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(STATIC_ASSETS);
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const staleKeys = keys.filter((key) => key !== CACHE);
      await Promise.all(staleKeys.map((key) => caches.delete(key)));
      await self.clients.claim();

      // Existing tabs are still executing the previous release's JavaScript, so
      // they cannot listen for this worker's controllerchange event. On upgrades,
      // navigate them once through the new network-only navigation handler.
      if (staleKeys.length > 0) {
        const windows = await self.clients.matchAll({ type: "window" });
        await Promise.all(windows.map((client) => client.navigate(client.url)));
      }
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never let an older worker cache the worker script itself. The app retires
  // legacy registrations on load, so this stays network-only during migration.
  if (url.pathname === "/sw.js") {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  // API requests are authenticated and may be streaming or multipart uploads.
  // Never send them through Cache Storage: caching an SSE response can throw
  // after the network request succeeds, and falling back to offline.html for a
  // failed POST hides the real upload error from the app.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(apiNetworkOnly(request));
    return;
  }

  // Authenticated pages include user-specific navigation and deployment-specific
  // chunk URLs. They must always come from the network, never an old app shell.
  if (request.mode === "navigate") {
    event.respondWith(networkOnlyNavigation(request));
    return;
  }

  // Deployment assets must be network-first. Next hashes its bundles, but an
  // old worker can otherwise keep serving a stale chunk until every tab closes.
  // The cache remains an offline fallback only.
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname.match(/\.(png|jpg|jpeg|svg|ico|woff2?|css|js)$/)
  ) {
    event.respondWith(networkFirstWithFallback(request, "/offline.html"));
    return;
  }

  // Everything else: network-first
  event.respondWith(networkFirstWithFallback(request, "/offline.html"));
});

// A fetch handler must always resolve to a Response. In particular, an SSE
// request such as /api/events can fail while the browser is online (or while
// the API is restarting); allowing that rejection to escape makes Chromium
// report a misleading ServiceWorker interception error and leaves the chat in
// a broken retry loop.
async function apiNetworkOnly(request) {
  try {
    return await fetch(request, { cache: "no-store" });
  } catch {
    return new Response(JSON.stringify({ error: "API unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
}

async function networkOnlyNavigation(request) {
  try {
    return await fetch(request, { cache: "no-store" });
  } catch {
    return (await caches.match("/offline.html")) || new Response("Offline", { status: 503 });
  }
}

async function networkFirstWithFallback(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === "GET") {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    const fallback = await caches.match(fallbackUrl);
    if (fallback) return fallback;
    return new Response("Offline", { status: 503 });
  }
}
