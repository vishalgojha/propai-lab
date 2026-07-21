"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Zap,
  MessageSquare,
  Image,
  Video,
  Mic,
  FileText,
  Smile,
  MapPin,
  Users,
  SmilePlus,
  BarChart3,
  Pencil,
  ArrowUpRight,
  Clock,
  CheckCheck,
  Camera,
  Download,
  Upload,
  Bot,
  Navigation,
  Circle,
  RefreshCw,
  Radio,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Wifi,
  WifiOff,
  Activity,
} from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface Capability {
  name: string;
  status: "active" | "partial" | "captured_unused" | "not_available";
  icon: string;
  description?: string;
  evidence_count?: number;
}

interface PhoneStatus {
  broker_id?: string;
  phone_number?: string;
  phone_number_live?: string;
  display_name?: string;
  connected?: boolean;
  connection_state?: string;
  total_messages_received?: number;
  total_outgoing?: number;
  total_locations?: number;
  total_contacts?: number;
  total_reactions?: number;
  last_message_at?: string;
  instance_name?: string;
  live_status_available?: boolean;
}

interface PhonesResponse {
  phones: PhoneStatus[];
}

interface CapabilityResponse {
  capabilities: Capability[];
  instance: string;
  version: string;
}

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  MessageSquare,
  Image,
  Video,
  Mic,
  FileText,
  Smile,
  MapPin,
  Users,
  Contact: Users,
  SmilePlus,
  BarChart3,
  Vote: BarChart3,
  Pencil,
  ArrowUpRight,
  Clock,
  CheckCheck,
  Camera,
  Download,
  Upload,
  Bot,
  Navigation: MapPin,
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-400",
  partial: "bg-amber-400",
  captured_unused: "bg-sky-400",
  not_available: "bg-zinc-600",
};

const STATUS_BORDER: Record<string, string> = {
  active: "border-emerald-500/20 bg-emerald-500/[0.04]",
  partial: "border-amber-500/20 bg-amber-500/[0.04]",
  captured_unused: "border-sky-500/20 bg-sky-500/[0.04]",
  not_available: "border-white/5 bg-white/[0.015]",
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  partial: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  captured_unused: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  not_available: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  partial: "Partial",
  captured_unused: "Captured",
  not_available: "Off",
};

function CapIcon({ name, className }: { name: string; className?: string }) {
  const C = ICON_MAP[name] || Circle;
  return <C className={className} />;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`border border-white/10 bg-[#090909] ${className}`}>{children}</div>;
}

