"use client";

import { useEffect, useState, useRef } from "react";
import * as api from "@/lib/api";

export default function SettingsPage() {
  const [connState, setConnState] = useState<api.ConnectionState | null>(null);
  const [connDetail, setConnDetail] = useState<any>(null);
  const [qrData, setQRData] = useState<any>(null);
  const [qrTimer, setQRTimer] = useState(0);
  const [showQR, setShowQR] = useState(false);
  const pollingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    refreshConnection();
  }, []);

  const connected = connDetail?.connected ?? connState?.connected ?? false;

  async function refreshConnection() {
    const detail = await api.getConnectionDetail().catch(() => null);
    if (detail) {
      setConnDetail(detail);
      setConnState({
        state: detail.connection_state || detail.state || "unknown",
        connected: Boolean(detail.connected),
      });
      return;
    }
    api.getConnectionState().then(setConnState).catch(() => {});
  }

  async function handleLogin() {
    setShowQR(true);
    setQRData(null);
    const data = await api.getQR();
    setQRData(data);
    setQRTimer(30);
    if (data?.count === 0) {
      setShowQR(false);
      refreshConnection();
      return;
    }
    pollingRef.current = true;
    pollConnection();
    startTimer();
  }

  async function pollConnection() {
    if (!pollingRef.current) return;
    try {
      const c = await api.getConnectionState();
      setConnState(c);
      if (c.connected) {
        pollingRef.current = false;
        setShowQR(false);
        refreshConnection();
        if (timerRef.current) clearInterval(timerRef.current);
        return;
      }
    } catch {}
    setTimeout(pollConnection, 2000);
  }

  function startTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setQRTimer(prev => {
        if (prev <= 1) {
          refreshQR();
          return 30;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function refreshQR() {
    const data = await api.getQR();
    setQRData(data);
    if (data?.count === 0) {
      setShowQR(false);
      refreshConnection();
    }
  }

  async function handleLogout() {
    await api.logout();
    refreshConnection();
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-lg font-bold">Settings</h2>

      {/* WhatsApp Connection */}
      <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
        <h3 className="text-sm font-bold text-[#e2e8f0] mb-4">WhatsApp Connection</h3>

        <div className="flex items-center gap-2 mb-4">
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-lg font-bold">{connected ? "Connected" : "Disconnected"}</span>
        </div>

        <div className="flex gap-2 mb-4">
          {!connected ? (
            <button onClick={handleLogin} className="px-4 py-2 bg-[#238636] text-white rounded-lg text-sm font-bold">Login</button>
          ) : (
            <button onClick={handleLogout} className="px-4 py-2 bg-[#da3633] text-white rounded-lg text-sm font-bold">Logout</button>
          )}
          <button onClick={refreshConnection} className="px-4 py-2 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm">Refresh</button>
        </div>

        {/* QR Modal */}
        {showQR && (
          <div className="bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-xl p-5 text-center max-w-sm">
            <h4 className="font-bold mb-3">Scan QR with WhatsApp</h4>
            <div className="bg-white rounded-lg p-3 mb-3 flex items-center justify-center min-h-[250px]">
              {qrData?.base64 ? (
                <img src={`data:image/png;base64,${qrData.base64}`} className="max-w-[250px]" alt="QR" />
              ) : (
                <div className="text-[#64748b]">Requesting QR code...</div>
              )}
            </div>
            <div className="flex items-center justify-center gap-3 mb-3">
              <div className="flex-1 bg-[#0d1117] rounded-full h-2 overflow-hidden">
                <div className="h-full bg-[#3EE88A] transition-all duration-1000" style={{ width: `${(qrTimer / 30) * 100}%` }} />
              </div>
              <span className="text-sm text-[#64748b] min-w-[60px]">{qrTimer}s</span>
            </div>
            <button onClick={refreshQR} className="px-3 py-1.5 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm">Generate New QR</button>
          </div>
        )}

        {/* Connection Details */}
        {connDetail && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            {[
              ["Device", connDetail.device_name],
              ["Phone", connDetail.phone_number],
              ["Profile", connDetail.display_name],
              ["Instance", connDetail.instance_name || connDetail.instance],
              ["Connected Since", connDetail.connected_since],
              ["Groups", connDetail.total_groups],
              ["Capture", connDetail.business_window?.label || "10 AM - 7 PM IST"],
              ["Mode", "Live webhook only"],
            ].map(([k, v]) => (
              <div key={k as string}>
                <div className="text-[10px] text-[#64748b] uppercase tracking-wider">{k as string}</div>
                <div className="text-[#e2e8f0]">{v || "—"}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Live Capture */}
      <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
        <h3 className="text-sm font-bold text-[#e2e8f0] mb-4">Live Capture</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          {[
            ["Window", "10 AM - 7 PM IST"],
            ["Mode", "Webhook only"],
            ["Backfill", "Disabled"],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-[10px] text-[#64748b] uppercase tracking-wider">{k}</div>
              <div className="text-[#e2e8f0]">{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
