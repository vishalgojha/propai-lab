"use client";

import { useInstallPrompt } from "@/hooks/useInstallPrompt";

export function InstallPrompt() {
  const { show, promptInstall, dismiss, installed } = useInstallPrompt();

  if (installed || !show) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 z-[900] lg:bottom-4 lg:left-auto lg:right-4 lg:w-80 animate-in fade-in">
      <div className="rounded-2xl border border-white/10 bg-black p-4 shadow-2xl">
        <div className="flex items-start gap-3">
          <img src="/propai-logo.svg" alt="" className="mt-0.5 h-8 w-8 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white">Install PropAI</div>
            <div className="mt-0.5 text-xs text-zinc-400">
              Add PropAI to your home screen for a faster experience
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={dismiss}
            className="flex-1 rounded-lg bg-white/5 px-3 py-2 text-xs font-semibold text-zinc-400 hover:bg-white/10 transition-colors"
          >
            Not now
          </button>
          <button
            onClick={promptInstall}
            className="flex-1 rounded-lg bg-propai-green px-3 py-2 text-xs font-semibold text-black hover:bg-propai-green-dark transition-colors"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );
}
