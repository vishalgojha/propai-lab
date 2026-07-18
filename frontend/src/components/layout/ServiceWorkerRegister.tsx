"use client";

import { useEffect } from "react";

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
        .register("/sw.js", { updateViaCache: "none" })
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
