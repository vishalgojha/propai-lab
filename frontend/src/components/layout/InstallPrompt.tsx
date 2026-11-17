"use client";

import { useInstallPrompt } from "@/hooks/useInstallPrompt";

// Installation is optional and available only from the navigation menu.
// Never display a banner or cover workspace content when the browser offers it.
export function InstallPrompt() {
  const { show, promptInstall, installed } = useInstallPrompt();

  if (installed || !show) return null;

  return (
    <button
      type="button"
      onClick={promptInstall}
      className="mt-2 flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
    >
      Install PropAI (optional)
    </button>
  );
}
