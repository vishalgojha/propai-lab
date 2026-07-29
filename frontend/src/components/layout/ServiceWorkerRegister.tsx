"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    void navigator.serviceWorker
      .getRegistrations()
      .then(async (registrations) => {
        // Retire workers from the former offline shell immediately. A worker
        // continues controlling an open tab until its next navigation, so
        // clear its caches and reload once after cleanup to guarantee that the
        // active release supplies both HTML and Next.js chunks.
        registrations.forEach((registration) => {
          registration.waiting?.postMessage({ type: "SKIP_WAITING" });
          registration.active?.postMessage({ type: "SKIP_WAITING" });
        });
        await Promise.all(registrations.map((registration) => registration.unregister()));
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.filter((cacheName) => cacheName.startsWith("propai-")).map((cacheName) => caches.delete(cacheName)));

        if (navigator.serviceWorker.controller && !sessionStorage.getItem("propai_sw_cleanup_complete")) {
          sessionStorage.setItem("propai_sw_cleanup_complete", "1");
          window.location.reload();
        }
      })
      .catch((error) => {
        console.warn("[SW] Cleanup failed:", error);
      });
  }, []);

  return null;
}
