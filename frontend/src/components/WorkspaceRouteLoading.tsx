"use client";

import { useEffect, useState } from "react";

// This is a route fallback, not an authentication result. Keep the surrounding
// authenticated shell responsive while the page's JavaScript or data loads.
export function WorkspaceRouteLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 10000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="mx-auto w-full max-w-xl p-6 text-text-primary" role="status" aria-live="polite">
      <h1 className="text-base font-semibold">Loading WhatsApp page...</h1>
      <p className="mt-2 text-sm text-text-muted">
        {slow ? "This page is taking longer than expected. You can reload it or use the menu to open another page." : "Your workspace is open. Waiting for this page to finish loading."}
      </p>
      {slow && (
        <button type="button" onClick={() => window.location.reload()} className="mt-4 min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-hover">
          Reload page
        </button>
      )}
    </div>
  );
}
