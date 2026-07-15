"use client";

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useRouter } from "next/navigation";
import { Activity, Clock, Database, ImageUp, Inbox, List, LogOut, MessageSquare, Plus, RefreshCw, Shield, Smartphone, Trash2, AlertTriangle, Users, Zap, Lock, X } from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";
import { getPhones, createPhone, deletePhone, resetPhone, disconnectPhone, connectPhone, type Phone } from "@/lib/api";

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

function ActionButton({ icon, label, onClick, variant }: { icon: React.ReactNode; label: string; onClick: () => void; variant?: "primary" | "danger" | "default" }) {
  const styles = {
    primary: "bg-[#3EE88A] text-black hover:bg-[#3EE88A]/90",
    danger: "border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20",
    default: "border border-white/10 bg-zinc-800 text-zinc-300 hover:bg-zinc-700",
  };
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-bold min-h-[44px] transition-colors ${styles[variant || "default"]}`}
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

function CreatePhoneDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!phoneNumber.trim()) {
      setError("Phone number is required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await createPhone({ phone_number: phoneNumber.trim(), instance_name: instanceName.trim() || undefined });
      setPhoneNumber("");
      setInstanceName("");
      onCreated();
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
        <p className="text-xs text-zinc-500 mb-4">Create a new WhatsApp connection. The phone will start disconnected and need QR pairing.</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Phone Number *</label>
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+91 98765 43210"
              className="w-full rounded-lg bg-zinc-800 border border-white/10 px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-[#3EE88A]/50"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Instance Name (optional)</label>
            <input
              type="text"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="e.g. Sales Team"
              className="w-full rounded-lg bg-zinc-800 border border-white/10 px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-[#3EE88A]/50"
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/10 bg-zinc-800 text-zinc-300 px-4 py-2.5 text-xs font-bold min-h-[44px]">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={loading || !phoneNumber.trim()}
            className="flex-1 rounded-lg bg-[#3EE88A] text-black px-4 py-2.5 text-xs font-bold min-h-[44px] disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create Phone"}
          </button>
        </div>
      </div>
    </div>
  );
}

function QRModal({ phone, open, onClose }: { phone: Phone; open: boolean; onClose: () => void }) {
  const [qrText, setQrText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fetchQR = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getPhone(phone.id);
      if (res.qr) {
        setQrText(res.qr);
      } else if (res.connected) {
        setError("Phone is already connected");
      } else {
        setError("QR not available yet. Try refreshing the connection.");
      }
    } catch {
      setError("Failed to fetch QR code");
    } finally {
      setLoading(false);
    }
  }, [phone.id]);

  useEffect(() => {
    if (open) fetchQR();
    if (!open) setQrText(null);
  }, [open, fetchQR]);

  useEffect(() => {
    if (!canvasRef.current || !qrText) return;
    QRCode.toCanvas(canvasRef.current, qrText, {
      width: 320,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  }, [qrText]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-white">Scan QR — {formatPhone(phone.phone_number)}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 rounded-full border-2 border-zinc-600 border-t-[#3EE88A] animate-spin" />
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center py-12 text-center">
            <p className="text-sm text-zinc-400">{error}</p>
            <button onClick={fetchQR} disabled={loading} className="mt-4 rounded-lg bg-[#3EE88A] px-6 py-2.5 text-xs font-bold text-black min-h-[44px] disabled:opacity-50">
              Retry
            </button>
          </div>
        )}
        {!loading && !error && qrText && (
          <div className="flex flex-col items-center">
            <canvas ref={canvasRef} className="rounded-xl border-[6px] border-white bg-white" style={{ width: "min(320px, 100%)", height: "min(320px, 100%)", aspectRatio: "1/1" }} />
            <ol className="mt-4 space-y-2 text-sm text-zinc-400 text-center">
              <li>Open <strong className="text-white">WhatsApp</strong> → <strong className="text-white">Settings</strong> → <strong className="text-white">Linked Devices</strong></li>
              <li>Tap <strong className="text-white">Link a Device</strong> and scan this QR</li>
            </ol>
            <button onClick={fetchQR} disabled={loading} className="mt-4 rounded-lg border border-white/10 bg-zinc-800 text-zinc-300 px-6 py-2.5 text-xs font-bold min-h-[44px] disabled:opacity-50 w-full">
              Refresh QR
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PhoneCard({ phone, onRefresh, onShowQR }: { phone: Phone; onRefresh: () => void; onShowQR: (p: Phone) => void }) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleAction = async (action: string) => {
    setActionLoading(action);
    try {
      if (action === "disconnect") await disconnectPhone(phone.id);
      else if (action === "reset") await resetPhone(phone.id);
      else if (action === "delete") await deletePhone(phone.id);
      else if (action === "connect") await connectPhone(phone.id);
      onRefresh();
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const isConnected = phone.connected || phone.connection_state === "open";
  const phoneDisplay = phone.phone_number_live || phone.phone_number;
  const health: HealthStatus = isConnected ? "healthy" : phone.connection_state === "unknown" ? "warning" : "error";

  return (
    <div className="rounded-2xl border border-white/10 p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#3EE88A]/10">
          <Smartphone className="w-5 h-5 text-[#3EE88A]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">{formatPhone(phoneDisplay)}</span>
            <StatusDot status={health} />
          </div>
          {phone.instance_name && <div className="text-xs text-zinc-500">{phone.instance_name}</div>}
          {!isConnected && phone.connection_state !== "unknown" && (
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

      <div className="grid grid-cols-4 gap-2">
        <ActionButton icon={<ImageUp className="w-3.5 h-3.5" />} label="QR" onClick={() => onShowQR(phone)} />
        <ActionButton
          icon={isConnected ? <LogOut className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
          label={isConnected ? "Disconnect" : "Connect"}
          onClick={() => handleAction(isConnected ? "disconnect" : "connect")}
          variant={isConnected ? "danger" : "primary"}
        />
        <ActionButton icon={<RefreshCw className="w-3.5 h-3.5" />} label="Reset" onClick={() => handleAction("reset")} />
        <ActionButton icon={<Trash2 className="w-3.5 h-3.5" />} label="Delete" onClick={() => handleAction("delete")} variant="danger" />
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
  const [phonesLoading, setPhonesLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [qrPhone, setQrPhone] = useState<Phone | null>(null);

  const [totalParsed, setTotalParsed] = useState<number>(0);
  const [totalListings, setTotalListings] = useState<number>(0);
  const [totalRequirements, setTotalRequirements] = useState<number>(0);
  const [totalBrokers, setTotalBrokers] = useState<number>(0);
  const [rawTotal, setRawTotal] = useState<number>(0);
  const [rawProcessed, setRawProcessed] = useState<number>(0);
  const [rawPending, setRawPending] = useState<number>(0);
  const [extractionPct, setExtractionPct] = useState<number>(0);
  const [recentlyProcessed1h, setRecentlyProcessed1h] = useState<number>(0);

  const fetchPhones = useCallback(async () => {
    try {
      const res = await getPhones();
      setPhones(res.phones || []);
    } catch { /* ignore */ }
    setPhonesLoading(false);
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const [stats, syncAct] = await Promise.all([
        fetch("/api/stats").then((r) => r.json()).catch(() => ({})),
        fetch("/api/dashboard/sync-activity").then((r) => r.json()).catch(() => ({})),
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
        const extProgress = await fetch("/api/extraction/progress").then((r) => r.json());
        if (extProgress?.recently_processed_1h != null) setRecentlyProcessed1h(extProgress.recently_processed_1h);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!authLoading && user) {
      fetchPhones();
      fetchStats();
      const interval = setInterval(() => {
        fetchPhones();
        fetchStats();
      }, 15000);
      return () => clearInterval(interval);
    }
  }, [authLoading, user, fetchPhones, fetchStats]);

  if (authLoading || !user) return null;

  const connectedCount = phones.filter((p) => p.connected || p.connection_state === "open").length;
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
      ) : phones.length === 0 ? (
        <div className="rounded-2xl border border-white/10 p-12 text-center">
          <Smartphone className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
          <p className="text-sm text-zinc-400">No phones connected yet.</p>
          <p className="text-xs text-zinc-600 mt-1">Add a phone to start monitoring WhatsApp groups.</p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 rounded-lg bg-[#3EE88A] text-black px-6 py-2.5 text-xs font-bold min-h-[44px]"
          >
            <Plus className="w-4 h-4 inline mr-1" /> Add Your First Phone
          </button>
        </div>
      ) : (
        <>
          {/* Phone Cards */}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {phones.map((phone) => (
              <PhoneCard key={phone.id} phone={phone} onRefresh={fetchPhones} onShowQR={setQrPhone} />
            ))}
          </div>

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

      <CreatePhoneDialog open={showCreate} onClose={() => setShowCreate(false)} onCreated={fetchPhones} />
      {qrPhone && <QRModal phone={qrPhone} open={!!qrPhone} onClose={() => setQrPhone(null)} />}
    </div>
  );
}
