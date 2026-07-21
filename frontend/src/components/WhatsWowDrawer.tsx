"use client";

import { useState, useEffect, useCallback } from "react";
import Drawer from "@/components/motion/Drawer";
import { fetchJSON } from "@/lib/api";
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
  Radio,
  Circle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface WhatsWowDrawerProps {
  open: boolean;
  onClose: () => void;
}

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
  "not_available": "Off",
};

function CapIcon({ name, className }: { name: string; className?: string }) {
  const C = ICON_MAP[name] || Circle;
  return <C className={className} />;
}

export default function WhatsWowDrawer({ open, onClose }: WhatsWowDrawerProps) {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [phones, setPhones] = useState<PhoneStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    connections: true,
    capabilities: true,
    raw: false,
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [caps, phonesRes] = await Promise.allSettled([
        fetchJSON<CapabilityResponse>("/ingestor/capabilities", undefined, 5000),
        fetchJSON<PhonesResponse>("/phones", undefined, 5000),
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
    if (!open) return;
    loadData();
    const interval = setInterval(loadData, 8000);
    return () => clearInterval(interval);
  }, [open, loadData]);

  const toggleSection = (key: string) =>
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const activeCount = capabilities.filter((c) => c.status === "active").length;
  const totalLocations = phones.reduce((s, p) => s + (p.total_locations || 0), 0);
  const totalContacts = phones.reduce((s, p) => s + (p.total_contacts || 0), 0);
  const totalReactions = phones.reduce((s, p) => s + (p.total_reactions || 0), 0);
  const totalOutgoing = phones.reduce((s, p) => s + (p.total_outgoing || 0), 0);

  return (
    <Drawer open={open} onClose={onClose} variant="right" widthClass="max-w-md" panelClass="bg-[#0a0e14] border-l border-white/10 shadow-2xl">
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-[#3EE88A]" />
            <h2 className="text-base font-bold text-white tracking-wide">WhatsWow</h2>
            <span className="text-[10px] text-zinc-500 ml-auto">v2.0</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">
            WhatsApp capabilities &amp; live status
          </p>
          {loading && (
            <div className="mt-2 h-0.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-[#3EE88A] animate-pulse w-1/3" />
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Connection Status */}
          <div className="border-b border-white/5">
            <button onClick={() => toggleSection("connections")} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-white/[0.02]">
              {expandedSections.connections ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />}
              <Radio className="w-3.5 h-3.5 text-[#3EE88A]" />
              <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Connections</span>
              <span className="ml-auto text-[10px] text-zinc-500">{phones.length} phone{phones.length !== 1 ? "s" : ""}</span>
            </button>
            {expandedSections.connections && (
              <div className="px-4 pb-3 space-y-2">
                {phones.length === 0 ? (
                  <div className="text-[11px] text-zinc-600 py-2">No connections found</div>
                ) : (
                  phones.map((phone, i) => (
                    <div key={i} className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${phone.connected ? "bg-emerald-400" : phone.connection_state === "connecting" ? "bg-amber-400" : "bg-red-400"}`} />
                        <span className="text-xs font-medium text-white">{phone.display_name || phone.phone_number_live || phone.phone_number || phone.broker_id}</span>
                        <span className="text-[10px] text-zinc-500 ml-auto">{phone.connection_state}</span>
                      </div>
                      {phone.phone_number_live && (
                        <div className="text-[10px] text-zinc-500 ml-4">+{phone.phone_number_live}</div>
                      )}
                      <div className="flex gap-3 ml-4 text-[10px] text-zinc-500">
                        <span>{phone.total_messages_received || 0} msgs</span>
                        <span>{phone.total_outgoing || 0} sent</span>
                        {phone.total_locations ? <span>{phone.total_locations} loc</span> : null}
                        {phone.total_contacts ? <span>{phone.total_contacts} contacts</span> : null}
                        {phone.total_reactions ? <span>{phone.total_reactions} reacts</span> : null}
                      </div>
                      {phone.last_message_at && (
                        <div className="text-[9px] text-zinc-600 ml-4">
                          Last: {new Date(phone.last_message_at).toLocaleTimeString()}
                        </div>
                      )}
                    </div>
                  ))
                )}
                {/* Totals summary */}
                {phones.length > 0 && (
                  <div className="flex gap-4 text-[10px] text-zinc-500 pt-1 ml-1">
                    <span>Total: {phones.reduce((s, p) => s + (p.total_messages_received || 0), 0)} msgs</span>
                    {totalOutgoing > 0 && <span>{totalOutgoing} outgoing</span>}
                    {totalLocations > 0 && <span>{totalLocations} locations</span>}
                    {totalContacts > 0 && <span>{totalContacts} contacts</span>}
                    {totalReactions > 0 && <span>{totalReactions} reactions</span>}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Capabilities Grid */}
          <div className="border-b border-white/5">
            <button onClick={() => toggleSection("capabilities")} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-white/[0.02]">
              {expandedSections.capabilities ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />}
              <Zap className="w-3.5 h-3.5 text-[#3EE88A]" />
              <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Capabilities</span>
              <span className="ml-auto text-[10px] text-zinc-500">{activeCount}/{capabilities.length} active</span>
            </button>
            {expandedSections.capabilities && (
              <div className="px-4 pb-3 space-y-1.5">
                {capabilities.map((cap) => (
                  <div key={cap.name} className="rounded-md border border-white/5 bg-white/[0.015] px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <CapIcon name={cap.icon} className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      <span className="text-[10px] font-medium text-white truncate flex-1">{cap.name}</span>
                      {cap.evidence_count !== undefined && cap.evidence_count > 0 && (
                        <span className="shrink-0 text-[9px] tabular-nums text-zinc-500">
                          {cap.evidence_count.toLocaleString("en-IN")}
                        </span>
                      )}
                      <span
                        className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider ${STATUS_BADGE[cap.status]}`}
                      >
                        <span className={`w-1 h-1 rounded-full ${STATUS_COLORS[cap.status]}`} />
                        {STATUS_LABELS[cap.status]}
                      </span>
                    </div>
                    {cap.description && (
                      <p className="mt-1 ml-5 text-[10px] leading-snug text-zinc-500">
                        {cap.description}
                      </p>
                    )}
                  </div>
                ))}
                <div className="flex gap-3 mt-2 text-[9px] text-zinc-600">
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Active</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Partial</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sky-400" /> Captured</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-zinc-600" /> Off</span>
                </div>
              </div>
            )}
          </div>

          {/* Raw Info */}
          <div>
            <button onClick={() => toggleSection("raw")} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-white/[0.02]">
              {expandedSections.raw ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />}
              <FileText className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Raw Data</span>
            </button>
            {expandedSections.raw && (
              <div className="px-4 pb-4">
                <pre className="text-[10px] text-zinc-500 bg-zinc-900 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto border border-white/5">
                  {JSON.stringify({ phones, capabilities: capabilities.slice(0, 5) }, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
