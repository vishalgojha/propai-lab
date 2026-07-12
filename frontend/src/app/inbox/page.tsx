"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useRef, useCallback, useMemo, Suspense, lazy } from "react";
import nextDynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import * as api from "@/lib/api";
import WhatsAppMessage, { MessageEntity } from "@/components/WhatsAppMessage";
import TextSelectionMenu from "@/components/TextSelectionMenu";
import NotesPanel from "@/components/notes/NotesPanel";
const CombinedLocalityDialog = nextDynamic(() => import("@/components/CombinedLocalityDialog").then((m) => ({ default: m.CombinedLocalityDialog })), { ssr: false });
const AddToClientBucket = nextDynamic(() => import("@/components/AddToClientBucket"), { ssr: false });
import ResizablePanel from "@/components/ResizablePanel";
import { entityProfileHref } from "@/lib/entity-links";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import InboxAIChat from "@/components/InboxAIChat";
import {
  Users,
  User,
  Phone,
  Search,
  Video,
  Info,
  Sparkles,
  Building2,
  MapPin,
  DollarSign,
  BedDouble,
  Ruler,
  Armchair,
  Send,
  Calendar,
  MessageSquare,
  ClipboardList,
  Maximize2,
  Minimize2,
  EyeOff,
  Eye,
  TrendingUp,
  Home,
  ChevronLeft,
} from "lucide-react";

const PAGE_SIZE = 100;
const RIGHT_TABS = [
  { key: "analysis", label: "Analysis" },
  { key: "broker", label: "Broker" },
  { key: "market", label: "Market" },
  { key: "ai", label: "AI Assistant" },
  { key: "notes", label: "Notes" },
] as const;

type TrainingPrompt = {
  text: string;
  question: string;
  actions: { label: string; action: string }[];
};

function stripEmojis(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{231A}-\u{23FF}\u{25A0}-\u{25FF}\u{2934}-\u{2935}\u{2B05}-\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{2122}\u{2139}\u{24C2}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2600}-\u{27EB}]/gu, "").trim();
}

function intentIcon(intent?: string): string {
  switch ((intent || "").toUpperCase()) {
    case "SELL": case "SALE": case "LEASE": return "🏢";
    case "RENT": return "🏠";
    case "BUY": case "REQUIREMENT": case "WANTED": return "🔍";
    case "COMMERCIAL": return "🏢";
    default: return "💬";
  }
}

function intentLabel(intent?: string): string {
  switch ((intent || "").toUpperCase()) {
    case "SELL": case "SALE": case "LEASE": return "Sale";
    case "RENT": return "Rental";
    case "BUY": case "REQUIREMENT": case "WANTED": return "Requirement";
    case "COMMERCIAL": return "Commercial";
    default: return "Message";
  }
}

function intentColor(intent?: string): string {
  switch ((intent || "").toUpperCase()) {
    case "SELL": case "SALE": case "LEASE": return "badge-green";
    case "RENT": return "badge-blue";
    case "BUY": case "REQUIREMENT": case "WANTED": return "badge-orange";
    case "COMMERCIAL": return "badge-purple";
    default: return "badge-gray";
  }
}

function observationTypeLabel(type?: string): string {
  return type || "UNKNOWN";
}

function observationTypeIcon(type?: string): string {
  switch ((type || "").toUpperCase()) {
    case "LISTING": return "🏷️";
    case "REQUIREMENT": return "🎯";
    case "MARKET_UPDATE": return "📊";
    case "INTRODUCTION": return "👋";
    default: return "⚪";
  }
}

function observationTypeColor(type?: string): string {
  switch ((type || "").toUpperCase()) {
    case "LISTING": return "badge-green";
    case "REQUIREMENT": return "badge-blue";
    case "MARKET_UPDATE": return "badge-purple";
    case "INTRODUCTION": return "badge-orange";
    default: return "badge-gray";
  }
}

function formatCurrency(val: number, unit?: string) {
  if (!val) return "—";
  // Normalize value by unit
  let normalized = val;
  if (unit) {
    const u = unit.toLowerCase();
    if (u === "cr" || u === "crore") normalized = val * 10000000;
    else if (u === "lac" || u === "lakh" || u === "l") normalized = val * 100000;
    else if (u === "k" || u === "thousand") normalized = val * 1000;
  }
  if (unit?.toLowerCase() === "cr" || normalized >= 10000000) {
    const cr = normalized / 10000000;
    return `₹${cr % 1 === 0 ? cr.toFixed(0) : cr.toFixed(2)} Cr`;
  }
  if (normalized >= 100000) {
    const l = normalized / 100000;
    return `₹${l % 1 === 0 ? l.toFixed(0) : l.toFixed(1)} L`;
  }
  if (normalized >= 1000) {
    return `₹${(normalized / 1000).toFixed(0)} K`;
  }
  return `₹${normalized.toLocaleString("en-IN")}`;
}

