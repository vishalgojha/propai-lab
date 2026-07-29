"use client";

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Clock, Database, Inbox, List, LogOut, MessageSquare, Plus, RefreshCw, Shield, Smartphone, Trash2, AlertTriangle, Users, Zap, Lock, X, ChevronLeft, MoreVertical, User, MessageCircle, Check, AlertCircle, Hash } from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";
import { getPhones, createPhone, deletePhone, resetPhone, disconnectPhone, pairCodePhone, updatePhone, fetchJSON, isLiveWhatsAppConnection, getOnboardingGroups, checkOnboardingGroup, connectOnboardingGroup, disconnectOnboardingGroup, type Phone, type WhatsAppStatus, type OnboardingGroup, type OnboardingGroupCheck, type OnboardingGroupState } from "@/lib/api";
import QRCode from "qrcode";

type HealthStatus = "healthy" | "warning" | "error";

type ConnectionSnapshot = {
  totalParsed?: number;
  totalListings?: number;
  totalRequirements?: number;
  totalBrokers?: number;
  rawTotal?: number;
  rawProcessed?: number;
  rawPending?: number;
  extractionPct?: number;
  recentlyProcessed1h?: number;
};

function connectionSnapshotKey(userId: string) {
  if (typeof window === "undefined" || !userId) return "";
  const tenant = window.localStorage.getItem("propai_active_tenant") || "default";
  return `propai_connection_snapshot:${userId}:${tenant}`;
}

function readConnectionSnapshot(userId: string): ConnectionSnapshot {
  const key = connectionSnapshotKey(userId);
  if (!key) return {};
  try {
    const snapshot = JSON.parse(window.localStorage.getItem(key) || "{}") as ConnectionSnapshot & { phones?: unknown };
    if ("phones" in snapshot) {
      delete snapshot.phones;
      window.localStorage.setItem(key, JSON.stringify(snapshot));
    }
    return snapshot;
  } catch {
    return {};
  }
}

function writeConnectionSnapshot(userId: string, patch: ConnectionSnapshot) {
  const key = connectionSnapshotKey(userId);
  if (!key) return;
  const current = readConnectionSnapshot(userId);
  window.localStorage.setItem(key, JSON.stringify({ ...current, ...patch }));
}

function StatusDot({ status }: { status: HealthStatus }) {
  const colors = { healthy: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)] animate-pulse", warning: "bg-amber-300", error: "bg-red-400" };
  return <span aria-label={status === "healthy" ? "Connected" : status} className={`w-2 h-2 rounded-full ${colors[status]} shrink-0`} />;
}

function StatBox({ icon, label, value, status }: { icon: React.ReactNode; label: string; value: string; status?: HealthStatus }) {
  return (
    <div className="flex items-center gap-3 p-3">
      <div className="flex h-8 w-8 items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
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
  const colors = { healthy: "text-zinc-200", warning: "text-zinc-400", error: "text-red-400" };
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">{detail}</span>
        <span className={`text-xs font-semibold ${colors[status]}`}>{labels[status]}</span>
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
    <div className="overflow-hidden rounded-xl border border-white/10">
      <div className="px-4 py-2 border-b border-white/10">
        <h3 className="text-xs font-bold text-white uppercase tracking-wider">{title}</h3>
      </div>
      <div className="px-4 py-2">{children}</div>
    </div>
  );
}

