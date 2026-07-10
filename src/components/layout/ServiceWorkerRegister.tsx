"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log("[SW] Registered:", registration.scope);
        })
        .catch((error) => {
          console.warn("[SW] Registration failed:", error);
        });
    }
  }, []);

  return null;
}
