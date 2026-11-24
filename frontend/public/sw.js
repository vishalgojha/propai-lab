// Bump this whenever the app shell changes so an old cache cannot keep serving
// deployment-specific Next.js chunks after a frontend redeploy.
// Bump on every frontend deployment so cached JS cannot retain stale
// deployment-time environment values such as the Supabase public key.
const CACHE = "propai-v20";
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

      // Claim future requests without navigating open tabs. A worker upgrade
      // must not discard unsaved forms, QR flows or an in-progress selection.

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

  // Let the browser own authenticated/streamed requests and hashed deployment
  // scripts. A worker must not sit between hydration and its required chunks,
  // nor substitute offline HTML for executable JavaScript or API data.
  if (
    url.origin !== self.location.origin ||
    url.pathname === "/sw.js" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/")
  ) return;

  if (request.mode === "navigate") {
    event.respondWith(networkOnlyNavigation(request));
    return;
  }

  // Cache only the fixed non-user-specific offline/install assets. Unknown
  // routes and scripts use the browser's native network path.
  if (request.method === "GET" && STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(networkFirstWithFallback(request, "/offline.html"));
  }
});

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