function ActionButton({ icon, label, onClick, variant, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; variant?: "primary" | "danger" | "default"; disabled?: boolean }) {
  const styles = {
    primary: "border border-white bg-white text-black hover:bg-zinc-200",
    danger: "border border-white/10 bg-transparent text-zinc-400 hover:border-red-500/40 hover:text-red-300",
    default: "border border-white/10 bg-transparent text-zinc-300 hover:bg-white/5 hover:text-white",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant || "default"]}`}
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

function isConnectedPhone(status: Pick<Phone, "connected" | "connection_state">) {
  return Boolean(
    status.connected ||
    status.connection_state === "open" ||
    status.connection_state === "connected"
  );
}

function matchesLiveStatus(phone: Phone, status: WhatsAppStatus | null) {
  if (!status || !isLiveWhatsAppConnection(status)) return false;
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

function CreatePhoneDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (phone: Phone) => void }) {
  const [instanceName, setInstanceName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      const phone = await createPhone({ instance_name: instanceName.trim() || undefined });
      setInstanceName("");
      onCreated(phone);
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
        <p className="text-xs text-zinc-500 mb-4">Create a WhatsApp connection, then link it with a pairing code from your phone.</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Agency / Workspace Name (optional)</label>
            <input
              type="text"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="e.g. Ananta Realty"
              className="w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:border-white/30 focus:outline-none"
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="min-h-[44px] flex-1 rounded-md border border-white/10 bg-transparent px-4 py-2.5 text-xs font-semibold text-zinc-300 hover:bg-white/5">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="min-h-[44px] flex-1 rounded-md border border-white bg-white px-4 py-2.5 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create Phone"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PhoneCard({
  phone,
  liveStatus,
  onRefresh,
  onDeleted,
}: {
  phone: Phone;
  liveStatus: WhatsAppStatus | null;
  onRefresh: () => Promise<void> | void;
  onDeleted: (phoneId: number) => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showPairCodeDialog, setShowPairCodeDialog] = useState(false);
  const [resetReceipt, setResetReceipt] = useState<string | null>(null);
  const [pairCodeInput, setPairCodeInput] = useState("");
  const [pairCodeResult, setPairCodeResult] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phone.qr_available && phone.qr) {
      QRCode.toDataURL(phone.qr, { width: 200, margin: 1, color: { dark: "#ffffff", light: "#18181b" } })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(null));
    } else {
      setQrDataUrl(null);
    }
  }, [phone.qr_available, phone.qr]);

  const handleAction = async (action: string) => {
    setActionLoading(action);
    setActionMessage(null);
    setActionError(null);
    try {
      if (action === "disconnect") await disconnectPhone(phone.id);
      else if (action === "reset") await resetPhone(phone.id);
      else if (action === "delete") {
        const result = await deletePhone(phone.id);
        if (!result.ok) throw new Error("Phone could not be removed");
        onDeleted(phone.id);
      } else if (action === "self-chat") {
        await updatePhone(phone.id, { self_chat_enabled: !phone.self_chat_enabled });
        setActionMessage(phone.self_chat_enabled ? "Self-chat assistant disabled" : "Self-chat assistant enabled");
      }
      else if (action === "pair-code") { setResetReceipt(null); setShowPairCodeDialog(true); setActionLoading(null); return; }
      else await onRefresh();
      if (!["self-chat", "pair-code"].includes(action)) {
        setActionMessage(
          action === "delete"
            ? "Phone removed"
            : action === "reset"
              ? "Session cleared. Pair this phone again with a new WhatsApp pairing code."
              : "Phone disconnected"
        );
      }
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `${action} failed`);
      // A cached card may refer to a connection already removed server-side.
      // Refresh even after a failed action so stale phones disappear.
      await onRefresh();
    } finally {
      setActionLoading(null);
    }
  };

  const handlePairCodeSubmit = async () => {
    if (pairCodeInput.length < 10) return;
    setActionLoading("pair-code");
    setActionError(null);
    try {
      // Pair-code owns session setup. Starting QR/connect immediately before it
      // races two WhatsApp pairing modes and causes intermittent 502 responses.
      const result = await pairCodePhone(phone.id, pairCodeInput);
      const code = result.pairing_code || result.code || result.status?.pairing_code;
      if (!code) throw new Error(result.note || result.error || "WhatsApp did not return a pairing code");
      setPairCodeResult(code);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Pair code request failed";
      // Show a clear message when the server is unreachable (502 from proxy).
      const isServerError = /502|503|unreachable|unavailable/i.test(msg);
      setActionError(isServerError
        ? "The WhatsApp service is not reachable right now. Check that the backend server is running, then try again."
        : msg
      );
      setShowPairCodeDialog(false);
    } finally {
      setActionLoading(null);
    }
  };

  const handleResetAndRepair = async () => {
    setActionLoading("reset");
    setActionMessage(null);
    setActionError(null);
    try {
      const receipt = await resetPhone(phone.id);
      if (!receipt.reset_at || receipt.pairing_required !== true) {
        throw new Error("WhatsApp did not confirm that the saved session was cleared");
      }
      setShowResetDialog(false);
      // Keep the number ready for the next, explicit pairing-code step. This
      // avoids an accidental request for a code for the wrong WhatsApp phone.
      setPairCodeInput(normalizePhoneDigits(phoneDisplay));
      setShowPairCodeDialog(true);
      setResetReceipt(receipt.reset_at);
      setActionMessage("Saved WhatsApp session cleared. A fresh pairing code is now required.");
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not reset the WhatsApp session");
      await onRefresh();
    } finally {
      setActionLoading(null);
    }
  };

  const statusAvailable = phone.live_status_available !== false;
  // `is_active` and old connection fields are persisted metadata. They are not
  // proof that WhatsMeow is reachable now. When the API cannot probe the
  // ingestor, never turn that stale metadata into a live "Connected" session.
  const isConnected = statusAvailable && (
    isConnectedPhone(phone) || matchesLiveStatus(phone, liveStatus)
  );
  const phoneDisplay = phone.phone_number_live || phone.phone_number;
  const isUnpaired = !isConnected && isPlaceholderPhone(phoneDisplay);
  const isReconnecting = statusAvailable && ["connecting", "reconnecting"].includes(phone.connection_state);
  const statusLabel = isConnected
    ? "Connected"
    : !statusAvailable
      ? "Service unavailable"
      : isReconnecting
        ? "Reconnecting"
        : "Disconnected";
  const health: HealthStatus = isConnected ? "healthy" : (!statusAvailable || isUnpaired || isReconnecting) ? "warning" : "error";

  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    }
    if (showMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showMenu]);

  return (
    <div className="rounded-xl border border-white/10 p-4">
      {/* Row 1: Avatar + Name + Phone + Status dot */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] shrink-0">
          <User className="h-4 w-4 text-zinc-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white truncate">
              {isUnpaired ? "New Phone" : (phone.instance_name || formatPhone(phoneDisplay))}
            </span>
            <StatusDot status={health} />
          </div>
          {!isUnpaired && phone.instance_name && (
            <div className="text-xs text-zinc-500 truncate">{formatPhone(phoneDisplay)}</div>
          )}
          {isUnpaired && (
            <div className="text-xs text-zinc-500">Pair with a WhatsApp code</div>
          )}
          {!statusAvailable && phone.live_status_error && (
            <div className="text-xs text-red-300">{phone.live_status_error}</div>
          )}
          {qrDataUrl && !isConnected && (
            <div className="mt-3 flex flex-col items-center gap-1.5">
              <img src={qrDataUrl} alt="WhatsApp QR code" className="w-32 h-32 rounded-lg" />
              <span className="text-[10px] text-zinc-500">Or scan QR with WhatsApp</span>
            </div>
          )}
        </div>
        {/* ⋮ Menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
          >
            <MoreVertical className="h-4 w-4 text-zinc-400" />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-full mt-1 w-56 rounded-xl border border-white/10 bg-zinc-900 shadow-popover z-50 overflow-hidden">
              <div className="px-3 py-2 border-b border-white/10">
                <div className="text-xs font-semibold text-white">Connection Status</div>
                <div className="flex items-center gap-2 mt-1">
                  <StatusDot status={health} />
                  <span className="text-xs text-zinc-300">{statusLabel}</span>
                </div>
              </div>
              <div className="px-3 py-2 border-b border-white/10">
                <div className="text-xs text-zinc-500">Account Number</div>
                <div className="text-xs text-white font-medium">{formatPhone(phoneDisplay)}</div>
              </div>
              <div className="px-3 py-2 border-b border-white/10">
                <div className="text-xs text-zinc-500">Last Active</div>
                <div className="text-xs text-white font-medium">{formatTime(phone.last_message_at)}</div>
              </div>
              <div className="px-3 py-2 border-b border-white/10">
                <div className="text-xs text-zinc-500">Connected Since</div>
                <div className="text-xs text-white font-medium">{phone.connected_since ? formatTime(phone.connected_since) : "—"}</div>
              </div>
              <div className="px-3 py-2 border-b border-white/10">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Self-chat</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={phone.self_chat_enabled !== false}
                    onClick={() => handleAction("self-chat")}
                    disabled={actionLoading !== null}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${phone.self_chat_enabled !== false ? "bg-emerald-500" : "bg-zinc-700"}`}
                  >
                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${phone.self_chat_enabled !== false ? "translate-x-4" : "translate-x-0"}`} />
                  </button>
                </div>
              </div>
              <div className="px-3 py-2 border-b border-white/10">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Messages</span>
                  <span className="text-xs text-white font-medium">{phone.total_messages_received?.toLocaleString() || "0"}</span>
                </div>
              </div>
              <div className="px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Connection Attempts</span>
                  <span className="text-xs text-white font-medium">Use pairing code</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  setShowResetDialog(true);
                }}
                disabled={actionLoading !== null}
                className="flex w-full items-center gap-2 border-t border-white/10 px-3 py-2.5 text-left text-xs font-semibold text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reset &amp; re-pair WhatsApp
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  if (window.confirm(`Remove ${isUnpaired ? "this empty phone" : (phone.instance_name || formatPhone(phoneDisplay))} from this workspace?`)) {
                    void handleAction("delete");
                  }
                }}
                disabled={actionLoading !== null}
                className="flex w-full items-center gap-2 border-t border-white/10 px-3 py-2.5 text-left text-xs font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove phone
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Row 2: Action buttons - icon-only, right-aligned */}
      <div className="flex items-center justify-end gap-2 mt-3">
        <button
          onClick={() => handleAction("pair-code")}
          disabled={actionLoading !== null}
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/10 transition-colors disabled:opacity-50"
          title="Pair with WhatsApp code"
        >
          {actionLoading === "pair-code" ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-white" />
          ) : (
            <Hash className="h-4 w-4 text-zinc-300" />
          )}
        </button>
        <button
          onClick={() => handleAction(isConnected ? "disconnect" : "pair-code")}
          disabled={actionLoading !== null}
          className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${
            isConnected
              ? "border border-white/10 bg-white/[0.03] hover:bg-white/10"
            : "border border-white bg-white text-black hover:bg-zinc-200"
          }`}
          title={isConnected ? "Disconnect" : "Pair with code"}
        >
          {actionLoading === "disconnect" || actionLoading === "pair-code" ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-white" />
          ) : isConnected ? (
            <LogOut className="h-4 w-4 text-zinc-300" />
          ) : (
            <RefreshCw className="h-4 w-4 text-black" />
          )}
        </button>
      </div>

      {/* Row 3: Stat chips inline */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-zinc-300">
          <List className="h-3 w-3 text-zinc-400" />
          {phone.total_messages_received?.toLocaleString() || "0"} items
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-zinc-300">
          <Users className="h-3 w-3 text-zinc-400" />
          {phone.instance_name || "Unknown"}
        </span>
        {isConnected && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">
            <Check className="h-3 w-3" />
            Active
          </span>
        )}
      </div>

      {/* Action feedback */}
      {actionMessage && <p className="text-xs text-zinc-300 mt-2">{actionMessage}</p>}
      {actionError && <p className="text-xs text-red-400 mt-2">{actionError}</p>}

      {showResetDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowResetDialog(false)}>
          <div className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
              <AlertTriangle className="h-5 w-5 text-amber-300" />
              <div className="text-sm font-semibold text-white">Reset WhatsApp session?</div>
              <button onClick={() => setShowResetDialog(false)} className="ml-auto text-zinc-500 hover:text-white" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3 px-5 py-4 text-xs leading-5 text-zinc-400">
              <p>This signs PropAI out as a linked device. Your phone&apos;s chats are not deleted.</p>
              <p>After reset, you&apos;ll request a new pairing code and link <span className="font-medium text-white">{formatPhone(phoneDisplay)}</span> in WhatsApp → Settings → Linked devices.</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
              <button onClick={() => setShowResetDialog(false)} disabled={actionLoading === "reset"} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white disabled:opacity-50">Cancel</button>
              <button onClick={handleResetAndRepair} disabled={actionLoading === "reset"} className="rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-300 disabled:opacity-50">
                {actionLoading === "reset" ? "Resetting…" : "Reset & continue"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pair Code Dialog */}
      {showPairCodeDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => { setShowPairCodeDialog(false); setPairCodeResult(null); setPairCodeInput(""); setResetReceipt(null); }}>
          <div className="w-full max-w-sm rounded-xl bg-zinc-900 border border-white/10 shadow-xl" onClick={(e) => e.stopPropagation()}>
            {!pairCodeResult ? (
              <>
                <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
                  <Hash className="h-5 w-5 text-zinc-400" />
                  <div className="text-sm font-semibold text-white">{resetReceipt ? "Session cleared — pair again" : "Pair with Code"}</div>
                  <button onClick={() => { setShowPairCodeDialog(false); setPairCodeInput(""); setResetReceipt(null); }} className="ml-auto text-zinc-500 hover:text-white"><X className="h-4 w-4" /></button>
                </div>
                <div className="px-5 py-4 space-y-3">
                  {resetReceipt && (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs leading-5 text-emerald-200">
                      <div className="font-semibold">Reset confirmed</div>
                      <div>Saved credentials and device mapping were deleted at {formatTime(resetReceipt)}. This phone now requires a fresh pairing code.</div>
                    </div>
                  )}
                  <p className="text-xs text-zinc-400">Enter the phone number to pair (with country code, e.g. 919820056180):</p>
                  <input
                    type="tel"
                    value={pairCodeInput}
                    onChange={(e) => setPairCodeInput(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="919820056180"
                    autoFocus
                    className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50"
                    onKeyDown={(e) => { if (e.key === "Enter" && pairCodeInput.length >= 10) handlePairCodeSubmit(); }}
                  />
                </div>
                <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/10">
                  <button onClick={() => { setShowPairCodeDialog(false); setPairCodeInput(""); setResetReceipt(null); }} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white">Cancel</button>
                  <button
                    onClick={handlePairCodeSubmit}
                    disabled={pairCodeInput.length < 10 || actionLoading === "pair-code"}
                    className="px-4 py-1.5 text-xs font-medium rounded-lg bg-emerald-500 text-white hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {actionLoading === "pair-code" ? "Requesting..." : "Get Code"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
                  <Check className="h-5 w-5 text-emerald-400" />
                  <div className="text-sm font-semibold text-white">Pairing Code</div>
                  <button onClick={() => { setShowPairCodeDialog(false); setPairCodeResult(null); setPairCodeInput(""); setResetReceipt(null); }} className="ml-auto text-zinc-500 hover:text-white"><X className="h-4 w-4" /></button>
                </div>
                <div className="px-5 py-4 text-center space-y-3">
                  <p className="text-xs text-zinc-400">Open WhatsApp → Settings → Linked Devices → Link a Device</p>
                  <div className="text-2xl font-mono font-bold text-white tracking-[0.3em] bg-white/[0.03] rounded-lg py-3 border border-white/10">
                    {pairCodeResult}
                  </div>
                  <p className="text-[11px] text-zinc-500">Code expires in ~2 minutes</p>
                </div>
                <div className="flex justify-end px-5 py-3 border-t border-white/10">
                  <button onClick={() => { setShowPairCodeDialog(false); setPairCodeResult(null); setPairCodeInput(""); setResetReceipt(null); }} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white">Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LiveStatusCard({ status, onAddPhone }: { status: WhatsAppStatus | null; onAddPhone: () => void }) {
  const connected = Boolean(status?.connected || status?.state === "open" || status?.state === "connected" || status?.connected_since);

  return (
    <div className="mb-8 rounded-xl border border-white/10 p-5">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03]">
          <Smartphone className="h-5 w-5 text-zinc-200" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">{connected ? "WhatsApp connected" : "Checking WhatsApp connection"}</span>
            <StatusDot status={connected ? "healthy" : "warning"} />
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {connected ? "Live WhatsApp session detected" : "Live session state is being checked"}
          </div>
        </div>
      </div>
      <div className="mt-4">
        <button
          onClick={onAddPhone}
          className="min-h-[44px] rounded-md border border-white bg-white px-4 py-2.5 text-xs font-semibold text-black hover:bg-zinc-200"
        >
          Add Phone
        </button>
      </div>
    </div>
  );
}

function OnboardingGroupPanel({ phone, liveStatus, onRefresh }: { phone: Phone; liveStatus: WhatsAppStatus | null; onRefresh: () => Promise<void> | void; }) {
  const statusAvailable = phone.live_status_available !== false;
  const isConnected = statusAvailable && (
    isConnectedPhone(phone) || matchesLiveStatus(phone, liveStatus)
  );
  const [data, setData] = useState<OnboardingGroupState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    if (!isConnected) return;
    setLoading(true);
    try {
      const next = await getOnboardingGroups(phone.id);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load group onboarding data.");
    } finally {
      setLoading(false);
    }
  }, [isConnected, phone.id]);

  useEffect(() => {
    setMessage(null);
    setError(null);
    void loadGroups();
  }, [loadGroups]);

  const handleConnect = async (group: OnboardingGroup, precheck?: OnboardingGroupCheck) => {
    setActiveGroup(group.group_jid);
    setError(null);
    setMessage(null);
    try {
      const check = precheck || await checkOnboardingGroup(phone.id, group.group_jid);
      const needsConfirm = check.high_overlap || check.cap.soft_warning_at_cap;
      let confirmOverlap = false;
      let confirmCap = false;
      if (needsConfirm) {
        const details = [
          check.high_overlap
            ? `This group overlaps heavily with brokers already in the network (${Math.round(check.overlap_score * 100)}% overlap).`
            : null,
          check.cap.soft_warning_at_cap
            ? `This connection is at the default tier cap (${check.cap.connected_count}/${check.cap.cap}).`
            : null,
        ].filter(Boolean);
        const accepted = window.confirm(`${details.join(" ")} Add it anyway?`);
        if (!accepted) return;
        confirmOverlap = check.high_overlap;
        confirmCap = check.cap.soft_warning_at_cap;
      }
      await connectOnboardingGroup(phone.id, group.group_jid, confirmOverlap, confirmCap);
      setMessage(`Added ${group.group_name}.`);
      await loadGroups();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the group.");
    } finally {
      setActiveGroup(null);
    }
  };

  const handleDisconnect = async (group: OnboardingGroup) => {
    if (!window.confirm(`Disconnect ${group.group_name}? Existing raw messages will be preserved.`)) return;
    setActiveGroup(group.group_jid);
    setError(null);
    setMessage(null);
    try {
      await disconnectOnboardingGroup(phone.id, group.group_jid);
      setMessage(`Disconnected ${group.group_name}. Raw messages were preserved.`);
      await loadGroups();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect the group.");
    } finally {
      setActiveGroup(null);
    }
  };

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-white/10 p-4">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-zinc-500" />
          <div className="text-sm font-semibold text-white">Group onboarding</div>
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          Pair this phone first. Group discovery and cap checks appear here after WhatsApp is connected.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-zinc-300" />
            <div className="text-sm font-semibold text-white">Group onboarding</div>
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            {phone.instance_name || formatPhone(phone.phone_number_live || phone.phone_number)} · {data ? `${data.connected_count}/${data.cap} connected` : "loading cap"}
          </div>
        </div>
        {data && (
          <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-zinc-300">
            {data.tier} tier{data.overridden ? " · override" : ""}
          </div>
        )}
      </div>

      {loading && <div className="mt-3 text-xs text-zinc-500">Loading group directory...</div>}
      {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
      {message && <div className="mt-3 text-xs text-emerald-300">{message}</div>}

      {data && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
            <div className="text-zinc-500">Connected</div>
            <div className="mt-1 font-semibold text-white">{data.connected_count}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
            <div className="text-zinc-500">Remaining</div>
            <div className="mt-1 font-semibold text-white">{data.remaining}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
            <div className="text-zinc-500">Cap</div>
            <div className="mt-1 font-semibold text-white">{data.cap}</div>
          </div>
        </div>
      )}

      {data && data.groups.length > 0 && (
        <div className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2 text-[11px] text-zinc-400">
          Recommendations are ranked by likely new broker reach. Duplicate risk is based on sampled sender numbers already seen across your broker network; connected groups stay visible for comparison.
        </div>
      )}

      <div className="mt-4 space-y-3">
        {data?.groups?.length ? data.groups.map((group) => (
          <div key={group.group_jid} className={`rounded-lg border p-3 ${group.connected ? "border-emerald-500/20 bg-emerald-500/[0.03]" : "border-white/10 bg-white/[0.02]"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="truncate text-sm font-semibold text-white">{group.group_name}</div>
                  {group.connected && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">Connected</span>}
                  {!group.connected && group.suggestion && group.suggestion.score >= 0.3 && (
                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                      Recommended
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  {group.group_jid} · {group.participants.toLocaleString()} participants · last active {formatTime(group.last_message_at)}
                </div>
                {group.overlap_status && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={`rounded-full border px-2 py-0.5 font-semibold ${
                      group.overlap_status === "high_overlap"
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                        : group.overlap_status === "moderate_overlap"
                          ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-300"
                          : group.overlap_status === "new_reach"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-white/10 text-zinc-400"
                    }`}>
                      {group.overlap_status === "high_overlap"
                        ? "Likely duplicate"
                        : group.overlap_status === "moderate_overlap"
                          ? "Some duplicate reach"
                          : group.overlap_status === "new_reach"
                            ? "Likely new reach"
                            : "No overlap sample"}
                    </span>
                    {group.overlap_sample_count ? (
                      <span className="text-zinc-400">
                        {Math.round((group.overlap_score || 0) * 100)}% overlap · {group.overlap_shared_count} of {group.overlap_sample_count} sampled senders already known
                      </span>
                    ) : (
                      <span className="text-zinc-500">No recent sender sample available</span>
                    )}
                  </div>
                )}
                {group.suggestion && group.suggestion.reasons.length > 0 && (
                  <div className="mt-2 text-[11px] text-zinc-400">
                    {group.suggestion.reasons.join(" · ")}
                  </div>
                )}
              </div>
              {group.connected ? (
                <button
                  onClick={() => void handleDisconnect(group)}
                  disabled={activeGroup === group.group_jid}
                  className="rounded-lg border border-red-400/30 px-3 py-1.5 text-[11px] font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {activeGroup === group.group_jid ? "Disconnecting..." : "Disconnect"}
                </button>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => void handleConnect(group)}
                    disabled={activeGroup === group.group_jid}
                    className="rounded-lg border border-white bg-white px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-zinc-200 disabled:opacity-50"
                  >
                    {activeGroup === group.group_jid ? "Connecting..." : "Connect"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )) : !loading && (
          <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-xs text-zinc-500">
            No group directory is available on this connection yet.
          </div>
        )}
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

  const [totalParsed, setTotalParsed] = useState(0);
  const [totalListings, setTotalListings] = useState(0);
  const [totalRequirements, setTotalRequirements] = useState(0);
  const [totalBrokers, setTotalBrokers] = useState(0);
  const [rawTotal, setRawTotal] = useState(0);
  const [rawProcessed, setRawProcessed] = useState(0);
  const [rawPending, setRawPending] = useState(0);
  const [extractionPct, setExtractionPct] = useState(0);
  const [recentlyProcessed1h, setRecentlyProcessed1h] = useState(0);
  const [extractionLag, setExtractionLag] = useState<any>(null);

  const fetchPhones = useCallback(async () => {
    try {
      const response = await getPhones(true, 15000);
      const nextPhones = response.phones || [];
      setPhones(nextPhones);
      if (user?.id) {
        localStorage.setItem(`propai_phones:${user.id}`, JSON.stringify(nextPhones));
      }
      setPhonesError(null);
    } catch (error) {
      setPhonesError(error instanceof Error ? error.message : "Could not load phones right now.");
    } finally {
      setPhonesLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user?.id) return;
    const hydrateTimer = window.setTimeout(() => {
      try {
        const cached = JSON.parse(localStorage.getItem(`propai_phones:${user.id}`) || "[]") as Phone[];
        if (cached.length > 0) setPhones(cached);
      } catch {
        // A corrupt local snapshot must not block the live request.
      }
    }, 0);
    return () => window.clearTimeout(hydrateTimer);
  }, [user?.id]);

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
      const snapshotPatch: ConnectionSnapshot = {};
      if (stats?.total_parsed != null) setTotalParsed(stats.total_parsed);
      if (stats?.total_parsed != null) snapshotPatch.totalParsed = stats.total_parsed;
      if (stats?.total_listings != null) setTotalListings(stats.total_listings);
      if (stats?.total_listings != null) snapshotPatch.totalListings = stats.total_listings;
      if (stats?.total_requirements != null) setTotalRequirements(stats.total_requirements);
      if (stats?.total_requirements != null) snapshotPatch.totalRequirements = stats.total_requirements;
      if (stats?.total_brokers != null) setTotalBrokers(stats.total_brokers);
      if (stats?.total_brokers != null) snapshotPatch.totalBrokers = stats.total_brokers;
      const ext = syncAct?.extraction;
      if (ext) {
        if (ext.total_raw != null) setRawTotal(ext.total_raw);
        if (ext.total_raw != null) snapshotPatch.rawTotal = ext.total_raw;
        if (ext.processed != null) setRawProcessed(ext.processed);
        if (ext.processed != null) snapshotPatch.rawProcessed = ext.processed;
        if (ext.pending != null) setRawPending(ext.pending);
        if (ext.pending != null) snapshotPatch.rawPending = ext.pending;
        if (ext.pct != null) setExtractionPct(ext.pct);
        if (ext.pct != null) snapshotPatch.extractionPct = ext.pct;
      }
      try {
        const extProgress = await fetchJSON<any>("/extraction/progress", undefined, 8000);
        if (extProgress?.recently_processed_1h != null) setRecentlyProcessed1h(extProgress.recently_processed_1h);
        if (extProgress?.recently_processed_1h != null) snapshotPatch.recentlyProcessed1h = extProgress.recently_processed_1h;
        if (extProgress?.lag != null) setExtractionLag(extProgress.lag);
      } catch { /* ignore */ }
      writeConnectionSnapshot(user?.id || "", snapshotPatch);
    } catch { /* ignore */ }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const cached = readConnectionSnapshot(user.id);
    if (cached.totalParsed != null) setTotalParsed(cached.totalParsed);
    if (cached.totalListings != null) setTotalListings(cached.totalListings);
    if (cached.totalRequirements != null) setTotalRequirements(cached.totalRequirements);
    if (cached.totalBrokers != null) setTotalBrokers(cached.totalBrokers);
    if (cached.rawTotal != null) setRawTotal(cached.rawTotal);
    if (cached.rawProcessed != null) setRawProcessed(cached.rawProcessed);
    if (cached.rawPending != null) setRawPending(cached.rawPending);
    if (cached.extractionPct != null) setExtractionPct(cached.extractionPct);
    if (cached.recentlyProcessed1h != null) setRecentlyProcessed1h(cached.recentlyProcessed1h);
  }, [user?.id]);

  const refreshData = useCallback(() => {
    void fetchPhones();
    void fetchLiveStatus();
  }, [fetchPhones, fetchLiveStatus]);

  const handlePhoneCreated = useCallback((created: Phone) => {
    setPhones((current) => {
      const next = current.some((phone) => phone.id === created.id)
        ? current.map((phone) => (phone.id === created.id ? { ...phone, ...created } : phone))
        : [...current, created];
      if (user?.id) {
        localStorage.setItem(`propai_phones:${user.id}`, JSON.stringify(next));
      }
      return next;
    });
    setPhonesLoading(false);
    setPhonesError(null);
    // Creation already succeeded. Refresh live status in the background so a
    // slow status endpoint cannot turn success into a misleading 500 error.
    refreshData();
  }, [refreshData, user?.id]);

  const handlePhoneDeleted = useCallback((phoneId: number) => {
    setPhones((current) => {
      const next = current.filter((phone) => phone.id !== phoneId);
      if (user?.id) {
        localStorage.setItem(`propai_phones:${user.id}`, JSON.stringify(next));
      }
      return next;
    });
  }, [user]);

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

  useEffect(() => {
    if (authLoading || !user) return;
    void fetchStats();
    const interval = setInterval(() => void fetchStats(), 60000);
    return () => clearInterval(interval);
  }, [authLoading, user, fetchStats]);

  if (authLoading || !user) return null;

  const connectedCount = phones.filter((p) => isConnectedPhone(p) || matchesLiveStatus(p, liveStatus)).length;
  const totalMessages = phones.reduce((sum, p) => sum + (p.total_messages_received || 0), 0);

  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-6 pt-8 pb-12">
      {/* Compact Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
          >
            <ChevronLeft className="h-5 w-5 text-zinc-300" />
          </button>
          <div>
            <h2 className="text-lg font-bold text-white">WhatsApp Phones</h2>
            <p className="text-xs text-zinc-500">
              {connectedCount}/{phones.length} connected · {totalMessages.toLocaleString()} messages
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {phones.length < 3 && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex h-10 items-center gap-2 rounded-lg border border-white bg-white px-4 py-2.5 text-xs font-semibold text-black hover:bg-zinc-200"
            >
              <Plus className="w-4 h-4" /> Add Phone
            </button>
          )}
        </div>
      </div>

      {phonesLoading ? (
        <div className="flex items-center justify-center py-16 text-sm text-zinc-500">Loading phones...</div>
      ) : (
        <>
          {phonesError && (
            <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-white">Couldn't load phones</div>
                  <div className="mt-1 text-xs text-zinc-500">{phonesError}</div>
                </div>
                <button
                  onClick={refreshData}
                  className="flex items-center gap-2 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  Retry
                </button>
              </div>
            </div>
          )}
          {phones.length === 0 && !phonesError && (
            <LiveStatusCard status={liveStatus} onAddPhone={() => setShowCreate(true)} />
          )}
          {/* Phone Cards - Compact Grid */}
          {phones.length > 0 && (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {phones.map((phone) => (
                <PhoneCard
                  key={phone.id}
                  phone={phone}
                  liveStatus={liveStatus}
                  onRefresh={refreshData}
                  onDeleted={handlePhoneDeleted}
                />
              ))}
            </div>
          )}

          {phones.some((phone) => isConnectedPhone(phone) || matchesLiveStatus(phone, liveStatus)) ? (
            <div className="mb-8">
              <Section title="Group onboarding">
                <div className="space-y-4 p-2">
                  {phones
                    .filter((phone) => isConnectedPhone(phone) || matchesLiveStatus(phone, liveStatus))
                    .map((phone) => (
                      <OnboardingGroupPanel
                        key={`onboarding-${phone.id}`}
                        phone={phone}
                        liveStatus={liveStatus}
                        onRefresh={refreshData}
                      />
                    ))}
                </div>
              </Section>
            </div>
          ) : phones.length > 0 ? (
            <div className="mb-8 rounded-xl border border-white/10 p-4 text-xs text-zinc-500">
              Pair a WhatsApp phone to unlock group onboarding.
            </div>
          ) : null}

          {extractionLag && extractionLag.status !== "healthy" && (
            <div className={`mb-6 rounded-xl border bg-transparent p-4 ${extractionLag.status === "error" ? "border-red-500/30" : "border-white/10"}`}>
              <div className="flex items-start gap-3">
                <AlertTriangle className={`mt-0.5 h-4 w-4 ${extractionLag.status === "error" ? "text-red-300" : "text-zinc-500"}`} />
                <div className="flex-1">
                  <div className={`text-sm font-semibold ${extractionLag.status === "error" ? "text-red-200" : "text-white"}`}>
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

          {/* Summary Stats - Compact */}
          <div className="grid lg:grid-cols-2 gap-4 mb-8">
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

          {/* Extraction Pipeline - Compact */}
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
                    <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Progress</span>
                    <span className="text-xs font-bold text-white">{extractionPct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-zinc-200 transition-all duration-500"
                      style={{ width: `${Math.min(extractionPct, 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </Section>
        </>
      )}

      <CreatePhoneDialog open={showCreate} onClose={() => setShowCreate(false)} onCreated={handlePhoneCreated} />
    </div>
  );
}
