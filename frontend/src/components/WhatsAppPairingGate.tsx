"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "react-qr-code";
import { RefreshCw, QrCode, LoaderCircle, Wifi, WifiOff } from "lucide-react";
import { getConnectionState, getQR, type ConnectionState, type SyncQrState } from "@/lib/api";

const POLL_MS = 3000;
const QR_TTL_MS = 45000;

type WhatsAppPairingGateProps = {
  embedded?: boolean;
  autoRedirect?: boolean;
};

export default function WhatsAppPairingGate({ embedded = false, autoRedirect = true }: WhatsAppPairingGateProps) {
  const router = useRouter();
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [qrState, setQrState] = useState<SyncQrState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastExpiredRefreshKey = useRef("");
  const connectionState = connection?.state || "unknown";
  const connectionConnected = connection?.connected || false;
  const expiredRefreshKey = `${qrState?.qr_updated_at || ""}:${connectionState}`;

  useEffect(() => {
    let active = true;

    const loadConnection = async () => {
      try {
        const next = await getConnectionState();
        if (!active) return;
        setConnection(next);
        if (next.connected && autoRedirect) {
          router.replace("/dashboard");
          return;
        }
      } catch {
        if (active) setConnection(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadConnection();
    const interval = setInterval(() => {
      void loadConnection();
    }, POLL_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [autoRedirect, router]);

  useEffect(() => {
    if (connectionConnected) return;
    if (connectionState !== "qr" && connectionState !== "connecting") return;

    let active = true;
    const loadQr = async () => {
      try {
        const next = await getQR();
        if (active) setQrState(next);
      } catch {
        if (active) setQrState(null);
      }
    };

    void loadQr();
    const interval = setInterval(() => {
      void loadQr();
    }, POLL_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [connectionState, connectionConnected]);

  useEffect(() => {
    if (connectionConnected && autoRedirect) {
      router.replace("/dashboard");
    }
  }, [connectionConnected, autoRedirect, router]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const state = qrState?.state || connectionState;
  const connected = qrState?.connected ?? connectionConnected;
  const qr = qrState?.qr || null;
  const qrUpdatedAt = qrState?.qr_updated_at || null;
  const qrExpiresAt = qrUpdatedAt ? new Date(qrUpdatedAt).getTime() + QR_TTL_MS : null;
  const qrTimeLeftMs = qrExpiresAt ? qrExpiresAt - now : null;
  const qrSecondsLeft = qrTimeLeftMs == null ? null : Math.max(0, Math.ceil(qrTimeLeftMs / 1000));
  const qrExpired = Boolean(qr && qrSecondsLeft !== null && qrSecondsLeft <= 0);
  const showQr = Boolean(qr) && !qrExpired && (state === "qr" || state === "connecting" || state === "open");
  const waitingForQr = !qr && (state === "qr" || state === "connecting" || state === "unknown");
  const needsRestart = state === "closed" || state === "logged_out";

  async function refreshNow() {
    setRefreshing(true);
    try {
      const nextConnection = await getConnectionState();
      setConnection(nextConnection);
      if (nextConnection.connected && autoRedirect) {
        router.replace("/dashboard");
        return;
      }
      if (nextConnection.state === "qr" || nextConnection.state === "connecting") {
        const nextQr = await getQR();
        setQrState(nextQr);
      }
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }

  useEffect(() => {
    if (connectionConnected) return;
    if (!qrUpdatedAt) return;
    if (!qrExpired) return;
    if (state !== "qr" && state !== "connecting") return;
    if (lastExpiredRefreshKey.current === expiredRefreshKey) return;
    lastExpiredRefreshKey.current = expiredRefreshKey;

    let active = true;
    const refreshExpiredQr = async () => {
      try {
        setRefreshing(true);
        const nextConnection = await getConnectionState();
        if (!active) return;
        setConnection(nextConnection);
        if (nextConnection.connected && autoRedirect) {
          router.replace("/dashboard");
          return;
        }
        if (nextConnection.state === "qr" || nextConnection.state === "connecting") {
          const nextQr = await getQR();
          if (active) setQrState(nextQr);
        }
      } finally {
        if (active) {
          setRefreshing(false);
          setLoading(false);
        }
      }
    };

    void refreshExpiredQr();
    return () => {
      active = false;
    };
  }, [autoRedirect, connectionConnected, expiredRefreshKey, qrExpired, qrUpdatedAt, router, state]);

  const qrCard = (
    <div className="rounded-[24px] border border-white/10 bg-black/90 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">QR panel</div>
          <div className="mt-1 text-lg font-semibold text-white">{embedded ? "Pair from settings" : "Scan from your phone"}</div>
        </div>
        <QrCode className="h-5 w-5 text-[#3EE88A]" />
      </div>

      <div className="mt-5 flex min-h-[320px] items-center justify-center rounded-[22px] border border-white/10 bg-zinc-900 p-6">
        {showQr && qr ? (
          <div className="rounded-2xl bg-white p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            <QRCode
              key={qrUpdatedAt || qr}
              value={qr}
              size={248}
              bgColor="#ffffff"
              fgColor="#0d1117"
              level="M"
            />
          </div>
        ) : (
          <div className="text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[rgba(62,232,138,0.2)] bg-[rgba(62,232,138,0.08)]">
              <LoaderCircle className="h-7 w-7 animate-spin text-[#3EE88A]" />
            </div>
            <div className="mt-4 text-sm font-medium text-white">
              {qrExpired ? "QR expired" : waitingForQr ? "Waiting for the first QR" : "Pairing status"}
            </div>
            <div className="mt-2 max-w-xs text-xs leading-5 text-zinc-500">
              {waitingForQr
                ? "Starting up the WhatsApp service. The QR code will appear in a moment."
                : qrExpired
                  ? "This QR is no longer valid. A fresh code will appear automatically when the WhatsApp session rotates it."
                : needsRestart
                  ? "A new QR will appear after the WhatsApp session is restarted."
                  : "The dashboard will replace this screen automatically once the session is connected."}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
        <span>Polling every 3 seconds</span>
        <span>{qrSecondsLeft === null ? "TTL unknown" : qrExpired ? "Expired" : `${qrSecondsLeft}s left`}</span>
        <span>{connected ? "Connected" : state.replace("_", " ")}</span>
      </div>
    </div>
  );

  const controls = (
    <div className="mt-6 flex flex-wrap gap-3">
      <button
        type="button"
        onClick={() => void refreshNow()}
        className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-white hover:border-[rgba(255,255,255,0.18)]"
      >
        <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        Refresh
      </button>
      <a
        href="/settings"
        className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-transparent px-4 py-2.5 text-sm font-medium text-zinc-400 hover:text-white"
      >
        Open settings
      </a>
    </div>
  );

  if (embedded) {
    return (
      <div className="w-full rounded-2xl border border-white/10 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-400">
              <Wifi className="h-3.5 w-3.5 text-[#3EE88A]" />
              WhatsApp pairing
            </div>
            <h2 className="mt-4 text-2xl font-bold leading-tight text-white">Connect WhatsApp from settings.</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
              This shared session unlocks the dashboard once the code is scanned. Keep this tab open until PropAI reports connected.
            </p>
          </div>
          <div className="hidden sm:block rounded-full border border-white/10 bg-black/90 px-3 py-1 text-[11px] text-zinc-400">
            {connected ? "Connected" : state.replace("_", " ")}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-black/90 p-4">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">State</div>
            <div className="mt-1 flex items-center gap-2 text-sm font-semibold">
              {connected ? (
                <>
                  <Wifi className="h-4 w-4 text-[#3EE88A]" />
                  Connected
                </>
              ) : needsRestart ? (
                <>
                  <WifiOff className="h-4 w-4 text-[#f59e0b]" />
                  {state.replace("_", " ")}
                </>
              ) : (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin text-[#3EE88A]" />
                  {state === "unknown" ? "Waiting for QR" : state}
                </>
              )}
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/90 p-4">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Updated</div>
            <div className="mt-1 text-sm font-semibold text-white">
              {qrUpdatedAt ? new Date(qrUpdatedAt).toLocaleString() : loading ? "Loading..." : "No QR yet"}
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_360px]">
          <div className="space-y-3 text-sm text-zinc-400">
            <p>1. Open WhatsApp on your phone.</p>
            <p>2. Tap Linked devices and scan the code shown here.</p>
            <p>3. Keep this page open until the dashboard appears.</p>
            {needsRestart && (
              <div className="rounded-2xl border border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.08)] px-4 py-3 text-sm text-[#fbbf24]">
                WhatsApp is {state.replace("_", " ")}. Restart the WhatsApp service and this page will pick up the next QR automatically.
              </div>
            )}
            {qrExpired && !needsRestart && (
              <div className="rounded-2xl border border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.08)] px-4 py-3 text-sm text-[#fbbf24]">
                This QR expired. A fresh one will load automatically when WhatsApp rotates the session code.
              </div>
            )}
            {controls}
          </div>
          {qrCard}
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-5xl rounded-[28px] border border-white/10 shadow-2xl shadow-black/30 overflow-hidden">
        <div className="grid gap-0 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="p-6 sm:p-8 lg:p-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-400">
              <Wifi className="h-3.5 w-3.5 text-[#3EE88A]" />
              WhatsApp pairing
            </div>

            <h1 className="mt-5 max-w-xl text-3xl font-bold leading-tight sm:text-4xl">
              Scan the QR with WhatsApp to unlock PropAI.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
              This deployment uses one shared WhatsApp session. Once the phone is paired, the dashboard loads automatically and keeps polling in the background.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-black/90 p-4">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">State</div>
                <div className="mt-1 flex items-center gap-2 text-sm font-semibold">
                  {connected ? (
                    <>
                      <Wifi className="h-4 w-4 text-[#3EE88A]" />
                      Connected
                    </>
                  ) : needsRestart ? (
                    <>
                      <WifiOff className="h-4 w-4 text-[#f59e0b]" />
                      {state.replace("_", " ")}
                    </>
                  ) : (
                    <>
                      <LoaderCircle className="h-4 w-4 animate-spin text-[#3EE88A]" />
                      {state === "unknown" ? "Waiting for QR" : state}
                    </>
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/90 p-4">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Updated</div>
                <div className="mt-1 text-sm font-semibold text-white">
                  {qrUpdatedAt ? new Date(qrUpdatedAt).toLocaleString() : loading ? "Loading..." : "No QR yet"}
                </div>
              </div>
            </div>

            <div className="mt-6 space-y-3 text-sm text-zinc-400">
              <p>1. Open WhatsApp on your phone.</p>
              <p>2. Tap Linked devices and scan the code shown here.</p>
              <p>3. Keep this page open until the dashboard appears.</p>
            </div>

            {needsRestart && (
              <div className="mt-6 rounded-2xl border border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.08)] px-4 py-3 text-sm text-[#fbbf24]">
                WhatsApp is {state.replace("_", " ")}. Restart the ingestor and this page will pick up the next QR automatically.
              </div>
            )}
            {qrExpired && !needsRestart && (
              <div className="mt-6 rounded-2xl border border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.08)] px-4 py-3 text-sm text-[#fbbf24]">
                This QR expired. A fresh one will load automatically when the session code rotates.
              </div>
            )}

            {controls}
          </section>

          <aside className="flex items-center justify-center border-t border-white/10 bg-[radial-gradient(circle_at_top,rgba(62,232,138,0.14),transparent_55%),linear-gradient(180deg,#0d1117,#090d12)] p-6 sm:p-8 lg:border-l lg:border-t-0">
            {qrCard}
          </aside>
        </div>
      </div>
    </main>
  );
}