function Kicker({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{children}</div>;
}

function ago(value?: string) {
  if (!value) return "never";
  const stamp = new Date(value).getTime();
  if (Number.isNaN(stamp)) return "unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - stamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export default function WhatsWowPage() {
  const router = useRouter();
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [phones, setPhones] = useState<PhoneStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [caps, phonesRes] = await Promise.allSettled([
        fetchJSON<CapabilityResponse>("/ingestor/capabilities", undefined, 8000),
        fetchJSON<PhonesResponse>("/phones", undefined, 8000),
      ]);
      if (caps.status === "fulfilled" && caps.value?.capabilities) {
        setCapabilities(caps.value.capabilities);
      }
      if (phonesRes.status === "fulfilled") {
        setPhones(phonesRes.value.phones || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    const interval = setInterval(loadData, 8000);
    return () => clearInterval(interval);
  }, [loadData]);

  const activeCount = capabilities.filter((c) => c.status === "active").length;
  const partialCount = capabilities.filter((c) => c.status === "partial").length;
  const capturedCount = capabilities.filter((c) => c.status === "captured_unused").length;
  const offCount = capabilities.filter((c) => c.status === "not_available").length;
  const totalMsgs = phones.reduce((s, p) => s + (p.total_messages_received || 0), 0);
  const totalOutgoing = phones.reduce((s, p) => s + (p.total_outgoing || 0), 0);
  const totalLocations = phones.reduce((s, p) => s + (p.total_locations || 0), 0);
  const totalContacts = phones.reduce((s, p) => s + (p.total_contacts || 0), 0);
  const totalReactions = phones.reduce((s, p) => s + (p.total_reactions || 0), 0);
  const connectedCount = phones.filter((p) => p.connected).length;

  return (
    <main className="mx-auto max-w-[1500px] space-y-5 px-4 py-5 text-white sm:px-6">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-5">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/5 hover:text-white transition-colors lg:hidden"
            aria-label="Go back"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div>
            <Kicker>WhatsApp ingestor</Kicker>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">WhatsWow</h1>
            <p className="mt-2 max-w-2xl text-sm text-zinc-500">
              Live connection status, message capture capabilities and ingestor health.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={loadData}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-white/15 bg-white px-3 py-2 text-xs font-semibold text-black transition hover:bg-zinc-200 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      {/* Stats row */}
      <section className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <Card className="p-4">
          <Kicker>Connected</Kicker>
          <div className="mt-2 flex items-center gap-2">
            {connectedCount > 0 ? (
              <Wifi className="h-4 w-4 text-emerald-400" />
            ) : (
              <WifiOff className="h-4 w-4 text-red-400" />
            )}
            <span className="text-2xl font-semibold tabular-nums">{connectedCount}<span className="text-sm text-zinc-500">/{phones.length}</span></span>
          </div>
        </Card>
        <Card className="p-4">
          <Kicker>Capabilities</Kicker>
          <div className="mt-2 flex items-center gap-2">
            <Zap className="h-4 w-4 text-[#3EE88A]" />
            <span className="text-2xl font-semibold tabular-nums">{activeCount}<span className="text-sm text-zinc-500">/{capabilities.length}</span></span>
          </div>
        </Card>
        <Card className="p-4">
          <Kicker>Messages captured</Kicker>
          <div className="mt-2 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-sky-400" />
            <span className="text-2xl font-semibold tabular-nums">{totalMsgs.toLocaleString("en-IN")}</span>
          </div>
        </Card>
        <Card className="p-4">
          <Kicker>Outgoing</Kicker>
          <div className="mt-2 flex items-center gap-2">
            <ArrowUpRight className="h-4 w-4 text-violet-400" />
            <span className="text-2xl font-semibold tabular-nums">{totalOutgoing.toLocaleString("en-IN")}</span>
          </div>
        </Card>
        <Card className="p-4">
          <Kicker>Locations</Kicker>
          <div className="mt-2 flex items-center gap-2">
            <MapPin className="h-4 w-4 text-amber-400" />
            <span className="text-2xl font-semibold tabular-nums">{totalLocations.toLocaleString("en-IN")}</span>
          </div>
        </Card>
        <Card className="p-4">
          <Kicker>Contacts</Kicker>
          <div className="mt-2 flex items-center gap-2">
            <Users className="h-4 w-4 text-rose-400" />
            <span className="text-2xl font-semibold tabular-nums">{totalContacts.toLocaleString("en-IN")}</span>
          </div>
        </Card>
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        {/* Connections */}
        <Card className="p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-[#3EE88A]" />
            <Kicker>Connections</Kicker>
          </div>
          <div className="mt-4 space-y-3">
            {phones.length === 0 ? (
              <div className="py-8 text-center text-sm text-zinc-600">
                {loading ? "Loading connections..." : "No WhatsApp connections found."}
              </div>
            ) : (
              phones.map((phone, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-white/5 bg-white/[0.02] p-4 space-y-2"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        phone.connected
                          ? "bg-emerald-400"
                          : phone.connection_state === "connecting"
                            ? "bg-amber-400 animate-pulse"
                            : "bg-red-400"
                      }`}
                    />
                    <span className="text-sm font-medium text-white">
                      {phone.display_name || phone.phone_number_live || phone.phone_number || phone.broker_id}
                    </span>
                    <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                      {phone.connection_state || "unknown"}
                    </span>
                  </div>
                  {phone.phone_number_live && (
                    <div className="text-[11px] text-zinc-500 ml-5">
                      +{phone.phone_number_live}
                      {phone.instance_name && <span className="ml-2 text-zinc-600">({phone.instance_name})</span>}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-5 gap-y-1 ml-5 text-[11px] text-zinc-500">
                    <span>{(phone.total_messages_received || 0).toLocaleString("en-IN")} received</span>
                    <span>{(phone.total_outgoing || 0).toLocaleString("en-IN")} sent</span>
                    {phone.total_locations ? <span>{phone.total_locations} locations</span> : null}
                    {phone.total_contacts ? <span>{phone.total_contacts} contacts</span> : null}
                    {phone.total_reactions ? <span>{phone.total_reactions} reactions</span> : null}
                  </div>
                  {phone.last_message_at && (
                    <div className="text-[10px] text-zinc-600 ml-5">
                      Last message: {ago(phone.last_message_at)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Capabilities */}
        <Card className="p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-[#3EE88A]" />
            <Kicker>Capabilities</Kicker>
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {capabilities.length === 0 ? (
              <div className="col-span-2 py-8 text-center text-sm text-zinc-600">
                {loading ? "Loading capabilities..." : "No capability data available."}
              </div>
            ) : (
              capabilities.map((cap) => (
                <div
                  key={cap.name}
                  className={`rounded-lg border px-3 py-2.5 ${STATUS_BORDER[cap.status]}`}
                >
                  <div className="flex items-center gap-2.5">
                    <CapIcon name={cap.icon} className="w-4 h-4 text-zinc-400 shrink-0" />
                    <span className="text-xs font-medium text-white truncate flex-1">{cap.name}</span>
                    {cap.evidence_count !== undefined && cap.evidence_count > 0 && (
                      <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
                        {cap.evidence_count.toLocaleString("en-IN")} seen
                      </span>
                    )}
                    <span
                      className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${STATUS_BADGE[cap.status]}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[cap.status]}`} />
                      {STATUS_LABELS[cap.status]}
                    </span>
                  </div>
                  {cap.description && (
                    <p className="mt-1 ml-6 text-[11px] leading-snug text-zinc-500">
                      {cap.description}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
          {capabilities.length > 0 && (
            <div className="flex flex-wrap gap-4 mt-4 pt-3 border-t border-white/5 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-400" /> {activeCount} Active</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" /> {partialCount} Partial</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-sky-400" /> {capturedCount} Captured</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-zinc-600" /> {offCount} Off</span>
            </div>
          )}
        </Card>
      </section>

      {/* Raw Data */}
      <Card className="p-5 sm:p-6">
        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="flex items-center gap-2"
        >
          {showRaw ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />}
          <FileText className="h-4 w-4 text-zinc-500" />
          <Kicker>Raw Inspector</Kicker>
        </button>
        {showRaw && (
          <pre className="mt-4 text-[10px] leading-4 text-zinc-500 bg-zinc-900 rounded-lg p-4 overflow-x-auto max-h-[500px] overflow-y-auto border border-white/5">
            {JSON.stringify({ phones, capabilities }, null, 2)}
          </pre>
        )}
      </Card>
    </main>
  );
}
