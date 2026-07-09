"use client";

import { useEffect, useState, useCallback } from "react";

interface NotificationPermissionState {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
}

export function useNotificationSetup() {
  const [state, setState] = useState<NotificationPermissionState>({
    supported: false,
    permission: "unsupported",
    subscribed: false,
  });

  useEffect(() => {
    const supported = "Notification" in window && "serviceWorker" in navigator;
    if (!supported) {
      setState({ supported: false, permission: "unsupported", subscribed: false });
      return;
    }
    setState({
      supported: true,
      permission: Notification.permission,
      subscribed: false,
    });
  }, []);

  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setState((prev) => ({ ...prev, permission: result }));
    return result;
  }, []);

  return {
    ...state,
    requestPermission,
  };
}
