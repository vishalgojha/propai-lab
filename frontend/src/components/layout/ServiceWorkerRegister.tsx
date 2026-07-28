"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then(async (registrations) => {
          // The legacy worker cached the removed inbox AI dock. This app no
          // longer needs offline shell behavior, so retire every worker and
          // its caches rather than registering another compatibility worker.
          await Promise.all(registrations.map((registration) => registration.unregister()));
          const cacheNames = await caches.keys();
          await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
        })
        .catch((error) => {
          console.warn("[SW] Cleanup failed:", error);
        });
    }
  }, []);

  return null;
}
