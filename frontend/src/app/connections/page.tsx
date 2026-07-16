"use client";

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useRouter } from "next/navigation";
import { Activity, Clock, Database, ImageUp, Inbox, List, LogOut, MessageSquare, Plus, RefreshCw, Shield, Smartphone, Trash2, AlertTriangle, Users, Zap, Lock, X } from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";
import { getPhones, getPhone, createPhone, deletePhone, resetPhone, disconnectPhone, connectPhone, fetchJSON, type Phone, type WhatsAppStatus } from "@/lib/api";

type HealthStatus = "healthy" | "warning" | "error";

function StatusDot({ status }: { status: HealthStatus }) {
  const colors = { healthy: "bg-emerald-400", warning: "bg-amber-400", error: "bg-red-400" };
  return <span className={`w-2 h-2 rounded-full ${colors[status]} shrink-0`} />;
}

function StatBox({ icon, label, value, status }: { icon: React.ReactNode; label: string; value: string; status?: HealthStatus }) {
  return (
    <div className="flex items-center gap-3 p-4">
      <div className="flex h-10 w-10 items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{label}</div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-sm font-bold text-white truncate">{value}</span>
          {status && <StatusDot status={status} />}
        </div>
      </div>
    </div>
  );
}

function HealthRow({ label, status, detail }: { label: string; status: HealthStatus; detail: string }) {
  const labels = { healthy: "Healthy", warning: "Warning", error: "Error" };
  const colors = { healthy: "text-emerald-400", warning: "text-amber-400", error: "text-red-400" };
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-white/[0.04] last:border-0">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">{detail}</span>
        <span className={`text-[11px] font-semibold ${colors[status]}`}>{labels[status]}</span>
        <StatusDot status={status} />
      </div>
    </div>
  );
}

function ActivityItem({ icon, text, time }: { icon: React.ReactNode; text: string; time: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 flex h-6 w-6 items-center justify-center">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-zinc-300">{text}</div>
        <div className="text-[11px] text-zinc-600">{time}</div>
      </div>
    </div>
  );
}

function QRDisplay({ qrText, onRefresh, refreshing }: { qrText: string; onRefresh: () => void; refreshing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, qrText, {
      width: 360,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  }, [qrText]);

  return (
    <div className="flex flex-col items-center">
      <canvas
        ref={canvasRef}
        className="rounded-xl border-[6px] border-white bg-white"
        style={{ width: "min(360px, 100%)", height: "min(360px, 100%)", aspectRatio: "1/1" }}
      />
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="mt-3 rounded-lg bg-[#3EE88A] px-4 py-2.5 text-xs font-bold text-black min-h-[44px] disabled:opacity-50 w-full max-w-[360px]"
      >
        {refreshing ? "Refreshing..." : "Refresh QR"}
      </button>
    </div>
  );
}

function LoadingDots() {
  const [dots, setDots] = useState("");
  useEffect(() => {
    const interval = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 500);
    return () => clearInterval(interval);
  }, []);
  return <span>{dots}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <div className="px-5 py-3 border-b border-white/10">
        <h3 className="text-sm font-bold text-white">{title}</h3>
      </div>
      <div className="px-5 py-3">{children}</div>
    </div>
  );
}