function formatAgeShort(value?: string) {
  if (!value) return "—";
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return "—";
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function Field({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-[10px] text-zinc-500 block uppercase tracking-wider">{label}</span>
      <span className={`mt-0.5 block leading-normal ${accent ? "font-bold text-[#3EE88A]" : "font-semibold text-white"}`}>
        {value}
      </span>
    </div>
  );
}

function buildTeachingNotes(
  instruction: string,
  scope: { future: boolean; similar: boolean; messageOnly: boolean }
): string {
  const trimmed = instruction.trim();
  const appliesTo = [
    scope.future ? "future messages" : null,
    scope.similar ? "similar patterns" : null,
    scope.messageOnly ? "this message only" : null,
  ].filter(Boolean);

  if (!trimmed && appliesTo.length === 0) return "";
  if (!trimmed) return `Applies to: ${appliesTo.join(", ")}`;
  if (appliesTo.length === 0) return trimmed;
  return `${trimmed}\n\nApplies to: ${appliesTo.join(", ")}`;
}

function TeachingForm({
  parsed,
  obsId,
  parsedId,
  rawMessageId,
  onSave,
}: {
  parsed: any;
  obsId: number;
  parsedId: number;
  rawMessageId: number;
  onSave: () => void;
}) {
  const [building, setBuilding] = useState(parsed?.building_name || "");
  const [location, setLocation] = useState(parsed?.micro_market || parsed?.location_raw || "");
  const [landmark, setLandmark] = useState(parsed?.landmark_name || "");
  const [developer, setDeveloper] = useState(parsed?.developer || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const payload: any = { parsed_id: parsedId, raw_message_id: rawMessageId };
      if (building.trim()) payload.building_name = building.trim();
      if (location.trim()) payload.micro_market = location.trim();
      if (landmark.trim()) payload.landmark_name = landmark.trim();
      if (developer.trim()) payload.developer = developer.trim();
      const res = await api.teachObservation(obsId, payload);
      if (res.status === "ok") {
        setSaved(true);
        setTimeout(() => { setSaved(false); onSave(); }, 1500);
      } else {
        setError("Save failed");
      }
    } catch (e: any) {
      setError(e.message || "Error saving");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg p-2 border border-white/10 space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <label className="text-[8px] text-zinc-500 uppercase tracking-wider">Building</label>
          <input
            value={building}
            onChange={(e) => { setBuilding(e.target.value); setSaved(false); }}
            className="w-full bg-[#161b22] border border-white/10 rounded px-1.5 py-1 text-[10px] text-white outline-none focus:border-[#3EE88A]/40"
            placeholder="e.g. Ananta"
          />
        </div>
        <div>
          <label className="text-[8px] text-zinc-500 uppercase tracking-wider">Location</label>
          <input
            value={location}
            onChange={(e) => { setLocation(e.target.value); setSaved(false); }}
            className="w-full bg-[#161b22] border border-white/10 rounded px-1.5 py-1 text-[10px] text-white outline-none focus:border-[#3EE88A]/40"
            placeholder="e.g. Bandra West"
          />
        </div>
        <div>
          <label className="text-[8px] text-zinc-500 uppercase tracking-wider">Landmark</label>
          <input
            value={landmark}
            onChange={(e) => { setLandmark(e.target.value); setSaved(false); }}
            className="w-full bg-[#161b22] border border-white/10 rounded px-1.5 py-1 text-[10px] text-white outline-none focus:border-[#3EE88A]/40"
            placeholder="e.g. Agarwal Nursing Home"
          />
        </div>
        <div>
          <label className="text-[8px] text-zinc-500 uppercase tracking-wider">Developer</label>
          <input
            value={developer}
            onChange={(e) => { setDeveloper(e.target.value); setSaved(false); }}
            className="w-full bg-[#161b22] border border-white/10 rounded px-1.5 py-1 text-[10px] text-white outline-none focus:border-[#3EE88A]/40"
            placeholder="e.g. Ananta Realty"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-[9px] px-2 py-0.5 rounded bg-[#166534] hover:bg-[#15803d] text-green-100 disabled:opacity-50"
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save Teaching"}
        </button>
        {error && <span className="text-[9px] text-red-400">{error}</span>}
        {saved && <span className="text-[9px] text-[#3EE88A]">Saved as global knowledge</span>}
      </div>
    </div>
  );
}

function TeachingPromptCard({
  prompt,
  onSave,
}: {
  prompt: TrainingPrompt;
  onSave: (text: string, action: string, notes: string) => void;
}) {
  const [selectedAction, setSelectedAction] = useState(prompt.actions[0]?.action || "");
  const [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState({ future: true, similar: true, messageOnly: false });

  return (
    <div className="rounded-lg bg-[#05070b] border border-[rgba(255,255,255,0.05)] p-2.5">
      <div className="text-[10px] text-zinc-500 mb-1">{prompt.question}</div>
      <div className="text-xs font-semibold text-white break-words">{prompt.text}</div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {prompt.actions.map(action => (
          <label
            key={action.action}
            className={`flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors ${
              selectedAction === action.action
                ? "border-[#3EE88A]/45 bg-[#3EE88A]/10 text-[#3EE88A]"
                : "border-white/10 bg-white/5 text-zinc-300"
            }`}
          >
            <input
              type="radio"
              name={`teaching-${prompt.text}`}
              checked={selectedAction === action.action}
              onChange={() => setSelectedAction(action.action)}
              className="h-3 w-3 accent-[#3EE88A]"
            />
            <span>{action.label}</span>
          </label>
        ))}
      </div>

      <label className="mt-2 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        Instruction
      </label>
      <textarea
        value={instruction}
        onChange={e => setInstruction(e.target.value)}
        placeholder={`Whenever you see "${prompt.text}", treat it as...`}
        rows={3}
        className="mt-1 w-full resize-none rounded-md border border-white/10 bg-black px-2 py-1.5 text-[11px] leading-relaxed text-zinc-300 placeholder-[#4a5568] outline-none focus:border-[#3EE88A]/40"
      />

      <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-zinc-400">
        {[
          { key: "future" as const, label: "Future messages" },
          { key: "similar" as const, label: "Similar patterns" },
          { key: "messageOnly" as const, label: "This message only" },
        ].map(item => (
          <label key={item.key} className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={scope[item.key]}
              onChange={e => setScope(prev => ({ ...prev, [item.key]: e.target.checked }))}
              className="h-3 w-3 accent-[#3EE88A]"
            />
            {item.label}
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={() => selectedAction && onSave(prompt.text, selectedAction, buildTeachingNotes(instruction, scope))}
        disabled={!selectedAction}
        className="mt-2 w-full rounded-md bg-[#3EE88A] px-2 py-1.5 text-[11px] font-bold text-[#07110b] hover:bg-[#2dd977] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Save Teaching
      </button>
    </div>
  );
}

const FIRM_LINE_RE = /\b(?:real\s+estate|realtors?|properties|property|consultants?|associates|llp|pvt|private|ltd|estate)\b/i;

type EntityDetailShape = {
  raw?: Partial<api.RawMessage>;
  parsed?: Partial<api.ParsedObservation> & {
    broker_phone?: string;
    profile_name?: string;
  };
  resolver?: {
    building_name?: string;
  };
  listings?: Array<{
    id?: string | number;
    bhk?: string;
    building_name?: string;
    micro_market?: string;
  }>;
};

function addEntity(entities: MessageEntity[], entity: MessageEntity) {
  const text = entity.text?.trim();
  if (!text || text.length < 2) return;
  const key = `${entity.type}:${(entity.phone || text).toLowerCase()}`;
  if (entities.some((item) => `${item.type}:${(item.phone || item.text).toLowerCase()}` === key)) return;
  entities.push({ ...entity, text });
}

function BuildingTooltip({ name }: { name: string }) {
  const [data, setData] = useState<any>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function doFetch() {
    api.getBuildingProfile(name).then(setData).catch(() => {});
  }

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => { if (hideTimer.current) clearTimeout(hideTimer.current); if (!data) doFetch(); setVisible(true); }}
      onMouseLeave={() => { hideTimer.current = setTimeout(() => setVisible(false), 200); }}
    >
      <span className="font-semibold text-[#3EE88A] truncate max-w-[220px] block cursor-pointer">{name}</span>
      {visible && data && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 min-w-[220px] rounded-lg border border-white/10 bg-zinc-800 p-3 shadow-xl pointer-events-none">
          <div className="text-[11px] text-white font-semibold mb-1.5">{data.canonical_name}</div>
          <div className="space-y-1 text-[10px] text-zinc-400">
            {data.micro_market && <div>Market: <span className="text-zinc-300">{data.micro_market}</span></div>}
            <div>Listings: <span className="text-zinc-300">{data.observed_listings}</span></div>
            <div>Brokers: <span className="text-zinc-300">{data.observed_brokers}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigurationBadge({ config }: { config?: string }) {
  if (!config) return null;
  const labels: Record<string, string> = {
    JODI: "Jodi",
    MULTI_OFFICE: "Multi Office",
    DUPLEX: "Duplex",
    PENTHOUSE: "Penthouse",
  };
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-900/40 text-purple-300 border border-purple-700/40">
      {labels[config] || config}
    </span>
  );
}

function SaleModeBadge({ mode }: { mode?: string }) {
  if (!mode) return null;
  const labels: Record<string, string> = {
    SPLIT_ALLOWED: "Can be sold separately",
    TOGETHER_ONLY: "Together only",
  };
  const colors: Record<string, string> = {
    SPLIT_ALLOWED: "bg-amber-900/40 text-amber-300 border-amber-700/40",
    TOGETHER_ONLY: "bg-rose-900/40 text-rose-300 border-rose-700/40",
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${colors[mode] || "bg-gray-800 text-gray-300"}`}>
      {labels[mode] || mode}
    </span>
  );
}

function listingSourceBadge(source: string | null) {
  switch (source) {
    case "DIRECT":
      return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-500/10 text-green-400" title="Direct inventory — broker's own listing">Direct</span>;
    case "INDIRECT":
      return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400" title="Indirect (+1) inventory — shared from another broker">Indirect (+1)</span>;
    default:
      return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-400" title="Unknown inventory source">Unknown</span>;
  }
}

function PropertyDetails({ parsed }: { parsed: any }) {
  const intent = (parsed.intent || "").toUpperCase();
  const obsType = parsed.observation_type || "UNKNOWN";
  const propertyType = parsed.property_type;
  const alternateIntent = parsed.alternate_intent;
  const price = parsed.price ? formatCurrency(parsed.price, parsed.price_unit) : null;
  const area = parsed.area_sqft ? `${parsed.area_sqft} sqft` : null;
  const location = parsed.location_raw || parsed.micro_market || null;
  const building = parsed.building_name || null;
  const furnishing = parsed.furnishing || null;
  const bhk = parsed.bhk || null;
  const configuration = parsed.configuration || null;
  const saleMode = parsed.sale_mode || null;
  const rate = parsed.rate ? formatCurrency(parsed.rate, parsed.rate_unit) : null;
  const parking = parsed.parking || null;
  const units: any[] = parsed.units || [];
  const combinedArea = parsed.combined_area_sqft;
  const floorDesc = parsed.floor_description || null;
  const view = parsed.view || null;
  const orientation = parsed.orientation || null;
  const position = parsed.position || null;
  const projectName = parsed.project_name || null;
  const towerName = parsed.tower_name || null;
  const wingName = parsed.wing_name || null;
  const listingSource = parsed.listing_source || null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${observationTypeColor(obsType)} flex items-center gap-1`}>
          <span>{observationTypeIcon(obsType)}</span>
          <span>{observationTypeLabel(obsType)}</span>
        </span>
        {intent && <span className={`badge ${intentColor(parsed.intent)} text-[9px]`}>{intent}</span>}
        {propertyType && <span className="text-[10px] text-zinc-400 font-medium">{propertyType}</span>}
        <ConfigurationBadge config={configuration} />
        <SaleModeBadge mode={saleMode} />
        {listingSourceBadge(listingSource)}
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <Field label="Intent" value={<span className={`badge ${intentColor(parsed.intent)}`}>{intent}</span>} />
        <Field label="Price" value={price} accent />
        <Field label="BHK" value={bhk} />
        <Field label="Carpet" value={area} />
        <Field label="Location" value={location} />
        {building && <Field label="Building" value={<BuildingTooltip name={building} />} />}
        {furnishing && <Field label="Furnishing" value={furnishing} />}
        {rate && <Field label="Rate" value={rate} />}
        {parking && <Field label="Parking" value={parking} />}
        {combinedArea && <Field label="Combined Area" value={`${combinedArea} sqft`} />}
        {floorDesc && <Field label="Floor" value={floorDesc} />}
        {view && <Field label="View" value={view} />}
        {orientation && <Field label="Orientation" value={orientation} />}
        {position && <Field label="Position" value={position} />}
        {projectName && <Field label="Project" value={projectName} />}
        {towerName && <Field label="Tower" value={towerName} />}
        {wingName && <Field label="Wing" value={wingName} />}
      </div>

      {/* Units section — show when there are multiple units */}
      {units.length > 0 && (
        <div className="border-t border-white/5 pt-2">
          <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-bold block mb-1.5">
            Inventory Units ({units.length})
          </span>
          <div className="space-y-1">
            {units.map((unit: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[10px] text-zinc-300 bg-white/5 rounded px-2 py-1">
                <span className="font-bold text-zinc-500">#{i + 1}</span>
                {unit.bhk && <span className="font-semibold">{unit.bhk}</span>}
                {unit.area_sqft && <span>{unit.area_sqft} sqft</span>}
                {(unit.price || unit.price_unit) && (
                  <span className="font-bold text-[#3EE88A]">₹{formatCurrency(unit.price, unit.price_unit)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {alternateIntent && (
        <div className="text-[10px] text-zinc-400 italic border-t border-white/5 pt-2 mt-1">
          Also available for {alternateIntent === "RENT" ? "rent" : "sale"}
        </div>
      )}
    </div>
  );
}

function BrokerTooltip({ name, phone, onContextMenu }: { name: string; phone: string; onContextMenu?: (e: React.MouseEvent) => void }) {
  const [data, setData] = useState<any>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function doFetch() {
    api.getBrokerSummary(name, phone).then(setData).catch(() => {});
  }

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => { if (hideTimer.current) clearTimeout(hideTimer.current); if (!data) doFetch(); setVisible(true); }}
      onMouseLeave={() => { hideTimer.current = setTimeout(() => setVisible(false), 200); }}
      onContextMenu={onContextMenu}
    >
      <span className="font-semibold text-zinc-300 truncate max-w-[220px] block">{name}</span>
      {visible && data && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 min-w-[220px] rounded-lg border border-white/10 bg-zinc-800 p-3 shadow-xl pointer-events-none">
          <div className="text-[11px] text-white font-semibold mb-1.5">{name}</div>
          <div className="space-y-1 text-[10px] text-zinc-400">
            <div className="flex justify-between"><span>Market Posts</span><span className="text-white">{data.total_listings}</span></div>
            {data.price_range_rent && <div className="flex justify-between"><span>Rent range</span><span className="text-white">{data.price_range_rent}</span></div>}
            {data.price_range_sale && <div className="flex justify-between"><span>Sale range</span><span className="text-white">{data.price_range_sale}</span></div>}
            {data.markets?.length > 0 && <div className="flex justify-between"><span>Markets</span><span className="text-white text-right max-w-[120px] truncate">{data.markets.join(", ")}</span></div>}
            {data.team_members?.length > 0 && (
              <div className="border-t border-white/10 pt-1.5 mt-1.5">
                <div className="text-[9px] text-zinc-500 uppercase tracking-wider mb-1">Team</div>
                {data.team_members.map((tm: any, i: number) => (
                  <div key={i} className="flex justify-between text-[10px]">
                    <span>{tm.name}</span>
                    <span className="text-white">{tm.phone}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InboxPageInner() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"list" | "conversation" | "analysis">("list");
  // Left Panel States
  const [messages, setMessages] = useState<api.InboxThread[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loadingLeft, setLoadingLeft] = useState(false);
  const [offset, setOffset] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [slugs, setSlugs] = useState<api.SavedView[]>([]);
  const [currentSlug, setCurrentSlug] = useState<string>("brokers");
  const activeSlug = useMemo(() => slugs.find(s => s.slug === currentSlug) || null, [slugs, currentSlug]);
  const [brokerFeed, setBrokerFeed] = useState<any[]>([]);
  const [loadingBrokerFeed, setLoadingBrokerFeed] = useState(false);
  const [selectedBrokerObservations, setSelectedBrokerObservations] = useState<any[]>([]);
  const [loadingBrokerObs, setLoadingBrokerObs] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Selection States
  const [selectedMsg, setSelectedMsg] = useState<api.RawMessage | api.InboxThread | null>(null);
  const [teachingMsgId, setTeachingMsgId] = useState<number | null>(null);
  
  // Center Panel States
  const [conversationMessages, setConversationMessages] = useState<api.RawMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Right Panel States
  const [activeRightTab, setActiveRightTab] = useState<"analysis" | "broker" | "market" | "ai" | "notes">("analysis");
  const [selectedMsgDetails, setSelectedMsgDetails] = useState<any>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightPoppedOut, setRightPoppedOut] = useState(false);
  const [selectedBroker, setSelectedBroker] = useState<any>(null);
  const [loadingBroker, setLoadingBroker] = useState(false);
  const [selectedBuilding, setSelectedBuilding] = useState<any>(null);
  const [loadingBuilding, setLoadingBuilding] = useState(false);
  const [priceStats, setPriceStats] = useState<any>(null);
  const [loadingPriceStats, setLoadingPriceStats] = useState(false);
  const [allSuggestions, setAllSuggestions] = useState<any[]>([]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const groupedBrokerObservations = useMemo(() => {
    const groups = new Map<string, any>();
    for (const obs of selectedBrokerObservations) {
      const key = String(obs.latest_raw_message_id || obs.raw_message_id || obs.id);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          key,
          rawMessageId: obs.latest_raw_message_id || obs.raw_message_id || obs.id,
          representative: obs,
          observations: [obs],
          firstSeen: obs.first_seen,
          lastSeen: obs.last_seen,
        });
        continue;
      }
      existing.observations.push(obs);
      if (obs.last_seen && (!existing.lastSeen || new Date(obs.last_seen).getTime() > new Date(existing.lastSeen).getTime())) {
        existing.lastSeen = obs.last_seen;
        existing.representative = obs;
        existing.rawMessageId = obs.latest_raw_message_id || obs.raw_message_id || obs.id;
      }
      if (obs.first_seen && (!existing.firstSeen || obs.first_seen < existing.firstSeen)) {
        existing.firstSeen = obs.first_seen;
      }
    }
    return [...groups.values()].sort(
      (a, b) => new Date(b.lastSeen || b.representative.last_seen || 0).getTime() - new Date(a.lastSeen || a.representative.last_seen || 0).getTime()
    );
  }, [selectedBrokerObservations]);
  
  // Interaction/UI States
  const [revealedPhone, setRevealedPhone] = useState<Record<string, boolean>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionUndo, setActionUndo] = useState<{phone: string; name: string} | null>(null);
  const [openMenuBroker, setOpenMenuBroker] = useState<string | null>(null);
  const [expandedRawMessages, setExpandedRawMessages] = useState<Set<string>>(new Set());

  const handleHideBroker = async (phone: string) => {
    try {
      const res = await api.hideBroker(phone);
      setActionMessage(`Hidden: ${res.broker_name}`);
      setActionUndo({ phone, name: res.broker_name });
      setBrokerFeed((prev) => prev.filter((b: any) => b.primary_phone !== phone));
      if (selectedBroker?.id === phone) {
        setSelectedBroker(null);
        setSelectedBrokerObservations([]);
        setSelectedMsgDetails(null);
      }
      setTimeout(() => { setActionMessage(null); setActionUndo(null); }, 5000);
    } catch {
      setActionMessage("Failed to hide broker");
      setTimeout(() => setActionMessage(null), 3000);
    }
    setOpenMenuBroker(null);
  };

  const handleUnhideBroker = async (phone: string) => {
    try {
      const res = await api.unhideBroker(phone);
      setActionMessage(`Unhidden: ${res.broker_name}`);
      setActionUndo(null);
      setTimeout(() => setActionMessage(null), 3000);
    } catch {
      setActionMessage("Failed to unhide broker");
      setTimeout(() => setActionMessage(null), 3000);
    }
  };

  // Context Action States
  const [showAddToBucket, setShowAddToBucket] = useState(false);
  const [selectedActionText, setSelectedActionText] = useState("");
  const [actionContext, setActionContext] = useState<any>(null);

  // Combined Locality Dialog State
  const [showCombinedLocalityDialog, setShowCombinedLocalityDialog] = useState(false);
  const [combinedLocalitySurfaceText, setCombinedLocalitySurfaceText] = useState("");

  const messageAreaRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // URL state for selected message
  const searchParams = useSearchParams();
  const msgParam = searchParams.get("message");
  const brokerParam = searchParams.get("broker");
  const observationParam = searchParams.get("observation");

  // Sync selected message to URL
  const updateUrlMessage = useCallback((conversationKey: string, msgId: number) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("broker");
    url.searchParams.delete("observation");
    url.searchParams.set("conversation", conversationKey);
    url.searchParams.set("message", String(msgId));
    window.history.replaceState({}, "", url.toString());
  }, []);

  const updateUrlBroker = useCallback((phone: string) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("message");
    url.searchParams.delete("conversation");
    url.searchParams.delete("observation");
    url.searchParams.set("broker", phone);
    window.history.replaceState({}, "", url.toString());
  }, []);

  const updateUrlObservation = useCallback((id: number) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("message");
    url.searchParams.delete("conversation");
    url.searchParams.delete("broker");
    url.searchParams.set("observation", String(id));
    window.history.replaceState({}, "", url.toString());
  }, []);

  const updateUrlView = useCallback((slug: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", slug);
    url.searchParams.delete("message");
    url.searchParams.delete("conversation");
    url.searchParams.delete("broker");
    url.searchParams.delete("observation");
    setSelectedBroker(null);
    setSelectedBrokerObservations([]);
    setSelectedMsg(null);
    setSelectedMsgDetails(null);
    setConversationMessages([]);
    window.history.replaceState({}, "", url.toString());
  }, []);

  // When conversation loads and URL has a message param, select it
  const prevMsgParam = useRef(msgParam);
  useEffect(() => {
    if (msgParam && msgParam !== prevMsgParam.current && conversationMessages.length > 0) {
      prevMsgParam.current = msgParam;
      const targetId = parseInt(msgParam, 10);
      if (!isNaN(targetId)) {
        const target = conversationMessages.find(m => m.id === targetId);
        if (target) {
          selectMessage(target);
        }
      }
    }
  }, [msgParam, conversationMessages]);

  // Auto-navigate to broker or observation from URL params
  const initialNavDone = useRef(false);
  useEffect(() => {
    if (initialNavDone.current) return;
    if (brokerParam && brokerFeed.length > 0) {
      initialNavDone.current = true;
      const broker = brokerFeed.find((b: any) =>
        b.primary_phone?.includes(brokerParam) || brokerParam.includes(b.primary_phone || "")
      );
      if (broker) {
        setCurrentSlug("brokers");
        if (slugs.length > 0 && !slugs.some(s => s.slug === "brokers")) {
          // brokers slug might not exist yet; ensure it's set
        }
        selectBroker(broker);
      }
    } else if (observationParam && Number(observationParam) > 0) {
      initialNavDone.current = true;
      const obsId = Number(observationParam);
      if (!isNaN(obsId)) {
        (async () => {
          // Load the raw message details to discover broker
          const details = await api.getObservation(obsId);
          // Resolve broker from parsed data and load their observations timeline
          const brokerPhone = details.parsed?.broker_phone;
          const brokerName = details.parsed?.broker_name || details.parsed?.profile_name || details.raw?.sender;
          if (brokerPhone || brokerName) {
            const brokerInFeed = brokerFeed.find((b: any) =>
              (brokerPhone && b.primary_phone?.includes(brokerPhone)) ||
              (brokerPhone && brokerPhone.includes(b.primary_phone || "")) ||
              (brokerName && b.canonical_name?.toLowerCase().includes(brokerName.toLowerCase()))
            );
            if (brokerInFeed) {
              setCurrentSlug("brokers");
              await selectBroker(brokerInFeed, obsId);
              return;
            }
          }
          // Fallback: just show the details without broker timeline
          setSelectedMsgDetails(details);
          if (details.raw?.id) {
            setSelectedMsg(details.raw);
          }
        })();
      }
    }
  }, [brokerParam, observationParam, brokerFeed, slugs]);

  // 1. Initial Load of Feed & Suggestions
  const loadFeed = useCallback(async (append = false) => {
    setLoadingLeft(true);
    try {
      const threadMsgs = await api.getInboxThreads(PAGE_SIZE, offset);
      setMessages((prev) => (append ? [...prev, ...threadMsgs] : threadMsgs));
      if (!append) {
        const [groupResult, suggestionResult] = await Promise.allSettled([
          api.getGroups(),
          api.getSuggestions("pending", 100),
        ]);
        if (groupResult.status === "fulfilled") {
          setGroups(groupResult.value);
        } else {
          console.error("Failed to load inbox groups:", groupResult.reason);
        }
        if (suggestionResult.status === "fulfilled") {
          setAllSuggestions(suggestionResult.value);
        } else {
          console.error("Failed to load inbox suggestions:", suggestionResult.reason);
        }
      }
    } catch (e) {
      console.error("Failed to load feed:", e);
    } finally {
      setLoadingLeft(false);
    }
  }, [offset]);

  const hasMore = messages.length >= PAGE_SIZE;

  const loadMore = useCallback(() => {
    if (!hasMore || loadingLeft) return;
    setOffset((prev) => prev + PAGE_SIZE);
  }, [hasMore, loadingLeft]);

  const { sentinelRef } = useInfiniteScroll(loadMore, {
    enabled: isMobile && hasMore && !loadingLeft,
    threshold: 300,
  });

  // Load feed on mount; append when offset changes via loadMore
  const initialLoadDone = useRef(false);
  const prevOffsetRef = useRef(0);
  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      prevOffsetRef.current = offset;
      loadFeed(false);
    } else if (offset !== prevOffsetRef.current) {
      prevOffsetRef.current = offset;
      loadFeed(offset > 0);
    }
  }, [offset, loadFeed]);

  // Fetch available slugs (saved views) for the inbox tabs
  useEffect(() => {
    (async () => {
      try {
        const data = (await api.getInboxSlugs()).filter((s) => s.view_type === "brokers" || s.slug === "brokers");
        setSlugs(data);
        const viewFromUrl = searchParams.get("view");
        if (viewFromUrl === "brokers" && data.some(s => s.slug === viewFromUrl)) {
          setCurrentSlug(viewFromUrl);
        } else if (data.length > 0 && !data.some(s => s.slug === currentSlug)) {
          const def = data.find(s => s.is_default) || data[0];
          setCurrentSlug(def.slug);
        } else {
          setCurrentSlug("brokers");
        }
      } catch (e) {
        console.error("Failed to load inbox slugs:", e);
      }
    })();
  }, []);

  const loadBrokerFeed = useCallback(async () => {
    setLoadingBrokerFeed(true);
    try {
      const data = await api.getBrokersFeed(100, 0);
      setBrokerFeed(data);
    } catch (e) {
      console.error("Failed to load broker feed:", e);
    } finally {
      setLoadingBrokerFeed(false);
    }
  }, []);

  // Load broker feed when switching to a slug whose view_type needs brokers feed
  useEffect(() => {
    const vt = activeSlug?.view_type;
    if (vt === "brokers" && brokerFeed.length === 0) {
      loadBrokerFeed();
    }
  }, [activeSlug, loadBrokerFeed, brokerFeed.length]);

  // Scroll to bottom of conversation thread when new messages arrive
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversationMessages]);

  useEffect(() => {
    if (!rightPoppedOut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        setRightPoppedOut(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rightPoppedOut]);

  // Helper formatting functions
  const maskPhoneString = (phone: string) => {
    const digits = phone?.replace(/\D/g, "") || "";
    if (digits.length < 4) return phone || "—";
    return `••••••${digits.slice(-4)}`;
  };

  const displayPhoneString = (phone: string) => {
    const digits = phone?.replace(/\D/g, "") || "";
    const local = digits.slice(-10);
    if (local.length !== 10) return phone || "—";
    return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
  };

  const isRawWhatsAppId = (value?: string) => {
    const text = value || "";
    return /@(?:g\.us|s\.whatsapp\.net|lid)$/.test(text) || /^\d{12,}[-\d]*@/.test(text);
  };

  const resolveKnownGroupName = (value?: string) => {
    const text = (value || "").trim();
    if (!text || text === "seed" || text === "seed-bot") return "";
    const knownGroup = groups.find((g) => g?.jid === text);
    return (knownGroup?.name || "").trim();
  };

  const displayGroupName = (value?: string) => {
    const text = (value || "").trim();
    if (!text || text === "seed" || text === "seed-bot") return "";
    const knownGroupName = resolveKnownGroupName(text);
    if (knownGroupName) return knownGroupName;
    if (isRawWhatsAppId(text)) {
      const raw = text.split("@")[0];
      const suffix = raw.includes("-") ? raw.split("-").pop()?.slice(-4) : raw.slice(-4);
      return suffix ? `WhatsApp Group ${suffix}` : "WhatsApp Group";
    }
    return text;
  };

  const displayChatTitle = (msg: api.InboxThread | api.RawMessage) => {
    const conversationName = msg.chat_name || ("conversation_name" in msg ? msg.conversation_name : "");
    const rawConversation = conversationName || msg.group_name;
    const brokerName = (msg.broker_name || "").trim();
    if (brokerName) return brokerName;
    const knownGroupName = resolveKnownGroupName(rawConversation);
    if (knownGroupName && msg.conversation_type !== "direct" && msg.chat_type !== "direct") return knownGroupName;
    const sender = (msg.sender || "").trim();
    const phone = resolveMessagePhone(msg);
    if (isRawWhatsAppId(sender)) return displayPhoneString(phone) || "Direct Message";
    if (sender && sender.toLowerCase() !== "unknown") return sender;
    const group = displayGroupName(rawConversation);
    return group || displayPhoneString(phone) || "Direct Message";
  };

  const getWaLink = (phone: string) => {
    const digits = phone?.replace(/\D/g, "");
    return digits ? `https://wa.me/${digits.startsWith("91") ? digits : "91" + digits}` : "#";
  };

  const getWaLinkWithRecall = (phone: string, extractedText: string) => {
    const digits = phone?.replace(/\D/g, "");
    if (!digits) return "#";
    const normalized = digits.startsWith("91") ? digits : `91${digits}`;
    const cleanedExtract = extractedText.trim();
    const clippedExtract =
      cleanedExtract.length > 320 ? `${cleanedExtract.slice(0, 320)}...` : cleanedExtract;
    const recallMessage = `Recall:\n${clippedExtract}\n\nFound on PropAI Live`;
    const safe = recallMessage.replace(/[\uD800-\uDFFF]/g, "");
    try {
      return `https://wa.me/${normalized}?text=${encodeURIComponent(recallMessage)}`;
    } catch {
      return `https://wa.me/${normalized}?text=${encodeURIComponent(safe)}`;
    }
  };

  const isRealPhoneDigits = (value?: string) => {
    const digits = (value || "").replace(/\D/g, "");
    if (digits.length === 10) return true;
    if (digits.length === 12 && digits.startsWith("91")) return true;
    if (digits.length === 11 && digits.startsWith("0")) return true;
    return false;
  };

  const normalizeRealPhone = (value?: string) => {
    const digits = (value || "").replace(/\D/g, "");
    if (!isRealPhoneDigits(digits)) return "";
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(-10);
    if (digits.length === 11 && digits.startsWith("0")) return digits.slice(-10);
    return digits;
  };

  const phoneFromJid = (jid?: string) => {
    if (!jid) return "";
    if (jid.includes("@lid")) return "";
    const head = jid.split("@")[0] || "";
    return normalizeRealPhone(head);
  };

  const resolveMessagePhone = (msg?: Partial<api.RawMessage> | null) => {
    if (!msg) return "";
    const brokerPhone = normalizeRealPhone(msg.broker_phone);
    if (brokerPhone) return brokerPhone;
    const direct = normalizeRealPhone(msg.sender_phone);
    if (direct) return direct;
    return (
      phoneFromJid(msg.sender_jid) ||
      phoneFromJid(msg.group_name) ||
      phoneFromJid((msg as Partial<api.InboxThread>)?.chat_id) ||
      phoneFromJid((msg as Partial<api.InboxThread>)?.conversation_key)
    );
  };

  const resolveMessageSenderName = (msg?: Partial<api.RawMessage> | null) => {
    if (!msg) return "";
    if (msg.from_me === 1 || msg.from_me === true || msg.sender === "seed-bot" || msg.sender === "system" || msg.sender === "owner") return "You";
    const phone = resolveMessagePhone(msg);
    const sender = (msg.sender || "").trim();
    if (sender && sender.toLowerCase() !== "unknown" && !isRawWhatsAppId(sender)) {
      return msg.broker_name || sender;
    }
    return msg.broker_name || (phone ? displayPhoneString(phone) : "");
  };

  const buildMessageEntities = (
    msg?: Partial<api.RawMessage> | null,
    details?: EntityDetailShape
  ): MessageEntity[] => {
    const entities: MessageEntity[] = [];
    const rawMessageId = msg?.id || details?.raw?.id;
    const parsed = details?.parsed || {};
    const resolver = details?.resolver || {};
    const listings = Array.isArray(details?.listings) ? details.listings : [];
    const text = msg?.message || details?.raw?.message || "";
    const brokerName = parsed.broker_name || msg?.broker_name || "";
    const brokerPhone = normalizeRealPhone(parsed.broker_phone || msg?.broker_phone || resolveMessagePhone(msg));

    addEntity(entities, {
      type: "broker",
      text: brokerName,
      phone: brokerPhone,
      exists: Boolean(brokerName || brokerPhone),
      rawMessageId,
    });
    if (brokerPhone) {
      addEntity(entities, {
        type: "phone",
        text: brokerPhone,
        phone: brokerPhone,
        exists: true,
        rawMessageId,
      });
    }

    const buildingName = resolver.building_name || parsed.building_name || msg?.building_name || "";
    addEntity(entities, {
      type: "building",
      text: buildingName,
      exists: Boolean(resolver.building_name || selectedBuilding?.name === buildingName),
      rawMessageId,
    });
    addEntity(entities, {
      type: "locality",
      text: parsed.micro_market || msg?.micro_market || "",
      exists: true,
      rawMessageId,
    });
    addEntity(entities, {
      type: "landmark",
      text: parsed.landmark_name || msg?.landmark_name || "",
      exists: Boolean(parsed.landmark_name || msg?.landmark_name),
      rawMessageId,
    });

    for (const listing of listings) {
      const label = [listing.bhk, listing.building_name || buildingName, listing.micro_market || parsed.micro_market]
        .filter(Boolean)
        .join(" ");
      addEntity(entities, {
        type: "listing",
        id: listing.id,
        text: label,
        exists: Boolean(listing.id),
        rawMessageId,
      });
    }

    for (const line of text.split("\n")) {
      const cleaned = line.replace(/^[^\w]+/, "").trim();
      if (cleaned.length < 4 || cleaned.length > 80) continue;
      if (brokerName && cleaned.toLowerCase() === brokerName.toLowerCase()) continue;
      if (FIRM_LINE_RE.test(cleaned)) {
        addEntity(entities, {
          type: "firm",
          text: cleaned,
          exists: false,
          rawMessageId,
        });
      }
    }

    return entities;
  };

  const handleEntityClick = (entity: MessageEntity) => {
    setActionContext({
      entity,
      entity_type: entity.type,
      entity_name: entity.text,
      entity_phone: entity.phone,
      message_id: entity.rawMessageId || selectedMsg?.id,
      selected_message_id: selectedMsg?.id,
    });

    if (entity.rawMessageId && entity.rawMessageId !== selectedMsg?.id) {
      const msg = conversationMessages.find((item) => item.id === entity.rawMessageId);
      if (msg) selectMessage(msg);
    }

    router.push(entityProfileHref(entity));
    return true;
  };

  const toggleRevealPhone = (phone: string) => {
    setRevealedPhone(prev => ({ ...prev, [phone]: !prev[phone] }));
  };

  // Context Action Handlers
  const handleTextAction = (text: string, action: string, notes = "") => {
    setSelectedActionText(text);
    // Build context from current message
    const ctx = selectedMsg ? {
      id: selectedMsg.id,
      building_name: selectedMsgDetails?.parsed?.building_name,
      micro_market: selectedMsgDetails?.parsed?.micro_market,
      bhk: selectedMsgDetails?.parsed?.bhk,
      price: selectedMsgDetails?.parsed?.price,
      area_sqft: selectedMsgDetails?.parsed?.area_sqft,
      furnishing: selectedMsgDetails?.parsed?.furnishing,
      intent: selectedMsgDetails?.parsed?.intent || selectedMsg.message_type,
      broker_name: selectedMsgDetails?.parsed?.broker_name || selectedMsg.broker_name || selectedMsg.sender,
      broker_phone: resolveMessagePhone(selectedMsg),
    } : {};
    setActionContext(ctx);

    switch (action) {
      case "training-building":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "building", notes).then(() =>
          alert(`"${text}" saved as Building`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "training-society":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "society", notes).then(() =>
          alert(`"${text}" saved as Society`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "training-landmark":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "landmark", notes).then(() =>
          alert(`"${text}" saved as Landmark`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "training-locality":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "locality", notes).then(() =>
          alert(`"${text}" saved as Locality`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "training-combined-locality":
        setCombinedLocalitySurfaceText(text);
        setShowCombinedLocalityDialog(true);
        break;
      case "training-ignore":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "ignored", notes).then(() =>
          alert(`"${text}" will be ignored in future`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "resolve-building":
        api.resolveBuilding(text).then(r => alert(r.resolved ? `Building: ${r.building_name}` : "No building found")).catch(e => alert("Error: " + e.message));
        break;
      case "summarize":
        api.summarizeText(text).then(r => alert(r.summary)).catch(e => alert("Error: " + e.message));
        break;
      case "ask-propai":
        api.askPropAI(text, selectedMsg?.id, ctx).then(r => alert(r.response)).catch(e => alert("Error: " + e.message));
        break;
    }
  };

  const handleCombinedLocalitySave = async (expandsTo: string[]) => {
    const surface = combinedLocalitySurfaceText;
    if (!surface) return;
    
    try {
      // First add to trainer if not already there
      const existing = await fetch(`/api/trainer/terms?status=combined_locality`).then(r => r.json());
      const alreadyExists = existing.some((t: any) => t.term.toLowerCase() === surface.toLowerCase());
      
      let termId: number;
      if (alreadyExists) {
        const term = existing.find((t: any) => t.term.toLowerCase() === surface.toLowerCase());
        termId = term.id;
      } else {
        // Add to trainer
        const context = selectedMsgDetails?.raw?.message?.slice(0, 120) || "";
        const addRes = await fetch("/api/trainer/inline-resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: surface,
            raw_message_id: selectedMsg?.id,
            status: "combined_locality",
            expands_to: expandsTo,
          }),
        });
        const addData = await addRes.json();
        if (!addData.status || addData.status === "error") {
          alert("Failed to save combined locality");
          return;
        }
        // Get the term ID
        const termRes = await fetch(`/api/trainer/terms?status=combined_locality`);
        const terms = await termRes.json();
        const term = terms.find((t: any) => t.term.toLowerCase() === surface.toLowerCase());
        termId = term?.id;
      }
      
      if (termId) {
        // Resolve with expands_to
        await fetch(`/api/trainer/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            term_id: termId,
            status: "combined_locality",
            expands_to: expandsTo,
          }),
        });
      }
      
      alert(`"${surface}" mapped to: ${expandsTo.join(", ")}`);
      setShowCombinedLocalityDialog(false);
      setCombinedLocalitySurfaceText("");
    } catch (err) {
      console.error("Error saving combined locality:", err);
      alert("Error saving combined locality");
    }
  };

  const contextActions = [
    { id: "ask-propai", label: "Ask PropAI", icon: "✨", handler: (t: string) => handleTextAction(t, "ask-propai") },
    { id: "summarize", label: "Summarize", icon: "📝", handler: (t: string) => handleTextAction(t, "summarize") },
    { id: "sep1", label: "", icon: "", handler: () => {} },
    { id: "training-building", label: "This is a Building", icon: "🏢", handler: (t: string) => handleTextAction(t, "training-building") },
    { id: "training-society", label: "This is a Society", icon: "🏘️", handler: (t: string) => handleTextAction(t, "training-society") },
    { id: "training-landmark", label: "This is a Landmark", icon: "📍", handler: (t: string) => handleTextAction(t, "training-landmark") },
    { id: "training-locality", label: "This is a Locality", icon: "🗺️", handler: (t: string) => handleTextAction(t, "training-locality") },
    { id: "training-combined-locality", label: "Combined Localities", icon: "🔀", handler: (t: string) => handleTextAction(t, "training-combined-locality") },
    { id: "training-ignore", label: "Ignore as Noise", icon: "🚫", handler: (t: string) => handleTextAction(t, "training-ignore") },
    { id: "sep2", label: "", icon: "", handler: () => {} },
    { id: "resolve-building", label: "Fix Building Detection", icon: "🔍", handler: (t: string) => handleTextAction(t, "resolve-building") },
  ];

  // 2. Compute Left Panel Grouped Lists
  const query = searchText.trim().toLowerCase();

  const filteredMessages = messages.filter((m) => {
    const haystack = [
      m.message,
      m.sender,
      m.sender_phone || "",
      m.sender_jid || "",
      m.group_name || "",
      m.conversation_name || "",
      displayGroupName(m.conversation_name || m.group_name),
    ]
      .join(" ")
      .toLowerCase();
    return !query || haystack.includes(query);
  });

  const uniqueThreads = Array.from(
    new Map(
      filteredMessages.map((m) => [
        m.chat_id || m.conversation_key || m.group_name || `${m.sender || "unknown"}:${m.timestamp}`,
        m,
      ])
    ).values()
  );

  const groupChats = uniqueThreads
    .filter((m) => m.conversation_type === "group")
    .map((m) => ({
      conversationKey: m.chat_id || m.conversation_key || m.group_name,
      rawGroupName: m.group_name,
      groupLabel: displayGroupName(m.chat_name || m.conversation_name || m.group_name),
      title: displayChatTitle(m),
      latest: m,
      count: m.message_count || 0,
    }))
    .sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());

  const directChats = uniqueThreads
    .filter((m) => m.conversation_type === "direct")
    .map((m) => ({
      senderKey: m.chat_id || m.conversation_key,
      name: displayChatTitle(m),
      latest: m,
      count: m.message_count || 0,
    }))
    .sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());

  // Apply search filter to broker feed and direct chats
  const filteredBrokerFeed = !query
    ? brokerFeed.filter((b: any) => Number(b.group_evidence_count || 0) > 0)
    : brokerFeed.filter((b: any) => {
        if (Number(b.group_evidence_count || 0) <= 0) return false;
        const haystack = [
          b.canonical_name,
          b.name,
          b.primary_phone,
          b.latest_title,
          b.latest_intent,
          b.latest_micro_market,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });

  const filteredDirectChats = !query
    ? directChats
    : directChats.filter((d: any) => {
        const haystack = [d.name, d.senderKey, d.latest?.message, d.latest?.sender]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });

  const threadFallbackItems = [
    ...(activeSlug?.view_type === "brokers" ? [] : groupChats.map((chat) => ({
      key: chat.conversationKey,
      title: chat.title,
      subtitle: chat.groupLabel && chat.groupLabel !== chat.title ? chat.groupLabel : "WhatsApp group",
      latest: chat.latest,
      count: chat.count,
      type: "group" as const,
    }))),
    ...filteredDirectChats.map((chat) => ({
      key: chat.senderKey,
      title: chat.name,
      subtitle:
        displayGroupName(chat.latest?.group_name)
        || (resolveMessagePhone(chat.latest) ? displayPhoneString(resolveMessagePhone(chat.latest)) : "Broker evidence"),
      latest: chat.latest,
      count: chat.count,
      type: "direct" as const,
    })),
  ].sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());

  const showThreadFallback = activeSlug?.view_type !== "brokers" || (!loadingBrokerFeed && filteredBrokerFeed.length === 0);

  const leftListEmpty = (() => {
    const vt = activeSlug?.view_type;
    if (vt === "brokers") return filteredBrokerFeed.length === 0 && threadFallbackItems.length === 0;
    return threadFallbackItems.length === 0;
  })();

  const groupedConversationMessages: [string, api.RawMessage[][]][] = (() => {
    const grouped: Record<string, api.RawMessage[]> = {};
    conversationMessages.forEach((message) => {
      const rawDate = message.timestamp || "";
      const date = rawDate ? new Date(rawDate.endsWith("Z") ? rawDate : `${rawDate}Z`) : new Date();
      const label = Number.isNaN(date.getTime())
        ? "Unknown date"
        : date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      if (!grouped[label]) grouped[label] = [];
      grouped[label].push(message);
    });
    // Within each day, group consecutive messages from same sender into blocks
    const result: [string, api.RawMessage[][]][] = [];
    for (const [dateLabel, dayMessages] of Object.entries(grouped)) {
      const blocks: api.RawMessage[][] = [];
      let currentBlock: api.RawMessage[] = [];
      for (const msg of dayMessages) {
        const lastMsg = currentBlock[currentBlock.length - 1];
        const sameSender = lastMsg && msg.sender === lastMsg.sender;
        const closeEnough = lastMsg && msg.timestamp && lastMsg.timestamp && (
          Math.abs(new Date(msg.timestamp).getTime() - new Date(lastMsg.timestamp).getTime()) < 300000
        );
        if (lastMsg && sameSender && closeEnough) {
          currentBlock.push(msg);
        } else {
          if (currentBlock.length > 0) blocks.push(currentBlock);
          currentBlock = [msg];
        }
      }
      if (currentBlock.length > 0) blocks.push(currentBlock);
      result.push([dateLabel, blocks]);
    }
    return result;
  })();

  const flatBlocks = conversationMessages.length > 0
    ? groupedConversationMessages.flatMap(([, blocks]) => blocks)
    : [];

  const selectedTitle = selectedMsg ? displayChatTitle(selectedMsg) : "";
  const isGroupConversationSelected =
    selectedMsg?.chat_type === "group" ||
    selectedMsg?.conversation_type === "group" ||
    (!!selectedMsg?.group_name && selectedMsg.group_name !== "seed" && selectedMsg.group_name !== "seed-bot");
  const selectedSubtitle =
    isGroupConversationSelected
      ? ""
      : resolveMessagePhone(selectedMsg)
      ? displayPhoneString(resolveMessagePhone(selectedMsg))
      : selectedMsg?.sender || "";
  const selectedCount =
    selectedMsg && "message_count" in selectedMsg ? selectedMsg.message_count : conversationMessages.length;

  // 3. Load Conversation Thread (Center Panel)
  const selectConversation = async (msg: api.RawMessage | api.InboxThread) => {
    if (isMobile) setMobileView("conversation");
    setSelectedMsg(msg);
    setConversationMessages(msg.id ? [msg as api.RawMessage] : []);
    setLoadingConv(true);
    try {
      let thread: api.RawMessage[] = [];
      const chatId = (msg.chat_id || ("conversation_key" in msg ? msg.conversation_key : "") || "").trim();
      const groupName =
        (msg.chat_type === "group" || ("conversation_type" in msg && msg.conversation_type === "group"))
          ? (chatId || msg.group_name || "").trim()
          : "";
      if (chatId) {
        thread = await api.getChatMessages(chatId, 500, 0);
      } else if (groupName && groupName !== "seed" && groupName !== "seed-bot") {
        thread = await api.getRaw(200, 0, groupName);
      } else {
        const resolvedPhone = resolveMessagePhone(msg);
        const phone = isRealPhoneDigits(resolvedPhone) ? resolvedPhone : undefined;
        const jid = msg.sender_jid || msg.group_name || ("conversation_key" in msg ? msg.conversation_key : "") || undefined;
        thread = await api.getRaw(200, 0, undefined, undefined, phone, jid);
      }
      // Threads come newest first, reverse to show chronological top-to-bottom
      const decoratedThread = thread.map((item) => ({
        ...item,
        chat_id: chatId || item.chat_id,
        chat_name: msg.chat_name || item.chat_name,
        chat_type: msg.chat_type || item.chat_type,
        conversation_type: msg.conversation_type || item.conversation_type,
        conversation_key: chatId || msg.conversation_key || item.conversation_key,
        conversation_name: msg.conversation_name || msg.chat_name || item.conversation_name,
      }));
      const chronologicalThread = (decoratedThread.length ? decoratedThread : msg.id ? [msg as api.RawMessage] : []).slice().reverse();
      setConversationMessages(chronologicalThread);

      // Inactive group rows use a synthetic row; analyze the latest real thread item instead.
      const detailTarget = msg.id ? msg : chronologicalThread[chronologicalThread.length - 1];
      if (detailTarget?.id) {
        setSelectedMsg({
          ...detailTarget,
          ...("conversation_key" in msg
            ? {
                conversation_type: msg.conversation_type,
                conversation_key: chatId || msg.conversation_key,
                conversation_name: msg.conversation_name || msg.chat_name,
                chat_id: chatId || msg.chat_id,
                chat_name: msg.chat_name,
                chat_type: msg.chat_type,
                message_count: msg.message_count,
              }
            : {}),
        } as api.RawMessage | api.InboxThread);
        loadMessageDetails(detailTarget.id);
      } else {
        setSelectedMsgDetails(null);
      }
    } catch (e) {
      console.error("Failed to load thread:", e);
    } finally {
      setLoadingConv(false);
    }
  };

  // 3b. Select a specific message within the current conversation
  const selectMessage = useCallback((msg: api.RawMessage) => {
    setSelectedMsg(msg as any);
    loadMessageDetails(msg.id);
    updateUrlMessage((msg as any).chat_id || (msg as any).conversation_key || msg.group_name || "", msg.id);
    const el = messageRefs.current[msg.id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [updateUrlMessage]);

  // 3c. Select a broker card -> show observations in center + profile in right panel
  const selectBroker = useCallback(async (broker: any, focusObsRawId?: number) => {
    if (isMobile) setMobileView(focusObsRawId ? "analysis" : "conversation");
    setActiveRightTab(!focusObsRawId ? "broker" : "analysis");
    if (broker.primary_phone) updateUrlBroker(broker.primary_phone);
    setSelectedBroker({
      id: broker.primary_phone,
      phone: broker.primary_phone,
      canonical_name: broker.canonical_name,
      building_count: broker.building_count || 0,
      active_days_30: broker.active_days_30 || 0,
      first_seen: broker.first_seen,
      last_seen: broker.last_active,
    });
    if (!focusObsRawId) setSelectedMsgDetails(null);
    // Load observations for center timeline
    setLoadingBrokerObs(true);
    try {
      const obs = await api.getObservationsFeed(50, 0, broker.primary_phone);
      setSelectedBrokerObservations(obs);
      const rawId = focusObsRawId || obs?.[0]?.latest_raw_message_id || obs?.[0]?.raw_message_id;
      if (rawId) {
        updateUrlObservation(rawId);
        loadMessageDetails(rawId, { setSelectedRaw: true, preserveProfiles: true });
      }
    } catch (e) {
      console.error("Failed to load broker observations:", e);
      setSelectedBrokerObservations([]);
    } finally {
      setLoadingBrokerObs(false);
    }
  }, [updateUrlBroker, updateUrlObservation]);

  // Keyboard navigation: arrow up/down through message blocks, enter to select
  useEffect(() => {
    if (flatBlocks.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const currentIdx = selectedMsg
        ? flatBlocks.findIndex(b => b.some(m => m.id === (selectedMsg as any).id))
        : -1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIdx = currentIdx < flatBlocks.length - 1 ? currentIdx + 1 : 0;
        selectMessage(flatBlocks[nextIdx][0]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : flatBlocks.length - 1;
        selectMessage(flatBlocks[prevIdx][0]);
      } else if (e.key === "Enter" && currentIdx >= 0) {
        e.preventDefault();
        selectMessage(flatBlocks[currentIdx][0]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [flatBlocks, selectedMsg, selectMessage]);

  // 4. Load Detailed Analysis, Broker, and Building (Right Panel)
  const loadMessageDetails = async (
    msgId: number,
    options: { setSelectedRaw?: boolean; preserveProfiles?: boolean } = {}
  ) => {
    setLoadingDetails(true);
    if (!options.preserveProfiles) {
      setSelectedBroker(null);
      setSelectedBuilding(null);
    }
    setPriceStats(null);
    try {
      const details = await api.getObservation(msgId);
      setSelectedMsgDetails(details);
      if (options.setSelectedRaw && details.raw?.id) {
        setSelectedMsg(details.raw);
      }
      
      // Resolve Broker if possible
      const brokerName = details.parsed?.broker_name || details.parsed?.profile_name || details.raw?.sender;
      const brokerPhone = details.parsed?.broker_phone;
      if (brokerName || brokerPhone) {
        loadBrokerDetails(brokerName, brokerPhone);
      }

      // Resolve Building if possible
      const buildingName = details.resolver?.building_name || details.parsed?.building_name;
      if (buildingName) {
        loadBuildingDetails(buildingName);
      }

      // Load Price Stats if price, bhk, and market are present
      const price = details.parsed?.price;
      const bhk = details.parsed?.bhk;
      const market = details.parsed?.micro_market;
      const intent = details.parsed?.intent?.toLowerCase() === "rent" ? "rental" : "listing";
      if (price && bhk && market) {
        loadPriceStats(market, bhk, intent);
      }

    } catch (e) {
      console.error("Failed to load message details:", e);
    } finally {
      setLoadingDetails(false);
    }
  };

  const selectBrokerObservation = (obs: any) => {
    const rawId = obs.latest_raw_message_id || obs.raw_message_id;
    if (!rawId) return;
    setActiveRightTab("analysis");
    updateUrlObservation(rawId);
    loadMessageDetails(rawId, { setSelectedRaw: true, preserveProfiles: true });
  };

  const loadBrokerDetails = async (name: string, phone: string) => {
    setLoadingBroker(true);
    try {
      const res = await api.findBroker(name, phone);
      if (res && res.broker_id) {
        const brokerData = await api.getBroker(res.broker_id);
        setSelectedBroker(brokerData);
      }
    } catch (e) {
      console.log("No canonical broker profile found or failed to load:", e);
    } finally {
      setLoadingBroker(false);
    }
  };

  const loadBuildingDetails = async (name: string) => {
    setLoadingBuilding(true);
    try {
      const buildingData = await api.getBuildingProfile(name);
      setSelectedBuilding(buildingData);
    } catch (e) {
      console.log("Failed to load building profile:", e);
    } finally {
      setLoadingBuilding(false);
    }
  };

  const loadPriceStats = async (market: string, bhk: string, intent: string) => {
    setLoadingPriceStats(true);
    try {
      const stats = await api.getPriceStats(market, bhk, intent);
      if (stats && !stats.error) {
        setPriceStats(stats);
      }
    } catch (e) {
      console.log("Failed to load price stats:", e);
    } finally {
      setLoadingPriceStats(false);
    }
  };

  // Act on merge/duplicate suggestions
  const handleApproveSuggestion = async (sugId: number) => {
    try {
      await api.actOnSuggestion(sugId, "approve");
      setActionMessage("Suggestion approved and successfully merged!");
      setTimeout(() => setActionMessage(null), 3000);
      
      // Reload feed, suggestions, and current details to reflect changes
      loadFeed();
      if (selectedMsg) {
        loadMessageDetails(selectedMsg.id);
      }
    } catch (e) {
      console.error("Failed to approve suggestion:", e);
      setActionMessage("Error approving suggestion.");
      setTimeout(() => setActionMessage(null), 3000);
    }
  };

  const handleRejectSuggestion = async (sugId: number) => {
    try {
      await api.actOnSuggestion(sugId, "reject", "User rejected from workspace");
      setActionMessage("Suggestion rejected and hidden.");
      setTimeout(() => setActionMessage(null), 3000);
      
      // Reload lists
      loadFeed();
      if (selectedMsg) {
        loadMessageDetails(selectedMsg.id);
      }
    } catch (e) {
      console.error("Failed to reject suggestion:", e);
    }
  };

  const suggestionHasSource = (suggestion: any, value: string) => {
    const source = suggestion?.source_data;
    if (source == null) return false;
    if (typeof source === "string") return source.includes(value);
    try {
      return JSON.stringify(source).includes(value);
    } catch {
      return false;
    }
  };

  const hasMarketContext = (details: any) => {
    const parsed = details?.parsed || {};
    const resolver = details?.resolver || {};
    const listings = Array.isArray(details?.listings) ? details.listings : [];
    const rawConfidence = parsed.confidence ?? resolver.final_confidence;
    const confidence = rawConfidence == null ? 1 : Number(rawConfidence);
    const hasPropertyAnchor = Boolean(
      parsed.bhk ||
      parsed.price ||
      parsed.area_sqft ||
      parsed.building_name ||
      resolver.building_name ||
      listings.length > 0
    );
    const hasLocationOnlyAnchor = Boolean(parsed.micro_market || parsed.landmark_name);
    const resolverDetail = String(resolver.method_detail || resolver.failure_category || "").toLowerCase();
    const hasKnownLocationAnchor = hasLocationOnlyAnchor && !resolverDetail.includes("unknown_landmark");
    const intent = String(parsed.intent || "").toUpperCase();
    return (
      (hasPropertyAnchor || (hasKnownLocationAnchor && confidence >= 0.65)) &&
      confidence >= 0.35 &&
      !["TEXT", "SOCIAL", "UNKNOWN", "NONE"].includes(intent)
    );
  };

  // Check signals/warnings
  const getAISignals = () => {
    const signals: { type: "info" | "warning" | "alert"; title: string; desc: string; actionSug?: any }[] = [];
    if (!selectedMsgDetails) return signals;

    const parsed = selectedMsgDetails.parsed || {};
    const resolver = selectedMsgDetails.resolver || {};
    if (!hasMarketContext(selectedMsgDetails)) return signals;

    // 1. Missing building — only warn when extraction itself failed to find any building
    if (!parsed.building_name && !resolver.building_name) {
      signals.push({
        type: "warning",
        title: "Missing Building Mapping",
        desc: `No property name detected in this message.`
      });
    }

    // 2. Price deviation comparison
    if (parsed.price && priceStats) {
      const listingPrice = parsed.price;
      const median = priceStats.median;
      const p25 = priceStats.p25;
      
      if (median && listingPrice < median * 0.75) {
        const percentBelow = Math.round(((median - listingPrice) / median) * 100);
        signals.push({
          type: "alert",
          title: "Price Unusually Low",
          desc: `${formatCurrency(listingPrice)} is ${percentBelow}% lower than the market median (${formatCurrency(median)}) for a ${parsed.bhk || ""} in ${parsed.micro_market || ""}. Could be a genuine deal or a detail that needs checking.`
        });
      }
    }

    // 3. Listing review suggestion
    if (selectedMsgDetails.listings && selectedMsgDetails.listings.length > 0) {
      const listingId = selectedMsgDetails.listings[0].id;
      const listingMergeSug = allSuggestions.find(
        s => s.agent === "duplicate_listing" && s.status === "pending" && suggestionHasSource(s, String(listingId))
      );
      if (listingMergeSug) {
        signals.push({
          type: "info",
          title: "Listing Needs Review",
          desc: `PropAI found a possible repeated property record: "${listingMergeSug.title}"`,
          actionSug: listingMergeSug
        });
      }
    }

    return signals;
  };

  const signals = getAISignals();

  const getTrainingPrompts = () => {
    if (!selectedMsgDetails?.raw?.message) return [];
    const parsed = selectedMsgDetails.parsed || {};
    const listings = Array.isArray(selectedMsgDetails.listings) ? selectedMsgDetails.listings : [];
    const knownValues = new Set(
      [
        parsed.building_name,
        parsed.micro_market,
        parsed.landmark_name,
        parsed.location_raw,
        ...listings.flatMap((listing: any) => [
          listing.building_name,
          listing.micro_market,
          listing.landmark_name,
          listing.location_raw,
        ]),
      ]
        .filter(Boolean)
        .map((value: string) => value.toLowerCase())
    );

    const lines = selectedMsgDetails.raw.message
      .split("\n")
      .map((line: string) => stripEmojis(line).replace(/[*_`~]/g, "").trim())
      .filter((line: string) => line.length >= 3 && line.length <= 90);

    const prompts: TrainingPrompt[] = [];
    const seen = new Set<string>();
    const addPrompt = (text: string, question: string, actions: { label: string; action: string }[]) => {
      const key = `${question}:${text}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      prompts.push({ text, question, actions });
    };

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (knownValues.has(lower)) continue;
      if (/^\d|rent|deposit|position|parking|family|bach|negotiable|available|monthly|security|inspection|enquiry|consultant|^\+?\d{8,}$/.test(lower)) {
        continue;
      }
      if (/\b(apartment|apartments|cosmic|parvati|tower|heights|residency|chsl|society)\b/i.test(line)) {
        addPrompt(line, "What is this place name?", [
          { label: "Building", action: "training-building" },
          { label: "Landmark", action: "training-landmark" },
          { label: "Ignore", action: "training-ignore" },
        ]);
      } else if (/\b(west|east|juhu|andheri|versova|lokhandwala|bkc|bandra|khar|malad|goregaon)\b/i.test(line)) {
        addPrompt(line, "What kind of location is this?", [
          { label: "Locality", action: "training-locality" },
          { label: "Combined Localities", action: "training-combined-locality" },
          { label: "Landmark", action: "training-landmark" },
          { label: "Ignore", action: "training-ignore" },
        ]);
      }
      if (prompts.length >= 4) break;
    }
    return prompts;
  };

  const trainingPrompts = getTrainingPrompts();

  const getListingPayloadText = (listing: any): string | null => {
    if (!listing) return null;
    const payload = listing.raw_payload;
    if (!payload) return null;
    try {
      const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
      return parsed?.full_text || parsed?.text || null;
    } catch {
      return null;
    }
  };

  const waSenderPhone =
    normalizeRealPhone(selectedMsgDetails?.parsed?.broker_phone) ||
    resolveMessagePhone(selectedMsgDetails?.raw) ||
    resolveMessagePhone(selectedMsg);
  const selectedHasMarketContext = hasMarketContext(selectedMsgDetails);

  return (
    <div className="flex flex-col h-full min-h-0 border border-white/10 rounded-2xl overflow-hidden bg-black">
      
      {/* Context Action Menu - floats over message area */}
      <TextSelectionMenu
        actions={contextActions}
        context={actionContext}
      />

      {/* Add to Client Bucket Modal */}
      <AddToClientBucket
        isOpen={showAddToBucket}
        onClose={() => setShowAddToBucket(false)}
        selectedText={selectedActionText}
        messageContext={actionContext}
        onSave={(clientId, notes) => {
          setActionMessage(`Added to client bucket!`);
          setTimeout(() => setActionMessage(null), 3000);
        }}
      />

      {actionMessage && (
        <div className="bg-[#1e293b] border-b border-[#3EE88A]/30 text-[#3EE88A] px-4 py-2 text-xs font-semibold text-center flex items-center justify-center gap-3 animate-fadeIn">
          <span>{actionMessage}</span>
          {actionUndo && (
            <button
              onClick={() => handleUnhideBroker(actionUndo.phone)}
              className="px-2 py-0.5 bg-zinc-800 border border-white/10 rounded text-[10px] text-white hover:text-white transition-colors"
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* Main Layout Grid */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* ================= LEFT PANEL: INBOX ================= */}
        <div className={`${isMobile && mobileView !== "list" ? "hidden" : ""}`}>
        <ResizablePanel
          defaultWidth={320}
          minWidth={240}
          maxWidth={500}
          storageKey="propai-inbox-left-width"
          mobile={isMobile}
          className="border-r border-white/10 bg-black/80"
        >
          <div className="flex flex-col h-full">
          {/* Panel Search & Header */}
          <div className="p-3 sm:p-4 border-b border-white/10 space-y-2 sm:space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold tracking-wider text-white uppercase">Market Inbox</div>
                <div className="hidden sm:block text-[10px] text-zinc-500 mt-0.5">WhatsApp conversations with PropAI memory</div>
              </div>
              <button
                onClick={() => { setOffset(0); prevOffsetRef.current = 0; loadFeed(false); }}
                className="text-[10px] sm:text-xs text-[#3EE88A] hover:underline"
                disabled={loadingLeft}
              >
                {loadingLeft ? "Refreshing..." : <><span className="sm:hidden">↻</span><span className="hidden sm:inline">Refresh</span></>}
              </button>
            </div>
            
            <input
              type="text"
              placeholder="Search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-zinc-900 border border-white/10 rounded-lg text-xs text-white focus:border-[#3EE88A] focus:outline-none transition-colors"
            />

            {/* Slug-based View Tabs */}
            <div className="flex gap-1 bg-zinc-900 p-0.5 rounded-lg border border-[rgba(255,255,255,0.03)]" style={{ gridTemplateColumns: `repeat(${Math.min(slugs.length, 5)}, 1fr)` }}>
              {slugs.length === 0 ? (
                <>
                  <div className="flex-1 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider text-center text-zinc-500 bg-zinc-800">Brokers</div>
                </>
              ) : (
                slugs.map((sv) => (
                  <button
                    key={sv.slug}
                    onClick={() => {
                      setCurrentSlug(sv.slug);
                      updateUrlView(sv.slug);
                    }}
                    className={`flex-1 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors touch-target ${
                      currentSlug === sv.slug
                        ? "bg-zinc-800 text-[#3EE88A] shadow-sm"
                        : "text-zinc-500 hover:text-white"
                    }`}
                  >
                    {sv.label}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* List Content */}
          <div className="flex-1 overflow-y-auto divide-y divide-[rgba(255,255,255,0.04)]">
            {loadingLeft && messages.length === 0 && groups.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">Loading inbox feed...</div>
            ) : leftListEmpty ? (
              <div className="p-8 text-center text-xs text-zinc-500">
                {activeSlug?.view_type === "brokers"
                  ? "No broker entities extracted from group messages yet."
                  : "No chats found"}
              </div>
            ) : (
              <>
                {activeSlug?.view_type === "brokers" && loadingBrokerFeed && (
                  <div className="p-8 text-center text-xs text-zinc-500">Loading broker feed...</div>
                )}
                {activeSlug?.view_type === "brokers" && !loadingBrokerFeed &&
                  filteredBrokerFeed.map((b: any) => {
                    const isSelected = selectedBroker?.id === b.primary_phone;
                    const menuOpen = openMenuBroker === b.primary_phone;
                    const isActiveNow = b.last_active && now - new Date(b.last_active).getTime() < 300000;
                    const latestIntent = b.latest_intent || (b.latest_title || "").match(/^(Sale|Rent|Lease|Buy|Requirement)/i)?.[1];
                    return (
                      <div key={b.primary_phone} className="relative">
                        <button
                          onClick={() => selectBroker(b)}
                          className={`w-full text-left p-2.5 lg:p-3 transition-colors select-none ${
                            isSelected ? "bg-blue-600/10 border-l-2 border-[#3b82f6]" : "hover:bg-white/5"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2 min-w-0">
                              {isActiveNow && <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />}
                              <span className="text-[12px] font-bold text-white truncate max-w-[160px]">
                                {stripEmojis(b.canonical_name || b.name) || "Unknown"}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-bold text-white tabular-nums">
                                {b.observation_count}
                              </span>
                              <div onClick={(e) => { e.stopPropagation(); setOpenMenuBroker(menuOpen ? null : b.primary_phone); }} className="w-5 h-5 flex items-center justify-center rounded hover:bg-[rgba(255,255,255,0.06)] text-zinc-500 hover:text-white transition-colors cursor-pointer">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                              </div>
                            </div>
                          </div>
                          {b.latest_title && (
                            <div className="text-[10px] text-zinc-400 leading-relaxed truncate mb-1.5">
                              <span className="text-zinc-500">Last: </span>
                              {(() => {
                                const title = stripEmojis(b.latest_title);
                                if (latestIntent) {
                                  const stripped = title.replace(new RegExp(`^${latestIntent}\\s*[|•-]?\\s*`, "i"), "");
                                  return <><span className="font-semibold text-zinc-300">{latestIntent}</span>{stripped ? ` ${stripped}` : ""}</>;
                                }
                                return <span>{title}</span>;
                              })()}
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-[9px] text-zinc-500">
                            {b.group_evidence_count > 0 && (
                              <span>{b.group_evidence_count}g</span>
                            )}
                            {b.dm_evidence_count > 0 && (
                              <span>{b.dm_evidence_count}dm</span>
                            )}
                            {b.last_active && (
                              <>
                                <span>·</span>
                                <span>{formatAgeShort(b.last_active)}</span>
                              </>
                            )}
                          </div>
                          </button>
                          {menuOpen && (
                            <div className="absolute right-2 top-3 z-50 bg-zinc-800 border border-white/10 rounded-lg shadow-xl py-1 min-w-[140px]">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleHideBroker(b.primary_phone); }}
                                className="w-full text-left px-3 py-1.5 text-[11px] text-white hover:bg-[rgba(255,255,255,0.06)] flex items-center gap-2"
                              >
                                <EyeOff className="w-3 h-3" strokeWidth={1.5} />
                                Hide Broker
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  }
                  {showThreadFallback && threadFallbackItems.map((item) => {
                    const isSelected = selectedMsg && (
                      selectedMsg.chat_id === item.key ||
                      ("conversation_key" in selectedMsg && selectedMsg.conversation_key === item.key) ||
                      selectedMsg.group_name === item.latest.group_name ||
                      selectedMsg.sender_jid === item.latest.sender_jid
                    );
                    return (
                      <button
                        key={`${item.type}-${item.key}`}
                        onClick={() => selectConversation(item.latest)}
                        className={`w-full text-left p-2.5 lg:p-3 transition-colors select-none ${
                          isSelected ? "bg-blue-600/10 border-l-2 border-[#3b82f6]" : "hover:bg-white/5"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <MessageSquare className="w-3.5 h-3.5 shrink-0 text-zinc-500" strokeWidth={1.5} />
                            <span className="text-[12px] font-bold text-white truncate max-w-[190px]">
                              {stripEmojis(item.title) || "WhatsApp conversation"}
                            </span>
                          </div>
                          <span className="text-[10px] font-bold text-white tabular-nums">{item.count}</span>
                        </div>
                        <div className="text-[10px] text-zinc-500 leading-relaxed truncate mb-1">
                          {stripEmojis(item.latest.sender || item.subtitle)}
                        </div>
                        <div className="text-[10px] text-zinc-400 leading-relaxed line-clamp-2">
                          {stripEmojis(item.latest.message) || "No text content"}
                        </div>
                        <div className="mt-1.5 text-[9px] text-zinc-600">
                          {formatAgeShort(item.latest.timestamp || item.latest.created_at || item.latest.latest_message_at)}
                        </div>
                      </button>
                    );
                  })}
                  </>
                )}
          </div>
          
          {/* Left panel footer / Pagination (desktop) / Infinite scroll sentinel (mobile) */}
          {isMobile ? (
            <>
              <div ref={sentinelRef} className="h-4" />
              {loadingLeft && (
                <div className="p-3 text-center text-[10px] text-zinc-500">Loading more...</div>
              )}
            </>
          ) : (
          <div className="p-3 border-t border-white/10 flex items-center justify-between bg-black/80">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-2 py-1 text-[10px] font-bold bg-zinc-800 text-zinc-400 border border-white/10 rounded disabled:opacity-30"
            >
              Prev
            </button>
            <span className="text-[10px] text-zinc-500">
              Page {Math.floor(offset / PAGE_SIZE) + 1}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={messages.length < PAGE_SIZE}
              className="px-2 py-1 text-[10px] font-bold bg-zinc-800 text-zinc-400 border border-white/10 rounded disabled:opacity-30"
            >
              Next
            </button>
          </div>
          )}
          </div>
        </ResizablePanel>
        </div>

        {/* ================= CENTER PANEL: CONVERSATION ================= */}
        <div className={`flex-1 flex flex-col bg-[#070b0e] overflow-hidden ${isMobile && mobileView !== "conversation" ? "hidden" : ""}`}>
          {activeSlug?.view_type === "brokers" && selectedBroker ? (
            <>
              {/* Observation Timeline Header */}
              <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between bg-black/80">
                <div className="flex items-center gap-3">
                  {isMobile && (
                    <button
                      onClick={() => setMobileView("list")}
                      className="p-1 -ml-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors touch-target"
                      aria-label="Back to inbox list"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                  )}
                  <div className="w-9 h-9 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-sm shadow-inner">
                    <User className="w-4 h-4 text-zinc-500" strokeWidth={1.5} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white truncate max-w-[340px]">
                      {selectedBroker.canonical_name || selectedBroker.name || selectedMsgDetails?.parsed?.broker_name || "Unknown Broker"}
                    </h3>
                    <div className="text-[10px] text-zinc-500 flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="truncate">{displayPhoneString(selectedBroker.phone)}</span>
                      <span>•</span>
                      <span>{selectedBrokerObservations.length} observations</span>
                      {selectedBroker.building_count > 0 && (
                        <>
                          <span>•</span>
                          <span>{selectedBroker.building_count} buildings</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => window.open(getWaLink(selectedBroker.phone), '_blank')}
                    className="h-7 px-3 rounded-md border border-white/10 bg-zinc-800 text-[#3EE88A] hover:text-white transition-colors text-[10px] font-bold flex items-center gap-1"
                  >
                    <MessageSquare className="w-3 h-3" strokeWidth={1.5} />
                    WhatsApp
                  </button>
                  <button
                    onClick={() => handleHideBroker(selectedBroker.phone)}
                    className="h-7 px-2 rounded-md border border-white/10 bg-zinc-800 text-zinc-500 hover:text-red-400 transition-colors text-[10px] font-bold flex items-center gap-1"
                    title="Hide this broker from inbox"
                  >
                    <EyeOff className="w-3 h-3" strokeWidth={1.5} />
                  </button>
                </div>
              </div>

              {/* Observation Timeline */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {loadingBrokerObs ? (
                  <div className="p-8 text-center text-xs text-zinc-500">Loading observations...</div>
                ) : groupedBrokerObservations.length === 0 ? (
                  <div className="p-8 text-center text-xs text-zinc-500">No observations yet</div>
                ) : (
                  groupedBrokerObservations.map((group: any) => {
                    const obs = group.representative;
                    const ev: any[] = obs.evidence_list || [];
                    const groupChannels: string[] = [...new Set<string>(ev.filter((e: any) => e.type === "group").map((e: any) => e.source))];
                    const dmCount = ev.filter((e: any) => e.type === "dm").length;
                    const isSelected = selectedMsgDetails?.raw?.id === (obs.latest_raw_message_id || obs.raw_message_id);
                    const obsTime = obs.last_seen ? new Date(obs.last_seen) : null;
                    const timeLabel = obsTime
                      ? obsTime.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                      : "";
                    const dayLabel = obsTime
                      ? obsTime.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
                      : "";
                    return (
                      <div key={group.key}>
                        {/* Time Divider */}
                        <div className="flex items-center gap-3 mb-3">
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                          <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">{timeLabel}</span>
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                        </div>
                        {/* Chat Bubble */}
                        <button
                          type="button"
                          onClick={() => selectBrokerObservation(obs)}
                          className={`w-full text-left border rounded-xl overflow-hidden transition-colors hover:border-[#3b82f6]/40 ${
                            isSelected ? "border-[#3b82f6]/50 ring-1 ring-[#3b82f6]/20" : "border-white/10"
                          }`}
                        >
                          {/* Bubble Header — Primary Type */}
                          <div className="px-4 py-2.5 border-b border-white/5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-base">{observationTypeIcon(obs.observation_type)}</span>
                                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${observationTypeColor(obs.observation_type)}`}>
                                  {observationTypeLabel(obs.observation_type)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`badge ${intentColor(obs.intent)} text-[9px]`}>
                                  {obs.intent?.toUpperCase() || "—"}
                                </span>
                                <span className="text-[9px] text-zinc-500 tabular-nums">{timeLabel}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-zinc-400">
                              {obs.property_type && <span className="font-medium text-zinc-300">{obs.property_type}</span>}
                              {obs.bhk && <><span className="text-[#475569]">·</span><span>{obs.bhk}</span></>}
                              {obs.price != null && <><span className="text-[#475569]">·</span><span className="font-bold text-[#3EE88A]">{formatCurrency(obs.price, obs.price_unit)}</span></>}
                              {obs.micro_market && <><span className="text-[#475569]">·</span><span>{obs.micro_market}</span></>}
                              {obs.alternate_intent && (
                                <span className="text-[9px] text-zinc-400 italic ml-1">
                                  Also {obs.alternate_intent === "RENT" ? "Rent" : "Sale"}
                                </span>
                              )}
                            </div>
                          </div>
                          {/* Bubble Body */}
                          <div className="px-4 py-3 space-y-2">
                            {/* Key fields as inline chips */}
                            <div className="flex flex-wrap gap-1.5">
                              {obs.bhk && (
                                <span className="text-[10px] bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full border border-white/5">
                                  {stripEmojis(obs.bhk)}
                                </span>
                              )}
                              {obs.micro_market && (
                                <span className="text-[10px] bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full border border-white/5">
                                  {stripEmojis(obs.micro_market)}
                                </span>
                              )}
                              {obs.building_name && (
                                <span className="text-[10px] bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full border border-white/5">
                                  {stripEmojis(obs.building_name)}
                                </span>
                              )}
                              {obs.times_seen && obs.times_seen > 1 && (
                                <span className="text-[9px] text-zinc-500 px-1 py-0.5">
                                  Seen {obs.times_seen}x
                                </span>
                              )}
                            </div>
                            {/* Posted In chips */}
                            {(groupChannels.length > 0 || dmCount > 0) && (
                              <div className="flex flex-wrap gap-1 items-center text-[8px]">
                                {groupChannels.slice(0, 3).map((src: string, i: number) => (
                                  <span key={i} className="bg-zinc-800 border border-white/10 text-zinc-400 px-1.5 py-0.5 rounded-full">
                                    {displayGroupName(src) || src.slice(-8)}
                                  </span>
                                ))}
                                {groupChannels.length > 3 && <span className="text-zinc-500">+{groupChannels.length - 3}g</span>}
                                {dmCount > 0 && <span className="border border-[rgba(62,232,138,0.15)] text-[#3EE88A] px-1.5 py-0.5 rounded-full">{dmCount}dm</span>}
                              </div>
                            )}
                            {/* Raw Message — always visible, truncate */}
                            {obs.raw_message && (
                              <div className="pt-1">
                                <div className={`text-[11px] text-zinc-400 whitespace-pre-wrap leading-relaxed ${!expandedRawMessages.has(group.key) ? "line-clamp-2" : ""}`}>
                                  {obs.raw_message}
                                </div>
                                {obs.raw_message.length > 120 && !expandedRawMessages.has(group.key) && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setExpandedRawMessages((prev) => { const next = new Set(prev); next.add(group.key); return next; }); }}
                                    className="text-[9px] text-blue-400 hover:underline mt-1"
                                  >
                                    Show more
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          {/* WhatsApp CTA */}
                          {selectedBroker?.phone && (
                            <div
                              className="border-t border-white/5 px-4 py-2 flex items-center gap-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <a
                                href={getWaLinkWithRecall(selectedBroker.phone, obs.raw_message || obs.summary_title || "")}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 text-[10px] font-semibold text-green-400 hover:text-green-300 transition-colors touch-target"
                              >
                                <MessageSquare className="w-3 h-3" strokeWidth={1.8} />
                                <span>Contact on WhatsApp</span>
                              </a>
                            </div>
                          )}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : selectedMsg ? (
            <>
              {/* Chat Thread Header */}
              <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between bg-black/80">
                <div className="flex items-center gap-3">
                  {isMobile && (
                    <button
                      onClick={() => setMobileView("list")}
                      className="p-1 -ml-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors touch-target"
                      aria-label="Back to inbox list"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                  )}
                  <div className="w-9 h-9 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-sm shadow-inner">
                    {selectedMsg.group_name && selectedMsg.group_name !== "seed" ? (
                      <Users className="w-4 h-4 text-zinc-500" strokeWidth={1.5} />
                    ) : (
                      <User className="w-4 h-4 text-zinc-500" strokeWidth={1.5} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white truncate max-w-[340px]">
                      {selectedTitle}
                    </h3>
                    <div className="text-[10px] text-zinc-500 flex items-center gap-2 mt-0.5 flex-wrap">
                      {selectedSubtitle && <span className="truncate">{selectedSubtitle}</span>}
                      {selectedCount ? (
                        <>
                          <span>•</span>
                          <span>{selectedCount.toLocaleString()} messages</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button className="h-7 w-7 lg:h-7 lg:w-7 rounded-md border border-white/10 bg-zinc-800 text-zinc-500 hover:text-white transition-colors flex items-center justify-center touch-target">
                    <Search className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                  <button className="h-7 w-7 lg:h-7 lg:w-7 rounded-md border border-white/10 bg-zinc-800 text-zinc-500 hover:text-white transition-colors flex items-center justify-center touch-target">
                    <Phone className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                  <button className="h-7 w-7 lg:h-7 lg:w-7 rounded-md border border-white/10 bg-zinc-800 text-zinc-500 hover:text-white transition-colors flex items-center justify-center touch-target">
                    <Video className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                  <button className="h-7 w-7 lg:h-7 lg:w-7 rounded-md border border-white/10 bg-zinc-800 text-zinc-500 hover:text-white transition-colors flex items-center justify-center touch-target">
                    <Info className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                  {!isGroupConversationSelected && resolveMessagePhone(selectedMsg) && (
                    <a
                      href={getWaLink(resolveMessagePhone(selectedMsg))}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1 bg-[#166534] text-green-100 hover:bg-[#15803d] rounded text-[10px] font-bold uppercase tracking-wider transition-colors touch-target"
                    >
                      Open WhatsApp
                    </a>
                  )}
                  {selectedBroker && (
                    <button
                      onClick={() => setActiveRightTab("broker")}
                      className="px-2.5 py-1 bg-[#1e293b] text-zinc-300 hover:text-white rounded text-[10px] font-bold uppercase tracking-wider transition-colors touch-target"
                    >
                      View Broker Graph
                    </button>
                  )}
                </div>
              </div>

              {/* Chat Thread Message Area — PropAI owns text selection here */}
              <div
                ref={messageAreaRef}
                className="flex-1 overflow-y-auto px-5 py-4 propai-interaction-area"
                data-prevent-context="true"
                onContextMenu={(e) => {
                  // Prevent native context menu — PropAI owns this
                  const selection = window.getSelection();
                  if (selection && !selection.isCollapsed && selection.toString().trim()) {
                    e.preventDefault();
                  }
                }}
              >
                {loadingConv ? (
                  <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                    Loading message thread...
                  </div>
                ) : (
                  <div className="space-y-5">
                    {groupedConversationMessages.map(([dateLabel, dayMessages]) => (
                      <div key={dateLabel} className="space-y-3">
                        <div className="flex items-center gap-3">
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                          <span className="text-[10px] uppercase tracking-[0.3em] text-zinc-500">{dateLabel}</span>
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                        </div>
                        <div className="space-y-3">
                          {dayMessages.map((block) => {
                            const first = block[0];
                            const last = block[block.length - 1];
                            const allBlocks = groupedConversationMessages.flatMap(([, b]) => b);
                            const isLatestBlock = block === allBlocks[allBlocks.length - 1];
                            const isSelf = first.from_me === 1 || first.from_me === true || first.sender === "seed-bot" || first.sender === "system" || first.sender === "owner";
                            const bubbleBg = isLatestBlock
                              ? "bg-[#1d4ed8]/10 border border-[#3b82f6]/30"
                              : isSelf
                              ? "bg-emerald-950/40 border border-emerald-800/30 ml-auto"
                              : "border border-white/10";

                            return (
                              <div
                                key={first.id}
                                className={`max-w-[72%] rounded-2xl p-4 space-y-2 relative transition-all ${
                                  isSelf ? "text-right ml-auto" : ""
                                } ${bubbleBg}`}
                              >
<div className={`flex items-center gap-2 text-[10px] text-zinc-500 ${isSelf ? "justify-end" : "justify-between"}`}>
                                   <BrokerTooltip 
                                     name={resolveMessageSenderName(first)} 
                                     phone={resolveMessagePhone(first)}
                                     onContextMenu={(e) => {
                                       e.preventDefault();
                                       e.stopPropagation();
                                       const rect = e.currentTarget.getBoundingClientRect();
                                       setActionContext({
                                         type: "broker",
                                         data: { name: resolveMessageSenderName(first), phone: resolveMessagePhone(first) },
                                         position: { x: rect.left + rect.width / 2, y: rect.top },
                                       });
                                     }}
                                   />
                                  <span className="whitespace-nowrap">
                                    {block.length > 1
                                      ? `${new Date(first.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${new Date(last.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                                      : new Date(first.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                  </span>
                                </div>
                                {block.map((m, msgIdx) => {
                                  const mPhone = resolveMessagePhone(m);
                                  const mSenderName = resolveMessageSenderName(m);
                                  const isSelectedMessage = selectedMsg?.id === m.id;
                                  const useInnerCard = block.length > 1;
                                  const mBadges = (() => {
                                    const badges: { label: string; color: string }[] = [];
                                    const intent = (m as api.InboxThread).parsed_intent || m.parsed_intent;
                                    if (intent) {
                                      const intentUpper = intent.toUpperCase();
                                      const label =
                                        intentUpper === "SELL" ? "Listing" :
                                        intentUpper === "BUY" ? "Requirement" :
                                        intentUpper === "RENT" ? "Rental" :
                                        intentUpper === "COMMERCIAL" ? "Commercial" : intent;
                                      const color =
                                        ({ SELL: "green", BUY: "purple", RENT: "yellow", COMMERCIAL: "orange" } as Record<string, string>)[intentUpper] || "blue";
                                      badges.push({ label, color });
                                    }
                                    if (m.attachments) {
                                      try {
                                        const att = JSON.parse(m.attachments);
                                        if (att.image) badges.push({ label: "Image", color: "cyan" });
                                        if (att.video) badges.push({ label: "Video", color: "pink" });
                                        if (att.document) badges.push({ label: "Document", color: "orange" });
                                      } catch {}
                                    }
                                    return badges;
                                  })();
                                  return (
                                    <div
                                      key={m.id}
                                      ref={el => { messageRefs.current[m.id] = el; }}
                                      onClick={() => selectMessage(m)}
                                      onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        // Semantic context: right-click on message bubble
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setActionContext({
                                          type: "message",
                                          data: m,
                                          position: { x: rect.left + rect.width / 2, y: rect.top },
                                        });
                                      }}
                                      className={`relative group/message transition-all cursor-pointer ${
                                        useInnerCard ? "rounded-lg px-2.5 py-2" : ""
                                      } ${
                                        isSelectedMessage && useInnerCard
                                          ? "bg-[#1d4ed8]/20 border border-[#3b82f6] shadow-[0_0_10px_rgba(59,130,246,0.14)]"
                                          : useInnerCard
                                          ? "border border-transparent hover:bg-white/[0.025] hover:border-white/[0.06]"
                                          : ""
                                      }`}
                                    >
                                      {isSelectedMessage && useInnerCard && (
                                        <div className="absolute -left-4 top-1/2 -translate-y-1/2 text-blue-400">
                                          <div className="w-2 h-2 rounded-full bg-[#3b82f6] shadow-[0_0_6px_rgba(59,130,246,0.6)]" />
                                        </div>
                                      )}
                                      <div className="text-xs text-white whitespace-pre-wrap leading-relaxed text-left propai-message-content">
                                        <WhatsAppMessage
                                          text={m.message || ""}
                                          sender={mSenderName}
                                          senderPhone={mPhone}
                                          entities={buildMessageEntities(m)}
                                          onEntityClick={handleEntityClick}
                                        />
                                      </div>

                                      {isSelectedMessage && selectedMsgDetails?.parsed && (
                                        <div className="pt-2 mt-2 border-t border-[rgba(62,232,138,0.1)]">
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setTeachingMsgId(teachingMsgId === m.id ? null : m.id);
                                            }}
                                            className="text-[9px] text-[#3EE88A]/70 hover:text-[#3EE88A] flex items-center gap-1"
                                          >
                                            <Sparkles className="w-2.5 h-2.5" strokeWidth={1.7} />
                                            {teachingMsgId === m.id ? "Close Teach AI" : "Teach AI"}
                                          </button>
                                          {teachingMsgId === m.id && (
                                            <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                                              <TeachingForm
                                                parsed={selectedMsgDetails.parsed}
                                                obsId={m.id}
                                                parsedId={selectedMsgDetails.parsed?.id}
                                                rawMessageId={m.id}
                                                onSave={() => setTeachingMsgId(null)}
                                              />
                                            </div>
                                          )}
                                        </div>
                                      )}

                                      <div className="flex items-center justify-between pt-1.5 mt-1.5 border-t border-white/5">
                                        <div className="flex gap-1 flex-wrap">
                                          {mBadges.map((b, bi) => (
                                            <span key={bi} className={`badge badge-${b.color} text-[8px] px-1 py-0`}>
                                              {b.label}
                                            </span>
                                          ))}
                                        </div>

                                        <div className="flex items-center gap-2 opacity-0 group-hover/message:opacity-100 transition-opacity">
                                          {mPhone && (
                                            <a
                                              href={getWaLinkWithRecall(mPhone, m.message || "")}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#166534] hover:bg-[#15803d] text-green-100"
                                              title="Message this broker on WhatsApp"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <MessageSquare className="w-3 h-3" strokeWidth={1.8} />
                                            </a>
                                          )}
                                          <button
                                            onClick={(e) => { e.stopPropagation(); selectMessage(m); }}
                                            className="text-[9px] text-[#3EE88A] hover:underline"
                                          >
                                            Analyze details →
                                          </button>
                                        </div>
                                      </div>
                                      {msgIdx < block.length - 1 && (
                                        <div className="my-2 border-t border-white/5" />
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div ref={threadEndRef} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-zinc-500 space-y-2">
              <span className="text-4xl">💬</span>
              <h3 className="text-sm font-semibold text-zinc-300">No conversation selected</h3>
              <p className="text-xs max-w-xs">
                Select a WhatsApp group or direct chat to see messages, evidence, and PropAI actions.
              </p>
            </div>
          )}
        </div>

        {/* ================= RIGHT PANEL: INTELLIGENCE PANEL ================= */}
        <div className={`${isMobile && mobileView !== "analysis" ? "hidden" : ""}`}>
        {rightPoppedOut && (
          <button
            type="button"
            aria-label="Close expanded intelligence panel"
            onClick={() => setRightPoppedOut(false)}
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]"
          />
        )}

        <ResizablePanel
          defaultWidth={384}
          minWidth={280}
          maxWidth={720}
          storageKey="propai-inbox-right-width"
          collapsed={rightCollapsed}
          onCollapse={() => setRightCollapsed(true)}
          onExpand={() => setRightCollapsed(false)}
          mobile={isMobile}
          presets={[
            { label: "Compact", width: 280 },
            { label: "Default", width: 384 },
            { label: "Deep Analysis", width: 560 },
          ]}
          className={
            rightPoppedOut
              ? "fixed z-50 top-6 right-6 bottom-6 left-[28%] border border-white/10 rounded-2xl shadow-2xl bg-black/80"
              : "border-l border-white/10 bg-black/80"
          }
        >
          <div className="flex flex-col h-full">
          {/* Tab Switcher */}
          <div className="flex border-b border-white/10 bg-[#070b0e]">
            {isMobile && (
              <button
                onClick={() => setMobileView("list")}
                className="px-3 py-3 text-zinc-400 hover:text-white border-r border-white/10 transition-colors"
                aria-label="Close analysis"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            {RIGHT_TABS.map(({ key: tab, label }) => {
              return (
                <button
                  key={tab}
                  onClick={() => setActiveRightTab(tab)}
                  className={`flex-1 py-3 text-xs font-bold text-center border-b-2 transition-colors ${
                    activeRightTab === tab
                      ? "border-[#3EE88A] text-[#3EE88A] bg-black/80/50"
                      : "border-transparent text-zinc-500 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              );
            })}
            <button
              onClick={() => setRightPoppedOut((prev) => !prev)}
              className="px-3 py-3 text-zinc-500 hover:text-white border-l border-white/10 transition-colors"
              title={rightPoppedOut ? "Dock panel (Esc/Enter)" : "Pop out panel"}
            >
              {rightPoppedOut ? (
                <Minimize2 className="w-3.5 h-3.5" strokeWidth={1.7} />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.7} />
              )}
            </button>
          </div>

          {/* Details Scroll Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {loadingDetails ? (
              <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                Updating workspace intelligence...
              </div>
            ) : !selectedMsgDetails ? (
              <div className="h-full flex items-center justify-center text-xs text-zinc-500 text-center p-6">
                Select a message to view PropAI evidence and broker actions.
              </div>
            ) : (
              <>
                {/* ================= TAB 1: MESSAGE ANALYSIS ================= */}
                {activeRightTab === "analysis" && (
                  <div className="space-y-4 animate-fadeIn">
                    
                    {/* AI Signals & Alerts Section */}
                    {signals.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                          AI Signals & Notifications
                        </div>
                        {signals.map((s, idx) => {
                          const bg = s.type === "alert" ? "bg-red-950/20 border-red-500/30 text-red-200" : s.type === "warning" ? "bg-amber-950/20 border-amber-500/30 text-amber-200" : "bg-blue-950/20 border-blue-500/30 text-blue-200";
                          return (
                            <div key={idx} className={`p-3 rounded-xl border text-xs leading-relaxed space-y-2 ${bg}`}>
                              <div className="font-bold flex items-center gap-1.5">
                                {s.type === "alert" ? "🚨" : s.type === "warning" ? "⚠️" : "💡"} {s.title}
                              </div>
                              <p className="text-[11px] text-zinc-400">{s.desc}</p>
                              
                              {/* Merge suggestion action trigger */}
                              {s.actionSug && (
                                <div className="flex gap-2 pt-1">
                                  <button
                                    onClick={() => handleApproveSuggestion(s.actionSug.id)}
                                    className="px-2 py-1 bg-[#166534] text-green-100 hover:bg-[#15803d] rounded text-[10px] font-bold"
                                  >
                                    Approve Merge
                                  </button>
                                  <button
                                    onClick={() => handleRejectSuggestion(s.actionSug.id)}
                                    className="px-2 py-1 bg-red-950/40 text-red-200 border border-red-800/40 rounded text-[10px] font-bold"
                                  >
                                    Reject
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Raw Text Card */}
                    <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-1.5">
                      <div className="flex justify-between items-center text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                        <span>Original text</span>
                        <button
                          onClick={() => navigator.clipboard.writeText(selectedMsgDetails.raw?.message || "")}
                          className="hover:text-white"
                        >
                          Copy
                        </button>
                      </div>
                      <div className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
                        <WhatsAppMessage
                          text={selectedMsgDetails.raw?.message || ""}
                          sender={resolveMessageSenderName(selectedMsgDetails.raw)}
                          senderPhone={resolveMessagePhone(selectedMsgDetails.raw)}
                          entities={buildMessageEntities(selectedMsgDetails.raw, selectedMsgDetails)}
                          onEntityClick={handleEntityClick}
                        />
                      </div>
                    </div>

                    {!selectedHasMarketContext && (
                      <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-3">
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                          Conversation Context
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="flex justify-between gap-3">
                            <span className="text-zinc-500">Type</span>
                            <span className="badge badge-blue">DIRECT MESSAGE</span>
                          </div>
                          <div className="flex justify-between gap-3">
                            <span className="text-zinc-500">Sender</span>
                            <span className="text-right font-semibold text-white">
                              {resolveMessageSenderName(selectedMsgDetails.raw) || "Unknown contact"}
                            </span>
                          </div>
                          {resolveMessagePhone(selectedMsgDetails.raw) && (
                            <div className="flex justify-between gap-3">
                              <span className="text-zinc-500">Phone</span>
                              <span className="font-mono text-zinc-300">
                                {displayPhoneString(resolveMessagePhone(selectedMsgDetails.raw))}
                              </span>
                            </div>
                          )}
                          <div className="rounded-lg bg-[#05070b] border border-white/5 p-3 text-[11px] leading-relaxed text-zinc-400">
                            PropAI did not find enough property context in this message. It is kept as a conversation until it is linked to a broker, client, listing, or requirement.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Structured Details Panel — Property-Type Aware */}
                    {selectedHasMarketContext && (
                      <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-3">
                        {selectedMsgDetails.parsed && Object.keys(selectedMsgDetails.parsed).length > 0 ? (
                          <PropertyDetails parsed={selectedMsgDetails.parsed} />
                        ) : (
                          <div className="text-xs text-zinc-500 italic py-2">No property details found.</div>
                        )}
                      </div>
                    )}

                    {/* Extracted Listings as Individual WhatsApp-style Messages */}
	                    {selectedHasMarketContext && selectedMsgDetails.listings && selectedMsgDetails.listings.length > 1 && (
	                      <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-2">
                        <div className="flex items-center justify-between text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                          <span>Extracted listings from this message</span>
                          {waSenderPhone && (
                            <a
                              href={getWaLink(waSenderPhone)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#166534] hover:bg-[#15803d] text-green-100"
                              title="Open WhatsApp with this broker"
                            >
                              <MessageSquare className="w-3 h-3" strokeWidth={1.6} />
                            </a>
                          )}
                        </div>
                        <div className="space-y-2">
                          {selectedMsgDetails.listings.map((listing: any, idx: number) => {
                            const text = getListingPayloadText(listing) || selectedMsgDetails.raw?.message || "";
                            const intentLabel = listing.intent || selectedMsgDetails.parsed?.intent || "TEXT";
                            const intentColor =
                              ({ SELL: "green", BUY: "purple", RENT: "yellow" } as Record<string, string>)[
                                String(intentLabel).toUpperCase()
                              ] || "blue";
                            return (
                              <div
                                key={listing.id ?? idx}
                                className="flex items-start justify-between gap-3 px-2.5 py-2 rounded-lg bg-[#05070b] border border-[rgba(255,255,255,0.05)]"
                              >
                                <div className="flex-1 text-xs text-zinc-300">
                                  <div className="flex items-center gap-1.5 mb-1">
                                    <span className={`badge badge-${intentColor} text-[8px]`}>
                                      {intentLabel || "TEXT"}
                                    </span>
                                    {listing.bhk && (
                                      <span className="text-[10px] text-white font-semibold">
                                        {listing.bhk}
                                      </span>
                                    )}
                                    {listing.area_sqft && (
                                      <span className="text-[10px] text-zinc-400">
                                        {listing.area_sqft.toLocaleString("en-IN")} sqft
                                      </span>
                                    )}
                                    {listing.furnishing && (
                                      <span className="text-[10px] text-zinc-400">{listing.furnishing}</span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-zinc-300 whitespace-pre-wrap leading-relaxed">
                                    <WhatsAppMessage
                                      text={text}
                                      entities={buildMessageEntities(selectedMsgDetails.raw, selectedMsgDetails)}
                                      onEntityClick={handleEntityClick}
                                    />
                                  </div>
                                </div>
                                {waSenderPhone && (
                                  <a
                                    href={getWaLinkWithRecall(waSenderPhone, text)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-full bg-[#166534] hover:bg-[#15803d] text-green-100 shrink-0"
                                    title="Message this broker on WhatsApp"
                                  >
                                    <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.8} />
                                  </a>
                                )}
                              </div>
                            );
                          })}
                        </div>
    </div>
	                    )}

	                    {/* Location Match Panel */}
	                    {selectedHasMarketContext && (
                      <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-3">
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                          Location Match
                        </div>

                        {selectedMsgDetails.resolver ? (
                          <div className="space-y-2.5 text-xs">
                            <div className="flex justify-between items-center">
                              <span className="text-zinc-500">Status</span>
                              <span className={`badge ${
                                selectedMsgDetails.resolver.method === "resolved" ? "badge-green" : "badge-yellow"
                              } font-bold`}>
                                {selectedMsgDetails.resolver.method?.toUpperCase()}
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-zinc-500 block uppercase">Building</span>
                              <span className="font-bold text-white block mt-0.5">
                                {selectedMsgDetails.resolver.building_name || "—"}
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-zinc-500 block uppercase">Confidence Level</span>
                              <div className="flex items-center gap-2 mt-1">
                                <div className="flex-1 h-2 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-blue-500 rounded-full"
                                    style={{ width: `${Math.round((selectedMsgDetails.resolver.final_confidence || 0) * 100)}%` }}
                                  />
                                </div>
                                <span className="font-mono text-[10px] text-zinc-300 font-bold">
                                  {Math.round((selectedMsgDetails.resolver.final_confidence || 0) * 100)}%
                                </span>
                              </div>
                            </div>
                            {selectedMsgDetails.resolver.method_detail && (
                              <div>
                                <span className="text-[10px] text-zinc-500 block uppercase">Match Notes</span>
                                <span className="text-zinc-300 block mt-0.5 leading-relaxed text-[11px]">
                                  {selectedMsgDetails.resolver.method_detail}
                                </span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-xs text-zinc-500 italic py-2">No location match recorded.</div>
                        )}
                      </div>
                    )}

                    {/* Price Stats Comparison Widget */}
                    {priceStats && selectedMsgDetails.parsed?.price && (
                      <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-3">
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                          Market Price Benchmarking
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="text-[11px] text-zinc-400 font-bold">
                            {selectedMsgDetails.parsed.bhk} in {selectedMsgDetails.parsed.micro_market}
                          </div>
                          <div className="flex justify-between text-[11px] border-b border-white/5 pb-1.5">
                            <span className="text-zinc-500">Listing Price:</span>
                            <span className="font-bold text-[#3EE88A]">{formatCurrency(selectedMsgDetails.parsed.price)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-zinc-500">Market Median:</span>
                            <span className="font-semibold text-white">{formatCurrency(priceStats.median)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-zinc-500">25th Percentile (p25):</span>
                            <span className="text-zinc-300">{formatCurrency(priceStats.p25)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-zinc-500">75th Percentile (p75):</span>
                            <span className="text-zinc-300">{formatCurrency(priceStats.p75)}</span>
                          </div>
                          <div className="text-[10px] text-zinc-500 pt-1.5 italic text-center">
                            Based on {priceStats.count} market listings
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Building Profile (inline in Analysis when resolved) */}
                    {selectedBuilding && (
                      <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-3">
                        <div className="flex items-center gap-2 text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                          <Building2 className="w-3 h-3" strokeWidth={1.5} />
                          <span>Building Profile</span>
                        </div>
                        <div className="space-y-2.5 text-xs">
                          <div className="flex justify-between items-center">
                            <span className="text-zinc-500">Building</span>
                            <span className="font-bold text-white">{selectedBuilding.name || "—"}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-zinc-500">Database Observations</span>
                            <span className="font-mono text-zinc-300 font-bold">{selectedBuilding.observation_count}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-zinc-500">Active Brokers</span>
                            <span className="font-mono text-zinc-300 font-bold">{selectedBuilding.broker_count}</span>
                          </div>
                          {selectedBuilding.markets?.[0]?.micro_market && (
                            <div className="flex justify-between">
                              <span className="text-zinc-500">Micro Market</span>
                              <span className="text-white font-semibold">{selectedBuilding.markets[0].micro_market}</span>
                            </div>
                          )}
                          {selectedBuilding.landmarks?.length > 0 && (
                            <div className="pt-1">
                              <span className="text-[10px] text-zinc-500 block uppercase mb-1">Nearby Landmarks</span>
                              <div className="flex flex-wrap gap-1">
                                {selectedBuilding.landmarks.map((l: any, idx: number) => (
                                  <span key={idx} className="bg-zinc-800 px-2 py-0.5 rounded text-[10px] text-zinc-300 border border-[rgba(255,255,255,0.03)]">{l.landmark_name}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {selectedBuilding.price_stats?.length > 0 && (
                            <div className="pt-1">
                              <span className="text-[10px] text-zinc-500 block uppercase mb-1">Price Benchmarks</span>
                              <div className="space-y-1">
                                {selectedBuilding.price_stats.map((s: any, idx: number) => (
                                  <div key={idx} className="flex justify-between text-[11px] border-b border-white/5 pb-1 last:border-b-0 last:pb-0">
                                    <span className="text-white">{s.bhk} - {s.intent?.toUpperCase()}</span>
                                    <span className="text-[#3EE88A]">Avg: {formatCurrency(s.avg_price)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                  </div>
                )}

                {/* ================= TAB 2: BROKER PROFILE ================= */}
                {activeRightTab === "broker" && (
                  <div className="space-y-4 animate-fadeIn">
                    {loadingBroker ? (
                      <div className="text-center text-xs text-zinc-500 py-8">Loading broker profile...</div>
                    ) : !selectedBroker ? (
                      <div className="text-center text-xs text-zinc-500 py-8">
                        No broker profile found for this contact.
                      </div>
                    ) : (
                      <div className="space-y-4 text-xs">
                        
                        {/* Broker Basic Info */}
                        <div className="bg-zinc-900 rounded-xl p-4 border border-white/5 flex flex-col gap-2">
                          <h4 className="text-sm font-bold text-white">{selectedBroker.name}</h4>
                          
                          <div className="flex items-center justify-between text-[11px] border-t border-white/5 pt-2.5">
                            <span className="text-zinc-500">Primary Phone</span>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-zinc-300">
                                {revealedPhone[selectedBroker.phone] ? displayPhoneString(selectedBroker.phone) : maskPhoneString(selectedBroker.phone)}
                              </span>
                              <button
                                onClick={() => toggleRevealPhone(selectedBroker.phone)}
                                className="text-[9.5px] text-blue-400 hover:underline"
                              >
                                {revealedPhone[selectedBroker.phone] ? "Hide" : "Reveal"}
                              </button>
                            </div>
                          </div>

                          {selectedBroker.first_seen_at && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-zinc-500">First Seen</span>
                              <span className="text-zinc-300">
                                {new Date(selectedBroker.first_seen_at).toLocaleDateString("en-IN", {
                                  day: "numeric",
                                  month: "short",
                                  year: "numeric"
                                })}
                              </span>
                            </div>
                          )}

                          {selectedBroker.last_seen_at && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-zinc-500">Last Activity</span>
                              <span className="text-zinc-300">
                                {new Date(selectedBroker.last_seen_at).toLocaleDateString("en-IN", {
                                  day: "numeric",
                                  month: "short",
                                  year: "numeric"
                                })}
                              </span>
                            </div>
                          )}

                          {selectedBroker.phone && (
                            <div className="pt-2">
                              <a
                                href={getWaLink(selectedBroker.phone)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-full py-1.5 bg-[#166534] hover:bg-[#15803d] text-green-100 rounded text-[10px] font-bold uppercase tracking-wider text-center block transition-colors"
                              >
                                Open WhatsApp
                              </a>
                            </div>
                          )}
                        </div>

                        {/* Stats Grid */}
                        <div className="grid grid-cols-2 gap-2 text-center">
                          {[
                            { label: "Observations", value: selectedBroker.observation_count },
                            { label: "Market Posts", value: selectedBroker.listing_count },
                            { label: "Coverage", value: selectedBroker.building_count ?? "—" },
                            { label: "Active Days", value: selectedBroker.active_days_30 != null ? `${selectedBroker.active_days_30}/30` : "—" },
                          ].map((stat) => (
                            <div key={stat.label} className="bg-zinc-900 rounded-xl p-2.5 border border-white/5">
                              <div className="text-sm font-bold text-white">{stat.value}</div>
                              <div className="text-[9px] text-zinc-500 uppercase mt-0.5">{stat.label}</div>
                            </div>
                          ))}
                        </div>

                        {/* Aliases */}
                        {selectedBroker.aliases?.length > 0 && (
                          <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-2">
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                              Known Aliases
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {selectedBroker.aliases.map((a: any, idx: number) => (
                                <span key={idx} className="bg-zinc-800 px-2 py-0.5 rounded text-[10px] text-zinc-300 border border-[rgba(255,255,255,0.03)]">
                                  {a.alias}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Top Micro-Markets */}
                        {selectedBroker.markets?.length > 0 && (
                          <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-2">
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                              Core Micro Markets
                            </div>
                            <div className="space-y-1.5">
                              {selectedBroker.markets.slice(0, 3).map((m: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center">
                                  <span className="font-semibold text-zinc-300">{m.micro_market}</span>
                                  <span className="text-[10px] text-zinc-500">
                                    {m.listing_count} listings · {m.requirement_count} requirements
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Top Buildings */}
                        {selectedBroker.buildings?.length > 0 && (
                          <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-2">
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                              Frequent Buildings
                            </div>
                            <div className="space-y-1.5">
                              {selectedBroker.buildings.slice(0, 3).map((b: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center">
                                  <span className="font-semibold text-zinc-300">{b.building_name}</span>
                                  <span className="text-[10px] text-zinc-500">
                                    {b.listing_count} listings · {b.requirement_count} requirements
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                      </div>
                    )}
                  </div>
                )}

                {/* ================= TAB 4: NOTES ================= */}
                {activeRightTab === "notes" && (
                  <NotesPanel
                    entityType="chat"
                    entityId={(() => {
                      if (!selectedMsg) return "none";
                      const msg = selectedMsg as any;
                      return msg.chat_id || msg.conversation_key || msg.group_name || msg.sender_phone || String(msg.id);
                    })()}
                  />
                )}

                {/* ================= TAB 3: MARKET INTELLIGENCE ================= */}
                {activeRightTab === "market" && (
                  <div className="space-y-4 animate-fadeIn">
                    {!selectedMsgDetails ? (
                      <div className="h-full flex items-center justify-center text-xs text-zinc-500 text-center p-6">
                        Select an observation to view market intelligence.
                      </div>
                    ) : (
                      <div className="space-y-4 text-xs">
                        {/* Broker Memory Card */}
                        {selectedBroker && (
                          <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-2">
                            <div className="flex items-center gap-2 text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                              <User className="w-3 h-3" strokeWidth={1.5} />
                              <span>Broker Memory</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="bg-zinc-800 rounded-lg p-2 text-center">
                                <div className="text-sm font-bold text-white">{selectedBroker.observation_count || "—"}</div>
                                <div className="text-[8px] text-zinc-500 uppercase">Observations</div>
                              </div>
                              <div className="bg-zinc-800 rounded-lg p-2 text-center">
                                <div className="text-sm font-bold text-white">{selectedBroker.active_days_30 != null ? `${selectedBroker.active_days_30}/30` : "—"}</div>
                                <div className="text-[8px] text-zinc-500 uppercase">Active Days</div>
                              </div>
                            </div>
                            {selectedMsgDetails.parsed?.micro_market && (
                              <div className="flex justify-between pt-1 border-t border-white/5">
                                <span className="text-zinc-500">Primary Market</span>
                                <span className="font-semibold text-white">{selectedMsgDetails.parsed.micro_market}</span>
                              </div>
                            )}
                            {selectedMsgDetails.parsed?.building_name && (
                              <div className="flex justify-between">
                                <span className="text-zinc-500">Building</span>
                                <span className="font-semibold text-white">{selectedMsgDetails.parsed.building_name}</span>
                              </div>
                            )}
                            <div className="flex justify-between">
                              <span className="text-zinc-500">Active Since</span>
                              <span className="text-zinc-300">
                                {selectedBroker.first_seen
                                  ? new Date(selectedBroker.first_seen).toLocaleDateString("en-IN", { month: "short", year: "numeric" })
                                  : "—"}
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Similar Observations (same locality/intent) */}
                        {selectedMsgDetails.parsed?.micro_market && (
                          <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-2">
                            <div className="flex items-center gap-2 text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                              <MapPin className="w-3 h-3" strokeWidth={1.5} />
                              <span>Similar in {selectedMsgDetails.parsed.micro_market}</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                              <span>BHK:</span>
                              <span className="font-semibold text-white">{selectedMsgDetails.parsed.bhk || "Any"}</span>
                              <span className="mx-1">·</span>
                              <span>Intent:</span>
                              <span className="font-semibold text-white">{selectedMsgDetails.parsed.intent || "Any"}</span>
                            </div>
                            {/* Price comparison */}
                            {priceStats && (
                              <div className="bg-zinc-800 rounded-lg p-2.5 space-y-1.5 mt-1">
                                <div className="flex justify-between">
                                  <span className="text-zinc-500">This listing</span>
                                  <span className="font-bold text-[#3EE88A]">{formatCurrency(selectedMsgDetails.parsed?.price)}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-500">Market median</span>
                                  <span className="font-semibold text-white">{formatCurrency(priceStats.median)}</span>
                                </div>
                                {selectedMsgDetails.parsed?.price && priceStats.median && (
                                  <div className="flex justify-between border-t border-white/5 pt-1.5">
                                    <span className="text-zinc-500">vs Market</span>
                                    <span className={`font-bold ${selectedMsgDetails.parsed.price > priceStats.median ? "text-red-400" : "text-[#3EE88A]"}`}>
                                      {selectedMsgDetails.parsed.price > priceStats.median
                                        ? `${Math.round((selectedMsgDetails.parsed.price / priceStats.median - 1) * 100)}% above`
                                        : `${Math.round((1 - selectedMsgDetails.parsed.price / priceStats.median) * 100)}% below`}
                                    </span>
                                  </div>
                                )}
                                <div className="text-[9px] text-zinc-500 pt-1 text-center">
                                  Based on {priceStats.count} similar listings
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Demand vs Supply Indicator */}
                        <div className="bg-zinc-900 rounded-xl p-3.5 border border-white/5 space-y-2">
                          <div className="flex items-center gap-2 text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                            <TrendingUp className="w-3 h-3" strokeWidth={1.5} />
                            <span>Activity Summary</span>
                          </div>
                          <div className="space-y-2 text-[11px]">
                            <div className="flex justify-between">
                              <span className="text-zinc-500">Total observations</span>
                              <span className="font-semibold text-white">{selectedBrokerObservations.length}</span>
                            </div>
                            {(() => {
                              const intents = selectedBrokerObservations.map((o: any) => (o.intent || "").toUpperCase());
                              const sell = intents.filter((i: string) => i === "SELL" || i === "SALE").length;
                              const rent = intents.filter((i: string) => i === "RENT").length;
                              const buy = intents.filter((i: string) => i === "BUY" || i === "REQUIREMENT" || i === "WANTED").length;
                              return (
                                <>
                                  {sell > 0 && <div className="flex justify-between"><span className="text-zinc-500">Sell/Lease posts</span><span className="text-white">{sell}</span></div>}
                                  {rent > 0 && <div className="flex justify-between"><span className="text-zinc-500">Rent posts</span><span className="text-white">{rent}</span></div>}
                                  {buy > 0 && <div className="flex justify-between"><span className="text-zinc-500">Requirements</span><span className="text-white">{buy}</span></div>}
                                  <div className="pt-1 text-[9.5px] text-zinc-500 italic">
                                    {sell + rent > buy ? "Supply-heavy — more listings than requirements" : buy > sell + rent ? "Demand-heavy — more requirements than listings" : "Balanced activity"}
                                  </div>
                                </>
                              );
                            })()}
                          </div>
                        </div>

                        {/* Teaching & Merge Suggestions */}
                        {allSuggestions.length > 0 && (
                          <div className="bg-zinc-900 rounded-xl p-3.5 border border-[rgba(62,232,138,0.14)] space-y-2">
                            <div className="flex items-center gap-2 text-[10px] text-[#3EE88A] uppercase tracking-wider font-bold">
                              <Sparkles className="w-3 h-3" strokeWidth={1.7} />
                              <span>Suggestions</span>
                            </div>
                            <div className="space-y-1.5">
                              {allSuggestions.slice(0, 5).map((s: any, idx: number) => (
                                <div key={idx} className="flex items-center justify-between bg-zinc-800 rounded-lg p-2">
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[10px] text-zinc-300 truncate">{s.text || s.description}</div>
                                    <div className="text-[8px] text-zinc-500 uppercase mt-0.5">{s.type}</div>
                                  </div>
                                  <div className="flex gap-1 shrink-0">
                                    <button className="px-1.5 py-0.5 bg-[#166534] text-green-100 rounded text-[8px] font-bold">Accept</button>
                                    <button className="px-1.5 py-0.5 bg-red-950/40 text-red-200 rounded text-[8px] font-bold">Reject</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          </div>
        </ResizablePanel>
      </div>

        {/* ================= TAB: AI ASSISTANT ================= */}
        {activeRightTab === "ai" ? (
          <InboxAIChat
            selectedMessage={selectedMsgDetails?.raw || selectedMsg}
            context={selectedMsgDetails?.raw?.message || selectedMsgDetails?.raw?.text || ""}
          />
        ) : null}
        {/* Combined Localities Dialog */}
        {showCombinedLocalityDialog && (
          <CombinedLocalityDialog
            isOpen={showCombinedLocalityDialog}
            onClose={() => setShowCombinedLocalityDialog(false)}
            surfaceText={combinedLocalitySurfaceText}
            onSave={handleCombinedLocalitySave}
          />
        )}
      </div>
      </div>
  );
}

export default function BrokerWorkspacePage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
      <InboxPageInner />
    </Suspense>
  );
}
