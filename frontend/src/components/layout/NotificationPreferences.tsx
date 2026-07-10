"use client";

import { useNotificationSetup } from "@/hooks/useNotificationSetup";
import { Bell, BellOff } from "lucide-react";

export function NotificationPreferences() {
  const { supported, permission, requestPermission } = useNotificationSetup();

  if (!supported) {
    return (
      <div className="rounded-xl border border-white/10 p-4">
        <h3 className="text-sm font-bold text-white">Notifications</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Notifications are not supported in this browser.
        </p>
      </div>
    );
  }

  const enabled = permission === "granted";

  return (
    <div className="rounded-xl border border-white/10 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {enabled ? (
            <Bell className="w-5 h-5 text-[#3EE88A]" />
          ) : (
            <BellOff className="w-5 h-5 text-zinc-500" />
          )}
          <div>
            <h3 className="text-sm font-bold text-white">Push Notifications</h3>
            <p className="text-xs text-zinc-500">
              {enabled
                ? "Notifications are enabled"
                : permission === "denied"
                  ? "Notifications were blocked. Update your browser settings."
                  : "Get notified about new messages and updates"}
            </p>
          </div>
        </div>
        {!enabled && permission !== "denied" && (
          <button
            onClick={requestPermission}
            className="rounded-lg bg-[#3EE88A] px-3 py-1.5 text-xs font-bold text-black min-h-[36px]"
          >
            Enable
          </button>
        )}
      </div>
    </div>
  );
}