function ActionButton({ icon, label, onClick, variant, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; variant?: "primary" | "danger" | "default"; disabled?: boolean }) {
  const styles = {
    primary: "bg-[#3EE88A] text-black hover:bg-[#3EE88A]/90",
    danger: "border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20",
    default: "border border-white/10 bg-zinc-800 text-zinc-300 hover:bg-zinc-700",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-bold min-h-[44px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${styles[variant || "default"]}`}
    >
      {icon}
      {label}
    </button>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

function formatPhone(p: string) {
  if (!p) return "—";
  if (p.startsWith("+")) return p;
  const digits = p.replace(/\D/g, "");
  if (digits.length === 12) return `+${digits.slice(0, 2)} ${digits.slice(2)}`;
  if (digits.length === 10) return `+91 ${digits}`;
  return `+${digits}`;
}

function isPlaceholderPhone(phoneNumber?: string | null) {
  if (!phoneNumber) return true;
  const text = phoneNumber.trim();
  if (!text) return true;
  if (text.startsWith("Unpaired")) return true;
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) return true;
  if (digits.length === 10 && /^0+$/.test(digits)) return true;
  return digits.length < 10;
}

function normalizePhoneDigits(value?: string | null) {
  return (value || "").replace(/\D/g, "");
}

function isConnectedPhone(status: Pick<Phone, "connected" | "connection_state" | "connected_since">) {
  return Boolean(
    status.connected ||
    status.connection_state === "open" ||
    status.connection_state === "connected" ||
    status.connected_since
  );
}

function matchesLiveStatus(phone: Phone, status: WhatsAppStatus | null) {
  if (!status || !api.isLiveWhatsAppConnection(status)) return false;
  const liveDigits = normalizePhoneDigits(status.phone);
  if (!liveDigits) return false;
  const candidateDigits = [
    phone.phone_number_live,
    phone.phone_number,
    phone.display_name,
    phone.instance_name,
  ]
    .map(normalizePhoneDigits)
    .filter(Boolean);
  return candidateDigits.includes(liveDigits);
}

function CreatePhoneDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => Promise<void> | void }) {
  const [instanceName, setInstanceName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      await createPhone({ instance_name: instanceName.trim() || undefined });
      setInstanceName("");
      await onCreated();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Failed to create phone");
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-white">Add Phone</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-4">Create a new WhatsApp connection. The phone number will be detected automatically when you scan the QR code.</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Agency / Workspace Name (optional)</label>
            <input
              type="text"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="e.g. Ananta Realty"
              className="w-full rounded-lg bg-zinc-800 border border-white/10 px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-[#3EE88A]/50"
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/10 bg-zinc-800 text-zinc-300 px-4 py-2.5 text-xs font-bold min-h-[44px]">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 rounded-lg bg-[#3EE88A] text-black px-4 py-2.5 text-xs font-bold min-h-[44px] disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create Phone"}
          </button>
        </div>
      </div>
    </div>
  );
}

type ConnectionAttemptState = {
  attempts: number;
  startedAt: string | null;
  lastOutcome: "connected" | "failed" | null;
  lastDurationSeconds: number | null;
};

function QRModal({
  phone,
  open,
  onClose,
  onRefresh,
  attemptState,
  now,
}: {
  phone: Phone;
  open: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  attemptState: ConnectionAttemptState | null;
  now: number;
}) {
  const [qrText, setQrText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchQR = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const qrResult = await getPhone(phone.id);
      if (qrResult?.qr) {
        setQrText(qrResult.qr);
        setError(null);
        setNotice(null);
        return;
      }
      if (qrResult?.connected || qrResult?.connection_state === "open" || qrResult?.connected_since) {
        setConnected(true);
        setQrText(null);
        setNotice(null);
        await onRefresh();
        window.dispatchEvent(new Event("propai_whatsapp_status_updated"));
        return;
      }
      setNotice((qrResult as any)?.message || "QR not available yet. Waiting for the ingestor to generate it.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to fetch QR code. Retry, or reset the phone if it stays stuck.");
    } finally {
      setLoading(false);
    }
  }, [onRefresh, phone.id]);

  const refreshSessionAndFetchQR = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await resetPhone(phone.id);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await fetchQR();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to refresh the session. Retry, or reset the phone if it stays stuck.");
    } finally {
      setLoading(false);
    }
  }, [fetchQR, phone.id]);

  useEffect(() => {
    if (open) {
      setConnected(false);
      fetchQR();
    }
    if (!open) {
      setQrText(null);
      setConnected(false);
    }
  }, [open, fetchQR]);

  useEffect(() => {
    if (!open || connected) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const res = await getPhone(phone.id);
        if (isConnectedPhone(res)) {
          setConnected(true);
          setQrText(null);
          setNotice(null);
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        } else if (res.qr && res.qr !== qrText) {
          setQrText(res.qr);
          setNotice(null);
        }
      } catch {}
    }, 3000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [open, connected, phone.id, qrText]);

  useEffect(() => {
    if (attemptState?.lastOutcome === "failed" && !connected) {
      setError(`Connection attempt failed after ${attemptState.lastDurationSeconds ?? 0}s. Retry or refresh the session.`);
      setLoading(false);
    }
  }, [attemptState?.lastDurationSeconds, attemptState?.lastOutcome, connected]);

  useEffect(() => {
    if (!canvasRef.current || !qrText) return;
    QRCode.toCanvas(canvasRef.current, qrText, {
      width: 320,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  }, [qrText]);

  useEffect(() => {
    if (connected) {
      onRefresh();
      const t = setTimeout(onClose, 2000);
      return () => clearTimeout(t);
    }
  }, [connected, onClose, onRefresh]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-white">
            {connected ? "Connected!" : `Scan QR — ${isPlaceholderPhone(phone.phone_number) ? "New Phone" : formatPhone(phone.phone_number)}`}
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        {attemptState && (
          <div className="mb-4 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-xs text-zinc-400">
            <div className="flex items-center justify-between gap-3">
              <span>Connection attempts</span>
              <span className="font-semibold text-white">{attemptState.attempts}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span>Current attempt</span>
              <span className="font-semibold text-white">
                {attemptState.startedAt
                  ? `${formatDuration(Math.max(0, Math.floor((now - new Date(attemptState.startedAt).getTime()) / 1000)))} elapsed`
                  : "—"}
              </span>
            </div>
            {attemptState.lastOutcome && attemptState.lastDurationSeconds != null && (
              <div className="mt-1 flex items-center justify-between gap-3">
                <span>Last result</span>
                <span className={`font-semibold ${attemptState.lastOutcome === "connected" ? "text-emerald-400" : "text-red-400"}`}>
                  {attemptState.lastOutcome === "connected" ? "Connected" : "Failed"} in {formatDuration(attemptState.lastDurationSeconds)}
                </span>
              </div>
            )}
          </div>
        )}
        {!connected && notice && !error && !loading && (
          <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
            {notice}
          </div>
        )}
        {connected && (
          <div className="flex flex-col items-center py-12 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-400/10 mb-4">
              <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            </div>
            <p className="text-sm text-emerald-400 font-semibold">WhatsApp connected successfully</p>
            <p className="text-xs text-zinc-500 mt-1">Closing automatically...</p>
          </div>
        )}
        {!connected && loading && (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 rounded-full border-2 border-zinc-600 border-t-[#3EE88A] animate-spin" />
          </div>
        )}
        {!connected && error && (
          <div className="flex flex-col items-center py-12 text-center">
            <p className="text-sm text-zinc-400">{error}</p>
            <button onClick={() => refreshSessionAndFetchQR().catch(() => {})} disabled={loading} className="mt-4 rounded-lg bg-[#3EE88A] px-6 py-2.5 text-xs font-bold text-black min-h-[44px] disabled:opacity-50">
              Retry
            </button>
          </div>
        )}
        {!connected && !loading && !error && qrText && (
          <div className="flex flex-col items-center">
            <canvas ref={canvasRef} className="rounded-xl border-[6px] border-white bg-white" style={{ width: "min(320px, 100%)", height: "min(320px, 100%)", aspectRatio: "1/1" }} />
            <ol className="mt-4 space-y-2 text-sm text-zinc-400 text-center">
              <li>Open <strong className="text-white">WhatsApp</strong> → <strong className="text-white">Settings</strong> → <strong className="text-white">Linked Devices</strong></li>
              <li>Tap <strong className="text-white">Link a Device</strong> and scan this QR</li>
            </ol>
            <p className="mt-3 text-[11px] text-zinc-600">Waiting for scan... (auto-refreshes every 3s)</p>
            <button onClick={refreshSessionAndFetchQR} disabled={loading} className="mt-3 rounded-lg border border-white/10 bg-zinc-800 text-zinc-300 px-6 py-2.5 text-xs font-bold min-h-[44px] disabled:opacity-50 w-full">
              Refresh QR
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PhoneCard({
  phone,
  liveStatus,
  onRefresh,
  onShowQR,
  onConnect,
  attemptState,
  now,
}: {
  phone: Phone;
  liveStatus: WhatsAppStatus | null;
  onRefresh: () => Promise<void> | void;
  onShowQR: (p: Phone) => void;
  onConnect: (p: Phone) => Promise<void> | void;
  attemptState: ConnectionAttemptState | null;
  now: number;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleAction = async (action: string) => {
    setActionLoading(action);
    try {
      if (action === "disconnect") await disconnectPhone(phone.id);
      else if (action === "reset") await resetPhone(phone.id);
      else if (action === "delete") await deletePhone(phone.id);
      else if (action === "connect") await onConnect(phone);
      else await onRefresh();
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const isConnected = isConnectedPhone(phone) || matchesLiveStatus(phone, liveStatus);
  const phoneDisplay = phone.phone_number_live || phone.phone_number;
  const isUnpaired = !isConnected && isPlaceholderPhone(phoneDisplay);
  const health: HealthStatus = isConnected ? "healthy" : isUnpaired ? "warning" : "error";

  return (
    <div className="rounded-2xl border border-white/10 p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#3EE88A]/10">
          <Smartphone className="w-5 h-5 text-[#3EE88A]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">{isUnpaired ? "New Phone" : formatPhone(phoneDisplay)}</span>
            <StatusDot status={health} />
          </div>
          {phone.instance_name && <div className="text-xs text-zinc-500">{phone.instance_name}</div>}
          {isUnpaired && (
            <div className="text-[11px] text-amber-400 mt-0.5">Scan QR to pair</div>
          )}
          {!isConnected && !isUnpaired && (
            <div className="text-[11px] text-amber-400 mt-0.5">Disconnected</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-0 text-center [&>*:nth-child(2n)]:border-l [&>*:nth-child(2n)]:border-white/10 [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-white/10">
        <div className="py-2">
          <div className="text-[11px] text-zinc-500 uppercase">Status</div>
          <div className={`text-xs font-semibold ${isConnected ? "text-emerald-400" : "text-amber-400"}`}>{isConnected ? "Connected" : "Disconnected"}</div>
        </div>
        <div className="py-2">
          <div className="text-[11px] text-zinc-500 uppercase">Last Active</div>
          <div className="text-xs font-semibold text-white">{formatTime(phone.last_message_at)}</div>
        </div>
        <div className="py-2">
          <div className="text-[11px] text-zinc-500 uppercase">Connected</div>
          <div className="text-xs font-semibold text-white">{phone.connected_since ? formatTime(phone.connected_since) : "—"}</div>
        </div>
        <div className="py-2">
          <div className="text-[11px] text-zinc-500 uppercase">Messages</div>
          <div className="text-xs font-semibold text-white">{phone.total_messages_received?.toLocaleString() || "0"}</div>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-[11px] text-zinc-400">
        <div className="flex items-center justify-between gap-3">
          <span>Connection attempts</span>
          <span className="font-semibold text-white">{attemptState?.attempts ?? 0}</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <span>Current attempt</span>
          <span className="font-semibold text-white">
            {attemptState?.startedAt
              ? `${formatDuration(Math.max(0, Math.floor((now - new Date(attemptState.startedAt).getTime()) / 1000)))} elapsed`
              : "—"}
          </span>
        </div>
        {attemptState?.lastOutcome && attemptState.lastDurationSeconds != null && (
          <div className="mt-1 flex items-center justify-between gap-3">
            <span>Last result</span>
            <span className={`font-semibold ${attemptState.lastOutcome === "connected" ? "text-emerald-400" : "text-red-400"}`}>
              {attemptState.lastOutcome === "connected" ? "Connected" : "Failed"} in {formatDuration(attemptState.lastDurationSeconds)}
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2">
        <ActionButton icon={<ImageUp className="w-3.5 h-3.5" />} label="QR" onClick={() => onShowQR(phone)} />
        <ActionButton
          icon={isConnected ? <LogOut className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
          label={isConnected ? "Disconnect" : actionLoading === "connect" ? "Connecting..." : "Connect"}
          onClick={() => handleAction(isConnected ? "disconnect" : "connect")}
          variant={isConnected ? "danger" : "primary"}
          disabled={actionLoading === "connect"}
        />
        <ActionButton icon={<RefreshCw className="w-3.5 h-3.5" />} label="Reset" onClick={() => handleAction("reset")} />
        <ActionButton icon={<Trash2 className="w-3.5 h-3.5" />} label="Delete" onClick={() => handleAction("delete")} variant="danger" />
      </div>
    </div>
  );
}

function LiveStatusCard({ status, onAddPhone }: { status: WhatsAppStatus | null; onAddPhone: () => void }) {
  const connected = Boolean(status?.connected || status?.state === "open" || status?.state === "connected" || status?.connected_since);
  const headline = connected ? "WhatsApp connected" : "Checking WhatsApp connection";

  return (
    <div className="rounded-2xl border border-white/10 p-5 mb-8 bg-gradient-to-br from-emerald-500/5 via-transparent to-transparent">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#3EE88A]/10">
          <Smartphone className="w-5 h-5 text-[#3EE88A]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">{headline}</span>
            <StatusDot status={connected ? "healthy" : "warning"} />
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {connected ? "Live WhatsApp session detected" : "Live session state is being checked"}
          </div>
        </div>
      </div>
      <div className="mt-4">
        <button
          onClick={onAddPhone}
          className="rounded-lg bg-[#3EE88A] text-black px-4 py-2.5 text-xs font-bold min-h-[44px]"
        >
          Add Phone
        </button>
      </div>
    </div>
  );
}

export default function ConnectionCenterPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/login?next=/connections");
    }
  }, [user, authLoading, router]);

  const [phones, setPhones] = useState<Phone[]>([]);
  const [liveStatus, setLiveStatus] = useState<WhatsAppStatus | null>(null);
  const [phonesLoading, setPhonesLoading] = useState(true);
  const [phonesError, setPhonesError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [qrPhone, setQrPhone] = useState<Phone | null>(null);
  const [connectionAttempts, setConnectionAttempts] = useState<Record<number, ConnectionAttemptState>>({});
  const [now, setNow] = useState(() => Date.now());

  const [totalParsed, setTotalParsed] = useState<number>(0);
  const [totalListings, setTotalListings] = useState<number>(0);
  const [totalRequirements, setTotalRequirements] = useState<number>(0);
  const [totalBrokers, setTotalBrokers] = useState<number>(0);
  const [rawTotal, setRawTotal] = useState<number>(0);
  const [rawProcessed, setRawProcessed] = useState<number>(0);
  const [rawPending, setRawPending] = useState<number>(0);
  const [extractionPct, setExtractionPct] = useState<number>(0);
  const [recentlyProcessed1h, setRecentlyProcessed1h] = useState<number>(0);
  const [extractionLag, setExtractionLag] = useState<any>(null);

  const fetchPhones = useCallback(async () => {
    let initialPhones: Phone[] = [];
    try {
      const res = await getPhones(false, 7000);
      initialPhones = res.phones || [];
      setPhones(initialPhones);
      setPhonesError(null);
    } catch (error) {
      setPhonesError(error instanceof Error ? error.message : "Could not load phones right now.");
    }
    setPhonesLoading(false);
  }, []);

  const fetchLiveStatus = useCallback(async () => {
    try {
      const status = await fetchJSON<WhatsAppStatus>("/dashboard/whatsapp-status", undefined, 8000);
      setLiveStatus(status);
    } catch { /* ignore */ }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const [stats, syncAct] = await Promise.all([
        fetchJSON<any>("/stats", undefined, 8000).catch(() => ({})),
        fetchJSON<any>("/dashboard/sync-activity", undefined, 8000).catch(() => ({})),
      ]);
      if (stats?.total_parsed != null) setTotalParsed(stats.total_parsed);
      if (stats?.total_listings != null) setTotalListings(stats.total_listings);
      if (stats?.total_requirements != null) setTotalRequirements(stats.total_requirements);
      if (stats?.total_brokers != null) setTotalBrokers(stats.total_brokers);
      const ext = syncAct?.extraction;
      if (ext) {
        if (ext.total_raw != null) setRawTotal(ext.total_raw);
        if (ext.processed != null) setRawProcessed(ext.processed);
        if (ext.pending != null) setRawPending(ext.pending);
        if (ext.pct != null) setExtractionPct(ext.pct);
      }
      try {
        const extProgress = await fetchJSON<any>("/extraction/progress", undefined, 8000);
        if (extProgress?.recently_processed_1h != null) setRecentlyProcessed1h(extProgress.recently_processed_1h);
        if (extProgress?.lag != null) setExtractionLag(extProgress.lag);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const updateAttemptState = useCallback((phoneId: number, updater: (current: ConnectionAttemptState) => ConnectionAttemptState) => {
    setConnectionAttempts((prev) => {
      const current = prev[phoneId] || { attempts: 0, startedAt: null, lastOutcome: null, lastDurationSeconds: null };
      return {
        ...prev,
        [phoneId]: updater(current),
      };
    });
  }, []);

  const refreshData = useCallback(() => {
    void fetchPhones();
    void fetchStats();
    void fetchLiveStatus();
  }, [fetchPhones, fetchStats, fetchLiveStatus]);

  const handleConnect = useCallback(async (phone: Phone): Promise<void> => {
    updateAttemptState(phone.id, (current) => ({
      attempts: current.attempts + 1,
      startedAt: new Date().toISOString(),
      lastOutcome: current.lastOutcome,
      lastDurationSeconds: current.lastDurationSeconds,
    }));
    setQrPhone(phone);
    const startedAt = Date.now();
    try {
      await connectPhone(phone.id);
      updateAttemptState(phone.id, (current) => ({
        ...current,
        lastOutcome: "connected",
        lastDurationSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      }));
      void refreshData();
      window.dispatchEvent(new Event("propai_whatsapp_status_updated"));
    } catch {
      updateAttemptState(phone.id, (current) => ({
        ...current,
        lastOutcome: "failed",
        lastDurationSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      }));
    }
  }, [refreshData, updateAttemptState]);

  useEffect(() => {
      if (!authLoading && user) {
        refreshData();
      const interval = setInterval(() => {
        refreshData();
      }, 15000);
      const onStatusUpdate = () => {
        void refreshData();
      };
      window.addEventListener("propai_whatsapp_status_updated", onStatusUpdate);
      return () => {
        clearInterval(interval);
        window.removeEventListener("propai_whatsapp_status_updated", onStatusUpdate);
      };
    }
  }, [authLoading, user, refreshData]);

  if (authLoading || !user) return null;

  const connectedCount = phones.filter((p) => isConnectedPhone(p) || matchesLiveStatus(p, liveStatus)).length;
  const totalMessages = phones.reduce((sum, p) => sum + (p.total_messages_received || 0), 0);

  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-6 pt-12 pb-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-lg font-bold text-white">WhatsApp Phones</h2>
          <p className="mt-2 max-w-2xl text-sm text-zinc-500">
            Manage your WhatsApp connections. Each phone runs its own session (max 3 per account).
          </p>
        </div>
        {phones.length < 3 && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-lg bg-[#3EE88A] text-black px-4 py-2.5 text-xs font-bold min-h-[44px]"
          >
            <Plus className="w-4 h-4" /> Add Phone
          </button>
        )}
      </div>

      {phonesLoading ? (
        <div className="flex items-center justify-center py-16 text-sm text-zinc-500">Loading phones...</div>
      ) : (
        <>
          {phonesError && (
            <div className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <div className="font-semibold">Phones are taking longer than usual to load</div>
              <div className="mt-1 text-xs text-amber-100/80">{phonesError}</div>
            </div>
          )}
          {phones.length === 0 && !phonesError && (
            <LiveStatusCard status={liveStatus} onAddPhone={() => setShowCreate(true)} />
          )}
          {/* Phone Cards */}
          {phones.length > 0 && (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {phones.map((phone) => (
                <PhoneCard
                  key={phone.id}
                  phone={phone}
                  liveStatus={liveStatus}
                  onRefresh={refreshData}
                  onShowQR={setQrPhone}
                  onConnect={handleConnect}
                  attemptState={connectionAttempts[phone.id] || null}
                  now={now}
                />
              ))}
            </div>
          )}

          {extractionLag && extractionLag.status !== "healthy" && (
            <div className={`mb-6 rounded-2xl border p-4 ${extractionLag.status === "error" ? "border-red-500/30 bg-red-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
              <div className="flex items-start gap-3">
                <AlertTriangle className={`mt-0.5 h-4 w-4 ${extractionLag.status === "error" ? "text-red-300" : "text-amber-300"}`} />
                <div className="flex-1">
                  <div className={`text-sm font-semibold ${extractionLag.status === "error" ? "text-red-200" : "text-amber-200"}`}>
                    Extraction backlog detected
                  </div>
                  <div className="mt-1 text-xs text-zinc-300">
                    {extractionLag.pending_over_15m || 0} messages pending for more than 15m
                    {extractionLag.pending_over_60m ? `, ${extractionLag.pending_over_60m} pending for more than 60m` : ""}
                    {extractionLag.oldest_pending_age_minutes != null ? `, oldest pending ${formatDuration(extractionLag.oldest_pending_age_minutes * 60)} ago` : ""}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Aggregate Stats */}
          <div className="grid lg:grid-cols-2 gap-6 mb-8">
            <Section title="Summary">
              <div className="grid grid-cols-2 gap-0 [&>*:nth-child(2n)]:border-l [&>*:nth-child(2n)]:border-white/10 [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-white/10">
                <StatBox icon={<Smartphone className="w-4 h-4 text-zinc-400" />} label="Phones" value={`${connectedCount}/${phones.length}`} />
                <StatBox icon={<MessageSquare className="w-4 h-4 text-zinc-400" />} label="Total Messages" value={totalMessages.toLocaleString()} />
                <StatBox icon={<Zap className="w-4 h-4 text-zinc-400" />} label="AI Processed" value={totalParsed.toLocaleString()} />
                <StatBox icon={<List className="w-4 h-4 text-zinc-400" />} label="Items Extracted" value={(totalListings + totalRequirements).toLocaleString()} />
              </div>
            </Section>

            <Section title="System Health">
              <div>
                <HealthRow label="WhatsApp" status={connectedCount > 0 ? "healthy" : "error"} detail={`${connectedCount} connected`} />
                <HealthRow label="Database" status="healthy" detail={`${totalParsed.toLocaleString()} messages processed`} />
                <HealthRow label="Extraction" status={recentlyProcessed1h > 0 ? "healthy" : "warning"} detail={`${recentlyProcessed1h} in last hour`} />
              </div>
            </Section>
          </div>

          {/* Extraction Pipeline */}
          <Section title="Extraction Pipeline">
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-0 [&>*:nth-child(2n)]:border-l [&>*:nth-child(2n)]:border-white/10">
                <StatBox icon={<Database className="w-4 h-4 text-zinc-400" />} label="Total Raw" value={rawTotal.toLocaleString()} />
                <StatBox icon={<Zap className="w-4 h-4 text-zinc-400" />} label="Processed" value={rawProcessed.toLocaleString()} />
                <StatBox icon={<Clock className="w-4 h-4 text-zinc-400" />} label="Pending" value={rawPending.toLocaleString()} />
              </div>
              {rawTotal > 0 && (
                <div className="px-4 pb-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Progress</span>
                    <span className="text-xs font-bold text-white">{extractionPct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#3EE88A] transition-all duration-500"
                      style={{ width: `${Math.min(extractionPct, 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </Section>
        </>
      )}

      <CreatePhoneDialog open={showCreate} onClose={() => setShowCreate(false)} onCreated={refreshData} />
      {qrPhone && (
        <QRModal
          phone={qrPhone}
          open={!!qrPhone}
          onClose={() => setQrPhone(null)}
          onRefresh={refreshData}
          attemptState={connectionAttempts[qrPhone.id] || null}
          now={now}
        />
      )}
    </div>
  );
}
