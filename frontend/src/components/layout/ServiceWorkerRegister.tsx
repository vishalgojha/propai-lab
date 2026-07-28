"use client";

import { useEffect } from "react";

// Changing this URL forces browsers that still have an older worker cached to
// install the current worker instead of continuing to serve the old app shell.
const SERVICE_WORKER_VERSION = "20260728-3";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      const hadController = Boolean(navigator.serviceWorker.controller);
      let refreshing = false;
      const activateFreshShell = () => {
        if (!hadController || refreshing) return;
        refreshing = true;
        window.location.reload();
      };

      navigator.serviceWorker.addEventListener("controllerchange", activateFreshShell);
      navigator.serviceWorker
        .getRegistrations()
        .then(async (registrations) => {
          // Retire workers from releases that contained the removed legacy
          // inbox AI dock.  Those workers can keep serving cached chunks even
          // after the page source no longer contains that panel.
          await Promise.all(registrations.map((registration) => registration.unregister()));
          const cacheNames = await caches.keys();
          await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
          return navigator.serviceWorker.register(`/sw.js?v=${SERVICE_WORKER_VERSION}`, { updateViaCache: "none" });
        })
        .then(async (registration) => {
          console.log("[SW] Registered:", registration.scope);
          await registration.update();
        })
        .catch((error) => {
          console.warn("[SW] Registration failed:", error);
        });

      return () => {
        navigator.serviceWorker.removeEventListener("controllerchange", activateFreshShell);
      };
    }
  }, []);

  return null;
}
