"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useRef, useCallback, useMemo, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import * as api from "@/lib/api";
import WhatsAppMessage, { MessageEntity } from "@/components/WhatsAppMessage";
import NotesPanel from "@/components/notes/NotesPanel";
import ResizablePanel from "@/components/ResizablePanel";
import { entityProfileHref } from "@/lib/entity-links";
import { marketRecordHref } from "@/lib/market-record-links";
import { classifyFormatIssue, type FormatIssue } from "@/lib/format-issues";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { stripDecorativeEmoji } from "@/lib/whatsapp-display";
import { formatListingValue } from "@/lib/format";
import {
  Users,
  User,
  Building2,
  MapPin,
  DollarSign,
  BedDouble,
  Ruler,
  Armchair,
  Send,
  Copy,
  Check,
  Paperclip,
  X,
  Calendar,
  MessageSquare,
  ClipboardList,
  EyeOff,
  Eye,
  TrendingUp,
  Home,
  ChevronLeft,
  Menu,
  CheckSquare,
  ListPlus,
  LoaderCircle,
} from "lucide-react";
import { useLayout } from "@/hooks/useLayout";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { MarketInboxCard } from "@/components/ui/market-inbox-card";
import { ListingHeadline } from "@/components/ui/listing-headline";
import { PillRow } from "@/components/ui/pill-row";
import { PriceDisplay } from "@/components/ui/price-display";
import { FileAttachment } from "@/components/ui/file-attachment";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const PAGE_SIZE = 100;
const BROKER_PAGE_SIZE = 25;
// Inbox is live again now that the reconstructed parsing pipeline is back.
const MARKET_INBOX_PAUSED = false;

type TrainingPrompt = {
  text: string;
  question: string;
  actions: { label: string; action: string }[];
};

type ThreadFallbackItem = {
  key: string;
  title: string;
  subtitle: string;
  latest: api.InboxThread;
  count: number;
  type: "group" | "direct";
};

function stripEmojis(text: string | null | undefined): string {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!value) return "";
  return value.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{231A}-\u{23FF}\u{25A0}-\u{25FF}\u{2934}-\u{2935}\u{2B05}-\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{2122}\u{2139}\u{24C2}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2600}-\u{27EB}]/gu, "").trim();
}

function compactEvidencePreview(value: string | null | undefined, maxLength = 420): string {
  const cleaned = stripEmojis(value).replace(/[ \t]+\n/g, "\n").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).trimEnd()}…`;
}

function EvidenceText({ value, previewLength = 420, className = "mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-400" }: { value: string | null | undefined; previewLength?: number; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const cleaned = stripEmojis(value).replace(/[ \t]+\n/g, "\n").trim();
  if (!cleaned) return null;
  const truncated = cleaned.length > previewLength;

  return (
    <>
      <div className={className}>{expanded || !truncated ? cleaned : compactEvidencePreview(cleaned, previewLength)}</div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 text-[10px] font-semibold text-emerald-300 underline decoration-emerald-300/40 underline-offset-2 hover:text-emerald-200"
        >
          {expanded ? "Hide full message" : "Show full message"}
        </button>
      )}
    </>
  );
}

function brokerDisplayName(value: unknown) {
  const label = stripDecorativeEmoji(value as string);
  return label.toLowerCase() === "workspace broker" ? "Your own" : label;
}

function whatsappPayloadObject(value: api.RawMessage["raw_payload"]): Record<string, any> {
  if (value && typeof value === "object") return value as Record<string, any>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function whatsappPayloadText(message: api.RawMessage): string {
  const payload = whatsappPayloadObject(message.raw_payload);
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const body = data.message && typeof data.message === "object" ? data.message : {};
  const candidates = [
    body.conversation,
    body.extendedTextMessage?.text,
    body.imageMessage?.caption,
    body.videoMessage?.caption,
    body.documentMessage?.caption,
    data.text,
    data.body,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim() || "";
}

function actualWhatsAppMessageText(message: api.RawMessage): string {
  const stored = String(message.message || "").trim();
  const recovered = whatsappPayloadText(message);
  const senderKeys = [
    message.sender,
    message.broker_name,
    message.conversation_name,
    message.chat_name,
  ]
    .map((value) => stripEmojis(value || "").toLowerCase())
    .filter(Boolean);
  const storedKey = stripEmojis(stored).toLowerCase();
  if (stored && !senderKeys.includes(storedKey)) return stored;
  return recovered && !senderKeys.includes(stripEmojis(recovered).toLowerCase()) ? recovered : "";
}

function isLikelyBrokerDisplayName(value?: string): boolean {
  const text = stripEmojis(value || "").trim();
  if (!text || text.length < 3 || text.toLowerCase() === "unknown") return false;
  if (/^[+\d\s().-]+$/.test(text)) return false;
  if (/\b(?:bhk|rk|sq\s*ft|sqft|carpet|built\s*up|rent|sale|sell|buy|commercial|office|shop|flat|furnished|unfurnished|semi|possession|available|requirement|required|wanted|client|tenant|bachelor|family|self\s*contained|lift|floor|cr|lac|lakh|abs|negotiable)\b/i.test(text)) {
    return false;
  }
  return /[A-Za-z]/.test(text);
}

function cleanSpecialtyValue(value: unknown): string {
  const text = stripDecorativeEmoji(String(value || ""))
    .replace(/[|•]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^(?:unknown|other|n\/?a|na|property|properties|listing|requirement)$/i.test(text)) return "";
  return text;
}

function brokerSpecialtyLabel(broker: any): string {
  const localities = (Array.isArray(broker.specialty_localities) ? broker.specialty_localities : [])
    .map(cleanSpecialtyValue)
    .filter(Boolean)
    .slice(0, 2);
  const propertyType = (Array.isArray(broker.specialty_property_types) ? broker.specialty_property_types : [])
    .map(cleanSpecialtyValue)
    .find(Boolean);
  const listings = Number(broker.listing_count || 0);
  const requirements = Number(broker.requirement_count || 0);
  const activity = listings > 0 && requirements > 0
    ? "Listings & requirements"
    : requirements > 0
      ? "Requirements"
      : "Listings";
  const focus = propertyType ? `${propertyType} ${activity.toLowerCase()}` : activity;
  return localities.length ? `${localities.join(", ")} · ${focus}` : focus;
}

function brokerCoverageLabel(broker: any): string {
  const localities = [
    ...(Array.isArray(broker.specialty_localities) ? broker.specialty_localities : []),
    broker.latest_micro_market,
  ]
    .map(cleanSpecialtyValue)
    .filter(Boolean)
    // Amenities and facility lists sometimes land in the model's locality
    // field. Keep the compact area names, while leaving the raw post itself
    // available in the item timeline as evidence.
    .filter((value) => value.length <= 40 && !/,/.test(value))
    .filter((value, index, values) => values.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index)
    .slice(0, 3);
  return localities.length ? localities.join(", ") : "No parsed locality yet";
}

function splitCode(rawMessageId: string | number | undefined, index: number): string {
  const source = String(rawMessageId || "RAW").replace(/[^\w-]/g, "").slice(-8) || "RAW";
  return `PO-${source}-${String(index + 1).padStart(2, "0")}`;
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

function intentColor(_intent?: string): string {
  return "badge-neutral";
}

function observationTypeLabel(type?: string): string {
  switch ((type || "").toUpperCase()) {
    case "LISTING": return "Available property";
    case "REQUIREMENT": return "Client requirement";
    case "MARKET_UPDATE": return "Market update";
    case "INTRODUCTION": return "Introduction";
    default: return "Message";
  }
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

function observationTypeColor(_type?: string): string {
  return "badge-neutral";
}

function inferOpportunityKind(input: { intent?: string; observation_type?: string; text?: string }) {
  const intent = (input.intent || "").toUpperCase();
  const type = (input.observation_type || "").toUpperCase();
  const text = (input.text || "").toLowerCase();
  const hasRequirementSignal = /\b(requirement|required|wanted|looking|need|client wants|buyer|tenant)\b/.test(text);
  const hasListingSignal = /\b(available|on rent|for rent|rent only|for sale|on sale|distress|outright|asking|inspection|call|contact)\b/.test(text);
  if (type === "LISTING") return "Listing";
  if (type === "REQUIREMENT") return "Requirement";
  if (
    ["BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER", "WANTED"].includes(intent) ||
    (hasRequirementSignal && !hasListingSignal)
  ) {
    return "Requirement";
  }
  if (hasListingSignal || type === "LISTING" || ["SELL", "SALE", "RENT", "LEASE"].includes(intent)) {
    return "Listing";
  }
  return "Market";
}

function inferOpportunitySide(input: { intent?: string; side?: string; text?: string }) {
  const intent = (input.intent || "").toUpperCase();
  const side = (input.side || "").toUpperCase();
  const text = (input.text || "").toLowerCase();
  if (["RENT", "LEASE", "RENTAL", "LEAVE_AND_LICENSE"].includes(side)) return "Rent";
  if (["SALE", "SELL", "OUTRIGHT", "PRE_LEASED"].includes(side)) return "Sale";
  if (["RENT", "LEASE", "RENTAL_SEEKER"].includes(intent)) return "Rent";
  if (["SELL", "SALE"].includes(intent)) return "Sale";
  const rentSignal = /\b(on rent|for rent|rent only|rent\s*:|rental|lease|leave\s*&\s*license|l\s*&\s*l|per month|p\.?m\.?)\b/.test(text);
  const saleSignal = /\b(for sale|on sale|distress sale|outright|sale price|reserve price)\b/.test(text);
  if (rentSignal) return "Rent";
  if (saleSignal) return "Sale";
  if (["BUY", "BUYER", "REQUIREMENT", "WANTED"].includes(intent)) {
    if (/\b(rent|rental|lease|tenant)\b/.test(text)) return "Rent";
    return "Buy";
  }
  if (/\b(rent|rental|lease|tenant)\b/.test(text)) return "Rent";
  if (/\b(sale|sell|outright|distress|asking|reserve price|for sale)\b/.test(text)) return "Sale";
  return "";
}

function marketOpportunityLabel(input: { intent?: string; observation_type?: string; side?: string; text?: string }) {
  const kind = inferOpportunityKind(input);
  const side = inferOpportunitySide(input);
  return side ? `${side} ${kind}` : kind;
}

function marketOpportunityColor(_label: string) {
  return "badge-neutral";
}

function formatCurrency(val: number, unit?: string) {
  if (!val) return "—";
  // Normalize value by unit
  let normalized = val;
  if (unit) {
    const u = unit.toLowerCase();
    // A native value in the thousands of crores is not a plausible Mumbai
    // listing and historically indicates an extraction scale error (for
    // example 2.80 Cr persisted as 2800 Cr). Never render that as fact.
    if ((u === "cr" || u === "crore") && val > 1000) return "Price needs review";
    if (u === "cr" || u === "crore") normalized = val * 10000000;
    else if (u === "lac" || u === "lakh" || u === "l") normalized = val * 100000;
    else if (u === "k" || u === "thousand") normalized = val * 1000;
    // "abs" or empty = already in absolute rupees, no multiplier needed
  }
  // Sanity check: flag implausibly low values for commercial/residential
  // ₹<1000 is never a real total price for Mumbai property
  if (normalized < 1000 && unit?.toLowerCase() !== "k") {
    return "Price on request";
  }
  if (normalized >= 10000000) {
    const cr = normalized / 10000000;
    return `₹${cr % 1 === 0 ? cr.toFixed(0) : cr.toFixed(2)} Cr`;
  }
  if (normalized >= 100000) {
    const l = normalized / 100000;
    const lakh = l % 1 === 0 ? l.toFixed(0) : l.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return `₹${lakh} Lakh`;
  }
  if (normalized >= 1000) {
    const thousands = normalized / 1000;
    const formatted = thousands % 1 === 0
      ? thousands.toFixed(0)
      : thousands.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return `₹${formatted} K`;
  }
  return `₹${normalized.toLocaleString("en-IN")}`;
}

function formatAgeDistance(value?: string) {
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

function formatAgeShort(value?: string) {
  if (!value) return "—";
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return "—";
  const age = formatAgeDistance(value);
  if (age === "now") return age;
  const days = Math.floor((Date.now() - ts) / 86400000);
  return days < 1 ? `Fresh · ${age}` : `Older · ${age}`;
}

function marketFreshness(item: Pick<BrokerObservationRow, "first_seen" | "last_seen" | "last_seen_at" | "times_seen">) {
  const latest = item.last_seen || item.last_seen_at;
  if (!latest) return { label: "—", className: "text-zinc-500" };
  const latestTs = new Date(latest).getTime();
  const firstTs = item.first_seen ? new Date(item.first_seen).getTime() : Number.NaN;
  if (Number.isNaN(latestTs)) return { label: "—", className: "text-zinc-500" };

  const latestAgeMs = Date.now() - latestTs;
  const firstAgeMs = Date.now() - firstTs;
  const day = 86400000;
  if (!Number.isNaN(firstTs) && firstAgeMs <= day) {
    return { label: `New · ${formatAgeDistance(latest)}`, className: "text-emerald-300" };
  }
  if (!Number.isNaN(firstTs) && item.times_seen && item.times_seen > 1 && latestAgeMs <= 7 * day) {
    return { label: `Reposted · ${formatAgeDistance(item.first_seen)} old`, className: "text-amber-300" };
  }
  return { label: formatAgeShort(latest), className: "text-zinc-500" };
}

function formatExpiry(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function expiryLabel(item: { expires_at?: string; lifecycle_status?: string }) {
  const date = formatExpiry(item.expires_at);
  if (!date) return null;
  const expired = item.lifecycle_status === "expired" || new Date(item.expires_at as string).getTime() <= Date.now();
  return { date, expired };
}

function formatDateTimeIST(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatFileSize(bytes: number) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function inferAttachmentMediaType(file: File): "image" | "video" | "audio" | "document" {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function normalizeMessageTimestamp(message?: Partial<api.RawMessage> | null) {
  if (!message) return "";
  const candidates = [
    message.timestamp,
    message.latest_message_at,
    message.created_at,
    message.synced_at,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const value = String(raw);
    const date = new Date(value.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return "";
}

function messageDateValue(message?: Partial<api.RawMessage> | null) {
  const normalized = normalizeMessageTimestamp(message);
  return normalized ? new Date(normalized) : null;
}

function messageTimeLabel(message?: Partial<api.RawMessage> | null) {
  const date = messageDateValue(message);
  return date ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Time unavailable";
}

function rawSearchResultToMessage(result: api.RawSearchResult): api.RawMessage {
  const groupName = (result.group_name || "").trim();
  const senderPhone = (result.sender_phone || "").trim();
  const sender = (result.sender || "").trim();
  const isGroup = /@g\.us$/i.test(groupName);
  const conversationName = groupName || sender || senderPhone || "Conversation";

  return {
    id: result.id,
    group_name: isGroup ? groupName : "",
    sender,
    sender_phone: senderPhone,
    chat_id: isGroup ? groupName : undefined,
    chat_type: isGroup ? "group" : "direct",
    chat_name: conversationName,
    conversation_type: isGroup ? "group" : "direct",
    conversation_key: isGroup ? groupName : "",
    conversation_name: conversationName,
    message: result.message || "",
    message_type: "text",
    timestamp: result.timestamp || "",
    created_at: result.timestamp || "",
    source: result.source || "",
    event_id: `search-${result.id}`,
    message_uid: `search-${result.id}`,
    raw_payload: "",
    synced_at: result.timestamp || "",
    pipeline_version: "search-result",
    from_me: false,
  } as api.RawMessage;
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
const URL_OR_SOCIAL_RE = /\b(?:https?:\/\/|www\.|instagram\.com|fb\.com|facebook\.com|youtu\.be|youtube\.com|t\.me|wa\.me|chat\.whatsapp\.com)\b/i;
const SOCIAL_PROMO_RE = /\b(?:follow|insta|instagram|subscribe|like|share|new properties|link in bio|reel|reels)\b/i;

function isExternalOrPromoLine(line: string) {
  return URL_OR_SOCIAL_RE.test(line) || SOCIAL_PROMO_RE.test(line);
}

function isLikelyFirmSignature(line: string) {
  const cleaned = stripEmojis(line).trim();
  if (!FIRM_LINE_RE.test(cleaned)) return false;
  if (isExternalOrPromoLine(cleaned)) return false;
  if (/[?=:/\\]/.test(cleaned)) return false;
  if (cleaned.split(/\s+/).length > 8) return false;
  return /^[A-Z0-9][A-Za-z0-9&.\-\s]+$/.test(cleaned);
}

function cleanMoneyLine(line: string) {
  return stripEmojis(line).replace(/^[^\dA-Za-z]+/, "").replace(/\s+/g, " ").trim();
}

function moneyValueFromLine(line: string) {
  const cleaned = cleanMoneyLine(line)
    .replace(/\b(?:rent|rental|deposit|deposite|security|budget|price|asking|ask|quote|reserve|sale|outright)\b\s*:?\s*/gi, "")
    .trim();
  const match = cleaned.match(/(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?\s*(?:k|l|lac|lacs|lakh|lakhs|cr|crore|crores)?(?:\s*(?:to|-)\s*\d[\d,]*(?:\.\d+)?\s*(?:k|l|lac|lacs|lakh|lakhs|cr|crore|crores)?)?)/i);
  return match ? match[1].trim() : "";
}

function extractMoneySignals(text?: string, label?: string) {
  const lines = (text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result: { rent?: string; deposit?: string; budget?: string; price?: string } = {};
  const bareMoney: string[] = [];
  const grouped: Record<"rent" | "deposit" | "budget" | "price", string[]> = {
    rent: [],
    deposit: [],
    budget: [],
    price: [],
  };
  const addSignal = (kind: keyof typeof grouped, value: string) => {
    const normalized = value.toLowerCase().replace(/\s+/g, "");
    if (!grouped[kind].some((existing) => existing.toLowerCase().replace(/\s+/g, "") === normalized)) {
      grouped[kind].push(value);
    }
  };

  for (const line of lines) {
    const cleaned = cleanMoneyLine(line);
    const lower = cleaned.toLowerCase();
    const value = moneyValueFromLine(cleaned);
    if (!value) continue;
    if (/\b(?:deposit|deposite|security)\b/.test(lower)) addSignal("deposit", value);
    else if (/\b(?:rent|rental)\b/.test(lower)) addSignal("rent", value);
    else if (/\bbudget\b/.test(lower)) addSignal("budget", value);
    else if (/\b(?:price|asking|ask|quote|reserve|sale|outright)\b/.test(lower)) addSignal("price", value);
    else if (/^(?:rs\.?|inr|₹)?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|l|lac|lacs|lakh|lakhs|cr|crore|crores)?$/i.test(cleaned)) {
      bareMoney.push(value);
    }
  }

  if ((label || "").toLowerCase().includes("rent")) {
    if (!grouped.rent.length && bareMoney[0]) addSignal("rent", bareMoney[0]);
    if (!grouped.deposit.length && bareMoney[1]) addSignal("deposit", bareMoney[1]);
  } else if (!grouped.price.length && bareMoney[0]) {
    bareMoney.forEach((value) => addSignal("price", value));
  }

  result.rent = grouped.rent.join(", ");
  result.deposit = grouped.deposit.join(", ");
  result.budget = grouped.budget.join(", ");
  result.price = grouped.price.join(", ");

  return result;
}

function MoneySignalChips({ text, label }: { text?: string; label?: string }) {
  const signals = extractMoneySignals(text, label);
  const items = [
    signals.rent ? ["Rent", signals.rent] : null,
    signals.deposit ? ["Deposit", signals.deposit] : null,
    signals.budget ? ["Budget", signals.budget] : null,
    signals.price && !signals.rent ? ["Price", signals.price] : null,
  ].filter(Boolean) as [string, string][];
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map(([name, value]) => (
        <span
          key={`${name}-${value}`}
          className="rounded border border-white/10 bg-white/[0.035] px-2 py-1 text-[10px] font-semibold text-zinc-200"
        >
          <span className="text-zinc-500">{name}:</span> {value}
        </span>
      ))}
    </div>
  );
}

function normalizeMessageForDedupe(text?: string) {
  return (text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function splitDelimitedListingText(text?: string) {
  const issue = classifyFormatIssue({ message: text || "" });
  if (issue && ["Too compressed", "Mixed listing + requirement"].includes(issue.reason)) return [];

  const rawLines = (text || "").split(/\r?\n/);
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return [];

  const normalizeBoundaryLine = (line: string) => stripEmojis(line).replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const hasPropertyDetails = (value: string) =>
    /\b(?:\d+(?:\.\d+)?\s*(?:BHK|RK)|Commercial|Office|Shop|Godown|Warehouse|Apartment|Villa)\b/i.test(value);
  const hasMoneyDetails = (value: string) =>
    /\b(?:Sale\s*Price|Rent|Budget|Deposit|Asking|Quote|Price|CR|Crore|Lac|Lakh|K)\b/i.test(value);
  const isDirectBoundary = (line: string) =>
    /^(?:\d+(?:\.\d+)?\s*(?:BHK|RK)|Commercial|Office|Shop|Godown|Warehouse)\b/i.test(normalizeBoundaryLine(line));
  const isLocationBoundary = (line: string, index: number) => {
    const cleaned = normalizeBoundaryLine(line);
    if (cleaned.length < 3 || cleaned.length > 60) return false;
    if (/^\d/.test(cleaned)) return false;
    if (/^(?:Sale|Rent|Budget|Deposit|Price|Carpet|Area|Furnished|Unfurnished|Bare|Higher|Lower|Middle|Car|Parking|Park|Open|Well|Spacious|Ready|Possession)\b/i.test(cleaned)) {
      return false;
    }
    if (/^[A-Za-z][A-Za-z\s]+:$/.test(cleaned)) return false;
    const startsWithMarker = /^[^\p{L}\p{N}]/u.test(line.trim());
    const mentionsLocation = /\b(?:road|rd|lane|marg|nagar|west|east|juhu|bandra|andheri|khar|santacruz|bkc|worli|parel|malad|goregaon|thane)\b/i.test(cleaned);
    if (!startsWithMarker && !mentionsLocation) return false;
    const lookahead = lines.slice(index + 1, index + 9).join("\n");
    return hasPropertyDetails(lookahead) && hasMoneyDetails(lookahead);
  };

  const boundaryIndexes: number[] = [];
  lines.forEach((line, index) => {
    if (isDirectBoundary(line) || isLocationBoundary(line, index)) {
      if (boundaryIndexes[boundaryIndexes.length - 1] === index - 1) return;
      boundaryIndexes.push(index);
    }
  });

  if (boundaryIndexes.length < 2) return [];

  const intro = lines.slice(0, boundaryIndexes[0]).join("\n");
  const footerMarkers = /^(?:[A-Z][A-Z\s.&-]{3,}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}:|\+?\d[\d\s/-]{7,})$/;

  return boundaryIndexes
    .map((start, index) => {
      const end = boundaryIndexes[index + 1] ?? lines.length;
      let chunk = lines.slice(start, end);
      if (index === boundaryIndexes.length - 1) {
        while (chunk.length > 4 && footerMarkers.test(chunk[chunk.length - 1])) {
          chunk = chunk.slice(0, -1);
        }
      }
      return [index === 0 ? intro : "", ...chunk].filter(Boolean).join("\n");
    })
    .filter((chunk) => chunk.split("\n").map((line) => line.trim()).filter(Boolean).length >= 3);
}

function formatIssueTag(label: string) {
  return /^(?:Add|Separate)\b/i.test(label) ? label : `Missing ${label.toLowerCase()}`;
}

function MissingDetailsNotice({ issue }: { issue: FormatIssue }) {
  return (
    <div className="mb-2 rounded-md border border-white/10 bg-white/[0.025] px-2.5 py-2 text-left">
      <div className="text-[10px] font-semibold text-zinc-300">Needs details</div>
      <div className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">{issue.detail}</div>
      {issue.missing.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {issue.missing.map((label) => (
            <span key={label} className="badge badge-neutral px-1.5 py-0.5 text-[8px]">
              {formatIssueTag(label)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

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

type BrokerEvidenceItem = {
  type?: string;
  source?: string;
};

type BrokerObservationRow = {
  id?: string | number;
  fingerprint?: string;
  latest_parsed_id?: string | number;
  listing_index?: string | number;
  latest_raw_message_id?: string | number;
  raw_message_id?: string | number;
  raw_message?: string;
  normalized_message?: string;
  source_message?: string;
  source_slice_text?: string;
  summary_title?: string;
  broker_phone?: string;
  broker_name?: string;
  source_notes?: string | null;
  evidence_list?: BrokerEvidenceItem[];
  first_seen?: string;
  last_seen?: string;
  last_seen_at?: string;
  expires_at?: string;
  lifecycle_status?: string;
  observation_type?: string;
  intent?: string;
  asset_type?: string;
  source_schema?: string;
  _typed_table?: string;
  property_type?: string;
  commercial_use_type?: string;
  bhk?: string;
  configuration?: string;
  transaction_type?: string;
  price?: number;
  price_unit?: string;
  price_raw_text?: string;
  budget_min?: number;
  budget_max?: number;
  budget_currency?: string;
  monthly_rent?: number;
  rate?: number;
  price_math?: { rate?: number } | null;
  total_asking_price?: number;
  computed_total_asking_price?: number;
  area_sqft?: number;
  carpet_area_sqft?: number;
  chargeable_area_sqft?: number;
  built_up_area_sqft?: number;
  rent_per_sqft?: number;
  price_per_sqft?: number;
  furnishing?: string;
  location_raw?: string;
  micro_market?: string;
  locality_id?: number;
  locality_match_status?: string;
  locality_sub_locality?: string;
  locality_parent_locality?: string;
  locality_canonical_locality?: string;
  floor_range?: string;
  floor?: string | number;
  wing?: string;
  flat_number?: string;
  car_parking_count?: number;
  tenant_type_preference?: string;
  sharing_allowed?: string | boolean;
  food_preference?: string;
  alternate_intent?: string;
  times_seen?: number;
  building_name?: string;
  building_address?: string;
  needs_review?: boolean;
};

function cleanMarketField(value?: string) {
  const cleaned = stripEmojis(value || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return ["", "UNKNOWN", "NOT SPECIFIED", "NOT_SPECIFIED", "UNSPECIFIED", "NONE", "NULL", "LISTING", "REQUIREMENT", "PROPERTY", "TEXT"].includes(cleaned.toUpperCase())
    ? ""
    : cleaned;
}

function displayPropertyType(value?: string) {
  const cleaned = cleanMarketField(value);
  return /^(residential|commercial|property|real estate)$/i.test(cleaned) ? "" : cleaned;
}

function isCommercialObservation(obs: BrokerObservationRow) {
  return /^commercial$/i.test(cleanMarketField(obs.asset_type))
    || /^commercial_/i.test(String(obs.source_schema || obs._typed_table || ""));
}

function assetTypeLabel(obs: BrokerObservationRow) {
  if (isCommercialObservation(obs)) return "Commercial";
  if (/^residential$/i.test(cleanMarketField(obs.asset_type)) || /^residential_/i.test(String(obs.source_schema || obs._typed_table || ""))) {
    return "Residential";
  }
  return cleanMarketField(obs.asset_type);
}

function observationTransactionType(obs: Pick<BrokerObservationRow, "source_schema" | "_typed_table" | "intent">) {
  const typedTable = String(obs.source_schema || obs._typed_table || "").toLowerCase();
  return typedTable.includes("_rent_")
    ? "rent"
    : typedTable.includes("_sale_")
      ? "sale"
      : cleanMarketField(obs.intent).toLowerCase();
}

function transactionTypeLabel(obs: BrokerObservationRow) {
  // The typed destination is the ingestion source of truth. Legacy
  // transaction_type values can be stale after a schema correction.
  const value = observationTransactionType(obs);
  const isRequirement = String(obs.observation_type || "").toUpperCase() === "REQUIREMENT"
    || String(obs.source_schema || obs._typed_table || "").endsWith("_requirements");
  if (/rent|lease/.test(value)) return "Rent";
  if (/sale|sell|outright/.test(value)) return isRequirement ? "Buy" : "Sale";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function tenantPreferenceLabel(obs: Pick<BrokerObservationRow, "tenant_type_preference" | "sharing_allowed" | "food_preference" | "source_message" | "raw_message" | "source_slice_text">) {
  const structured = cleanMarketField(obs.tenant_type_preference);
  if (structured) return structured;
  const source = `${obs.source_message || ""} ${obs.raw_message || ""} ${obs.source_slice_text || ""}`;
  if (/\bsingle\s+occupancy\b/i.test(source)) {
    const match = source.match(/single\s+occupancy(?:\s+for\s+([^\n*;,|]+))?/i);
    const qualifier = cleanMarketField(match?.[1]);
    return qualifier ? `Single occupancy · ${qualifier}` : "Single occupancy";
  }
  if (obs.sharing_allowed === false || /^no$/i.test(String(obs.sharing_allowed || "").trim())) return "No sharing";
  return "";
}

function commercialTypeLabel(obs: BrokerObservationRow) {
  if (!isCommercialObservation(obs)) return "";
  const value = displayPropertyType(obs.commercial_use_type || obs.property_type);
  if (!/^mixed[\s_-]*use$/i.test(value)) return value;

  // Older rows were defaulted to mixed_use when no subtype was extracted.
  // Show that label only when the source explicitly supports it.
  const source = `${obs.source_message || ""} ${obs.raw_message || ""} ${obs.normalized_message || ""} ${obs.source_slice_text || ""}`;
  return /\bmixed[\s-]*use\b|\bresidential\s*(?:cum|\+|and)\s*commercial\b/i.test(source)
    ? "mixed use"
    : "";
}

function formatBhkLabel(value?: string) {
  const cleaned = cleanMarketField(value);
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return cleaned;
  const number = Number(cleaned);
  return Number.isFinite(number) ? `${number.toString()} BHK` : `${cleaned} BHK`;
}

function normalizeBhkText(value: string) {
  return value.replace(/\b(\d+(?:\.\d+)?)\s*BHK\b/gi, (_match, number: string) => {
    const numeric = Number(number);
    return Number.isFinite(numeric) ? `${numeric.toString()} BHK` : `${number} BHK`;
  });
}

function sourceTextForObservation(obs: {
  raw_message?: string | null;
  source_message?: string | null;
  source_slice_text?: string | null;
  normalized_message?: string | null;
  price_raw_text?: string | null;
}) {
  return `${obs.raw_message || ""} ${obs.source_message || ""} ${obs.source_slice_text || ""} ${obs.normalized_message || ""} ${obs.price_raw_text || ""}`;
}

function explicitPerSqftRate(source: string) {
  const match = source.match(/(?:rent|lease|rate|price)[^\n]{0,24}?(?:₹|rs\.?\s*)?\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*(?:sq\.?\s*ft|sqft)|per\s*(?:sq\.?\s*ft|sqft)|p\.?\s*s\.?\s*f)/i);
  if (!match) return 0;
  const value = Number(String(match[1]).replace(/,/g, ""));
  return Number.isFinite(value) ? value : 0;
}

function explicitMonthlyRentFromSource(source: string) {
  const rent = source.match(
    /\b(?:rent|rental|monthly\s+rent)\b\s*[:=\-]?\s*(?:₹|rs\.?\s*|inr\s*)?([\d,]+(?:\.\d+)?)\s*(cr(?:ore|ores)?|lac(?:s)?|lakh(?:s)?|l|k|thousand(?:s)?)?\b/i,
  );
  const asking = source.match(
    /\basking\b\s*[:=\-]?\s*(?:₹|rs\.?\s*|inr\s*)?([\d,]+(?:\.\d+)?)\s*(cr(?:ore|ores)?|lac(?:s)?|lakh(?:s)?|l|k|thousand(?:s)?)?\b/i,
  );
  const match = rent || asking;
  if (!match) return 0;
  const amount = Number(String(match[1]).replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = String(match[2] || "").toLowerCase().replace(/s$/, "");
  const decimalKMeansLakh = unit === "k" && match[1].includes(".") && amount < 5;
  const multiplier = decimalKMeansLakh ? 100_000
    : unit === "cr" || unit === "crore" ? 10_000_000
    : unit === "lac" || unit === "lakh" || unit === "l" ? 100_000
    : unit === "k" || unit === "thousand" ? 1_000
    : 1;
  return amount * multiplier;
}

function formatObservationPrice(obs: {
  source_schema?: string | null;
  _typed_table?: string | null;
  price?: number | null;
  price_unit?: string | null;
  price_raw_text?: string | null;
  monthly_rent?: number | null;
  total_asking_price?: number | null;
  transaction_type?: string | null;
  intent?: string | null;
  area_sqft?: number | null;
  carpet_area_sqft?: number | null;
  rent_per_sqft?: number | null;
  price_per_sqft?: number | null;
  computed_total_asking_price?: number | null;
  budget_min?: number | null;
  budget_max?: number | null;
  observation_type?: string | null;
  rate?: number | null;
  price_math?: { rate?: number } | null;
  raw_message?: string | null;
  source_message?: string | null;
  source_slice_text?: string | null;
  normalized_message?: string | null;
}) {
  const isRequirement = String(obs.observation_type || "").toUpperCase() === "REQUIREMENT";
  if (isRequirement) {
    const minimum = Number(obs.budget_min) || 0;
    const maximum = Number(obs.budget_max) || 0;
    if (minimum > 0 && maximum > 0 && minimum !== maximum) {
      return `${formatCurrency(minimum, "abs")} – ${formatCurrency(maximum, "abs")}`;
    }
    if (maximum > 0) return formatCurrency(maximum, "abs");
    if (minimum > 0) return formatCurrency(minimum, "abs");
    return "";
  }
  const transaction = observationTransactionType(obs);
  const isRent = /rent|lease/i.test(transaction);
  const source = `${obs.raw_message || ""} ${obs.source_message || ""} ${obs.source_slice_text || ""} ${obs.normalized_message || ""} ${obs.price_raw_text || ""}`;
  const hasPerSqftRentQuote = isRent && /(?:rent|lease)[^\n]{0,80}(?:per\s*sq\.?\s*ft|p\.?\s*s\.?f|\/\s*sq\.?\s*ft)/i.test(source);
  // An explicit monthly total is authoritative. Only derive area × rate when
  // the source did not provide a monthly total; otherwise per-sqft sale/rent
  // rates can overwrite the broker's actual asking rent in the card.
  if (isRent && Number(obs.monthly_rent) > 0 && !hasPerSqftRentQuote) return formatCurrency(Number(obs.monthly_rent), "abs");
  if (isRent && !hasPerSqftRentQuote) {
    const sourceRent = explicitMonthlyRentFromSource(source);
    if (sourceRent > 0) return formatCurrency(sourceRent, "abs");
  }
  const area = Number(obs.carpet_area_sqft || obs.area_sqft);
  const quotedRate = hasPerSqftRentQuote ? explicitPerSqftRate(source) : 0;
  const rate = quotedRate || Number(obs.rate || obs.price_math?.rate || (isRent ? obs.rent_per_sqft : obs.price_per_sqft));
  // A per-sqft quote is a rate, not a monthly total. Do not invent a total
  // when the source does not explicitly state one.
  if (isRent && rate > 0 && hasPerSqftRentQuote) return `${formatCurrency(rate, "abs")} / sqft`;
  if (isRent && area > 0 && rate > 0) return formatCurrency(area * rate, "abs");
  if (!isRent && Number(obs.total_asking_price) > 0) {
    return formatCurrency(Number(obs.total_asking_price), "abs");
  }
  if (Number(obs.computed_total_asking_price) > 0) {
    return formatCurrency(Number(obs.computed_total_asking_price), "abs");
  }
  if (area > 0 && rate > 0) {
    return formatCurrency(area * rate, "abs");
  }
  if (Number(obs.price) > 0) return formatCurrency(Number(obs.price), obs.price_unit || undefined);
  const rawPrice = String(obs.price_raw_text || "").trim();
  return rawPrice && /\d/.test(rawPrice) ? rawPrice : "";
}

function hasObservationPrice(obs: Parameters<typeof formatObservationPrice>[0]) {
  return Boolean(formatObservationPrice(obs));
}

function observationPriceLabel(obs: Parameters<typeof formatObservationPrice>[0]) {
  if (String(obs.observation_type || "").toUpperCase() === "REQUIREMENT") return "Budget";
  const source = `${obs.raw_message || ""} ${obs.source_message || ""} ${obs.source_slice_text || ""} ${obs.normalized_message || ""}`;
  const transaction = observationTransactionType(obs);
  if (/rent|lease/i.test(transaction) && /(?:rent|lease)[^\n]{0,80}(?:per\s*sq\.?\s*ft|p\.?\s*s\.?f|\/\s*sq\.?\s*ft)/i.test(source)) return "Rent rate";
  return /rent|lease/i.test(transaction) ? "Monthly rent" : "Asking price";
}

function comparableBudget(obs: BrokerObservationRow) {
  const isRequirement = String(obs.observation_type || "").toUpperCase() === "REQUIREMENT";
  if (isRequirement) return Number(obs.budget_max || obs.budget_min || 0);
  if (/rent|lease/i.test(observationTransactionType(obs))) {
    return Number(obs.monthly_rent || explicitMonthlyRentFromSource(sourceTextForObservation(obs)) || 0);
  }
  return Number(obs.total_asking_price || obs.computed_total_asking_price || obs.price || 0);
}

function comparableArea(obs: BrokerObservationRow) {
  return Number(obs.carpet_area_sqft || obs.area_sqft || obs.chargeable_area_sqft || obs.built_up_area_sqft || 0);
}

function buildMarketItemTitle(obs: BrokerObservationRow) {
  const source = obs.source_message || obs.raw_message || obs.normalized_message || obs.source_slice_text || "";
  const storedTitle = normalizeBhkText(stripEmojis(cleanMarketField(obs.summary_title))
    .replace(/\s*\|\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim());
  const genericStoredTitle = /^(?:property(?: details extracted)?(?: for (?:sale|rent))?|property opportunity|listing|extracted property|\[?unstructured\]?)(?:\s|$)/i;
  const brokerName = stripEmojis(cleanMarketField(obs.broker_name));
  const broadcastStoredTitle = Boolean(storedTitle && (
    /(?:commercial\s+showcase|direct\s+inventor(?:y|ies)|new\s+arrivals|property\s+updates|market\s+inventory)/i.test(storedTitle) ||
    /\b(?:realtors?|realty|properties|estate)\b/i.test(storedTitle) && (
      !/\d/.test(storedTitle) || /showcase|inventory|arrivals/i.test(storedTitle)
    ) ||
    brokerName && storedTitle.toLowerCase().startsWith(brokerName.toLowerCase()) && !/\d/.test(storedTitle)
  ));
  const structuredSide = inferOpportunitySide({
    intent: obs.intent,
    side: observationTransactionType(obs),
    text: `${obs.summary_title || ""} ${source}`,
  });
  const titleSideConflicts =
    (structuredSide === "Rent" && /\b(?:buy|buying|purchase|purchasing|for\s+sale|sale)\b/i.test(storedTitle)) ||
    (structuredSide === "Sale" && /\b(?:rent|rental|lease|leasing|for\s+rent)\b/i.test(storedTitle));

  // The API's source-grounded title is authoritative when it is specific.
  // Build a synthetic title only when older rows contain a generic placeholder.
  if (storedTitle && !broadcastStoredTitle && !titleSideConflicts && !genericStoredTitle.test(storedTitle) && !/^(?:unknown|not (?:specified|identified|found)|none|null)$/i.test(storedTitle)) {
    return storedTitle;
  }

  const kind = inferOpportunityKind({
    intent: obs.intent,
    observation_type: obs.observation_type,
    text: `${obs.summary_title || ""} ${source}`,
  });
  const side = inferOpportunitySide({
    intent: obs.intent,
    side: observationTransactionType(obs),
    text: `${obs.summary_title || ""} ${source}`,
  });
  if (/^\[image\]$/i.test(source.trim())) {
    return `Image-only property for ${side === "Rent" ? "rent" : "sale"}`;
  }
  const rawConfiguration = cleanMarketField(obs.bhk) || cleanMarketField(obs.configuration);
  const bhk = formatBhkLabel(rawConfiguration);
  // `property_type` is sometimes the broad asset bucket. Do not expose
  // titles such as “3 BHK residential”; use an actual subtype only.
  const propertyType = isCommercialObservation(obs)
    ? commercialTypeLabel(obs)
    : displayPropertyType(obs.property_type);
  const furnishing = cleanMarketField(obs.furnishing).replace(/\bsemi furnished\b/i, "semi-furnished");
  let subject = bhk || propertyType || (isCommercialObservation(obs) ? "commercial property" : "property");
  if (bhk && propertyType && !bhk.toLowerCase().includes(propertyType.toLowerCase())) {
    subject = `${bhk} ${propertyType}`;
  }
  let descriptor = [furnishing.toLowerCase(), subject].filter(Boolean).join(" ");
  if (obs.area_sqft && Number(obs.area_sqft) > 0) {
    descriptor += ` with ${Number(obs.area_sqft).toLocaleString("en-IN")} sqft`;
  }
  const locality = cleanMarketField(obs.micro_market || obs.location_raw);
  const building = cleanSourceBuildingName(obs.building_name, locality);
  const places = [building, locality].filter((place, index, values) => {
    if (!place) return false;
    return !values.slice(0, index).some((existing) =>
      existing.toLowerCase().includes(place.toLowerCase()) || place.toLowerCase().includes(existing.toLowerCase())
    );
  });
  const place = places.join(", ");
  const price = formatObservationPrice(obs);
  const validPrice = price && !/^(?:—|price on request|none|null|undefined|not specified)$/i.test(price.trim()) ? price : "";
  const rent = side === "Rent";
  const isRentRate = observationPriceLabel(obs) === "Rent rate";
  const article = /^[aeiou]/i.test(descriptor) ? "an" : "a";

  let title: string;
  if (kind === "Requirement") {
    title = `Looking to ${rent ? "rent" : "buy"} ${article} ${descriptor}`;
    if (place) title += ` in ${place}`;
    if (validPrice) title += ` with a ${rent ? "monthly " : ""}budget of ${validPrice}`;
  } else {
    title = `${descriptor.charAt(0).toUpperCase()}${descriptor.slice(1)} for ${rent ? "rent" : "sale"}`;
    if (place) title += ` at ${place}`;
    if (validPrice) title += ` for ${validPrice}${rent && !isRentRate ? " per month" : ""}`;
  }

  if (title && !title.includes("|")) return title;
  return normalizeBhkText(stripEmojis(obs.summary_title || "Property opportunity"))
    .replace(/\s*\|\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

type BrokerObservationGroup = {
  key: string;
  rawMessageId?: string | number;
  rawMessageIds: string[];
  representative: BrokerObservationRow;
  observations: BrokerObservationRow[];
  firstSeen?: string;
  lastSeen?: string;
  duplicateCount: number;
};

type OpportunityFilter = "all" | "listings" | "requirements";
type AssetFilter = "all" | "residential" | "commercial";
type TransactionFilter = "all" | "rent" | "sale";

function marketCountLabel({
  searching,
  hasSearch,
  visibleCount,
  searchTotal,
  marketTotal,
  marketTotalScope,
  assetFilter,
  mode,
  isMarketScopedFeed,
}: {
  searching: boolean;
  hasSearch: boolean;
  visibleCount: number;
  searchTotal: number;
  marketTotal: number | null;
  marketTotalScope?: string;
  assetFilter: AssetFilter;
  mode: OpportunityFilter;
  isMarketScopedFeed: boolean;
}) {
  if (searching) return "Searching your market…";
  if (hasSearch) {
    return `Showing ${visibleCount} of ${searchTotal} matching${assetFilter === "all" ? "" : ` ${assetFilter}`} records`;
  }
  if (assetFilter !== "all") {
    const kind = mode === "all" ? "records" : mode;
    if (marketTotal === 0 && visibleCount > 0) {
      return `Showing ${visibleCount} recent ${assetFilter} ${kind} — more may exist`;
    }
    if (marketTotal != null) {
      return `Showing ${visibleCount} of ${marketTotal} recent ${assetFilter} ${kind} — more may exist`;
    }
    return `Showing ${visibleCount} recent ${assetFilter} ${kind} — more may exist`;
  }
  if (marketTotal == null || marketTotalScope === "bounded_recent_market_sample" || (marketTotal === 0 && visibleCount > 0)) {
    return `Showing ${visibleCount} most recent records — more may exist`;
  }
  if (isMarketScopedFeed) return `Showing ${visibleCount} of ${marketTotal} recent records in your selected market`;
  return `Showing ${visibleCount} of ${marketTotal} recent records`;
}

function marketQualityLabel(qualityCounts: {
  sample_total: number;
  visible: number;
  needs_review: number;
  scope?: string;
} | null) {
  if (!qualityCounts || qualityCounts.needs_review <= 0) return null;
  const held = qualityCounts.needs_review;
  return `${held} recent record${held === 1 ? " is" : "s are"} held for verification and not shown as clean inventory`;
}

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
      {labels[config] || "Other configuration"}
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
      {labels[mode] || "Sale terms not specified"}
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
  const areaForRent = Number(parsed.area_sqft ?? parsed.carpet_area_sqft ?? parsed.chargeable_area_sqft) || 0;
  const rentRate = Number(parsed.rate ?? parsed.price_math?.rate ?? parsed.rent_per_sqft) || 0;
  const isRent = /rent|lease/i.test(observationTransactionType(parsed));
  const source = `${parsed.raw_message || ""} ${parsed.source_message || ""} ${parsed.source_slice_text || ""} ${parsed.normalized_message || ""}`;
  const hasPerSqftRentQuote = isRent && /(?:rent|lease)[^\n]{0,80}(?:per\s*sq\.?\s*ft|p\.?\s*s\.?f|\/\s*sq\.?\s*ft)/i.test(source);
  const quotedRate = hasPerSqftRentQuote ? explicitPerSqftRate(source) : 0;
  const price = hasPerSqftRentQuote && quotedRate > 0
    ? `${formatCurrency(quotedRate, "abs")} / sqft`
    : isRent && Number(parsed.monthly_rent) > 0
    ? formatCurrency(Number(parsed.monthly_rent), "abs")
    : parsed.price ? formatCurrency(parsed.price, parsed.price_unit) : null;
  const area = parsed.area_sqft ? `${parsed.area_sqft} sqft` : null;
  const location = parsed.location_raw || parsed.micro_market || null;
  const building = parsed.building_name || null;
  const furnishing = parsed.furnishing || null;
  const bhk = parsed.bhk || null;
  const configuration = parsed.configuration || null;
  const saleMode = parsed.sale_mode || null;
  const rate = quotedRate > 0
    ? `${formatCurrency(quotedRate, "abs")} / sqft`
    : parsed.rate ? formatCurrency(parsed.rate, parsed.rate_unit) : null;
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

const PARSED_FIELD_EXCLUSIONS = new Set([
  "id", "raw_message_id", "tenant_id", "listing_id", "latest_raw_message_id",
  "latest_parsed_id", "broker_phone", "contacts", "raw_payload", "ai_extraction",
  "raw_message", "source_message", "normalized_message", "source_slice_text",
  "fingerprint", "source_fingerprint", "legacy_source_id", "intent", "alternate_intent",
  "property_category", "listing_type", "price_model", "price_unit", "price_basis",
  "availability_status", "deposit_applicable", "furnishing_status", "furnishing_canonical",
  "confidence", "extraction_confidence", "extraction_confidence_score", "field_confidence",
  "locality_confidence", "building_resolution_confidence", "building_context_allowed",
  "needs_review", "observation_type", "times_seen", "first_seen",
  "raw_price_text", "profile_name", "group_name", "broker_id", "building_id",
]);

const PARSED_FIELD_ALLOWLIST = new Set([
  "asset_type", "transaction_type", "summary_title", "building_name", "micro_market", "location_raw", "source_notes",
  "broker_name", "source_schema", "_typed_table", "bhk", "listing_count", "configuration", "area_sqft", "carpet_area_sqft",
  "monthly_rent", "total_asking_price", "rent_per_sqft", "price_per_sqft", "computed_total_asking_price",
  "furnishing", "possession_status", "car_parking_count", "parking", "parking_type", "parking_details",
  "amenities", "building_amenities", "deal_tags", "additional_charges", "deposit_amount", "deposit_months",
  "deposit_raw_text", "lease_term_type", "lease_term_raw_text", "tenant_type", "tenant_type_preference",
  "buyer_type", "building_preferences", "locality_options", "urgency", "special_requirements",
  "property_features", "listing_source", "budget_min", "budget_max", "area_min_sqft", "area_max_sqft",
  "floor", "floor_range", "floor_label", "floor_description", "view", "orientation", "position",
  "project_name", "tower_name", "wing_name", "combined_area_sqft", "rate", "rate_unit",
  "created_at", "updated_at", "last_seen", "last_seen_at", "expires_at", "lifecycle_status",
]);

const PARSED_FIELD_LABELS: Record<string, string> = {
  source_schema: "Record type",
  _typed_table: "Record type",
  listing_count: "Units",
  micro_market: "Location",
  location_raw: "Location",
  area_sqft: "Carpet area",
  carpet_area_sqft: "Carpet area",
  monthly_rent: "Monthly rent",
  total_asking_price: "Total asking price",
  rent_per_sqft: "Rent / sqft",
  price_per_sqft: "Price / sqft",
  computed_total_asking_price: "Calculated total",
  car_parking_count: "Parking",
  tenant_type_preference: "Tenant preference",
  buyer_type: "Buyer type",
  building_preferences: "Building preference",
  locality_options: "Locality options",
  deposit_raw_text: "Deposit terms",
  lease_term_raw_text: "Lease terms",
};

function parsedFieldLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanSourceBuildingName(value?: string, locality?: string) {
  const building = cleanMarketField(value);
  const place = cleanMarketField(locality);
  if (!building || !place || !building.includes("@")) return building;
  const [name, suffix] = building.split(/\s*@\s*/, 2).map((part) => part.trim());
  const normalizedSuffix = suffix.toLowerCase();
  const normalizedPlace = place.toLowerCase();
  return normalizedPlace.includes(normalizedSuffix) || normalizedSuffix.includes(normalizedPlace) ? name : building;
}

const NEARBY_MARKETS: Record<string, string[]> = {
  "bandra": ["Bandra West", "Khar West", "Santacruz West"],
  "bandra west": ["Bandra West", "Khar West", "Santacruz West"],
  "bandra east": ["Bandra East", "Khar West", "Santacruz West"],
  "khar west": ["Khar West", "Bandra West", "Santacruz West"],
  "santacruz west": ["Santacruz West", "Khar West", "Bandra West"],
};

function similarMarketLabels(item: BrokerObservationRow) {
  const market = cleanMarketField(item.micro_market || item.locality_parent_locality || item.locality_canonical_locality || item.location_raw);
  const normalized = market.toLowerCase();
  return NEARBY_MARKETS[normalized] || (market ? [market] : []);
}

function equivalentFieldValues(left: unknown, right: unknown) {
  if (left === right) return true;
  const leftNumber = Number(String(left ?? "").replace(/[, ]/g, ""));
  const rightNumber = Number(String(right ?? "").replace(/[, ]/g, ""));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber === rightNumber;
  const leftDate = new Date(String(left ?? "")).getTime();
  const rightDate = new Date(String(right ?? "")).getTime();
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) return leftDate === rightDate;
  return String(left ?? "").trim() === String(right ?? "").trim();
}

function ParsedFieldGrid({ parsed }: { parsed: any }) {
  const fields = Object.entries(parsed || {}).filter(([key, value]) => {
    if (PARSED_FIELD_EXCLUSIONS.has(key) || !PARSED_FIELD_ALLOWLIST.has(key) || value == null || value === "") return false;
    if (key === "_typed_table" && parsed.source_schema) return false;
    if (key === "source_schema" && parsed._typed_table) return false;
    if (key === "summary_title" && typeof value === "string" && /\b(?:none|null|undefined)\b/i.test(value)) return false;
    if (typeof value === "string" && !cleanMarketField(value)) return false;
    if (typeof value === "boolean" && !value) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return false;
    // These pairs can be populated by different ingestion paths. Deduplicate
    // only when this record actually contains equivalent values.
    if (key === "area_sqft" && parsed.carpet_area_sqft != null && equivalentFieldValues(value, parsed.carpet_area_sqft)) return false;
    if (key === "last_seen" && parsed.last_seen_at != null && equivalentFieldValues(value, parsed.last_seen_at)) return false;
    if (key === "updated_at" && parsed.created_at != null && equivalentFieldValues(value, parsed.created_at)) return false;
    return true;
  });
  if (fields.length === 0) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-white/10 pt-2 sm:grid-cols-3">
      {fields.map(([key, value]) => {
        const rentRate = Number(parsed.rate ?? parsed.price_math?.rate ?? parsed.rent_per_sqft) || 0;
        const rentArea = Number(parsed.area_sqft ?? parsed.carpet_area_sqft ?? parsed.chargeable_area_sqft) || 0;
        const normalizedValue = key === "rent_per_sqft" && rentRate > 0
            ? rentRate
            : value;
        const display = Array.isArray(normalizedValue)
          ? normalizedValue.map((item) => formatListingValue(item)).filter(Boolean).join(", ")
          : typeof normalizedValue === "object"
            ? JSON.stringify(normalizedValue)
            : ["created_at", "updated_at", "last_seen", "last_seen_at", "expires_at"].includes(key)
              ? formatDateTimeIST(String(normalizedValue))
              : formatListingValue(normalizedValue);
        if (!display) return null;
        return (
          <div key={key} className="min-w-0">
            <div className="text-[8px] uppercase tracking-wider text-zinc-600">{PARSED_FIELD_LABELS[key] || parsedFieldLabel(key)}</div>
            <div className="mt-0.5 break-words text-[10px] leading-relaxed text-zinc-300">{display}</div>
          </div>
        );
      })}
    </div>
  );
}

function RentCalculator({ parsed }: { parsed: any }) {
  const toNumber = (value: unknown) => {
    const number = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(number) ? number : 0;
  };
  const initialArea = toNumber(parsed?.area_sqft ?? parsed?.carpet_area_sqft);
  const isRent = /rent|lease/i.test(observationTransactionType(parsed || {}));
  // An explicit monthly total is already authoritative. Showing a second
  // editable-looking calculation invites users to trust a malformed rate.
  if (isRent && toNumber(parsed?.monthly_rent) > 0) return null;
  const initialRate = toNumber(parsed?.rate ?? parsed?.price_math?.rate ?? (isRent ? parsed?.rent_per_sqft : parsed?.price_per_sqft));

  if (!initialArea || !initialRate) return null;

  const total = initialArea * initialRate;
  return (
    <div className="mt-3 border-t border-[#3EE88A]/20 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-[#3EE88A]">{isRent ? "Rent calculator" : "Price calculator"}</div>
          <div className="mt-0.5 text-[10px] text-zinc-500">Carpet area × rate per sqft</div>
        </div>
        <div className="text-sm font-semibold text-[#3EE88A]">₹{total.toLocaleString("en-IN")}{isRent ? " / month" : " total"}</div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
        <label className="flex items-center gap-1.5">
          <span>Area</span>
          <span className="min-w-16 text-right text-xs text-zinc-200">{initialArea.toLocaleString("en-IN")}</span>
          <span>sqft</span>
        </label>
        <span className="text-zinc-700">×</span>
        <label className="flex items-center gap-1.5">
          <span>Rate</span>
          <span>₹</span>
          <span className="min-w-16 text-right text-xs text-zinc-200">{initialRate.toLocaleString("en-IN")}</span>
          <span>/ sqft</span>
        </label>
      </div>
    </div>
  );
}

function BrokerTooltip({ name, phone }: { name: string; phone: string }) {
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

interface InboxPageInnerProps {
  defaultView?: string;
}

function UnifiedMarketInbox() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [searchItems, setSearchItems] = useState<any[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [marketTotal, setMarketTotal] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [corridorLabel, setCorridorLabel] = useState("");
  const [mode, setMode] = useState<"all" | "listings" | "requirements">("all");
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>("all");
  const [includeRequirements, setIncludeRequirements] = useState(false);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [scope, setScope] = useState("your market + the PropAI shared network");
  const [marketPreferences, setMarketPreferences] = useState<api.MarketPreferences | null | undefined>(undefined);
  const [marketInput, setMarketInput] = useState("");
  const [marketSetupDismissed, setMarketSetupDismissed] = useState(false);
  const [savingMarket, setSavingMarket] = useState(false);
  const [contactingId, setContactingId] = useState<string | null>(null);
  const [similarForKey, setSimilarForKey] = useState<string | null>(null);
  const [similarResults, setSimilarResults] = useState<Record<string, BrokerObservationRow[]>>({});
  const [similarLoadingKey, setSimilarLoadingKey] = useState<string | null>(null);
  const [similarError, setSimilarError] = useState<Record<string, string>>({});
  const [contactOptions, setContactOptions] = useState<Record<string, Array<{ index: number; label: string }>>>({});
  const [expandedDetails, setExpandedDetails] = useState<Record<string, any>>({});
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [loadingDetails, setLoadingDetails] = useState<Record<string, boolean>>({});
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateMessage, setCandidateMessage] = useState("");
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  const [clientPickerLoading, setClientPickerLoading] = useState(false);
  const [clients, setClients] = useState<api.Client[]>([]);
  const [clientQuery, setClientQuery] = useState("");
  const selectedRecordsRef = useRef<Record<string, api.MarketCandidateRef>>({});
  const [savedSearches, setSavedSearches] = useState<api.SavedMarketSearch[]>([]);
  const [marketTotalScope, setMarketTotalScope] = useState<string | undefined>(undefined);
  const [marketQualityCounts, setMarketQualityCounts] = useState<api.MarketItemsFeedPage["quality_counts"]>(null);
  const [activeSavedSearchId, setActiveSavedSearchId] = useState<number | null>(null);
  const [savedSearchName, setSavedSearchName] = useState("");
  const [savedSearchBusy, setSavedSearchBusy] = useState(false);
  const [savedSearchMessage, setSavedSearchMessage] = useState("");
  const savedSearchBaselineRef = useRef<Record<number, string | null>>({});
  const savedSearchCursorUpdateRef = useRef<Set<number>>(new Set());
  const [contactQueue, setContactQueue] = useState<any[] | null>(null);
  const [contactQueueIndex, setContactQueueIndex] = useState(0);
  const [contactQueueState, setContactQueueState] = useState<"ready" | "opening" | "opened" | "failed">("ready");
  const [contactQueueError, setContactQueueError] = useState("");
  const itemsRef = useRef<any[]>([]);
  const feedAbortRef = useRef<AbortController | null>(null);

  const marketItemKey = useCallback((item: any) => (
    `${item.source_schema || item._typed_table || ""}:${item.latest_parsed_id || item.id}`
  ), []);

  const marketItemRef = useCallback((item: any): api.MarketCandidateRef => ({
    source_schema: String(item.source_schema || item._typed_table || ""),
    source_id: Number(item.latest_parsed_id || item.id || 0),
  }), []);

  const contactBroker = useCallback(async (item: any, contactIndex?: number) => {
    const listingId = Number(item.id || item.latest_parsed_id || 0);
    if (!listingId) return;
    setContactingId(String(listingId));
    const contactWindow = window.open("", "_blank");
    try {
      const { contact_url } = await api.resolveBrokerContact(
        listingId,
        String(item.source_schema || item._typed_table || "") || undefined,
        Number(item.latest_raw_message_id || item.raw_message_id || 0) || undefined,
        contactIndex,
      );
      if (contactWindow) {
        contactWindow.opener = null;
        contactWindow.location.assign(contact_url);
      } else {
        window.location.assign(contact_url);
      }
    } catch {
      contactWindow?.close();
      setError("The broker contact could not be opened right now.");
    } finally {
      setContactingId(null);
    }
  }, []);

  const findSimilar = useCallback(async (item: BrokerObservationRow) => {
    const key = marketItemKey(item);
    if (similarForKey === key && similarResults[key]) {
      setSimilarForKey(null);
      return;
    }
    setSimilarForKey(key);
    setSimilarLoadingKey(key);
    setSimilarError((current) => ({ ...current, [key]: "" }));
    try {
      const markets = similarMarketLabels(item);
      const intent = observationTransactionType(item);
      const budget = comparableBudget(item);
      const commercial = isCommercialObservation(item);
      const area = comparableArea(item);
      const responses = await Promise.all(markets.map((micro_market) => api.marketSearchListings({
        micro_market,
        intent,
        bhk: cleanMarketField(item.bhk),
        price_min: budget > 0 ? budget * 0.8 : undefined,
        price_max: budget > 0 ? budget * 1.2 : undefined,
        sort_by: "last_seen",
        limit: 30,
        offset: 0,
      })));
      const currentId = marketItemKey(item);
      const rows = responses
        .flatMap((response) => Array.isArray(response?.results) ? response.results : Array.isArray(response) ? response : [])
        .filter((candidate: BrokerObservationRow) => marketItemKey(candidate) !== currentId)
        .filter((candidate: BrokerObservationRow) => !candidate.needs_review)
        .filter((candidate: BrokerObservationRow) => {
          const candidateBudget = comparableBudget(candidate);
          return !budget || !candidateBudget || (candidateBudget >= budget * 0.8 && candidateBudget <= budget * 1.2);
        })
        .filter((candidate: BrokerObservationRow) => {
          if (!commercial || !area) return true;
          const candidateArea = comparableArea(candidate);
          return !candidateArea || (candidateArea >= area * 0.9 && candidateArea <= area * 1.1);
        })
        .reduce<BrokerObservationRow[]>((unique, candidate) => {
          const candidateKey = marketItemKey(candidate);
          if (!unique.some((existing) => marketItemKey(existing) === candidateKey)) unique.push(candidate);
          return unique;
        }, [])
        .sort((left, right) => {
          const leftDate = new Date(String(left.last_seen || left.last_seen_at || left.first_seen || "")).getTime() || 0;
          const rightDate = new Date(String(right.last_seen || right.last_seen_at || right.first_seen || "")).getTime() || 0;
          return rightDate - leftDate;
        })
        .slice(0, 6);
      setSimilarResults((current) => ({ ...current, [key]: rows }));
    } catch {
      setSimilarError((current) => ({ ...current, [key]: "Similar listings could not be loaded right now." }));
      setSimilarResults((current) => ({ ...current, [key]: [] }));
    } finally {
      setSimilarLoadingKey(null);
    }
  }, [marketItemKey, similarForKey, similarResults]);

  const load = useCallback(async () => {
    // Keep the last usable cards rendered while the refresh runs. This makes
    // refresh stale-while-revalidate instead of turning every refresh into a
    // blank blocking state.
    feedAbortRef.current?.abort();
    const controller = new AbortController();
    feedAbortRef.current = controller;
    setLoading(itemsRef.current.length === 0);
    setError("");
    try {
      const getFeedPage = async (...args: Parameters<typeof api.getMarketItemsFeedPage>) => {
        try {
          return await api.getMarketItemsFeedPage(...args);
        } catch {
          // The optional bounded total must never make the inbox unusable.
          // Retry the normal card endpoint and make the count unavailable
          // rather than showing a false number or a blank error state.
          const [limit, offset, brokerKey, signal, resultType, marketLocalities, assetType, intentFilter] = args;
          const items = await api.getMarketItemsFeed(
            limit,
            offset,
            brokerKey,
            signal,
            resultType,
            marketLocalities,
            assetType,
            intentFilter,
          );
          return { items, total: null as number | null, total_scope: "unavailable" };
        }
      };
      const [memberResult, preferences] = await Promise.all([
        api.getCurrentTeamMember().catch(() => null),
        api.getMarketPreferences(),
      ]);
      // Asset filtering is applied to the typed feed after the shared query
      // returns. Load a wider bounded sample so a mixed recent batch does not
      // make Residential or Commercial look artificially empty.
      // Asset filters only need a bounded recent window. Requesting 500 rows
      // fans out across all typed tables and can time out before the chip
      // state is reflected in the UI.
      const feedLimit = assetFilter === "all" ? 50 : 100;
      setMarketPreferences(preferences);
      const member = memberResult;
      if (!preferences?.onboarding_completed || !preferences.primary_localities?.length) {
        // Preserve the existing broker-first experience for workspaces whose
        // own parsed history is already available. Only a genuinely cold
        // workspace is stopped at market setup.
        const brokerKey = member?.linked_broker_phone || "";
        if (brokerKey) {
          const existingBrokerFeed = await getFeedPage(feedLimit, 0, brokerKey, controller.signal, mode, undefined, assetFilter, transactionFilter);
          if (existingBrokerFeed.items.length > 0) {
            itemsRef.current = existingBrokerFeed.items;
            setItems(existingBrokerFeed.items);
            setMarketTotal(existingBrokerFeed.total);
            setMarketTotalScope(existingBrokerFeed.total_scope);
            setMarketQualityCounts(existingBrokerFeed.quality_counts || null);
            setScope(member?.name ? `${member.name}'s market + the PropAI shared network` : "your market + the PropAI shared network");
            return;
          }
        }
        itemsRef.current = [];
        setItems([]);
        setMarketTotal(0);
        setMarketTotalScope(undefined);
        setMarketQualityCounts(null);
        setScope("choose your market to personalize this feed");
        return;
      }
      const marketLocalities = [...preferences.primary_localities, ...(preferences.nearby_localities || [])];
      const workspaceResult = await getFeedPage(feedLimit, 0, undefined, controller.signal, mode, marketLocalities, assetFilter, transactionFilter);
      // Name-based broker scans are expensive and ambiguous. Only an
      // explicit linked broker phone is safe for the broker-first scope;
      // otherwise load the unified workspace feed directly.
      const brokerKey = member?.linked_broker_phone || "";
      // Asset filters describe the selected market, so they must use the
      // workspace market sample rather than narrowing back to the linked
      // broker's own posts. Keep broker-first behavior for the unfiltered
      // feed, where it is useful for the default broker workspace view.
      let resultPage = assetFilter !== "all"
        ? workspaceResult
        : brokerKey
        ? await getFeedPage(feedLimit, 0, brokerKey, controller.signal, mode, marketLocalities, assetFilter, transactionFilter)
        : workspaceResult;
      if (brokerKey && resultPage.items.length === 0) {
        resultPage = workspaceResult;
        setScope("your market + the PropAI shared network");
      } else if (brokerKey) {
        setScope(member?.name ? `${member.name}'s market + the PropAI shared network` : "your market + the PropAI shared network");
      } else {
        setScope("your team + the PropAI shared network");
      }
      const result = resultPage.items;
      itemsRef.current = result;
      setItems(result);
      setMarketTotal(resultPage.total);
      setMarketTotalScope(resultPage.total_scope);
      setMarketQualityCounts(resultPage.quality_counts || null);
      try { window.localStorage.setItem(`propai:last-market-feed:${mode}`, JSON.stringify(result)); } catch { /* storage is optional */ }
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (itemsRef.current.length === 0) setItems([]);
      setError(reason instanceof Error ? reason.message : "Parsed market data could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [assetFilter, mode, transactionFilter]);

  const saveMarket = useCallback(async () => {
    const primary = marketInput.split(",").map((value) => value.trim()).filter(Boolean);
    if (!primary.length) return;
    setSavingMarket(true);
    try {
      const saved = await api.saveMarketPreferences({
        primary_localities: primary,
        nearby_localities: [],
        transaction_types: ["sale", "rent"],
        asset_types: ["residential", "commercial"],
      });
      setMarketPreferences(saved);
      setMarketSetupDismissed(false);
      try { window.localStorage.removeItem("propai:market-setup-dismissed"); } catch { /* storage is optional */ }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Market preferences could not be saved.");
    } finally {
      setSavingMarket(false);
    }
  }, [load, marketInput]);

  useEffect(() => {
    try {
      itemsRef.current = [];
      setItems([]);
      const cached = window.localStorage.getItem(`propai:last-market-feed:${mode}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) { itemsRef.current = parsed; setItems(parsed); }
      }
      setMarketSetupDismissed(window.localStorage.getItem("propai:market-setup-dismissed") === "true");
    } catch { /* ignore an unavailable/corrupt browser cache */ }
    void load();
  }, [load, mode]);

  useEffect(() => {
    void api.getSavedMarketSearches().then(setSavedSearches).catch(() => setSavedSearches([]));
  }, []);

  const saveCurrentSearch = useCallback(async () => {
    const queryText = query.trim();
    if (queryText.length < 2) return;
    const name = savedSearchName.trim() || queryText.slice(0, 80);
    setSavedSearchBusy(true);
    setSavedSearchMessage("");
    try {
      const saved = await api.createSavedMarketSearch(name, queryText, {
        mode,
        asset_filter: assetFilter,
        transaction_filter: transactionFilter,
        include_requirements: includeRequirements,
      });
      setSavedSearches((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setActiveSavedSearchId(saved.id);
      setSavedSearchName("");
      setSavedSearchMessage("Search saved.");
    } catch (reason) {
      setSavedSearchMessage(reason instanceof Error ? reason.message : "Could not save this search.");
    } finally {
      setSavedSearchBusy(false);
    }
  }, [assetFilter, includeRequirements, mode, query, savedSearchName, transactionFilter]);

  const openSavedSearch = useCallback(async (saved: api.SavedMarketSearch) => {
    const filters = saved.filters || {};
    setActiveSavedSearchId(saved.id);
    savedSearchBaselineRef.current[saved.id] = saved.last_seen_record_at || null;
    savedSearchCursorUpdateRef.current.delete(saved.id);
    setQuery(saved.query_text);
    setMode(filters.mode === "listings" || filters.mode === "requirements" ? filters.mode : "all");
    setAssetFilter(filters.asset_filter === "residential" || filters.asset_filter === "commercial" ? filters.asset_filter : "all");
    setTransactionFilter(filters.transaction_filter === "rent" || filters.transaction_filter === "sale" ? filters.transaction_filter : "all");
    setIncludeRequirements(filters.include_requirements === true);
    setSavedSearchMessage(`Opened ${saved.name}.`);
  }, []);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setSearchItems(null);
      setSearchTotal(0);
      setSearching(false);
      setCorridorLabel("");
      return;
    }
    // Do not keep showing the previous feed while this query is being
    // resolved. Those cards are not search results and make a locality query
    // look incorrect (for example Bandra East showing Bandra West).
    setSearchItems([]);
    setSearchTotal(0);
    setCorridorLabel("");
    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setError("");
      try {
        const result = await api.searchMarketItems(normalized, mode, 50, 0, controller.signal, includeRequirements, assetFilter, transactionFilter);
        if (!controller.signal.aborted) {
          setSearchItems(Array.isArray(result.items) ? result.items : []);
          setSearchTotal(Number(result.total || 0));
          setCorridorLabel(
            result.corridor?.resolved
              ? result.corridor.localities.join(" · ")
              : "",
          );
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setSearchItems([]);
          setSearchTotal(0);
          setError(reason instanceof Error ? reason.message : "Market search could not be completed.");
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [assetFilter, includeRequirements, mode, query, transactionFilter]);

  useEffect(() => {
    const saved = savedSearches.find((item) => item.id === activeSavedSearchId);
    if (!saved || !searchItems || !query.trim() || saved.query_text.trim() !== query.trim()) return;
    if (savedSearchCursorUpdateRef.current.has(saved.id)) return;
    const latestRecordAt = searchItems
      .map((item) => String(item.last_seen || item.last_seen_at || item.created_at || ""))
      .filter(Boolean)
      .sort()
      .at(-1);
    if (!latestRecordAt) return;
    savedSearchCursorUpdateRef.current.add(saved.id);
    void api.markSavedMarketSearchViewed(saved.id, latestRecordAt)
      .then((viewed) => setSavedSearches((current) => current.map((item) => item.id === saved.id ? viewed : item)))
      .catch(() => { savedSearchCursorUpdateRef.current.delete(saved.id); });
  }, [activeSavedSearchId, query, savedSearches, searchItems]);

  const loadDetails = useCallback(async (item: any) => {
    const key = `${item.latest_parsed_id || item.id}:${item.source_schema || ""}`;
    if (expandedDetails[key] || loadingDetails[key]) return;
    setLoadingDetails((current) => ({ ...current, [key]: true }));
    try {
      const detail = await api.getMarketItemDetails(
        Number(item.latest_parsed_id || item.id),
        String(item.source_schema || ""),
        Number(item.latest_raw_message_id || item.raw_message_id || 0) || undefined,
      );
      setExpandedDetails((current) => ({ ...current, [key]: detail }));
      const contacts = await api.listBrokerContacts(
        Number(item.latest_parsed_id || item.id),
        String(item.source_schema || ""),
        Number(item.latest_raw_message_id || item.raw_message_id || 0) || undefined,
      );
      setContactOptions((current) => ({ ...current, [key]: contacts.contacts || [] }));
    } finally {
      setLoadingDetails((current) => ({ ...current, [key]: false }));
    }
  }, [expandedDetails, loadingDetails]);

  const searchSelectionKey = `propai:inbox-selection:${query.trim().toLowerCase()}:${mode}:${assetFilter}:${transactionFilter}`;

  useEffect(() => {
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(searchSelectionKey) || "[]");
      setSelectedKeys(new Set(Array.isArray(stored) ? stored : []));
    } catch {
      setSelectedKeys(new Set());
    }
  }, [searchSelectionKey]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(searchSelectionKey, JSON.stringify([...selectedKeys]));
    } catch { /* session persistence is optional */ }
  }, [searchSelectionKey, selectedKeys]);

  const toggleSelected = useCallback((item: any) => {
    const key = marketItemKey(item);
    const ref = marketItemRef(item);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
        delete selectedRecordsRef.current[key];
      } else {
        next.add(key);
        selectedRecordsRef.current[key] = ref;
      }
      return next;
    });
    setCandidateMessage("");
  }, [marketItemKey, marketItemRef]);

  const selectLoadedItems = useCallback((checked: boolean, loadedItems: any[]) => {
    setSelectedKeys((current) => {
      // “Select loaded results” means exactly this visible batch. Do not
      // carry a stale selection from a previous refresh into the save count.
      const next = checked ? new Set<string>() : new Set(current);
      if (checked) selectedRecordsRef.current = {};
      for (const item of loadedItems) {
        const key = marketItemKey(item);
        if (checked) {
          next.add(key);
          selectedRecordsRef.current[key] = marketItemRef(item);
        } else {
          next.delete(key);
          delete selectedRecordsRef.current[key];
        }
      }
      return next;
    });
    setCandidateMessage("");
  }, [marketItemKey, marketItemRef]);

  const visibleItems = useMemo(() => {
    const hasActiveSearch = query.trim().length >= 2;
    const candidates = hasActiveSearch ? (searchItems ?? []) : items;
    return candidates.filter((item) => {
      const isRequirement = item.observation_type === "REQUIREMENT" || String(item.source_schema || "").endsWith("_requirements");
      if (mode === "listings" && isRequirement) return false;
      if (mode === "requirements" && !isRequirement) return false;
      const commercial = isCommercialObservation(item);
      const residential = /^residential$/i.test(cleanMarketField(item.asset_type))
        || /^residential_/i.test(String(item.source_schema || item._typed_table || ""));
      if (assetFilter === "commercial" && !commercial) return false;
      if (assetFilter === "residential" && !residential) return false;
      const transaction = observationTransactionType(item);
      if (transactionFilter !== "all" && transaction !== transactionFilter) return false;
      const source = String(item.source_message || item.raw_message || item.normalized_message || item.source_slice_text || "").trim();
      const hasStructuredDetails = [
        item.building_name, item.micro_market, item.location_raw, item.bhk,
        item.configuration, item.area_sqft, item.price, item.monthly_rent,
        item.total_asking_price, item.furnishing,
      ].some((value) => value !== null && value !== undefined && cleanMarketField(String(value)));
      const invalidSummary = /\b(?:none|null|undefined)\b/i.test(String(item.summary_title || ""));
      // Do not show empty parser/no-anchor rows beside the real image-only or
      // source-backed observation. A broker/time alone is not a listing.
      if (!source && !hasStructuredDetails && (!item.summary_title || invalidSummary)) return false;
      return true;
    });
  }, [assetFilter, items, mode, query, searchItems, transactionFilter]);

  const selectedCandidateRefs = useMemo(() => {
    // Derive refs from the rendered batch as well as the ref cache. The cache
    // is intentionally mutable, so relying on it alone can leave the save
    // callback with an empty list after selections are restored from session
    // storage or after a fresh batch finishes loading.
    const refs = new Map<string, api.MarketCandidateRef>();
    for (const item of visibleItems) {
      const key = marketItemKey(item);
      if (!selectedKeys.has(key)) continue;
      const ref = marketItemRef(item);
      if (ref.source_schema && ref.source_id > 0) refs.set(key, ref);
    }
    for (const key of selectedKeys) {
      const ref = selectedRecordsRef.current[key];
      if (ref?.source_schema && ref.source_id > 0) refs.set(key, ref);
    }
    return [...refs.values()];
  }, [marketItemKey, marketItemRef, selectedKeys, visibleItems]);

  const openClientPicker = useCallback(async () => {
    if (!selectedCandidateRefs.length) {
      setCandidateMessage("Select at least one loaded listing or requirement first.");
      return;
    }
    setClientPickerOpen(true);
    setClientPickerLoading(true);
    try {
      setClients(await api.getClients());
    } catch {
      setCandidateMessage("Clients could not be loaded right now.");
    } finally {
      setClientPickerLoading(false);
    }
  }, [selectedCandidateRefs.length]);

  const attachSelectedToClient = useCallback(async (client: api.Client) => {
    setCandidateBusy(true);
    setCandidateMessage("");
    try {
      const result = await api.addClientCandidates(client.id, selectedCandidateRefs);
      const added = result.added;
      const alreadyAdded = result.already_added;
      setClientPickerOpen(false);
      setCandidateMessage(`${added} record${added === 1 ? "" : "s"} saved for ${client.name}${alreadyAdded ? ` · ${alreadyAdded} already there` : ""}.`);
      setSelectedKeys(new Set());
    } catch (reason) {
      setCandidateMessage(reason instanceof Error ? reason.message : "Could not save these properties for the client.");
    } finally {
      setCandidateBusy(false);
    }
  }, [selectedCandidateRefs]);

  useEffect(() => {
    for (const item of visibleItems) {
      const key = marketItemKey(item);
      if (selectedKeys.has(key)) selectedRecordsRef.current[key] = marketItemRef(item);
    }
  }, [marketItemKey, marketItemRef, selectedKeys, visibleItems]);

  const loadedSelectionCount = visibleItems.filter((item) => selectedKeys.has(marketItemKey(item))).length;
  const allLoadedSelected = visibleItems.length > 0 && loadedSelectionCount === visibleItems.length;
  const selectedVisibleItems = visibleItems.filter((item) => selectedKeys.has(marketItemKey(item)));
  const similarFeedItems = similarForKey ? (similarResults[similarForKey] || []) : null;
  const displayedItems = similarFeedItems || visibleItems;
  const similarAnchor = similarForKey ? visibleItems.find((item) => marketItemKey(item) === similarForKey) : null;
  const similarSearchMarkets = similarAnchor ? similarMarketLabels(similarAnchor) : [];
  const activeSavedSearch = savedSearches.find((item) => item.id === activeSavedSearchId) || null;
  const activeSavedSearchBaseline = activeSavedSearch
    ? (savedSearchBaselineRef.current[activeSavedSearch.id] ?? activeSavedSearch.last_seen_record_at)
    : null;
  const newSavedSearchCount = activeSavedSearchBaseline && searchItems
    ? searchItems.filter((item) => String(item.last_seen || item.last_seen_at || item.created_at || "") > String(activeSavedSearchBaseline)).length
    : 0;

  const startContactQueue = useCallback(() => {
    if (!selectedVisibleItems.length) return;
    setContactQueue(selectedVisibleItems);
    setContactQueueIndex(0);
    setContactQueueState("ready");
    setContactQueueError("");
  }, [selectedVisibleItems]);

  const openQueuedContact = useCallback(async () => {
    const item = contactQueue?.[contactQueueIndex];
    if (!item) return;
    setContactQueueState("opening");
    setContactQueueError("");
    try {
      const { contact_url } = await api.resolveBrokerContact(
        Number(item.id || item.latest_parsed_id || 0),
        String(item.source_schema || item._typed_table || "") || undefined,
        Number(item.latest_raw_message_id || item.raw_message_id || 0) || undefined,
      );
      window.open(contact_url, "_blank", "noopener,noreferrer");
      setContactQueueState("opened");
    } catch (reason) {
      setContactQueueState("failed");
      setContactQueueError(reason instanceof Error ? reason.message : "This broker contact could not be opened.");
    }
  }, [contactQueue, contactQueueIndex]);

  const selectedMarketLabels = useMemo(() => {
    if (!marketPreferences?.onboarding_completed) return [];
    return [...(marketPreferences.primary_localities || []), ...(marketPreferences.nearby_localities || [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }, [marketPreferences]);
  const isMarketScopedFeed = selectedMarketLabels.length > 0 && query.trim().length < 2;

  return (
    <div className="unified-market-inbox market-intelligence-screen flex min-h-[calc(100dvh-44px)] flex-1 flex-col overflow-hidden bg-[#090b0f] text-white">
      <div className="market-feed-header shrink-0 border-b border-white/10 bg-[#0d1117] px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#6B8E63]">Live WhatsApp Feed</div>
            <h1 className="mt-1 text-xl font-semibold">Live Market Feed</h1>
            <p className="mt-1 text-xs text-zinc-500">Fresh listings and buyer requirements from your connected groups and the wider PropAI broker network — including groups you may not be in · {scope}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="border-[var(--line)] bg-transparent text-[var(--mist)] hover:border-[var(--signal-lime)] hover:bg-[var(--surface-hover)]">
            {loading ? "Refreshing..." : "Refresh data"}
          </Button>
        </div>
        <div className={`mt-4 grid gap-2 lg:items-center ${assetFilter === "all" ? "lg:grid-cols-[minmax(0,1fr)_auto]" : "lg:grid-cols-[minmax(0,1fr)_auto_auto]"}`}>
          <div className="relative min-w-[260px] flex-1">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try ‘3 BHK rent between Bandra and Andheri under 3 Lakh’" className="h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] px-3 pr-24 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none focus:border-[var(--signal-lime)]/50" />
            {searching ? <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wider text-[#3EE88A]">Searching…</span> : query.trim().length >= 2 ? <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500">{searchTotal} found</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-[9px] font-bold uppercase tracking-wider text-zinc-600 sm:inline">Asset</span>
            <Tabs value={assetFilter} onValueChange={(value) => { const next = value as "all" | "residential" | "commercial"; if (assetFilter !== next) { setMode("all"); setTransactionFilter("all"); } setAssetFilter(next); }}>
              <TabsList aria-label="Asset type">
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="residential">Residential</TabsTrigger>
                <TabsTrigger value="commercial">Commercial</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {assetFilter !== "all" && <div className="flex items-center gap-2">
            <span className="hidden text-[9px] font-bold uppercase tracking-wider text-zinc-600 sm:inline">Show</span>
            <Tabs value={mode} onValueChange={(value) => { const next = value as "all" | "listings" | "requirements"; setMode(next); setTransactionFilter("all"); }}>
              <TabsList aria-label="Record type">
                <TabsTrigger value="listings">Listings</TabsTrigger>
                <TabsTrigger value="requirements">Requirements</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>}
          {assetFilter !== "all" && mode !== "all" && <div className="flex items-center gap-2">
            <span className="hidden text-[9px] font-bold uppercase tracking-wider text-zinc-600 sm:inline">Deal</span>
            <Tabs value={transactionFilter} onValueChange={(value) => setTransactionFilter(value as "all" | "rent" | "sale")}>
              <TabsList aria-label="Transaction type">
                <TabsTrigger value="rent">Rent</TabsTrigger>
                <TabsTrigger value="sale">Sale</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>}
          {query.trim().length >= 2 && mode !== "requirements" && <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[10px] font-semibold text-zinc-400 hover:border-cyan-300/30 hover:text-zinc-200">
            <input
              type="checkbox"
              checked={includeRequirements}
              onChange={(event) => setIncludeRequirements(event.target.checked)}
              className="h-3.5 w-3.5 accent-cyan-300"
            />
            Include buyer requirements
          </label>}
        </div>
        {query.trim().length >= 2 && <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={savedSearchName} onChange={(event) => setSavedSearchName(event.target.value)} placeholder="Name this search" className="h-8 w-44 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] px-2.5 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none focus:border-cyan-300/40" />
          <Button type="button" variant="outline" size="sm" onClick={() => void saveCurrentSearch()} disabled={savedSearchBusy} className="h-8 border-[var(--monsoon-teal)] px-3 text-[10px] uppercase tracking-wider text-[var(--mist)] hover:bg-[var(--monsoon-teal)]/15">{savedSearchBusy ? "Saving…" : "Save this search"}</Button>
          {savedSearchMessage && <span role="status" className="text-[11px] text-cyan-200">{savedSearchMessage}</span>}
          {activeSavedSearch && newSavedSearchCount > 0 && <span className="rounded-full bg-cyan-300 px-2 py-1 text-[10px] font-bold text-[#061015]">{newSavedSearchCount} new since last viewed</span>}
        </div>}
        {savedSearches.length > 0 && <div className="mt-2 flex max-w-full items-center gap-2 overflow-x-auto pb-1">
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Saved searches</span>
          {savedSearches.map((saved) => <button key={saved.id} type="button" onClick={() => void openSavedSearch(saved)} className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${activeSavedSearchId === saved.id ? "border-cyan-300/50 bg-cyan-300/10 text-cyan-200" : "border-white/10 text-[var(--text-secondary)] hover:border-white/25 hover:text-[var(--text-primary)]"}`}>{saved.name}</button>)}
        </div>}
        {isMarketScopedFeed && <div className="mt-3 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.05] px-3 py-2.5 text-xs text-[var(--text-primary)]" role="note">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-bold uppercase tracking-wider text-[var(--text-secondary)]">Market scope</span>
            <span>Showing the shared broker market for {selectedMarketLabels.join(", ")}.</span>
          </div>
          <p className="mt-1 leading-relaxed text-[var(--text-secondary)]">These are recent records from your selected areas. Search above to explore other localities. “Shared broker market” means the opportunity came from another connected broker source, not your own WhatsApp connection.</p>
        </div>}
        <details className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-zinc-400">
          <summary className="cursor-pointer font-semibold text-zinc-300 hover:text-[#3EE88A]">How to use this market feed</summary>
          <Separator className="my-3 bg-white/10" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><div className="text-[10px] font-bold uppercase tracking-wider text-[#3EE88A]">1. Search</div><p className="mt-1 leading-relaxed">Find a building, locality, broker or BHK across your PropAI market.</p></div>
            <div><div className="text-[10px] font-bold uppercase tracking-wider text-[#3EE88A]">2. Filter</div><p className="mt-1 leading-relaxed">Start with Residential or Commercial. The Listings or Requirements filter appears after you choose an asset type.</p></div>
            <div><div className="text-[10px] font-bold uppercase tracking-wider text-[#3EE88A]">3. Inspect</div><p className="mt-1 leading-relaxed">Open a property to see its details and the original broker message.</p></div>
            <div><div className="text-[10px] font-bold uppercase tracking-wider text-[#3EE88A]">4. Refresh</div><p className="mt-1 leading-relaxed">Refresh after new WhatsApp activity arrives. PropAI combines your connected groups with relevant shared broker activity.</p></div>
          </div>
        </details>
        {!loading && !error && <div className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
          {marketCountLabel({ searching, hasSearch: searchItems !== null, visibleCount: visibleItems.length, searchTotal, marketTotal, marketTotalScope, assetFilter, mode, isMarketScopedFeed })}
          {corridorLabel ? <span className="ml-2 normal-case tracking-normal text-cyan-300">Corridor: {corridorLabel}</span> : null}
        </div>}
        {!loading && !error && searchItems === null && marketQualityCounts && marketQualityCounts.needs_review > 0 && <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-[11px] text-amber-100" role="status">
          <span className="font-semibold">{marketQualityLabel(marketQualityCounts)}.</span>
          <span className="text-amber-100/70">They remain available in review tools; this feed protects you from unverified values.</span>
        </div>}
      </div>

      <main className="unified-market-main min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        {visibleItems.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.04] px-3 py-2.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-zinc-200">
            <input
              type="checkbox"
              checked={allLoadedSelected}
              onChange={(event) => selectLoadedItems(event.target.checked, visibleItems)}
              className="h-4 w-4 accent-cyan-300"
              aria-label="Select all currently loaded results"
            />
            Select loaded results
          </label>
          <span className="text-[11px] text-zinc-500">{loadedSelectionCount} selected in this view · only checked records will be saved</span>
          {selectedCandidateRefs.length > 0 && <Button type="button" size="sm" onClick={() => void openClientPicker()} disabled={candidateBusy} className="h-8 bg-[var(--signal-lime)] px-3 text-[11px] font-bold text-[var(--asphalt)] hover:brightness-105">
            {candidateBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ListPlus className="h-3.5 w-3.5" />}
            {candidateBusy ? "Saving…" : `Save ${selectedCandidateRefs.length} for a client`}
          </Button>}
          {selectedVisibleItems.length > 0 && <Button type="button" variant="outline" size="sm" onClick={startContactQueue} className="h-8 border-[var(--monsoon-teal)] px-3 text-[11px] font-bold text-[var(--mist)] hover:bg-[var(--monsoon-teal)]/15">Open WhatsApp sequence ({selectedVisibleItems.length})</Button>}
          {candidateMessage && <span role="status" className="text-[11px] text-cyan-200">{candidateMessage} {candidateMessage.includes("saved for a client") && <Link href="/clients" className="ml-1 font-semibold underline underline-offset-2">Open Private CRM</Link>}</span>}
        </div>}
        {error && <Alert className="mb-4 border-[var(--alert-vermilion)]/50 bg-[var(--alert-vermilion)]/10 text-[var(--mist)]"><AlertTitle>Market feed unavailable</AlertTitle><AlertDescription className="flex items-center gap-3">{error}<Button type="button" variant="outline" size="sm" onClick={() => void load()} className="h-7 border-[var(--taxi-amber)] text-[var(--taxi-amber)]">Retry</Button></AlertDescription></Alert>}
        {loading ? <div className="grid gap-3 md:grid-cols-2" aria-label="Loading market feed"><Skeleton className="h-56 rounded-xl" /><Skeleton className="h-56 rounded-xl" /></div> : searching ? <div className="flex h-48 items-center justify-center text-sm text-zinc-500">Searching parsed records…</div> : error && visibleItems.length === 0 ? null : (marketPreferences === null || !marketPreferences?.onboarding_completed) && visibleItems.length === 0 && !marketSetupDismissed ? (
          <section className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-[#080808] p-6 sm:p-8">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#3EE88A]">Set your market</div>
            <h2 className="mt-2 text-xl font-semibold text-white">Start with the areas you actually work in</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">We’ll show listings and requirements from these markets first. Add multiple areas separated by commas.</p>
            <label className="mt-5 block text-xs font-semibold text-zinc-300" htmlFor="primary-market">Primary market</label>
            <input id="primary-market" value={marketInput} onChange={(event) => setMarketInput(event.target.value)} placeholder="e.g. Bandra West, Bandra East, BKC" className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black px-3 text-sm text-white outline-none focus:border-[#3EE88A]/50" />
            <p className="mt-2 text-xs text-zinc-500">Examples: Bandra West · Bandra · Bandra East · BKC</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => void saveMarket()} disabled={savingMarket || !marketInput.trim()} className="bg-[var(--signal-lime)] text-[var(--asphalt)]">{savingMarket ? "Saving…" : "Show my market"}</Button>
              <Button type="button" variant="outline" onClick={() => { setMarketSetupDismissed(true); try { window.localStorage.setItem("propai:market-setup-dismissed", "true"); } catch { /* storage is optional */ } }} className="border-white/10 text-zinc-400 hover:bg-white/5 hover:text-white">Not now</Button>
            </div>
          </section>
        ) : (marketPreferences === null || !marketPreferences?.onboarding_completed) && visibleItems.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-zinc-500">
            <p>No {assetFilter === "all" ? "" : `${assetFilter} `}{mode === "all" ? "parsed records" : mode} match your selected market yet.</p>
            <Button type="button" variant="ghost" onClick={() => { setMarketSetupDismissed(false); try { window.localStorage.removeItem("propai:market-setup-dismissed"); } catch { /* storage is optional */ } }} className="mt-3 px-0 text-[var(--signal-lime)] hover:bg-transparent hover:underline">Set your market</Button>
          </div>
        ) : displayedItems.length === 0 ? <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-zinc-500">{similarFeedItems ? (similarLoadingKey === similarForKey ? "Finding recent similar options…" : similarError[similarForKey || ""] || "No recent similar options found in the nearby markets.") : `No ${assetFilter === "all" ? "" : `${assetFilter} `}${mode === "all" ? "parsed records" : mode} match your selected market yet.`}</div> : (
          <>
          {similarFeedItems && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.04] px-4 py-3">
            <div>
              <div className="text-[11px] font-bold text-cyan-100">Recent options similar to {similarAnchor ? buildMarketItemTitle(similarAnchor) : "this listing"}</div>
              <div className="mt-1 text-[10px] text-zinc-400">Rule: {similarAnchor?.bhk ? `${formatBhkLabel(similarAnchor.bhk)} · ` : "same layout · "}{transactionTypeLabel(similarAnchor || {}) || "same transaction type"} · budget ±20%{similarAnchor && isCommercialObservation(similarAnchor) ? " · commercial area ±10%" : ""} · searched {similarSearchMarkets.length ? similarSearchMarkets.join(" · ") : "same market and nearby markets"}</div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setSimilarForKey(null)} className="h-8 rounded-lg border-cyan-300/25 px-3 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-300/10">Back to market feed</Button>
          </div>}
          <div className="market-inbox-grid">
            {displayedItems.map((item) => {
              const isRequirement = item.observation_type === "REQUIREMENT" || String(item.source_schema || "").endsWith("_requirements");
              const expiry = expiryLabel(item);
              const freshness = marketFreshness(item);
              const commercial = isCommercialObservation(item);
              const commercialType = commercialTypeLabel(item);
              const assetType = assetTypeLabel(item);
              const transactionType = transactionTypeLabel(item);
              const tenantPreference = tenantPreferenceLabel(item);
              const locality = cleanMarketField(item.locality_sub_locality || item.micro_market || item.location_raw);
              const parentLocality = cleanMarketField(item.locality_parent_locality || item.locality_canonical_locality);
              const localityHref = locality
                ? entityProfileHref({ type: "locality", text: locality })
                : null;
              const title = buildMarketItemTitle(item);
              const recordHref = marketRecordHref(item, title);
              const buildingName = item.building_name
                ? cleanSourceBuildingName(item.building_name, item.micro_market || item.location_raw)
                : "";
              const buildingHref = buildingName
                ? entityProfileHref({ type: "building", text: buildingName })
                : null;
              return (
                <article key={`${item.latest_raw_message_id || item.raw_message_id || item.id}-${item.listing_index || 0}`}>
                <MarketInboxCard selected={selectedKeys.has(marketItemKey(item))}>
                  <CardHeader className="mb-2 flex-row items-center justify-between gap-3 p-0">
                    <label className="flex cursor-pointer items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-200">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(marketItemKey(item))}
                        onChange={() => toggleSelected(item)}
                        className="h-4 w-4 accent-cyan-300"
                        aria-label={`Select ${buildMarketItemTitle(item)}`}
                      />
                      Select for pipeline
                    </label>
                    <CheckSquare className="h-3.5 w-3.5 text-zinc-700" aria-hidden="true" />
                  </CardHeader>
                  <PillRow className="mb-3" items={[
                    assetType ? { label: assetType, tone: "teal" as const } : null,
                    transactionType ? { label: transactionType, tone: "neutral" as const } : null,
                    isRequirement ? { label: "Requirement", tone: "amber" as const } : null,
                    item.market_scope === "shared" ? { label: "Shared broker market", tone: "teal" as const } : null,
                    tenantPreference ? { label: tenantPreference, tone: "neutral" as const } : null,
                  ].filter((value): value is { label: string; tone: "neutral" | "teal" | "lime" | "amber" | "vermilion" } => Boolean(value))} />
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    {locality && localityHref && <Link href={localityHref} className="market-context-label market-context-link max-w-full truncate" title={`Open ${locality} market intelligence`}>
                      <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{locality}{parentLocality && parentLocality.toLowerCase() !== locality.toLowerCase() && <span className="ml-1 text-zinc-500">· {parentLocality}</span>}</span>
                      <span className="market-context-intel" aria-hidden="true">Details ↗</span>
                    </Link>}
                  </div>
                  <div className="mb-3"><StatusBadge tone={item.needs_review ? "needs-review" : "verified"} /></div>
                  <CardContent className="market-card-content min-w-0 p-0">
                    <div className="market-card-primary">
                      <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <ListingHeadline title={title} className="market-card-title text-base sm:text-[17px]">
                          {recordHref ? <Link href={recordHref} className="hover:text-[var(--monsoon-teal)] hover:underline">{title}</Link> : title}
                        </ListingHeadline>
                        {commercialType && <span className="propai-pill propai-pill-teal shrink-0">{commercialType}</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-zinc-500">
                        {item.broker_name && (brokerDisplayName(item.broker_name) === "Your own"
                          ? <span className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-1.5 py-0.5 font-semibold text-emerald-200">Your own</span>
                          : <span>{brokerDisplayName(item.broker_name)}</span>)}
                        <span className={freshness.className}>{freshness.label}</span>
                        {item.times_seen && item.times_seen > 1 && <span className="text-zinc-500">Seen {item.times_seen}x</span>}
                        {expiry && <span className={expiry.expired ? "font-semibold text-red-300" : "text-amber-300"}>{expiry.expired ? `Expired · ${expiry.date}` : `Expires · ${expiry.date}`}</span>}
                        {item.alternate_intent && <span className="font-semibold text-sky-300">Also available for {item.alternate_intent === "RENT" ? "rent" : "sale"}</span>}
                      </div>
                      {item.source_notes && <p className="mt-2 max-w-2xl rounded-lg border border-amber-300/15 bg-amber-300/[0.04] px-2.5 py-2 text-[11px] leading-relaxed text-amber-100/75"><span className="mr-1 font-semibold uppercase tracking-wider text-[9px] text-amber-200/80">Source note</span>{item.source_notes}</p>}
                      </div>
                      <div className="market-price-highlight rounded-lg border border-emerald-300/15 bg-emerald-300/[0.04] px-3 py-2"><div className="text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">{observationPriceLabel(item)}</div><div className="market-price-value mt-1 whitespace-nowrap"><PriceDisplay value={formatObservationPrice(item)} /></div></div>
                    </div>
                  <div className="market-card-facts mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-zinc-400">
                    {item.bhk && cleanMarketField(item.bhk) && <span><b className="font-medium text-[var(--text-secondary)]">Layout</b> {formatBhkLabel(item.bhk)}</span>}
                    {(item.area_sqft || item.carpet_area_sqft || item.chargeable_area_sqft) && <span><b className="font-medium text-[var(--text-secondary)]">Area</b> {Number(item.area_sqft || item.carpet_area_sqft || item.chargeable_area_sqft).toLocaleString("en-IN")} sqft</span>}
                    {(item.rent_per_sqft || item.price_per_sqft || item.rate || item.price_math?.rate) && <span><b className="font-medium text-[var(--text-secondary)]">Rate</b> ₹{Number(item.rate || item.price_math?.rate || item.rent_per_sqft || item.price_per_sqft).toLocaleString("en-IN")} / sqft</span>}
                    {item.furnishing && cleanMarketField(item.furnishing) && <span><b className="font-medium text-zinc-600">Furnishing</b> {formatListingValue(item.furnishing)}</span>}
                    {tenantPreference && <span><b className="font-medium text-zinc-600">Occupancy</b> {tenantPreference}</span>}
                    {buildingName && <span className="market-card-building inline-flex min-w-0 items-center gap-1.5"><Building2 className="h-3.5 w-3.5 shrink-0 text-[var(--monsoon-teal)]" aria-hidden="true" /><b className="font-medium text-[var(--market-card-muted)]">Building</b>{" "}<Link href={buildingHref!} title="Open building details" className="market-card-building-link font-semibold">{buildingName}</Link><Link href={buildingHref!} title={`Open building details for ${buildingName}`} aria-label={`Open building details for ${buildingName}`} className="market-card-intel-link inline-flex items-center rounded-full border border-[var(--monsoon-teal)]/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">Details <span aria-hidden="true">↗</span></Link></span>}
                  </div>
                  {item.building_address && <div className="market-card-address mt-2 flex min-w-0 items-start gap-2 rounded-md border border-[var(--line)] bg-black/10 px-2.5 py-2 text-[11px] leading-relaxed"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--monsoon-teal)]" aria-hidden="true" /><span><b className="mr-1.5 font-medium text-[var(--market-card-muted)]">Address</b><span>{item.building_address}</span></span></div>}
                  </CardContent>
                  <CardFooter className="mt-3 flex-wrap justify-between gap-2 border-t border-[var(--line)] p-0 pt-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void findSimilar(item)}
                      className="h-9 rounded-lg border-cyan-300/25 px-3.5 text-[11px] font-bold text-cyan-200 hover:bg-cyan-300/10"
                    >
                      Find similar
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void contactBroker(item)}
                      disabled={contactingId === String(item.id || item.latest_parsed_id || "")}
                      className="market-whatsapp-action h-9 rounded-lg px-3.5 text-[11px] font-bold transition-colors disabled:cursor-wait disabled:opacity-50"
                    >
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                      {contactingId === String(item.id || item.latest_parsed_id || "") ? "Opening…" : "Message on WhatsApp"}
                    </Button>
                  </CardFooter>
                  <details
                    className="mt-3 border-t border-white/10 pt-3"
                    open={Boolean(openDetails[`${item.latest_parsed_id || item.id}:${item.source_schema || ""}`])}
                    onToggle={(event) => {
                      const disclosure = event.currentTarget as HTMLDetailsElement;
                      const detailKey = `${item.latest_parsed_id || item.id}:${item.source_schema || ""}`;
                      setOpenDetails((current) => ({ ...current, [detailKey]: disclosure.open }));
                      if (disclosure.open) void loadDetails(item);
                    }}
                  >
                    <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--text-primary)]">View source evidence</summary>
                    {(() => { const detailKey = `${item.latest_parsed_id || item.id}:${item.source_schema || ""}`; const detail = expandedDetails[detailKey]; const contacts = contactOptions[detailKey] || []; return detail ? <>{contacts.length > 1 && <div className="mt-3 border-t border-white/10 pt-3"><div className="text-[9px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">WhatsApp team contacts</div><div className="mt-2 flex flex-wrap gap-2">{contacts.map((contact) => <button key={contact.index} type="button" onClick={() => void contactBroker(item, contact.index)} className="rounded-md border border-emerald-400/30 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-400/10">{contact.label}</button>)}</div></div>}<div className="mt-3 border-t border-white/10 pt-3"><div className="text-[9px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Source evidence slice</div><EvidenceText value={detail.source_slice_text || detail.source_message || detail.raw_message || "Evidence unavailable"} /></div></> : <div className="py-3 text-xs text-[var(--text-secondary)]">{loadingDetails[detailKey] ? "Loading source evidence..." : "Source evidence could not be loaded."}</div>; })()}
                  </details>
                </MarketInboxCard>
                </article>
              );
            })}
          </div>
          </>
        )}
        <Sheet open={clientPickerOpen} onOpenChange={setClientPickerOpen}>
          <SheetContent side="right" className="w-full max-w-md border-l border-[var(--border-subtle)] bg-[var(--ink-2)] text-[var(--mist)]">
            <SheetHeader>
              <SheetTitle>Save properties for a client</SheetTitle>
              <SheetDescription>Select who you want to follow up with. The original WhatsApp evidence stays attached.</SheetDescription>
            </SheetHeader>
            <div className="mt-5 space-y-3">
              <input value={clientQuery} onChange={(event) => setClientQuery(event.target.value)} placeholder="Search clients by name or phone" className="h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] focus:border-[var(--signal-lime)]/50" autoFocus />
              {clientPickerLoading ? <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">Loading clients…</div> : clients.filter((client) => `${client.name} ${client.phone || ""}`.toLowerCase().includes(clientQuery.toLowerCase())).length === 0 ? (
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">No matching clients. Add the client in Private CRM first.</div>
              ) : (
                <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                  {clients.filter((client) => `${client.name} ${client.phone || ""}`.toLowerCase().includes(clientQuery.toLowerCase())).map((client) => (
                    <button key={client.id} type="button" onClick={() => void attachSelectedToClient(client)} disabled={candidateBusy} className="flex w-full items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] px-3 py-3 text-left transition-colors hover:border-[var(--signal-lime)]/50 hover:bg-[var(--surface-hover)] disabled:opacity-50">
                      <span><span className="block text-sm font-semibold text-[var(--text-primary)]">{client.name}</span>{client.phone && <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">{client.phone}</span>}</span>
                      <span className="text-xs font-semibold text-[var(--signal-lime)]">Save here</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
        {contactQueue && <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="WhatsApp contact sequence">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0d1117] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-300">Controlled sequence</div>
                <h2 className="mt-1 text-lg font-semibold text-white">Open selected broker contacts</h2>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">PropAI opens one WhatsApp contact at a time. You confirm each message in WhatsApp before sending.</p>
              </div>
              <button type="button" onClick={() => setContactQueue(null)} className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-white" aria-label="Close contact sequence"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex items-center justify-between text-xs text-zinc-400"><span>Broker {contactQueueIndex + 1} of {contactQueue.length}</span><span>{contactQueueState === "opened" ? "Opened" : contactQueueState === "opening" ? "Opening…" : contactQueueState === "failed" ? "Failed" : "Ready"}</span></div>
              <div className="mt-2 text-sm font-semibold text-white">{buildMarketItemTitle(contactQueue[contactQueueIndex])}</div>
              <div className="mt-1 text-xs text-zinc-500">{cleanMarketField(contactQueue[contactQueueIndex].broker_name) || "Broker contact"} · {cleanMarketField(contactQueue[contactQueueIndex].micro_market || contactQueue[contactQueueIndex].location_raw) || "Market context unavailable"}</div>
            </div>
            {contactQueueError && <div role="alert" className="mt-3 rounded-lg border border-red-300/20 bg-red-300/5 px-3 py-2 text-xs text-red-200">{contactQueueError}</div>}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setContactQueue(null)} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-400 hover:text-white">Done</button>
              {contactQueueState !== "opened" && <button type="button" onClick={() => void openQueuedContact()} disabled={contactQueueState === "opening"} className="rounded-lg bg-emerald-300 px-3 py-2 text-xs font-bold text-[#061015] disabled:opacity-50">{contactQueueState === "opening" ? "Opening…" : "Open WhatsApp"}</button>}
              {contactQueueState === "opened" && contactQueueIndex < contactQueue.length - 1 && <button type="button" onClick={() => { setContactQueueIndex((current) => current + 1); setContactQueueState("ready"); setContactQueueError(""); }} className="rounded-lg bg-emerald-300 px-3 py-2 text-xs font-bold text-[#061015]">Next broker</button>}
            </div>
          </div>
        </div>}
      </main>
    </div>
  );
}

function InboxPageInner({ defaultView }: InboxPageInnerProps) {
  /*
   * Legacy broker workspace implementation retained temporarily for the
   * historical route shape. The live route renders UnifiedMarketInbox below;
   * keep the retired implementation out of the active lint surface until it
   * is removed in a dedicated cleanup.
   */
  /* eslint-disable */
  if (MARKET_INBOX_PAUSED) {
    return (
      <div className="flex h-[calc(100dvh-10rem)] min-h-[420px] w-full items-center justify-center rounded-xl border border-white/10 bg-black px-6 text-center">
        <div className="max-w-md">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-amber-400/30 bg-amber-400/10 text-amber-300">⏸</div>
          <h1 className="text-lg font-semibold text-white">Market Inbox is paused</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            Extraction is paused while the new pipeline is rebuilt. Historical parsed messages and broker records are hidden so this screen cannot imply live inventory.
          </p>
          <Link href="/whatsapp-groups" className="mt-5 inline-flex rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-400/15">
            Open WhatsApp Groups
          </Link>
        </div>
      </div>
    );
  }
  return <UnifiedMarketInbox />;

  const router = useRouter();
  const isMobile = useIsMobile();
  const { toggleDrawer } = useLayout();
  const [mobileView, setMobileView] = useState<"list" | "conversation">("list");

  // Left Panel States
  const [messages, setMessages] = useState<api.InboxThread[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loadingLeft, setLoadingLeft] = useState(true);
  const [offset, setOffset] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<api.RawSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [slugs, setSlugs] = useState<api.SavedView[]>([]);
  const [loadingSlugs, setLoadingSlugs] = useState(true);
  const [currentSlug, setCurrentSlug] = useState<string>(defaultView === "groups" ? "groups" : "brokers");
  const activeSlug = useMemo(() => slugs.find(s => s.slug === currentSlug) || null, [slugs, currentSlug]);
  const [brokerFeed, setBrokerFeed] = useState<any[]>([]);
  const [parsedInboxItems, setParsedInboxItems] = useState<any[]>([]);
  const [loadingParsedInbox, setLoadingParsedInbox] = useState(defaultView !== "groups");
  const [brokerFeedTotal, setBrokerFeedTotal] = useState<number | null>(null);
  const [loadingBrokerFeed, setLoadingBrokerFeed] = useState(defaultView !== "groups");
  const [brokerOffset, setBrokerOffset] = useState(0);
  const [marketAccess, setMarketAccess] = useState<api.MarketAccessStatus | null>(null);
  const [loadingMarketAccess, setLoadingMarketAccess] = useState(true);
  const [marketAccessError, setMarketAccessError] = useState<string | null>(null);
  const [whatsappStatus, setWhatsappStatus] = useState<api.WhatsAppStatus | null>(null);
  const [selectedBrokerObservations, setSelectedBrokerObservations] = useState<any[]>([]);
  const [loadingBrokerObs, setLoadingBrokerObs] = useState(false);
  const [brokerObsError, setBrokerObsError] = useState("");
  const brokerObservationRequestRef = useRef<AbortController | null>(null);
  const [opportunityFilter, setOpportunityFilter] = useState<OpportunityFilter>("all");
  const [now, setNow] = useState(() => Date.now());

  // Selection States
  const [selectedMsg, setSelectedMsg] = useState<api.RawMessage | api.InboxThread | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null);
  
  // Center Panel States
  const [conversationMessages, setConversationMessages] = useState<api.RawMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyAttachment, setReplyAttachment] = useState<File | null>(null);
  const [brokerReplyText, setBrokerReplyText] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [replyStatus, setReplyStatus] = useState("");
  const [replyAccessLoading, setReplyAccessLoading] = useState(true);
  const [canReplyWhatsApp, setCanReplyWhatsApp] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<api.WabaSessionStatus | null>(null);
  const [sessionCountdown, setSessionCountdown] = useState("");
  const [replyDraftLoadedKey, setReplyDraftLoadedKey] = useState("");
  const [currentTeamMember, setCurrentTeamMember] = useState<api.TeamMember | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const withThreadTimeout = async <T,>(promise: Promise<T>, ms = 8000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Thread load timed out")), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const [selectedMsgDetails, setSelectedMsgDetails] = useState<any>(null);
  const [selectedBroker, setSelectedBroker] = useState<any>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<any>(null);
  const [priceStats, setPriceStats] = useState<any>(null);
  const [allSuggestions, setAllSuggestions] = useState<any[]>([]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => {
      window.clearInterval(timer);
      const activeRequest = brokerObservationRequestRef.current;
      brokerObservationRequestRef.current = null;
      activeRequest?.abort();
    };
  }, []);

  useEffect(() => {
    const query = searchText.trim();
    let cancelled = false;
    if (!query) {
      setSearchResults([]);
      setSearchError("");
      setSearchLoading(false);
      return;
    }

    // On the WhatsApp mirror, search is a local conversation-directory filter.
    // It must not call the Market Inbox raw-search endpoint or be blocked by
    // extraction/database health.
    if (window.location.pathname === "/whatsapp-groups") {
      setSearchResults([]);
      setSearchError("");
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    setSearchError("");
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await api.searchRawMessages(query, 25, 0);
          if (cancelled) return;
          setSearchResults(result.results || []);
        } catch (e: any) {
          if (cancelled) return;
          setSearchResults([]);
          setSearchError(e?.message || "Search failed");
        } finally {
          if (!cancelled) setSearchLoading(false);
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchText]);

  useEffect(() => {
    // The WhatsApp Groups route is a raw mirror of joined WhatsApp
    // conversations. It does not use the Market Inbox access gate, and
    // probing that unrelated endpoint here can show a timeout/error even
    // while the group directory is healthy.
    if (typeof window !== "undefined" && ["/whatsapp-groups", "/inbox"].includes(window.location.pathname)) {
      setLoadingMarketAccess(false);
      setMarketAccess(null);
      setMarketAccessError(null);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoadingMarketAccess(true);
      try {
        const access = await api.getMarketAccessStatus();
        if (!cancelled) setMarketAccess(access);
        if (!cancelled) setMarketAccessError(null);
      } catch (e) {
        console.error("Failed to load market access:", e);
        if (!cancelled) {
          setMarketAccess(null);
          setMarketAccessError(
            "Could not verify WhatsApp right now. Wait a moment, or open QR if it keeps failing."
          );
        }
      } finally {
        if (!cancelled) setLoadingMarketAccess(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && ["/whatsapp-groups", "/inbox"].includes(window.location.pathname)) {
      // The raw mirror does not need the dashboard WhatsApp status probe.
      // A slow status service must not block or crash the group directory.
      return;
    }

    let cancelled = false;

    const loadWhatsAppStatus = async () => {
      try {
        const status = await api.getWhatsAppStatus();
        if (!cancelled) setWhatsappStatus(status);
      } catch (e) {
        console.error("Failed to load WhatsApp status:", e);
        if (!cancelled) setWhatsappStatus(null);
      }
    };

    void loadWhatsAppStatus();
    const interval = window.setInterval(() => {
      void loadWhatsAppStatus();
    }, 15000);
    const onStatusUpdate = () => {
      void loadWhatsAppStatus();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) void loadWhatsAppStatus();
    };
    window.addEventListener("propai_whatsapp_status_updated", onStatusUpdate);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("propai_whatsapp_status_updated", onStatusUpdate);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const connectionLock = useMemo(() => {
return {
        title: "WhatsApp not connected",
        description:
        marketAccess?.message ||
          "Wait for WhatsApp to reconnect. If it keeps failing, reopen QR pairing.",
        primaryHref: "/whatsapp?tab=numbers",
        primaryCta: "Open Connection Center",
      };
  }, [marketAccess]);

  const marketLock = useMemo(() => {
    const reason = marketAccess?.reason || "connect_whatsapp";
    if (reason === "sync_pending") {
      return {
        title: "Preparing your market feed",
        description:
          marketAccess?.message ||
          "WhatsApp is connected. PropAI is waiting for the first synced messages before opening Market Inbox.",
        href: "/whatsapp?tab=groups",
        cta: "Review WhatsApp groups",
      };
    }
    return {
      title: "Connect WhatsApp first",
      description:
        marketAccess?.message ||
        "Connect WhatsApp and start your trial to unlock your personalized broker market feed.",
      href: "/whatsapp?tab=numbers",
      cta: "Connect WhatsApp",
    };
  }, [marketAccess]);

  const GATING_ENABLED = false; // Temporary bypass until billing/pricing access is finalized.
  const activeAccessGate = marketAccess?.whatsapp_connected === false ? connectionLock : marketLock;
  const accessHealthGate = useMemo(() => {
    if (marketAccessError) {
      return {
        title: "Checking WhatsApp connection",
        description: marketAccessError,
        primaryHref: "/whatsapp?tab=numbers",
        primaryCta: "Open Connection Center",
      };
    }
    return activeAccessGate;
  }, [activeAccessGate, marketAccessError]);

  const accessProbeFailed = Boolean(marketAccessError);
  const whatsappDisconnected = marketAccess?.whatsapp_connected === false;
  const connectionPending = GATING_ENABLED && (loadingMarketAccess || accessProbeFailed || whatsappDisconnected);

  const groupedBrokerObservations = useMemo(() => {
    const groups = new Map<string, BrokerObservationGroup>();
    for (const obs of selectedBrokerObservations as BrokerObservationRow[]) {
      const rawMessageId = obs.latest_raw_message_id || obs.raw_message_id || obs.id;
      const sourceText = normalizeMessageForDedupe(obs.source_message || obs.normalized_message || obs.raw_message || "");
      const identityParts = [
        obs.observation_type,
        obs.intent,
        observationTransactionType(obs),
        obs.property_type,
        obs.bhk,
        obs.configuration,
        obs.building_name,
        obs.micro_market,
        obs.location_raw,
        obs.price,
        obs.price_unit,
        obs.area_sqft,
        obs.furnishing,
        obs.floor_range,
        obs.floor,
        obs.wing,
        obs.flat_number,
        obs.car_parking_count,
      ].filter(Boolean);
      const structuredSignature = normalizeMessageForDedupe(identityParts.join(" "));
      // Typed-feed rows currently carry an implementation fingerprint such as
      // typed:<id>. That is row identity, not opportunity identity, so it must
      // not prevent reposts from collapsing into one market item.
      // Prefer the exact item slice: two units in one bulk message may share
      // a building and price but are still distinct listings. Fall back to a
      // structured key only when no source text exists and enough identity is
      // present to make a safe comparison.
      const normalizedText = sourceText || (
        identityParts.length >= 5 && (obs.building_name || obs.micro_market || obs.location_raw)
          ? structuredSignature
          : ""
      );
      const brokerKey = normalizeMessageForDedupe(
        [obs.broker_phone, obs.broker_name, selectedBroker?.phone, selectedBroker?.canonical_name].filter(Boolean).join(" ")
      );
      const key = normalizedText
        ? `${brokerKey || "broker"}::${normalizedText}`
        : `${brokerKey || "broker"}::${rawMessageId || "raw"}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          key,
          rawMessageId,
          rawMessageIds: rawMessageId ? [String(rawMessageId)] : [],
          representative: obs,
          observations: [obs],
          firstSeen: obs.first_seen,
          lastSeen: obs.last_seen,
          duplicateCount: 1,
        });
        continue;
      }
      existing.observations.push(obs);
      if (rawMessageId && !existing.rawMessageIds.includes(String(rawMessageId))) {
        existing.rawMessageIds.push(String(rawMessageId));
      }
      existing.duplicateCount = existing.rawMessageIds.length || 1;
      if (obs.last_seen && (!existing.lastSeen || new Date(obs.last_seen).getTime() > new Date(existing.lastSeen).getTime())) {
        existing.lastSeen = obs.last_seen;
        existing.representative = obs;
        existing.rawMessageId = rawMessageId;
      }
      if (obs.first_seen && (!existing.firstSeen || obs.first_seen < existing.firstSeen)) {
        existing.firstSeen = obs.first_seen;
      }
    }
    return [...groups.values()].sort(
      (a, b) => new Date(b.lastSeen || b.representative.last_seen || 0).getTime() - new Date(a.lastSeen || a.representative.last_seen || 0).getTime()
    );
  }, [selectedBroker, selectedBrokerObservations]);

  const isRequirementObservation = useCallback((obs: BrokerObservationRow) => {
    const type = (obs.observation_type || "").toUpperCase();
    if (type === "REQUIREMENT") return true;
    if (type === "LISTING") return false;
    return inferOpportunityKind({
      intent: obs.intent || obs.alternate_intent,
      observation_type: obs.observation_type,
      text: `${obs.summary_title || ""} ${obs.source_message || obs.normalized_message || obs.raw_message || ""}`,
    }) === "Requirement";
  }, []);

  const filteredBrokerObservationGroups = useMemo(() => {
    if (opportunityFilter === "all") return groupedBrokerObservations;
    return groupedBrokerObservations.filter((group) => {
      const isRequirement = isRequirementObservation(group.representative);
      return opportunityFilter === "requirements" ? isRequirement : !isRequirement;
    });
  }, [groupedBrokerObservations, isRequirementObservation, opportunityFilter]);
  
  // Interaction/UI States
  const [revealedPhone, setRevealedPhone] = useState<Record<string, boolean>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionUndo, setActionUndo] = useState<{brokerKeys: string[]; name: string} | null>(null);
  const [openMenuBroker, setOpenMenuBroker] = useState<string | null>(null);
  const autoSelectedThreadRef = useRef<string>("");

  const handleHideBroker = async (phone: string, name = "Broker") => {
    const label = stripDecorativeEmoji(name || "Broker").trim() || "Broker";
    if (!window.confirm(`Block ${label} from this workspace's Market Inbox? Their existing evidence will remain stored, but their market items will be hidden here.`)) return;
    try {
      const res = await api.blockBroker(phone, label, "Blocked from Market Inbox");
      const brokerKeys = (res.blocked || []).map((row: { broker_key?: string }) => String(row.broker_key || "")).filter(Boolean);
      setActionMessage(`Blocked ${label} from this workspace`);
      setActionUndo({ brokerKeys, name: label });
      setBrokerFeed((prev) => prev.filter((b: any) => b.primary_phone !== phone));
      const phoneKey = normalizeRealPhone(phone);
      const nameKey = label.toLowerCase();
      setParsedInboxItems((prev) => prev.filter((item: any) => {
        const itemPhone = normalizeRealPhone(item.broker_phone || "");
        const itemName = String(item.broker_name || item.profile_name || "").trim().toLowerCase();
        return !(phoneKey && itemPhone === phoneKey) && !(nameKey && itemName === nameKey);
      }));
      const selectedBrokerPhone = normalizeRealPhone(selectedBroker?.phone || selectedBroker?.id || "");
      if (selectedBrokerPhone === normalizeRealPhone(phone)) {
        setSelectedBroker(null);
        setSelectedBrokerObservations([]);
        setSelectedMsgDetails(null);
      }
      setTimeout(() => { setActionMessage(null); setActionUndo(null); }, 5000);
    } catch {
      setActionMessage("Could not block this broker");
      setTimeout(() => setActionMessage(null), 3000);
    }
    setOpenMenuBroker(null);
  };

  const handleUnhideBroker = async (brokerKeys: string[]) => {
    try {
      await Promise.all(brokerKeys.map((brokerKey) => api.unblockBroker(brokerKey)));
      setActionMessage("Broker unblocked for this workspace");
      setActionUndo(null);
      await handleRefreshInbox();
      setTimeout(() => setActionMessage(null), 3000);
    } catch {
      setActionMessage("Could not undo the broker block");
      setTimeout(() => setActionMessage(null), 3000);
    }
  };

  // 4. Load detailed analysis, broker, and building data
  const loadMessageDetails = async (
    msgId: number,
    options: { setSelectedRaw?: boolean; preserveProfiles?: boolean } = {}
  ) => {
    if (!options.preserveProfiles) {
      setSelectedBroker(null);
      setSelectedBuilding(null);
    }
    setPriceStats(null);
    let rawMessage: api.RawMessage | null = null;
    try {
      // The inbox evidence endpoint also enriches the message, but a parsed row
      // can disappear or be unavailable while the raw WhatsApp message is
      // still valid. Always load the source text independently so the inbox
      // never falls back to a truncated parsed summary.
      rawMessage = await api.getRawMessage(msgId);
      setSelectedMsgDetails((current: any) => ({ ...(current || {}), raw: rawMessage }));
      if (options.setSelectedRaw && rawMessage) setSelectedMsg(rawMessage);
    } catch (e) {
      console.warn("Failed to load raw WhatsApp message:", e);
    }
    try {
      const details = await api.getInboxEvidence(msgId);
      setSelectedMsgDetails({ ...details, raw: details.raw || rawMessage });
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
      // Raw text has already been loaded above; only the optional enrichment
      // failed. Keep rendering the full source message instead of replacing
      // it with an error or a normalized preview.
      if (!rawMessage) console.error("Failed to load message details:", e);
    }
  };

  const messageAreaRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // URL state for selected message
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const msgParam = searchParams.get("message");
  const brokerParam = searchParams.get("broker");
  const itemParam = searchParams.get("item");
  const isGroupsView = defaultView === "groups" || searchParams.get("view") === "groups" || currentSlug === "groups";

  useEffect(() => {
    if (searchParams.get("view") === "groups") {
      router.replace("/whatsapp?tab=groups");
    }
  }, [searchParams, router]);

  // Sync selected message to URL
  const updateUrlMessage = useCallback((conversationKey: string, msgId: number) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("broker");
    url.searchParams.delete("item");
    url.searchParams.set("conversation", conversationKey);
    url.searchParams.set("message", String(msgId));
    window.history.replaceState({}, "", url.toString());
  }, []);

  const updateUrlBroker = useCallback((phone: string) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("message");
    url.searchParams.delete("conversation");
    url.searchParams.delete("item");
    url.searchParams.set("broker", phone);
    window.history.replaceState({}, "", url.toString());
  }, []);

  const updateUrlItem = useCallback((id: number) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("message");
    url.searchParams.delete("conversation");
    url.searchParams.delete("broker");
    url.searchParams.set("item", String(id));
    window.history.replaceState({}, "", url.toString());
  }, []);

  const updateUrlView = useCallback((slug: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", slug);
    url.searchParams.delete("message");
    url.searchParams.delete("conversation");
    url.searchParams.delete("broker");
    url.searchParams.delete("item");
    setSelectedBroker(null);
    setSelectedBrokerObservations([]);
    setSelectedMsg(null);
    setSelectedMsgDetails(null);
    setConversationMessages([]);
    autoSelectedThreadRef.current = "";
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

  // Auto-navigate to broker or market item from URL params
  const initialNavDone = useRef(false);
  useEffect(() => {
    if (initialNavDone.current) return;
    if (itemParam && parsedInboxItems.length > 0) {
      const itemId = Number(itemParam);
      const parsedItem = parsedInboxItems.find((item) =>
        Number(item.latest_raw_message_id || item.raw_message_id) === itemId
      );
      if (parsedItem) {
        initialNavDone.current = true;
        setCurrentSlug("brokers");
        void selectBroker({
          primary_phone: parsedItem.broker_phone || "",
          canonical_name: parsedItem.broker_name || parsedItem.profile_name || "Broker",
          identity_key: parsedItem.broker_key || parsedItem.broker_phone || `name:${parsedItem.broker_name || parsedItem.profile_name || "broker"}`,
        }, itemId);
        return;
      }
    }
    if (brokerParam && brokerFeed.length > 0) {
      initialNavDone.current = true;
      const brokerParamName = stripEmojis(brokerParam).trim().toLowerCase();
      const brokerParamPhone = normalizeRealPhone(brokerParam);
      const brokerParamKey = brokerParam.trim().toLowerCase();
      const broker = brokerFeed.find((b: any) =>
        (brokerParamKey && String(b.identity_key || b.primary_phone || b.id || "").trim().toLowerCase() === brokerParamKey) ||
        (brokerParamPhone && normalizeRealPhone(b.primary_phone || "") === brokerParamPhone) ||
        b.primary_phone?.includes(brokerParam) ||
        brokerParam.includes(b.primary_phone || "") ||
        (brokerParamName && stripEmojis(b.canonical_name || b.name || "").trim().toLowerCase().includes(brokerParamName))
      );
      if (broker) {
        setCurrentSlug("brokers");
        if (slugs.length > 0 && !slugs.some(s => s.slug === "brokers")) {
          // brokers slug might not exist yet; ensure it's set
        }
        selectBroker(broker);
      } else {
        // The broker no longer exists in this workspace. Do not construct a
        // fake profile; reset the stale deep link and leave the Inbox usable.
        initialNavDone.current = true;
        const url = new URL(window.location.href);
        url.searchParams.delete("broker");
        url.searchParams.delete("item");
        url.searchParams.delete("message");
        url.searchParams.delete("conversation");
        window.history.replaceState({}, "", url.toString());
      }
    } else if (itemParam && Number(itemParam) > 0) {
      initialNavDone.current = true;
      const itemId = Number(itemParam);
      if (!isNaN(itemId)) {
        (async () => {
          // Load the raw message details to discover broker
          const details = await api.getInboxEvidence(itemId);
          // Resolve broker from parsed data and load their market item timeline
          const brokerPhone = details.parsed?.broker_phone;
          const brokerName = details.parsed?.broker_name || details.parsed?.profile_name || details.raw?.sender;
          if (brokerPhone || brokerName) {
            const brokerInFeed = brokerFeed.find((b: any) =>
              (brokerPhone && String(b.identity_key || b.primary_phone || b.id || "").trim().toLowerCase() === brokerPhone.toLowerCase()) ||
              (brokerPhone && b.primary_phone?.includes(brokerPhone)) ||
              (brokerPhone && brokerPhone.includes(b.primary_phone || "")) ||
              (brokerName && b.canonical_name?.toLowerCase().includes(brokerName.toLowerCase()))
            );
            if (brokerInFeed) {
              setCurrentSlug("brokers");
              await selectBroker(brokerInFeed, itemId);
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
    } else if (brokerParam && !loadingBrokerFeed && brokerFeed.length === 0) {
      initialNavDone.current = true;
      // The feed has finished loading with no contactable brokers, so a
      // broker URL cannot resolve. Keep the workspace on a clean Inbox URL.
      const url = new URL(window.location.href);
      url.searchParams.delete("broker");
      url.searchParams.delete("item");
      url.searchParams.delete("message");
      url.searchParams.delete("conversation");
      window.history.replaceState({}, "", url.toString());
    }
  }, [brokerParam, itemParam, brokerFeed, parsedInboxItems, slugs, loadingBrokerFeed]);

  // 1. Initial Load of Feed & Suggestions
  const loadFeed = useCallback(async (append = false, requestedOffset = offset) => {
    setLoadingLeft(true);
    const isWhatsAppGroupsRoute = typeof window !== "undefined" && window.location.pathname === "/whatsapp-groups";
    // The raw WhatsApp mirror must never depend on the Market Inbox feed.
    // Start this independently: a broker-feed timeout or parsing failure must
    // not make groups/broadcasts vanish from the user-facing WhatsApp view.
    if (!append) {
      void api.getWhatsAppConversations()
        .then((directory) => setGroups(directory))
        .catch((reason) => {
          console.error("Failed to load WhatsApp conversation directory:", reason);
        });
    }
    try {
      const threadMsgs = await api.getInboxThreads(PAGE_SIZE, requestedOffset);
      setMessages((prev) => (append ? [...prev, ...threadMsgs] : threadMsgs));
      if (!append && !isWhatsAppGroupsRoute && typeof window !== "undefined" && window.location.pathname !== "/inbox") {
        const suggestionResult = await Promise.allSettled([api.getSuggestions("pending", 100)]);
        if (suggestionResult.status === "fulfilled") {
          setAllSuggestions(suggestionResult.value[0]);
        } else {
          console.error("Failed to load inbox suggestions:", suggestionResult.reason);
        }
      }
    } catch (e) {
      console.error("Failed to load feed:", e);
      // Do not fall back to raw WhatsApp messages here.  Market Inbox is a
      // parsed broker feed; the raw mirror lives on /whatsapp-groups and raw
      // messages are loaded only as evidence after selecting a parsed item.
      if (!append) {
        setMessages([]);
        setAllSuggestions([]);
      }
    } finally {
      setLoadingLeft(false);
    }
  }, [marketAccess, offset]);

  useEffect(() => {
    if (typeof window === "undefined" || window.location.pathname !== "/inbox") return;

    const refreshFeed = () => {
      if (document.hidden || loadingLeft || connectionPending) return;
      void loadFeed(false, offset);
    };

    const interval = window.setInterval(refreshFeed, 30000);
    const onVisibilityChange = () => {
      if (!document.hidden) refreshFeed();
    };
    const onFocus = () => refreshFeed();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [connectionPending, loadFeed, loadingLeft, offset]);

  const resetSelectionForPageChange = useCallback(() => {
    autoSelectedThreadRef.current = "";
    setSelectedBroker(null);
    setSelectedBrokerObservations([]);
    setSelectedMsg(null);
    setSelectedMsgDetails(null);
    setConversationMessages([]);
  }, []);

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
    if (connectionPending) return;
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      prevOffsetRef.current = offset;
      loadFeed(false);
    } else if (offset !== prevOffsetRef.current) {
      prevOffsetRef.current = offset;
      loadFeed(isMobile && offset > 0);
    }
  }, [isMobile, connectionPending, offset, loadFeed]);

  // Fetch available slugs (saved views) for the inbox tabs
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingSlugs(true);
      try {
        const data = (await api.getInboxSlugs()).filter((s) => s.view_type === "brokers" || s.slug === "brokers");
        if (cancelled) return;
        setSlugs(data);
        const viewFromUrl = defaultView || searchParams.get("view");
        setCurrentSlug((previousSlug) => {
          if (viewFromUrl === "groups") return "groups";
          if (viewFromUrl === "brokers" && data.some((s) => s.slug === viewFromUrl)) return viewFromUrl;
          if (data.length > 0 && !data.some((s) => s.slug === previousSlug)) {
            return (data.find((s) => s.is_default) || data[0]).slug;
          }
          return "brokers";
        });
      } catch (e) {
        console.error("Failed to load inbox slugs:", e);
      } finally {
        if (!cancelled) setLoadingSlugs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defaultView, pathname, searchParams]);

  const loadBrokerFeed = useCallback(async (requestedOffset = brokerOffset) => {
    if (connectionPending) {
      setBrokerFeed([]);
      return;
    }
    setLoadingBrokerFeed(true);
    try {
      const response = await api.getBrokersFeed(BROKER_PAGE_SIZE, requestedOffset, true);
      const items = Array.isArray(response) ? response : (response.items || []);
      if (Array.isArray(response)) {
        setBrokerFeed(items);
        setBrokerFeedTotal(null);
      } else {
        setBrokerFeed(items);
        setBrokerFeedTotal(Number.isFinite(response.total) ? response.total : null);
      }
      if (selectedBroker && items.length > 0) {
        const selectedPhone = normalizeRealPhone(selectedBroker.phone || selectedBroker.primary_phone || selectedBroker.identity_key || selectedBroker.id || "");
        const selectedKey = (selectedBroker.identity_key || selectedBroker.id || selectedBroker.phone || selectedPhone || "").toString().trim().toLowerCase();
        const refreshed = items.find((broker: any) => {
          const brokerPhone = normalizeRealPhone(broker.primary_phone || broker.phone || broker.identity_key || broker.id || "");
          const brokerKey = (broker.identity_key || broker.id || broker.primary_phone || brokerPhone || "").toString().trim().toLowerCase();
          return (
            (selectedPhone && brokerPhone && selectedPhone === brokerPhone) ||
            (selectedKey && brokerKey && selectedKey === brokerKey)
          );
        });
        if (refreshed) {
          setSelectedBroker((current: any) => (current ? { ...current, ...refreshed } : current));
        }
      }
    } catch (e) {
      console.error("Failed to load broker feed:", e);
    } finally {
      setLoadingBrokerFeed(false);
    }
  }, [brokerOffset, connectionPending, selectedBroker]);

  const loadParsedInboxItems = useCallback(async () => {
    if (connectionPending || (typeof window !== "undefined" && window.location.pathname !== "/inbox")) return;
    setLoadingParsedInbox(true);
    try {
      const linkedPhone = currentTeamMember?.linked_broker_phone || currentTeamMember?.phone || "";
      const linkedName = currentTeamMember?.name || "";
      const brokerKey = linkedPhone || (linkedName ? `name:${linkedName}` : "");
      let items = await api.getMarketItemsFeed(200, 0, brokerKey || undefined);
      // A missing/stale broker link must not make the Inbox appear empty.
      if (brokerKey && items.length === 0) {
        items = await api.getMarketItemsFeed(200, 0);
      }
      setParsedInboxItems(items);
    } catch (error) {
      console.error("Failed to load parsed Inbox items:", error);
      setParsedInboxItems([]);
    } finally {
      setLoadingParsedInbox(false);
    }
  }, [connectionPending, currentTeamMember]);

  useEffect(() => {
    void loadParsedInboxItems();
  }, [loadParsedInboxItems]);

  const refreshSelectedBrokerObservations = useCallback(async () => {
    if (connectionPending || !selectedBroker) return;

    const brokerPhone = normalizeRealPhone(
      selectedBroker.primary_phone || selectedBroker.phone || selectedBroker.identity_key || selectedBroker.id || ""
    );
    const rawBrokerName = stripDecorativeEmoji(selectedBroker.canonical_name || selectedBroker.name || "").trim();
    const brokerName = isLikelyBrokerDisplayName(rawBrokerName) ? rawBrokerName : "";
    const brokerIdentityKey = (selectedBroker.identity_key || selectedBroker.id || selectedBroker.primary_phone || brokerPhone || brokerName || "").toString().trim();

    brokerObservationRequestRef.current?.abort();
    const request = new AbortController();
    brokerObservationRequestRef.current = request;
    setBrokerObsError("");
    setLoadingBrokerObs(true);

    try {
      const itemKey = brokerPhone
        || (/^name:/i.test(brokerIdentityKey) ? brokerIdentityKey : "")
        || (brokerName ? `name:${brokerName}` : brokerIdentityKey);
      const items = await api.getMarketItemsFeed(200, 0, itemKey, request.signal);
      if (request.signal.aborted || brokerObservationRequestRef.current !== request) return;
      setSelectedBrokerObservations(items);
      const rawId = items?.[0]?.latest_raw_message_id || items?.[0]?.raw_message_id;
      if (rawId) {
        loadMessageDetails(rawId, { setSelectedRaw: true, preserveProfiles: true });
      }
    } catch (e) {
      if (request.signal.aborted || brokerObservationRequestRef.current !== request) return;
      console.error("Failed to refresh broker market items:", e);
      setBrokerObsError("Market items could not be refreshed. Please retry.");
    } finally {
      if (brokerObservationRequestRef.current === request) {
        setLoadingBrokerObs(false);
        brokerObservationRequestRef.current = null;
      }
    }
  }, [connectionPending, loadMessageDetails, selectedBroker]);

  const handleRefreshInbox = useCallback(async () => {
    await Promise.all([
      loadFeed(false, offset),
      loadBrokerFeed(brokerOffset),
      loadParsedInboxItems(),
      refreshSelectedBrokerObservations(),
    ]);
  }, [brokerOffset, loadBrokerFeed, loadFeed, loadParsedInboxItems, offset, refreshSelectedBrokerObservations]);

  // The broker view is the primary Market Inbox surface. Keep it in sync with
  // newly parsed WhatsApp observations; the generic thread poll above does not
  // update this list because it is a separate parsed broker endpoint.
  useEffect(() => {
    if (typeof window === "undefined" || window.location.pathname !== "/inbox") return;
    if (connectionPending) return;
    const brokerViewActive = activeSlug?.view_type === "brokers" || (!activeSlug && currentSlug === "brokers");
    if (!brokerViewActive) return;

    const refreshBrokerView = () => {
      if (document.hidden || loadingBrokerFeed) return;
      void loadBrokerFeed(brokerOffset);
      void loadParsedInboxItems();
      if (selectedBroker) void refreshSelectedBrokerObservations();
    };

    const interval = window.setInterval(refreshBrokerView, 30000);
    const onVisibilityChange = () => {
      if (!document.hidden) refreshBrokerView();
    };
    const onFocus = () => refreshBrokerView();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [
    activeSlug,
    brokerOffset,
    connectionPending,
    currentSlug,
    loadBrokerFeed,
    loadParsedInboxItems,
    loadingBrokerFeed,
    refreshSelectedBrokerObservations,
    selectedBroker,
  ]);

  // Load broker feed when switching to a slug whose view_type needs brokers feed
  const prevBrokerOffsetRef = useRef(0);
  const brokerInitialLoadDone = useRef(false);
  useEffect(() => {
    if (connectionPending) return;
    const brokerViewActive = activeSlug?.view_type === "brokers" || (!activeSlug && currentSlug === "brokers");
    if (!brokerViewActive) return;
    if (!brokerInitialLoadDone.current) {
      brokerInitialLoadDone.current = true;
      prevBrokerOffsetRef.current = brokerOffset;
      loadBrokerFeed(brokerOffset);
      return;
    }
    if (brokerOffset !== prevBrokerOffsetRef.current) {
      prevBrokerOffsetRef.current = brokerOffset;
      loadBrokerFeed(brokerOffset);
    }
  }, [activeSlug, brokerOffset, connectionPending, currentSlug, loadBrokerFeed]);

  // Scroll to bottom of conversation thread when new messages arrive
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversationMessages]);

  // Helper formatting functions
  const maskPhoneString = (phone: string) => {
    const digits = normalizeRealPhone(phone);
    if (digits.length < 4) return "Phone unavailable";
    return `••••••${digits.slice(-4)}`;
  };

  const displayPhoneString = (phone: string) => {
    const local = normalizeRealPhone(phone);
    if (!local) return "";
    return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
  };

  const threadKeyFor = (msg?: Partial<api.InboxThread | api.RawMessage> | null) => {
    if (!msg) return "";
    return (
      (msg as Partial<api.InboxThread>).conversation_key ||
      (msg as Partial<api.InboxThread>).chat_id ||
      msg.sender_jid ||
      msg.sender_phone ||
      msg.group_name ||
      (msg.id ? String(msg.id) : "")
    );
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

  const isGroupJidLike = (value?: string) => {
    const text = (value || "").trim();
    return /@g\.us$/i.test(text) || /@newsletter$/i.test(text);
  };

  const conversationTypeFor = (msg: Partial<api.InboxThread | api.RawMessage>) => {
    return ((msg.chat_type || msg.conversation_type || "") as string).trim().toLowerCase();
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
    return stripDecorativeEmoji(text);
  };

  const displayChatTitle = (msg: api.InboxThread | api.RawMessage) => {
    const conversationName = msg.chat_name || ("conversation_name" in msg ? msg.conversation_name : "");
    const rawConversation = conversationName || msg.group_name;
    const brokerName = (msg.broker_name || "").trim();
    if (brokerName) return brokerName;
    const explicitType = conversationTypeFor(msg);
    const isExplicitDirect = explicitType === "direct";
    const isExplicitGroup = explicitType === "group";
    if (isExplicitDirect) {
      const sender = (msg.sender || "").trim();
      const phone = resolveMessagePhone(msg);
      if (isRawWhatsAppId(sender)) return displayPhoneString(phone) || "Direct Message";
      if (isLikelyBrokerDisplayName(sender)) return stripDecorativeEmoji(sender);
      return displayPhoneString(phone) || "Direct Message";
    }
    const knownGroupName = resolveKnownGroupName(rawConversation);
    if (knownGroupName && !isExplicitDirect) return knownGroupName;
    if (isExplicitGroup && rawConversation) return displayGroupName(rawConversation);
    const sender = (msg.sender || "").trim();
    const phone = resolveMessagePhone(msg);
    if (isRawWhatsAppId(sender)) return displayPhoneString(phone) || "Direct Message";
    if (isLikelyBrokerDisplayName(sender)) return stripDecorativeEmoji(sender);
    const group = displayGroupName(rawConversation);
    return group || displayPhoneString(phone) || "Direct Message";
  };

  const getWaLink = (phone: string) => {
    const digits = normalizeRealPhone(phone);
    return digits ? `https://wa.me/91${digits}` : "#";
  };

  const getWaLinkWithRecall = (phone: string, extractedText: string) => {
    const digits = normalizeRealPhone(phone);
    if (!digits) return "#";
    const normalized = `91${digits}`;
    const cleanText = extractedText.trim();
    if (!cleanText) return getWaLink(phone);
    const recallMessage = `Hi, I found this on PropAI Live:\n\n${cleanText}\n\nIs this still available?`;
    const safe = recallMessage.replace(/[\uD800-\uDFFF]/g, "");
    try {
      return `https://wa.me/${normalized}?text=${encodeURIComponent(recallMessage)}`;
    } catch {
      return `https://wa.me/${normalized}?text=${encodeURIComponent(safe)}`;
    }
  };

  const isRealPhoneDigits = (value?: string) => {
    const raw = (value || "").trim();
    if (!raw || /[xX*•]/.test(raw)) return false;
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 10) return /^[6-9]\d{9}$/.test(digits);
    if (digits.length === 12 && digits.startsWith("91")) return /^[6-9]\d{9}$/.test(digits.slice(-10));
    if (digits.length === 11 && digits.startsWith("0")) return /^[6-9]\d{9}$/.test(digits.slice(-10));
    return false;
  };

  const normalizeRealPhone = (value?: string) => {
    const raw = (value || "").trim();
    if (!isRealPhoneDigits(raw)) return "";
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(-10);
    if (digits.length === 11 && digits.startsWith("0")) return digits.slice(-10);
    return digits;
  };

  const extractPhoneFromText = (text?: string) => {
    const raw = text || "";
    const matches = raw.match(/(?:\+?91[\s-]?)?[6-9]\d(?:[\s-]?\d){8}/g) || [];
    for (const match of matches) {
      const phone = normalizeRealPhone(match);
      if (phone) return phone;
    }
    return "";
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
    const bodyPhone = extractPhoneFromText(
      [msg.message].filter(Boolean).join("\n")
    );
    if (bodyPhone) return bodyPhone;
    return (
      phoneFromJid(msg.sender_jid) ||
      phoneFromJid(msg.group_name) ||
      phoneFromJid((msg as Partial<api.InboxThread>)?.chat_id) ||
      phoneFromJid((msg as Partial<api.InboxThread>)?.conversation_key)
    );
  };

  const isLikelyGroupConversation = (msg: Partial<api.InboxThread | api.RawMessage>) => {
    // The remote JID is WhatsApp's source of truth. Some historical rows
    // were decorated as direct using their sender, but `@g.us` can never be
    // a direct conversation and must win over that stale classification.
    if ([msg.chat_id, msg.conversation_key, msg.group_name].some((value) => isGroupJidLike(value || ""))) {
      return true;
    }
    const explicitType = conversationTypeFor(msg);
    if (explicitType === "direct") return false;
    if (explicitType === "group") return true;
    return isGroupJidLike(msg.group_name || msg.chat_id || msg.conversation_key || "");
  };

  const inferredMessageIntent = (msg?: Partial<api.RawMessage> | null) => {
    const text = (msg?.message || "").toLowerCase();
    if (!text) return "";
    if (/\b(requirement|required|wanted|looking|need|client wants|buyer|tenant|lease requirement|rent requirement)\b/.test(text)) {
      return "BUY";
    }
    if (/\b(rent|rental|lease|leave\s*&\s*license|l\s*&\s*l)\b/.test(text)) {
      return "RENT";
    }
    if (/\b(available|for sale|distress sale|outright|rent|lease|asking|price|carpet|bhk|sq\.?ft|inspection)\b/.test(text)) {
      return "SELL";
    }
    return "";
  };

  const intentLabelFor = (intent?: string) => {
    const intentUpper = (intent || "").toUpperCase();
    if (intentUpper === "SELL") return "Listing";
    if (intentUpper === "BUY") return "Requirement";
    if (intentUpper === "RENT") return "Rental";
    if (intentUpper === "COMMERCIAL") return "Commercial";
    return intent || "";
  };

  const resolveMessageSenderName = (msg?: Partial<api.RawMessage> | null) => {
    if (!msg) return "";
    if (msg.from_me === 1 || msg.from_me === true || msg.sender === "seed-bot" || msg.sender === "system" || msg.sender === "owner") return "You";
    const phone = resolveMessagePhone(msg);
    const sender = (msg.sender || "").trim();
    if (isLikelyBrokerDisplayName(sender) && !isRawWhatsAppId(sender)) {
      return stripDecorativeEmoji(msg.broker_name || sender);
    }
    return stripDecorativeEmoji(msg.broker_name || (phone ? displayPhoneString(phone) : ""));
  };

  const appendBrokerSignature = (text: string, brokerName?: string, brokerPhone?: string) => {
    const cleanText = String(text || "").trim();
    const name = stripDecorativeEmoji(brokerName || "").trim();
    const phone = normalizeRealPhone(brokerPhone) || "";
    if (!cleanText || (!name && !phone)) return cleanText;

    const normalizedText = normalizeMessageForDedupe(cleanText);
    const signatureParts = [name, phone ? displayPhoneString(phone) : ""].filter(Boolean);
    const signature = `Broker: ${signatureParts.join(" | ")}`;
    const hasSignature = normalizedText.includes(normalizeMessageForDedupe(signature));
    if (hasSignature) return cleanText;
    return `${cleanText}\n\n${signature}`;
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
      if (isLikelyFirmSignature(cleaned)) {
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

  // 2. Compute Left Panel Grouped Lists
  const query = searchText.trim().toLowerCase();
  const hasSearchQuery = query.length > 0;

  const filteredMessages = messages.filter((m) => {
    const haystack = [
      actualWhatsAppMessageText(m),
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

  const groupChats = (() => {
    const byGroup = new Map<string, { rawGroupName: string; messages: typeof filteredMessages; latest: typeof filteredMessages[0] }>();
    for (const m of filteredMessages) {
      if (!isLikelyGroupConversation(m)) continue;
      // group_name is only WhatsApp's editable human label.  Join the raw
      // mirror to the directory with the immutable remote JID instead.
      const gKey = m.chat_id || m.conversation_key || m.group_name || "unknown";
      const existing = byGroup.get(gKey);
      if (existing) {
        const ts = messageDateValue(m)?.getTime() || 0;
        const latestTs = messageDateValue(existing.latest)?.getTime() || 0;
        if (ts > latestTs) existing.latest = m;
        existing.messages.push(m);
      } else {
        byGroup.set(gKey, { rawGroupName: m.group_name || "", messages: [m], latest: m });
      }
    }
    return Array.from(byGroup.entries())
      .map(([gKey, g]) => ({
        conversationKey: gKey,
        rawGroupName: g.rawGroupName,
        groupLabel: displayGroupName(g.rawGroupName),
        title: displayGroupName(g.rawGroupName) || "WhatsApp Group",
        latest: g.latest,
        count: g.messages.length,
      }))
      .sort((a, b) => (messageDateValue(b.latest)?.getTime() || 0) - (messageDateValue(a.latest)?.getTime() || 0));
  })();

  // WhatsApp Groups is a directory view, not a derived view of parsed broker
  // posts.  `groups` comes from Whatsmeow's joined-group directory, so groups
  // with no captured property post are still visible and selecting one uses
  // its actual WhatsApp JID (rather than the latest sender's identity).
  const directoryGroupItems: ThreadFallbackItem[] = (() => {
    const capturedByJid = new Map(groupChats.map((chat) => [String(chat.conversationKey), chat]));
    return groups
      .filter((group) => String(group?.conversation_jid || group?.jid || "").trim())
      .map((group) => {
        const jid = String(group.conversation_jid || group.jid).trim();
        const captured = capturedByJid.get(jid);
        const groupName = String(group.display_name || group.name || captured?.title || "WhatsApp Group").trim();
        const conversationType = group.conversation_type === "broadcast" ? "broadcast" : "group";
        const historyCount = Number(group.message_count || group.records_found || 0);
        const hasHistory = historyCount > 0;
        const latest = captured?.latest || ({
          id: 0,
          chat_id: jid,
          chat_type: "group",
          chat_name: groupName,
          conversation_key: jid,
          conversation_type: "group",
          conversation_name: groupName,
          group_name: jid,
          message: "",
          message_count: historyCount,
          timestamp: group.last_message_at || "",
        } as api.InboxThread);
        return {
          key: jid,
          title: groupName,
          subtitle: captured
            ? (conversationType === "broadcast" ? "WhatsApp broadcast" : "WhatsApp group")
            : `${conversationType === "broadcast" ? "WhatsApp broadcast" : "WhatsApp group"} · ${hasHistory ? `${historyCount} captured messages` : "No captured messages yet"}`,
          latest: {
            ...latest,
            chat_id: jid,
            chat_type: "group",
            chat_name: groupName,
            conversation_key: jid,
            conversation_type: "group",
            conversation_name: groupName,
          },
          count: captured?.count || historyCount,
          type: "group" as const,
        };
      })
      .filter((item) => !query || [item.title, item.subtitle, item.key].join(" ").toLowerCase().includes(query))
      .sort((a, b) => {
        const newest = (messageDateValue(b.latest)?.getTime() || 0) - (messageDateValue(a.latest)?.getTime() || 0);
        return newest || a.title.localeCompare(b.title);
      });
  })();

  const directChats = uniqueThreads
    .filter((m) => !isLikelyGroupConversation(m))
    .map((m) => ({
      senderKey: m.chat_id || m.conversation_key,
      name: displayChatTitle(m),
      latest: m,
      count: m.message_count || 0,
    }))
    .sort((a, b) => (messageDateValue(b.latest)?.getTime() || 0) - (messageDateValue(a.latest)?.getTime() || 0));

  // Apply search filter to broker feed and direct chats
  const validBrokerFeed = brokerFeed.filter((b: any) => b && typeof b === "object");
  const filteredBrokerFeed = !query
    ? validBrokerFeed
    : validBrokerFeed.filter((b: any) => {
        const haystack = [
          b.canonical_name,
          b.name,
          b.primary_phone,
          b.identity_key,
          b.latest_title,
          b.latest_intent,
          b.latest_micro_market,
          ...(Array.isArray(b.specialty_localities) ? b.specialty_localities : []),
          ...(Array.isArray(b.specialty_property_types) ? b.specialty_property_types : []),
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

  const threadFallbackItems: ThreadFallbackItem[] = [
    ...(isGroupsView
      ? directoryGroupItems
      : [
          ...(activeSlug?.view_type === "brokers" ? [] : groupChats.map((chat) => ({
            key: String(chat.conversationKey || ""),
            title: chat.title,
            subtitle: chat.groupLabel && chat.groupLabel !== chat.title ? chat.groupLabel : "WhatsApp group",
            latest: chat.latest,
            count: chat.count,
            type: "group" as const,
          }))),
          ...filteredDirectChats.map((chat) => ({
            key: String(chat.senderKey || ""),
            title: chat.name,
            subtitle:
              displayGroupName(chat.latest?.group_name)
              || (resolveMessagePhone(chat.latest) ? displayPhoneString(resolveMessagePhone(chat.latest)) : "Broker evidence"),
            latest: chat.latest,
            count: chat.count,
            type: "direct" as const,
          })),
        ]),
  ]
    .filter((item) => Boolean(item.key))
    .sort((a, b) => (messageDateValue(b.latest)?.getTime() || 0) - (messageDateValue(a.latest)?.getTime() || 0));

  const isBrokerView = activeSlug?.view_type === "brokers" || (!activeSlug && currentSlug === "brokers");
  const showThreadFallback = !isBrokerView;
  const brokerHasMore = brokerFeed.length >= BROKER_PAGE_SIZE;
  const brokerPage = Math.floor(brokerOffset / BROKER_PAGE_SIZE) + 1;
  const brokerTotalPages = Math.max(1, Math.ceil((brokerFeedTotal ?? (brokerOffset + brokerFeed.length)) / BROKER_PAGE_SIZE));
  const messagePage = Math.floor(offset / PAGE_SIZE) + 1;

  const leftListEmpty = (() => {
    if (loadingSlugs || (isBrokerView && loadingParsedInbox)) return false;
    if (isBrokerView) return parsedInboxItems.length === 0 && threadFallbackItems.length === 0;
    return threadFallbackItems.length === 0;
  })();
  const initialLeftPanelLoading = isBrokerView
    ? parsedInboxItems.length === 0 && (loadingParsedInbox || loadingSlugs)
    : threadFallbackItems.length === 0 && loadingLeft;

  const groupedConversationMessages: [string, api.RawMessage[][]][] = (() => {
    const grouped: Record<string, api.RawMessage[]> = {};
    const dedupedMessages = Array.from(
      conversationMessages.reduce((map, message) => {
        const senderKey = message.sender_jid || message.sender_phone || message.sender || "";
        const uniqueMessageKey = (message.message_uid || "").trim() || `id:${message.id}`;
        const key = `${senderKey}::${uniqueMessageKey}`;
        const existing = map.get(key);
        if (!existing) {
          map.set(key, {
            ...message,
            duplicate_count: 1,
            duplicate_group_names: message.group_name ? [message.group_name] : [],
          });
          return map;
        }
        existing.duplicate_count = (existing.duplicate_count || 1) + 1;
        if (message.group_name && !(existing.duplicate_group_names || []).includes(message.group_name)) {
          existing.duplicate_group_names = [...(existing.duplicate_group_names || []), message.group_name];
        }
        const existingTime = messageDateValue(existing)?.getTime() || 0;
        const messageTime = messageDateValue(message)?.getTime() || 0;
        if (messageTime > existingTime) {
          map.set(key, {
            ...message,
            duplicate_count: existing.duplicate_count,
            duplicate_group_names: existing.duplicate_group_names,
          });
        }
        return map;
      }, new Map<string, api.RawMessage>()).values()
    ).sort((a, b) => (messageDateValue(a)?.getTime() || 0) - (messageDateValue(b)?.getTime() || 0));

    dedupedMessages.forEach((message) => {
      const date = messageDateValue(message);
      const label = !date || Number.isNaN(date.getTime())
        ? "Recent"
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
        const msgTime = messageDateValue(msg)?.getTime();
        const lastTime = messageDateValue(lastMsg)?.getTime();
        const closeEnough = Boolean(lastMsg && msgTime && lastTime && Math.abs(msgTime - lastTime) < 300000);
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
    Boolean(selectedMsg && isLikelyGroupConversation(selectedMsg));
  const selectedSubtitle =
    isGroupConversationSelected
      ? ""
      : resolveMessagePhone(selectedMsg)
      ? displayPhoneString(resolveMessagePhone(selectedMsg))
      : resolveMessageSenderName(selectedMsg) || selectedMsg?.sender || "";
  const selectedCount =
    selectedMsg && "message_count" in selectedMsg ? selectedMsg.message_count : conversationMessages.length;
  const selectedConversationJid = useMemo(() => {
    if (!selectedMsg) return "";
    const candidate = (
      selectedMsg.chat_id ||
      ("conversation_key" in selectedMsg ? selectedMsg.conversation_key : "") ||
      selectedMsg.sender_jid ||
      (isRawWhatsAppId(selectedMsg.group_name) ? selectedMsg.group_name : "")
    ).trim();
    return candidate;
  }, [selectedMsg]);
  const replyTargetMessage = useMemo(() => {
    if (!selectedMsg) return null;
    const selectedId = selectedMsg.id;
    const inThread = selectedId ? conversationMessages.find((item) => item.id === selectedId) : null;
    if (inThread) return inThread;
    return conversationMessages.length > 0 ? conversationMessages[conversationMessages.length - 1] : selectedMsg;
  }, [conversationMessages, selectedMsg]);
  const resolvedBrokerPhone = useMemo(() => {
    const candidates = [
      selectedBroker?.phone,
      selectedMsgDetails?.parsed?.broker_phone,
      selectedMsgDetails?.raw?.broker_phone,
      selectedMsgDetails?.raw?.sender_phone,
      selectedMsgDetails?.raw?.message ? extractPhoneFromText(selectedMsgDetails.raw.message) : "",
      selectedMsgDetails?.raw?.raw_message ? extractPhoneFromText(selectedMsgDetails.raw.raw_message) : "",
      selectedMsgDetails?.raw?.summary_title ? extractPhoneFromText(selectedMsgDetails.raw.summary_title) : "",
      selectedBroker?.identity_key,
      selectedBroker?.id,
      ...selectedBrokerObservations.flatMap((obs: BrokerObservationRow) => [
        obs.broker_phone,
        obs.broker_name,
        extractPhoneFromText(obs.raw_message),
      ]),
    ];
    for (const candidate of candidates) {
      const phone = normalizeRealPhone(candidate);
      if (phone) return phone;
    }
    return "";
  }, [
    selectedBroker?.phone,
    selectedBroker?.identity_key,
    selectedBroker?.id,
    selectedMsgDetails?.parsed?.broker_phone,
    selectedMsgDetails?.raw?.broker_phone,
    selectedMsgDetails?.raw?.sender_phone,
    selectedMsgDetails?.raw?.message,
    selectedMsgDetails?.raw?.raw_message,
    selectedMsgDetails?.raw?.summary_title,
    selectedBrokerObservations,
  ]);
  const replyFallbackPhone = normalizeRealPhone(
    resolveMessagePhone(selectedMsg) || resolvedBrokerPhone || phoneFromJid(selectedConversationJid)
  );
  const brokerReplyPhone = resolvedBrokerPhone;
  const replyDraftKey = selectedConversationJid ? `propai-inbox-draft:${selectedConversationJid}` : "";
  const whatsappConnected = whatsappStatus
    ? api.isLiveWhatsAppConnection(whatsappStatus)
    : marketAccess?.whatsapp_connected !== false;
  const wabaConfigured = marketAccess?.waba_configured === true;

  useEffect(() => {
    setReplyError("");
    setReplyStatus("");
  }, [selectedConversationJid]);

  useEffect(() => {
    setBrokerReplyText("");
  }, [selectedBroker?.identity_key]);

  useEffect(() => {
    if (!replyDraftKey) {
      setReplyText("");
      setReplyDraftLoadedKey("");
      return;
    }
    try {
      const stored = window.localStorage.getItem(replyDraftKey);
      setReplyText(stored || "");
    } catch {
      setReplyText("");
    }
    setReplyDraftLoadedKey(replyDraftKey);
  }, [replyDraftKey]);

  useEffect(() => {
    if (!replyDraftKey || replyDraftLoadedKey !== replyDraftKey) return;
    try {
      if (replyText.trim()) {
        window.localStorage.setItem(replyDraftKey, replyText);
      } else {
        window.localStorage.removeItem(replyDraftKey);
      }
    } catch {
      // Ignore local storage failures in private mode / restricted browsers.
    }
  }, [replyDraftKey, replyDraftLoadedKey, replyText]);

  useEffect(() => {
    if (!replyStatus) return;
    const timer = window.setTimeout(() => setReplyStatus(""), 2500);
    return () => window.clearTimeout(timer);
  }, [replyStatus]);

  // Session countdown timer — updates display every 60s
  useEffect(() => {
    if (!sessionStatus?.active || !sessionStatus.remaining_seconds) {
      setSessionCountdown(sessionStatus?.expired ? "Session expired" : "");
      return;
    }
    const updateCountdown = () => {
      if (!sessionStatus?.remaining_seconds) return;
      const now = Date.now();
      const end = now + sessionStatus.remaining_seconds * 1000;
      const remaining = Math.max(0, Math.floor((end - Date.now()) / 1000));
      if (remaining <= 0) {
        setSessionCountdown("Session expired");
        setSessionStatus((prev) => prev ? { ...prev, active: false, expired: true, remaining_seconds: 0 } : prev);
        return;
      }
      const hours = Math.floor(remaining / 3600);
      const mins = Math.floor((remaining % 3600) / 60);
      setSessionCountdown(`${hours}h ${mins}m remaining`);
    };
    updateCountdown();
    const interval = window.setInterval(updateCountdown, 60000);
    return () => window.clearInterval(interval);
  }, [sessionStatus?.active, sessionStatus?.remaining_seconds]);

  useEffect(() => {
    let cancelled = false;
    const loadReplyAccess = async () => {
      setReplyAccessLoading(true);
      try {
        const member = await api.getCurrentTeamMember();
        if (!cancelled) {
          setCurrentTeamMember(member);
          setCanReplyWhatsApp((member.permission_keys || []).includes("reply_whatsapp"));
        }
      } catch (e) {
        console.error("Failed to load reply permissions:", e);
        if (!cancelled) {
          setCurrentTeamMember(null);
          setCanReplyWhatsApp(false);
        }
      } finally {
        if (!cancelled) setReplyAccessLoading(false);
      }
    };
    void loadReplyAccess();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSendReply = useCallback(async () => {
    const text = replyText.trim();
    const attachment = replyAttachment;
    if (sendingReply || !selectedConversationJid || !canReplyWhatsApp || (!whatsappConnected && !wabaConfigured)) return;
    if (!text && !attachment) return;

    // A WhatsApp group can only be addressed through the linked WhatsApp
    // session.  Meta's Business API requires a phone number and cannot send
    // to a group JID, so never send a group reply through /waba/send.
    if (isGroupConversationSelected && !whatsappConnected) {
      setReplyError("Reconnect the linked WhatsApp phone before sending to this group.");
      return;
    }

    setSendingReply(true);
    setReplyError("");
    setReplyStatus("");

    const nowIso = new Date().toISOString();

    try {
      const outboundText = text || (attachment ? `Attachment: ${attachment.name}` : "");
      if (attachment) {
        await api.sendMediaMessage({
          remote_jid: selectedConversationJid,
          media_type: inferAttachmentMediaType(attachment),
          caption: text,
          file_name: attachment.name,
          mime_type: attachment.type || "",
          file: attachment,
        });
      } else {
        await api.sendMessage({
          remote_jid: selectedConversationJid,
          text: outboundText,
        });
      }

      const optimisticMessage: api.RawMessage = {
        id: Number(`${Date.now()}`),
        chat_id: selectedConversationJid,
        chat_type: selectedMsg?.chat_type || selectedMsg?.conversation_type || (isGroupConversationSelected ? "group" : "direct"),
        chat_name: selectedMsg?.chat_name || selectedTitle || "",
        conversation_type: selectedMsg?.conversation_type || selectedMsg?.chat_type || (isGroupConversationSelected ? "group" : "direct"),
        conversation_key: selectedConversationJid,
        conversation_name: selectedMsg?.conversation_name || selectedMsg?.chat_name || selectedTitle || "",
        group_name: selectedMsg?.group_name || selectedConversationJid,
        sender: "You",
        sender_jid: selectedConversationJid,
        sender_phone: replyFallbackPhone || "",
        broker_name: selectedMsg?.broker_name || "",
        broker_phone: replyFallbackPhone || "",
        building_name: selectedMsg?.building_name || "",
        micro_market: selectedMsg?.micro_market || "",
        landmark_name: selectedMsg?.landmark_name || "",
        parsed_intent: selectedMsg?.parsed_intent || "",
        message: outboundText,
        message_type: attachment ? inferAttachmentMediaType(attachment) : "text",
        timestamp: nowIso,
        source: isGroupConversationSelected ? "WHATSAPP_OUTBOUND" : "WABA_OUTBOUND",
        event_id: `local-${Date.now()}`,
        message_uid: `local-${Date.now()}`,
        raw_payload: JSON.stringify({
          local: true,
          remote_jid: selectedConversationJid,
          media_type: attachment ? inferAttachmentMediaType(attachment) : "text",
          file_name: attachment?.name || "",
        }),
        synced_at: nowIso,
        pipeline_version: "propai-web-send",
        from_me: true,
        created_at: nowIso,
      };
      setConversationMessages((prev) => [...prev, optimisticMessage]);
      setReplyText("");
      setReplyAttachment(null);
      if (attachmentInputRef.current) {
        attachmentInputRef.current.value = "";
      }
      if (replyDraftKey) {
        try {
          window.localStorage.removeItem(replyDraftKey);
        } catch {
          // Ignore local storage failures.
        }
      }
      setReplyStatus(attachment ? "Attachment sent" : "Message sent");
    } catch (e: any) {
      const message = e?.message || "Failed to send reply";
      setReplyError(message);
      if (/whatsapp|ingestor|connect/i.test(message)) {
        setReplyStatus("WhatsApp is disconnected. Open QR to reconnect.");
      } else if (!isGroupConversationSelected && replyFallbackPhone) {
        setReplyStatus("Send failed. Open chat to continue.");
      }
    } finally {
      setSendingReply(false);
    }
  }, [
    isGroupConversationSelected,
    replyFallbackPhone,
    replyTargetMessage,
    replyText,
    replyAttachment,
    replyDraftKey,
    selectedConversationJid,
    selectedMsg,
    sendingReply,
    selectedTitle,
    canReplyWhatsApp,
    whatsappConnected,
    wabaConfigured,
  ]);

  const handleSendBrokerReply = useCallback(async () => {
    const text = brokerReplyText.trim();
    if (!text || sendingReply) return;
    if (!brokerReplyPhone) {
      setReplyError("This broker's phone number has not been resolved yet.");
      return;
    }
    if (!canReplyWhatsApp) {
      setReplyError("Your workspace role does not allow WhatsApp replies.");
      return;
    }
    if (!whatsappConnected) {
      setReplyError("Connect your WhatsApp phone before sending this message.");
      return;
    }

    setSendingReply(true);
    setReplyError("");
    setReplyStatus("");
    try {
      await api.sendMessage({
        remote_jid: `${brokerReplyPhone}@s.whatsapp.net`,
        text,
      });
      setBrokerReplyText("");
      setReplyStatus("Message sent and recorded in workspace activity");
    } catch (error: unknown) {
      setReplyError(error instanceof Error ? error.message : "Message could not be sent");
    } finally {
      setSendingReply(false);
    }
  }, [brokerReplyPhone, brokerReplyText, canReplyWhatsApp, sendingReply, whatsappConnected]);

  const trackBrokerWhatsAppOpen = useCallback((phone: string, source: string) => {
    void api.logWorkspaceActivity({
      action: "broker_whatsapp_opened",
      target_type: "broker",
      target_id: phone,
      details: {
        source,
        broker_name: selectedBroker?.canonical_name || selectedBroker?.name || "",
      },
    }).catch(() => {
      // Tracking must never block the user's contact action.
    });
  }, [selectedBroker?.canonical_name, selectedBroker?.name]);

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
        thread = await withThreadTimeout(api.getChatMessages(chatId, 80, 0));
      } else if (groupName && groupName !== "seed" && groupName !== "seed-bot") {
        thread = await withThreadTimeout(api.getRaw(80, 0, groupName));
      } else {
        const resolvedPhone = resolveMessagePhone(msg);
        const phone = isRealPhoneDigits(resolvedPhone) ? resolvedPhone : undefined;
        const jid = msg.sender_jid || msg.group_name || ("conversation_key" in msg ? msg.conversation_key : "") || undefined;
        thread = await withThreadTimeout(api.getRaw(80, 0, undefined, undefined, phone, jid));
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

      // Fetch 24h session status for direct conversations
      if (chatId && chatId.includes("@s.whatsapp.net")) {
        try {
          const session = await api.getWabaSessionStatus(chatId);
          setSessionStatus(session);
        } catch {
          setSessionStatus(null);
        }
      } else {
        setSessionStatus(null);
      }

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
        // The WhatsApp Groups page is a raw mirror. Its message ids are raw-message
        // ids, not inbox evidence ids, so asking the evidence endpoint here produces
        // noisy 404s and can trigger unrelated broker/building lookups.
        const isRawMirrorRoute = typeof window !== "undefined" && window.location.pathname === "/whatsapp-groups";
        if (isRawMirrorRoute) {
          setSelectedMsgDetails(null);
          setSelectedBroker(null);
          setSelectedBuilding(null);
          setPriceStats(null);
        } else {
          loadMessageDetails(detailTarget.id);
        }
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
    if (isMobile) setMobileView("conversation");
    const isRawMirrorRoute = typeof window !== "undefined" && window.location.pathname === "/whatsapp-groups";
    if (isRawMirrorRoute) {
      setSelectedMsgDetails(null);
      setSelectedBroker(null);
      setSelectedBuilding(null);
      setPriceStats(null);
    } else {
      loadMessageDetails(msg.id);
    }
    updateUrlMessage((msg as any).chat_id || (msg as any).conversation_key || msg.group_name || "", msg.id);
    const el = messageRefs.current[msg.id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isMobile, updateUrlMessage]);

  // 3c. Select a broker card -> show market items in the center workspace
  const selectBroker = useCallback(async (broker: any, focusObsRawId?: number) => {
    if (isMobile) setMobileView("conversation");
    setOpportunityFilter("all");
    const brokerPhone = normalizeRealPhone(broker.primary_phone || broker.phone || broker.identity_key || broker.id || "");
    const rawBrokerName = stripDecorativeEmoji(broker.canonical_name || broker.name || "").trim();
    const brokerName = isLikelyBrokerDisplayName(rawBrokerName) ? rawBrokerName : "";
    const brokerIdentityKey = (broker.identity_key || broker.id || broker.primary_phone || brokerPhone || brokerName || "").toString().trim();
    const displayName = brokerName || displayPhoneString(brokerPhone || broker.primary_phone || broker.phone || brokerIdentityKey) || "Broker";
    if (brokerIdentityKey) updateUrlBroker(brokerIdentityKey);
    setSelectedBroker({
      id: brokerIdentityKey || brokerPhone || broker.primary_phone || brokerName,
      identity_key: brokerIdentityKey,
      phone: brokerPhone || broker.primary_phone || broker.phone || normalizeRealPhone(brokerIdentityKey) || "",
      canonical_name: displayName,
      name: displayName,
      building_count: broker.building_count || 0,
      active_days_30: broker.active_days_30 || 0,
      first_seen: broker.first_seen,
      last_seen: broker.last_active,
      observation_count: broker.observation_count || broker.obs_count || 0,
      listing_count: broker.listing_count || 0,
      requirement_count: broker.requirement_count || 0,
      specialty_localities: broker.specialty_localities || [],
      specialty_property_types: broker.specialty_property_types || [],
      latest_title: broker.latest_title || "",
      latest_intent: broker.latest_intent || "",
      latest_micro_market: broker.latest_micro_market || "",
      channels: broker.channels || [],
    });
    api.findBroker(brokerName, brokerPhone || broker.primary_phone || broker.phone || "")
      .then(({ broker_id }) => {
        setSelectedBroker((current: any) =>
          current?.identity_key === brokerIdentityKey
            ? { ...current, profile_id: broker_id }
            : current
        );
      })
      .catch(() => {
        // The directory remains available as a fallback for identities without enough parsed evidence.
      });
    if (!focusObsRawId) setSelectedMsgDetails(null);
    // Load market items for the center timeline. One broker selection maps to one
    // canonical request; equivalent phone/name retries previously multiplied
    // slow scans and left the UI spinning for minutes.
    brokerObservationRequestRef.current?.abort();
    const request = new AbortController();
    brokerObservationRequestRef.current = request;
    setBrokerObsError("");
    setSelectedBrokerObservations([]);
    setLoadingBrokerObs(true);
    try {
      const itemKey = brokerPhone
        || (/^name:/i.test(brokerIdentityKey) ? brokerIdentityKey : "")
        || (brokerName ? `name:${brokerName}` : brokerIdentityKey);
      const items = await api.getMarketItemsFeed(200, 0, itemKey, request.signal);
      if (request.signal.aborted || brokerObservationRequestRef.current !== request) return;
      setSelectedBrokerObservations(items);
      const rawId = focusObsRawId || items?.[0]?.latest_raw_message_id || items?.[0]?.raw_message_id;
      if (rawId) {
        updateUrlItem(rawId);
        loadMessageDetails(rawId, { setSelectedRaw: true, preserveProfiles: true });
      }
    } catch (e) {
      if (request.signal.aborted || brokerObservationRequestRef.current !== request) return;
      console.error("Failed to load broker market items:", e);
      setSelectedBrokerObservations([]);
      setBrokerObsError("Market items could not be loaded. Please retry.");
    } finally {
      if (brokerObservationRequestRef.current === request) {
        setLoadingBrokerObs(false);
        brokerObservationRequestRef.current = null;
      }
    }
  }, [updateUrlBroker, updateUrlItem]);

  useEffect(() => {
    autoSelectedThreadRef.current = "";
  }, [
    activeSlug?.view_type,
    offset,
  ]);

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

  const selectBrokerItem = (item: any) => {
    const rawId = item.latest_raw_message_id || item.raw_message_id;
    if (!rawId) return;
    if (isMobile) setMobileView("conversation");
    updateUrlItem(rawId);
    loadMessageDetails(rawId, { setSelectedRaw: true, preserveProfiles: true });
  };

  const loadBrokerDetails = async (name: string, phone: string) => {
    try {
      const res = await api.findBroker(name, phone);
      if (res && res.broker_id) {
        const brokerData = await api.getBroker(res.broker_id);
        setSelectedBroker(brokerData);
      }
    } catch (e) {
      console.log("No canonical broker profile found or failed to load:", e);
    }
  };

  const loadBuildingDetails = async (name: string) => {
    try {
      const buildingData = await api.getBuildingProfile(name);
      setSelectedBuilding(buildingData);
    } catch (e) {
      console.log("Failed to load building profile:", e);
    }
  };

  const loadPriceStats = async (market: string, bhk: string, intent: string) => {
    try {
      const stats = await api.getPriceStats(market, bhk, intent);
      if (stats && !stats.error) {
        setPriceStats(stats);
      }
    } catch (e) {
      console.log("Failed to load price stats:", e);
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

  const waSenderPhone =
    normalizeRealPhone(selectedMsgDetails?.parsed?.broker_phone) ||
    resolveMessagePhone(selectedMsgDetails?.raw) ||
    resolveMessagePhone(selectedMsg) ||
    extractPhoneFromText(selectedMsgDetails?.raw?.message || selectedMsg?.message);
    const selectedHasMarketContext = hasMarketContext(selectedMsgDetails);

  return (
    <div className="mobile-inbox safe-area-top safe-area-bottom flex h-full min-h-0 max-h-full flex-col overflow-hidden bg-black max-lg:pb-14 lg:h-full lg:max-h-full lg:rounded-2xl lg:border lg:border-white/10">




      
      {actionMessage && (
        <div className="bg-[#1e293b] border-b border-[#3EE88A]/30 text-[#3EE88A] px-4 py-2 text-xs font-semibold text-center flex items-center justify-center gap-3 animate-fadeIn">
          <span>{actionMessage}</span>
          {actionUndo && (
            <button
              onClick={() => void handleUnhideBroker(actionUndo?.brokerKeys || [])}
              className="px-2 py-0.5 bg-zinc-800 border border-white/10 rounded text-[10px] text-white hover:text-white transition-colors"
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* Main Layout Grid */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        
        {/* ================= LEFT PANEL: INBOX ================= */}
        <div className={`h-full min-h-0 w-full shrink-0 lg:w-auto ${isMobile && mobileView !== "list" ? "hidden" : ""}`}>
        <ResizablePanel
          defaultWidth={320}
          minWidth={240}
          maxWidth={500}
          storageKey="propai-inbox-left-width"
          mobile={isMobile}
          className="h-full min-h-0 border-r border-white/10 bg-black/80"
        >
          <div className="flex flex-col h-full">
          {/* Panel Search & Header */}
          <div className="shrink-0 p-2 sm:p-4 border-b border-white/10 space-y-1.5 sm:space-y-3">
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={toggleDrawer}
                className="order-first flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-white transition-colors lg:hidden"
                aria-label="Open menu"
                title="Open menu"
              >
                <Menu className="h-4 w-4" strokeWidth={1.5} />
              </button>
              <div className="min-w-0">
                <div className="text-[12px] font-bold tracking-wider text-white uppercase sm:text-sm">
                  {isGroupsView ? "WhatsApp Groups" : "Market Inbox"}
                </div>
                <div className="hidden sm:block text-[10px] text-zinc-500 mt-0.5">
                  {isGroupsView
                    ? "Raw WhatsApp groups with inline PropAI composer"
                    : "Parsed listings from your broker network"}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => {
                    void handleRefreshInbox();
                  }}
                  className="text-[10px] sm:text-xs text-[#3EE88A] hover:underline"
                  disabled={loadingLeft}
                >
                  {loadingLeft ? "Refreshing..." : <><span className="sm:hidden">↻</span><span className="sm:hidden ml-0.5">Refresh</span><span className="hidden sm:inline">Refresh</span></>}
                </button>
              </div>
            </div>
            
            <input
              type="text"
              placeholder="Search messages, brokers, localities"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="hidden h-8 w-full rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1 text-xs text-white focus:border-[#3EE88A] focus:outline-none transition-colors sm:block sm:h-auto sm:py-1.5"
            />

            {/* Saved broker views do not apply to the raw WhatsApp mirror. */}
            {isGroupsView ? (
              <div className="flex gap-1 bg-zinc-900 p-0.5 rounded-lg border border-[rgba(255,255,255,0.03)]">
                <div className="flex-1 rounded-md bg-zinc-800 py-1 text-center text-[9px] font-bold uppercase tracking-wider text-[#3EE88A] sm:py-1.5 sm:text-[10px]">
                  Chats & broadcasts
                </div>
              </div>
            ) : (
              <div className="flex gap-1 bg-zinc-900 p-0.5 rounded-lg border border-[rgba(255,255,255,0.03)]" style={{ gridTemplateColumns: `repeat(${Math.min(slugs.length, 5)}, 1fr)` }}>
                {slugs.length === 0 ? (
                  <div className="flex-1 rounded-md bg-zinc-800 py-1 text-center text-[9px] font-bold uppercase tracking-wider text-zinc-500 sm:py-1.5 sm:text-[10px]">
                    Parsed Listings
                  </div>
                ) : (
                  slugs.map((sv) => (
                    <button
                      key={sv.slug}
                      onClick={() => {
                        setCurrentSlug(sv.slug);
                        updateUrlView(sv.slug);
                      }}
                      className={`flex-1 rounded-md py-1 text-[9px] font-bold uppercase tracking-wider transition-colors sm:py-1.5 sm:text-[10px] ${
                        currentSlug === sv.slug
                          ? "bg-zinc-800 text-[#3EE88A] shadow-sm"
                          : "text-zinc-500 hover:text-white"
                      }`}
                    >
                      {sv.slug === "brokers" ? "Parsed Listings" : sv.label}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* List Content */}
          <div className="flex-1 overflow-y-auto divide-y divide-[rgba(255,255,255,0.04)]">
            {GATING_ENABLED && loadingMarketAccess ? (
              <div className="p-8 text-center text-xs text-zinc-500">Checking workspace access...</div>
            ) : connectionPending ? (
              <div className="p-5 text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300">
                  <MessageSquare className="h-4 w-4" strokeWidth={1.6} />
                </div>
                <div className="text-sm font-bold text-white">
                  {whatsappDisconnected ? "Pair WhatsApp to continue" : accessHealthGate.title}
                </div>
                <p className="mx-auto mt-2 max-w-[260px] text-xs leading-relaxed text-zinc-500">
                  {whatsappDisconnected
                    ? "Open Connection Center and pair WhatsApp with a code to unlock Market Inbox and WhatsApp Groups."
                    : accessHealthGate.description}
                </p>
                <div className="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
                  <Link
                    href="/whatsapp?tab=numbers"
                    className="inline-flex h-9 items-center justify-center rounded-lg bg-[#3EE88A] px-4 text-xs font-bold text-black hover:bg-[#35d47c]"
                  >
                    Open QR
                  </Link>
                  {!whatsappDisconnected && "secondaryHref" in accessHealthGate && (
                    <Link
                      href={accessHealthGate.secondaryHref}
                      className="inline-flex h-9 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 px-4 text-xs font-bold text-zinc-200 hover:border-[#3EE88A]/40 hover:text-[#3EE88A]"
                    >
                      {accessHealthGate.secondaryCta}
                    </Link>
                  )}
                </div>
              </div>
            ) : hasSearchQuery && !isGroupsView ? (
              searchLoading ? (
                <div className="p-8 text-center text-xs text-zinc-500">Searching messages...</div>
              ) : searchError ? (
                <div className="p-8 text-center text-xs text-red-400">{searchError}</div>
              ) : searchResults.length === 0 ? (
                <div className="p-8 text-center text-xs text-zinc-500">
                  No messages found. Try a broker name, locality, or property keyword.
                </div>
              ) : (
                searchResults.map((result) => {
                  const item = rawSearchResultToMessage(result);
                  const title = stripDecorativeEmoji(result.group_name || result.sender || result.sender_phone || "Conversation");
                  const subtitle = stripDecorativeEmoji(
                    result.group_name && /@g\.us$/i.test(result.group_name)
                      ? "WhatsApp group"
                      : result.sender_phone
                        ? `Phone ending ${normalizeRealPhone(result.sender_phone).slice(-4) || "—"}`
                        : result.sender || "Direct message"
                  );
                  const snippet = stripEmojis((result.snippet || result.message || "").replace(/<\/?mark>/gi, "").trim());
                  return (
                    <button
                      key={result.id}
                      onClick={() => {
                        void selectConversation(item);
                      }}
                      className="w-full select-none p-2 transition-colors hover:bg-white/5 lg:p-3"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <MessageSquare className="w-3.5 h-3.5 shrink-0 text-zinc-500" strokeWidth={1.5} />
                          <span className="text-[12px] font-bold text-white truncate max-w-[190px]">
                            {title || "WhatsApp message"}
                          </span>
                        </div>
                        <span className="text-[10px] font-bold text-white tabular-nums">
                          {messageTimeLabel(item)}
                        </span>
                      </div>
                      <div className="text-[10px] text-zinc-500 leading-relaxed truncate mb-1">
                        {subtitle}
                      </div>
                      <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[10px] text-zinc-400 leading-relaxed">
                        {snippet || "No text content"}
                      </div>
                    </button>
                  );
                })
              )
            ) : initialLeftPanelLoading ? (
            <div className="p-8 text-center text-xs text-zinc-500">Loading captured listings...</div>
            ) : leftListEmpty ? (
              <div className="p-8 text-center text-xs text-zinc-500">
                {isBrokerView
                  ? "No broker entities extracted from group messages yet."
                  : "No chats found"}
              </div>
            ) : (
              <>
                {isBrokerView && loadingParsedInbox && parsedInboxItems.length > 0 && (
                  <div className="px-3 py-2 text-center text-[10px] text-zinc-600">Refreshing parsed listings...</div>
                )}
                {isBrokerView && parsedInboxItems.map((item) => {
                  const rawId = item.latest_raw_message_id || item.raw_message_id;
                  const isSelected = Boolean(rawId && selectedMsgDetails?.raw?.id === rawId);
                  const sourceSlice = String(item.source_message || item.raw_message || item.normalized_message || item.source_slice_text || "").trim();
                  const expiry = expiryLabel(item);
                  const broker = {
                    primary_phone: item.broker_phone || "",
                    canonical_name: item.broker_name || item.profile_name || "Broker",
                    identity_key: item.broker_key || item.broker_phone || `name:${item.broker_name || item.profile_name || "broker"}`,
                    listing_count: item.observation_type === "LISTING" ? 1 : 0,
                    requirement_count: item.observation_type === "REQUIREMENT" ? 1 : 0,
                  };
                  return (
                    <button
                      key={`${rawId || item.id}-${item.listing_index || 0}`}
                      onClick={() => rawId && void selectBroker(broker, Number(rawId))}
                      className={`w-full select-none p-3 text-left transition-colors ${isSelected ? "bg-[#005c4b]/40 border-l-2 border-[#3EE88A]" : "hover:bg-white/[0.035]"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[12px] font-bold leading-snug text-white">{buildMarketItemTitle(item)}</div>
                          <div className="mt-1 flex flex-wrap gap-1.5 text-[9px] text-zinc-400">
                            {item.broker_name && (brokerDisplayName(item.broker_name) === "Your own"
                              ? <span className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-1.5 py-0.5 font-semibold text-emerald-200">Your own</span>
                              : <span>{brokerDisplayName(item.broker_name)}</span>)}
                            {item.micro_market && <span>· {item.micro_market}</span>}
                            {item.last_seen && <span>· {formatAgeShort(item.last_seen)}</span>}
                            {item.alternate_intent && <span className="font-semibold text-sky-300">· Also for {item.alternate_intent === "RENT" ? "rent" : "sale"}</span>}
                            {expiry && <span className={expiry.expired ? "font-semibold text-red-300" : "text-amber-300"}>· {expiry.expired ? `Expired ${expiry.date}` : `Expires ${expiry.date}`}</span>}
                          </div>
                        </div>
                        <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase text-zinc-300">
                          {item.observation_type === "REQUIREMENT" ? "Need" : "Parsed"}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-zinc-300">
                        {hasObservationPrice(item) && <span><b className="text-zinc-500">{item.observation_type === "REQUIREMENT" ? "Budget:" : "Price:"}</b> {formatObservationPrice(item)}</span>}
                        {item.area_sqft && <span><b className="text-zinc-500">Area:</b> {item.area_sqft} sqft</span>}
                        {item.bhk && <span><b className="text-zinc-500">Config:</b> {item.bhk}</span>}
                        {item.furnishing && <span><b className="text-zinc-500">Furnishing:</b> {formatListingValue(item.furnishing)}</span>}
                      </div>
                      {sourceSlice && <div className="mt-2 whitespace-pre-wrap break-words text-[10px] leading-relaxed text-zinc-500">{compactEvidencePreview(sourceSlice, 220)}</div>}
                    </button>
                  );
                })}
                  {showThreadFallback && threadFallbackItems.map((item) => {
                    const selectedKey = threadKeyFor(selectedMsg);
                    const isSelected = Boolean(selectedKey && selectedKey === item.key);
                    return (
                      <button
                        key={`${item.type}-${item.key}`}
                        onClick={() => selectConversation(item.latest)}
                        className={`w-full select-none p-2 transition-colors lg:p-3 ${
                          isSelected ? "bg-white/[0.055] border-l border-white/40" : "hover:bg-white/[0.035]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <MessageSquare className="w-3.5 h-3.5 shrink-0 text-zinc-500" strokeWidth={1.5} />
                          <span className="text-[12px] font-bold text-white truncate max-w-[190px]">
                              {stripDecorativeEmoji(item.title) || "WhatsApp conversation"}
                          </span>
                        </div>
                          <span className="text-[10px] font-bold text-white tabular-nums">{item.count}</span>
                        </div>
                        <div title={item.latest.market_scope === "shared" ? "Shared market inventory contributed by another workspace or network source; it is not from this WhatsApp connection." : "Captured from this workspace's connected WhatsApp sources."} className={`mb-1 inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${item.latest.market_scope === "shared" ? "border-white/10 text-zinc-400" : "border-emerald-400/20 text-emerald-300"}`}>
                          {item.latest.market_scope === "shared" ? "Shared broker market" : "Your WhatsApp"}
                        </div>
                        <div className="text-[10px] text-zinc-500 leading-relaxed truncate mb-1">
                          {stripDecorativeEmoji(resolveMessageSenderName(item.latest) || item.subtitle)}
                        </div>
                        <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[10px] text-zinc-400 leading-relaxed">
                          {stripEmojis(actualWhatsAppMessageText(item.latest)) || (item.count > 0 ? "Open to view captured messages" : "No captured messages yet")}
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
              onClick={() => {
                resetSelectionForPageChange();
                if (isBrokerView) {
                  setBrokerOffset(Math.max(0, brokerOffset - BROKER_PAGE_SIZE));
                } else {
                  setOffset(Math.max(0, offset - PAGE_SIZE));
                }
              }}
              disabled={isBrokerView ? brokerOffset === 0 : offset === 0}
              className="px-2 py-1 text-[10px] font-bold bg-zinc-800 text-zinc-400 border border-white/10 rounded disabled:opacity-30"
            >
              Prev
            </button>
            <span className="text-[10px] text-zinc-500">
              Page {isBrokerView ? brokerPage : messagePage}{isBrokerView ? ` of ${brokerTotalPages}` : ""}
            </span>
            <button
              onClick={() => {
                resetSelectionForPageChange();
                if (isBrokerView) {
                  setBrokerOffset(brokerOffset + BROKER_PAGE_SIZE);
                } else {
                  setOffset(offset + PAGE_SIZE);
                }
              }}
              disabled={isBrokerView ? !brokerHasMore : messages.length < PAGE_SIZE}
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
        <div className={`flex-1 min-w-0 w-full h-full min-h-0 flex flex-col bg-[#070b0e] overflow-hidden lg:w-auto ${isMobile && mobileView !== "conversation" ? "hidden" : ""}`}>
          {GATING_ENABLED && accessProbeFailed && (
            <div className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
              {accessHealthGate.title}: {accessHealthGate.description}
            </div>
          )}
          {connectionPending ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <div className="max-w-md">
                <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-[#3EE88A]/30 bg-[#3EE88A]/10 text-[#3EE88A]">
                  <MessageSquare className="h-5 w-5" strokeWidth={1.6} />
                </div>
                <h3 className="text-lg font-bold text-white">
                  {whatsappDisconnected ? "Pair WhatsApp to continue" : accessHealthGate.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                  {whatsappDisconnected
                    ? "Open Connection Center and pair WhatsApp with a code to unlock Market Inbox and WhatsApp Groups."
                    : accessHealthGate.description}
                </p>
                <div className="mt-5 flex flex-col items-center justify-center gap-2 sm:flex-row">
                  <Link
                    href="/whatsapp?tab=numbers"
                    className="inline-flex h-10 items-center justify-center rounded-lg bg-[#3EE88A] px-5 text-sm font-bold text-black hover:bg-[#35d47c]"
                  >
                    Open QR
                  </Link>
                  {!whatsappDisconnected && "secondaryHref" in accessHealthGate && (
                    <Link
                      href={accessHealthGate.secondaryHref}
                      className="inline-flex h-10 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 px-5 text-sm font-bold text-zinc-200 hover:border-[#3EE88A]/40 hover:text-[#3EE88A]"
                    >
                      {accessHealthGate.secondaryCta}
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ) : activeSlug?.view_type === "brokers" && selectedBroker ? (
            <>
              {/* Market Items Header */}
              <div className="shrink-0 px-3 py-2 border-b border-white/10 flex items-center justify-between bg-black/80 sm:px-5 sm:py-3">
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
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white truncate max-w-[340px]">
                      {stripDecorativeEmoji(selectedBroker.canonical_name || selectedBroker.name || selectedMsgDetails?.parsed?.broker_name || selectedMsgDetails?.parsed?.profile_name || "Broker")}
                    </h3>
                    <div className="hidden text-[10px] text-zinc-500 items-center gap-2 mt-0.5 flex-wrap sm:flex">
                      <span className="truncate">{displayPhoneString(resolvedBrokerPhone) || "Number not resolved"}</span>
                      <span>•</span>
                      <span>
                        {loadingBrokerObs ? (
                          <>
                            {selectedBroker.observation_count || 0} parsed posts{' '}
                            <span className="text-[10px] text-zinc-500 ml-1">(loading…)</span>
                          </>
                        ) : (
                          <>
                            {selectedBroker.observation_count || 0} parsed posts
                          </>
                        )}
                      </span>
                      {selectedBroker.building_count > 0 && (
                        <>
                          <span>•</span>
                          <span>{selectedBroker.building_count} buildings</span>
                        </>
                      )}
                      <span>•</span>
                      <span>Focus: {brokerSpecialtyLabel(selectedBroker)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Link
                    href={selectedBroker.profile_id
                      ? `/brokers/${selectedBroker.profile_id}`
                      : `/brokers?q=${encodeURIComponent(selectedBroker.canonical_name || selectedBroker.name || resolvedBrokerPhone || "")}`}
                    className="flex h-7 items-center rounded border border-white/15 bg-white/[0.04] px-3 text-[10px] font-semibold text-zinc-200 hover:bg-white/[0.08]"
                  >
                    View profile
                  </Link>
                  {resolvedBrokerPhone && (
                    <button
                      onClick={() => {
                        trackBrokerWhatsAppOpen(resolvedBrokerPhone, "broker_header");
                        window.open(getWaLink(resolvedBrokerPhone), "_blank", "noopener,noreferrer");
                      }}
                      className="flex h-7 items-center gap-1 rounded border border-white/15 bg-white/[0.04] px-3 text-[10px] font-semibold text-zinc-200 hover:bg-white/[0.08]"
                    >
                      <MessageSquare className="w-3 h-3" strokeWidth={1.5} />
                      WhatsApp
                    </button>
                  )}
                  <button
                    onClick={() => void handleHideBroker(
                      selectedBroker.phone || resolvedBrokerPhone || "",
                      selectedBroker.canonical_name || selectedBroker.name || "Broker",
                    )}
                    className="flex h-7 items-center gap-1 rounded border border-red-300/20 bg-red-300/[0.06] px-2.5 text-[10px] font-semibold text-red-200 hover:border-red-300/40 hover:bg-red-300/[0.1]"
                    title="Block this broker from this workspace's Market Inbox"
                  >
                    <EyeOff className="w-3 h-3" strokeWidth={1.5} />
                    <span>Block broker</span>
                  </button>
                </div>
              </div>

              {/* Market Items Timeline */}
              <main className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3 sm:p-4 sm:space-y-4">
                {loadingBrokerObs && groupedBrokerObservations.length === 0 ? (
                  <div className="p-8 text-center text-xs text-zinc-500">Loading market items...</div>
                ) : brokerObsError ? (
                  <div className="py-2 text-center">
                    <div className="text-sm font-semibold text-amber-200">Market items did not load</div>
                    <div className="mx-auto mt-1 max-w-[360px] text-xs leading-relaxed text-zinc-500">
                      Retry the item lookup without leaving Market Inbox.
                    </div>
                    <button
                      type="button"
                      onClick={() => void selectBroker(selectedBroker)}
                      className="mt-3 inline-flex h-8 items-center justify-center rounded-md border border-white/15 bg-white/[0.06] px-3 text-[11px] font-semibold text-white hover:bg-white/[0.1]"
                    >
                      Retry
                    </button>
                  </div>
                ) : groupedBrokerObservations.length === 0 ? (
                  <div className="px-2 py-2 sm:px-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <ClipboardList className="h-4 w-4 shrink-0 text-zinc-500" strokeWidth={1.6} />
                      <span>No matching items yet</span>
                    </div>
                    <div className="mt-1 max-w-[460px] text-xs leading-relaxed text-zinc-500">
                      {selectedBroker.latest_title
                        ? "We found a recent post, but it has not been split into structured items yet."
                        : "This broker has not resolved to parsed items yet. The market feed item is still usable for navigation and broker context."}
                    </div>
                    {selectedBroker.latest_title && (
                      <div className="mt-3 max-w-[560px] text-left text-xs leading-relaxed text-zinc-500">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Source post</div>
                        <div className="mt-1 text-sm font-semibold text-zinc-200">
                          <WhatsAppMessage
                            text={
                              selectedMsgDetails?.raw?.message ||
                              selectedMsgDetails?.raw?.raw_message ||
                              selectedBroker.latest_title ||
                              ""
                            }
                            sender={selectedMsgDetails?.raw?.sender || stripDecorativeEmoji(selectedBroker.canonical_name || selectedBroker.name || "")}
                            senderPhone={resolvedBrokerPhone || selectedMsgDetails?.raw?.broker_phone || ""}
                            flatMultiBlocks
                            className="text-sm text-zinc-200"
                          />
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                          {selectedBroker.latest_intent && (
                            <span className={`badge ${intentColor(selectedBroker.latest_intent)}`}>
                              {intentLabel(selectedBroker.latest_intent)}
                            </span>
                          )}
                          {selectedBroker.latest_micro_market && (
                            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-zinc-300">
                              {selectedBroker.latest_micro_market}
                            </span>
                          )}
                          <span title="Repeated parsed posts, not unique listings">{selectedBroker.observation_count || 0} parsed posts</span>
                          <span>•</span>
                          <span>{selectedBroker.building_count || 0} buildings</span>
                          <span>•</span>
                          <span>{(selectedBroker.channels || []).length || 0} channels</span>
                          <span>•</span>
                          <span>{selectedBroker.last_seen ? formatAgeShort(selectedBroker.last_seen) : "Unknown"}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="sticky top-0 z-10 -mx-4 -mt-4 border-b border-white/10 bg-black/95 px-4 py-3 backdrop-blur">
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          {filteredBrokerObservationGroups.length} shown
                        </div>
                        <div className="flex rounded-lg border border-white/10 bg-zinc-950 p-0.5">
                          {([
                            ["all", "All"],
                            ["listings", "Listings"],
                            ["requirements", "Requirements"],
                          ] as [OpportunityFilter, string][]).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setOpportunityFilter(value)}
                              className={`h-7 rounded-md px-2.5 text-[10px] font-bold transition-colors ${
                                opportunityFilter === value
                                  ? "bg-white text-black"
                                  : "text-zinc-500 hover:text-white"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {filteredBrokerObservationGroups.length === 0 ? (
                      <div className="p-8 text-center text-xs text-zinc-500">No {opportunityFilter} for this broker yet.</div>
                    ) : filteredBrokerObservationGroups.map((group) => {
                    const obs = group.representative;
                    const ev = group.observations.flatMap((item) => item.evidence_list || []);
                    const groupChannels = [
                      ...new Set(
                        ev
                          .filter((e) => e.type === "group")
                          .map((e) => e.source)
                          .filter((source): source is string => Boolean(source))
                      ),
                    ];
                    const dmCount = ev.filter((e) => e.type === "dm").length;
                    const isSelected = selectedMsgDetails?.raw?.id === (obs.latest_raw_message_id || obs.raw_message_id);
                    const obsTime = obs.last_seen ? new Date(obs.last_seen) : null;
                    const timeLabel = obsTime
                      ? obsTime.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                      : "";
                    // A bulk WhatsApp post can produce several typed
                    // item rows. Prefer each item's source slice over the
                    // complete raw message so the listings render separately.
                    const itemSource = obs.source_message || obs.raw_message || obs.normalized_message || obs.source_slice_text || "";
                    // Keep the extracted item slice visible for bulk posts.
                    // The raw-message drawer/details view can still show the
                    // complete WhatsApp message without replacing this item.
                    const fullSourceText = String(itemSource || "").trim() || (
                      isSelected
                        ? String(
                            selectedMsgDetails?.raw?.message ||
                            selectedMsgDetails?.raw?.raw_message ||
                            ""
                          ).trim()
                        : ""
                    );
                    const marketTitle = buildMarketItemTitle(obs);
                    const opportunityLabel = marketOpportunityLabel({
                      intent: obs.intent,
                      observation_type: obs.observation_type,
                      side: observationTransactionType(obs),
                      text: `${obs.summary_title || ""} ${itemSource}`,
                    });
                    return (
                      <div key={group.key}>
                        {/* Time Divider */}
                        <div className="flex items-center gap-3 mb-3">
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                          <span className="text-[10px] uppercase tracking-wider text-zinc-300 font-semibold">{timeLabel}</span>
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                        </div>
                        {/* WhatsApp-style message bubble */}
                        <div
                          onClick={(event) => {
                            const target = event.target as HTMLElement;
                            if (target.closest("a, button, input, textarea")) return;
                            const selection = window.getSelection();
                            if (selection && !selection.isCollapsed) return;
                            selectBrokerItem(obs);
                          }}
                          className={`w-full cursor-pointer text-left transition-all rounded-xl rounded-tl-none px-3 py-2 max-w-[85%] ${
                            isSelected
                              ? "bg-[#005c4b] shadow-lg shadow-emerald-900/20"
                              : "bg-[#1f2c34] hover:bg-[#243241]"
                          }`}
                        >
                          {/* Sender + time */}
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[10px] font-semibold text-[#3EE88A]">
                              {observationTypeIcon(obs.observation_type)} {opportunityLabel}
                            </span>
                            <span className="text-[10px] text-zinc-300 tabular-nums">{timeLabel}</span>
                          </div>
                          {/* Property summary line */}
                          <div className="flex items-center gap-1.5 text-[11px] text-zinc-300 flex-wrap">
                            {cleanMarketField(obs.property_type) && <span className="font-medium text-white">{cleanMarketField(obs.property_type)}</span>}
                            {obs.bhk && <span>{obs.bhk}</span>}
                            {hasObservationPrice(obs) && <span className="font-semibold text-white">{formatObservationPrice(obs)}</span>}
                            {obs.area_sqft && <span>{obs.area_sqft} sqft</span>}
                            {obs.micro_market && <span className="text-zinc-400">· {obs.micro_market}</span>}
                          </div>
                          {/* Title */}
                          {marketTitle && (
                            <div className="mt-1 text-[12px] font-semibold leading-relaxed text-white">
                              {marketTitle}
                            </div>
                          )}
                          {/* Source text */}
                          {fullSourceText && (
                            <div className="mt-1 select-text whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-300">
                              {stripEmojis(fullSourceText)}
                            </div>
                          )}
                          {/* Key fields as inline text */}
                          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-zinc-400">
                            {obs.bhk && <span>{stripEmojis(obs.bhk)}</span>}
                            {obs.building_name && <span className="text-zinc-300">{stripEmojis(obs.building_name)}</span>}
                            {obs.furnishing && <span>{stripEmojis(obs.furnishing)}</span>}
                            {obs.times_seen && obs.times_seen > 1 && <span className="text-zinc-500">Seen {obs.times_seen}x</span>}
                            {group.duplicateCount > 1 && <span className="text-zinc-500">Repeated {group.duplicateCount}x</span>}
                          </div>
                          <details className="mt-2 border-t border-white/10 pt-2" onClick={(event) => event.stopPropagation()}>
                            <summary className="cursor-pointer text-[9px] font-bold uppercase tracking-wider text-zinc-500 hover:text-zinc-300">
                              View source evidence
                            </summary>
                            {(obs.source_message || obs.raw_message || obs.normalized_message || obs.source_slice_text) && (
                              <div className="mt-2 border-t border-white/10 pt-2">
                                <div className="text-[8px] font-bold uppercase tracking-wider text-zinc-600">Relevant broker message</div>
                                <div className="mt-1 whitespace-pre-wrap break-words text-[10px] leading-relaxed text-zinc-400">
                                  {stripEmojis(obs.source_slice_text || obs.source_message || obs.raw_message || obs.normalized_message)}
                                </div>
                              </div>
                            )}
                          </details>
                          {/* Posted In */}
                          {(groupChannels.length > 0 || dmCount > 0) && (
                            <div className="mt-1 flex flex-wrap gap-1 items-center text-[8px]">
                              {groupChannels.length > 0 && (
                                <span title="Captured from an eligible WhatsApp group in your connected network." className="rounded-full border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-sky-300">
                                  Connected group
                                </span>
                              )}
                              {groupChannels.slice(0, 3).map((src: string, i: number) => (
                                <span key={i} className="text-zinc-500">
                                  {displayGroupName(src) || src.slice(-8)}
                                </span>
                              ))}
                              {groupChannels.length > 3 && <span className="text-zinc-500">+{groupChannels.length - 3}g</span>}
                              {dmCount > 0 && <span className="text-emerald-400/70">{dmCount}dm</span>}
                            </div>
                          )}
                          {/* Action row */}
                          <div className="mt-2 flex items-center gap-3 text-[10px]">
                            {resolvedBrokerPhone && (
                              <a
                                href={getWaLinkWithRecall(resolvedBrokerPhone, itemSource || marketTitle)}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => { e.stopPropagation(); trackBrokerWhatsAppOpen(resolvedBrokerPhone, "market_item"); }}
                                className="text-zinc-500 hover:text-white transition-colors"
                              >
                                WhatsApp
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                    })}
                  </>
                )}
              </main>
              <div className="shrink-0 border-t border-white/10 bg-black/90 p-3 pb-[env(safe-area-inset-bottom)] sm:px-4 sm:py-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-500">
                    Message broker
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {brokerReplyPhone ? displayPhoneString(brokerReplyPhone) : "Number not resolved yet"}
                  </div>
                </div>
                {brokerReplyPhone ? (
                  <>
                    <div className="relative flex items-end gap-2 rounded-2xl border border-white/10 bg-zinc-950 px-3 py-2 focus-within:border-white/35">
                      <textarea
                        value={brokerReplyText}
                        onChange={(e) => setBrokerReplyText(e.target.value)}
                        onInput={(e) => {
                          e.currentTarget.style.height = "auto";
                          e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 160)}px`;
                        }}
                        rows={1}
                        placeholder="Write a short note, question, or follow-up..."
                        className="min-h-8 max-h-40 flex-1 resize-none overflow-y-auto bg-transparent py-1 text-sm text-white placeholder-zinc-500 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSendBrokerReply()}
                        disabled={!brokerReplyText.trim() || sendingReply || !whatsappConnected || replyAccessLoading}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                        aria-label={sendingReply ? "Sending message" : "Send message"}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 text-[11px] text-zinc-500">
                        {whatsappConnected
                          ? "Replies route through the connected WhatsApp link and record the action in workspace analytics."
                          : "Connect your WhatsApp phone to reply from PropAI."}
                      </div>
                      <div className="shrink-0" />
                    </div>
                    {replyError && <div className="mt-2 text-[11px] text-red-400">{replyError}</div>}
                    {replyStatus && <div className="mt-2 text-[11px] text-zinc-300">{replyStatus}</div>}
                  </>
                ) : (
                    <div className="rounded-xl border border-white/10 bg-zinc-950 px-3 py-3 text-[11px] text-zinc-400">
                      No phone anchor was found in this broker&apos;s captured evidence yet. You can keep reviewing the parsed market items above; PropAI will link the number automatically when it appears in a future post.
                    </div>
                  )}
                </div>
            </>
          ) : selectedMsg ? (
            <>
              {/* Chat Thread Header */}
              <div className="shrink-0 px-3 py-2 border-b border-white/10 flex items-center justify-between bg-black/80 sm:px-5 sm:py-3">
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
                  <div className="w-9 h-9 rounded-full bg-[#3EE88A]/10 text-[#3EE88A] flex items-center justify-center font-bold text-sm shadow-inner">
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
                      <div className="hidden text-[10px] text-zinc-500 items-center gap-2 mt-0.5 flex-wrap sm:flex">
                        {selectedSubtitle && <span className="truncate">{selectedSubtitle}</span>}
                        {selectedCount ? (
                        <>
                          <span>•</span>
                          <span>{selectedCount.toLocaleString()} messages</span>
                        </>
                      ) : null}
                      {selectedBroker?.observation_count ? (
                        <>
                          <span>•</span>
                          <span title="Total parsed WhatsApp posts; the center feed deduplicates these into market items">
                            {groupedBrokerObservations.length} unique items shown of {selectedBroker.observation_count} parsed posts
                          </span>
                        </>
                      ) : null}
                      {selectedBroker?.last_seen && (
                        <>
                          <span>•</span>
                          <span title="Last WhatsApp message received for this broker">
                            Last message {formatAgeShort(selectedBroker.last_seen)}
                          </span>
                        </>
                      )}
                      {groupedBrokerObservations[0]?.last_seen && (
                        <>
                          <span>•</span>
                          <span title="Latest deduplicated market item timestamp">
                            Last market item {formatAgeShort(groupedBrokerObservations[0].last_seen)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <div
                    className={`hidden sm:inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${
                      replyAccessLoading
                        ? "border-white/10 bg-white/5 text-zinc-500"
                        : !whatsappConnected && !wabaConfigured
                          ? "border-amber-500/20 bg-amber-500/10 text-amber-300"
                          : canReplyWhatsApp
                            ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                            : "border-amber-500/20 bg-amber-500/10 text-amber-300"
                    }`}
                    title={currentTeamMember?.name ? `${currentTeamMember.name}` : undefined}
                  >
                    {replyAccessLoading
                      ? "Checking access"
                      : !whatsappConnected && !wabaConfigured
                        ? "WhatsApp disconnected"
                        : canReplyWhatsApp
                        ? `Can send${currentTeamMember?.name ? ` · ${currentTeamMember.name}` : ""}`
                        : `View only${currentTeamMember?.name ? ` · ${currentTeamMember.name}` : ""}`}
                  </div>
                  {!isGroupConversationSelected && resolveMessagePhone(selectedMsg) && (
                    <a
                      href={getWaLink(resolveMessagePhone(selectedMsg))}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1 bg-[#166534] text-green-100 hover:bg-[#15803d] rounded text-[10px] font-bold uppercase tracking-wider transition-colors touch-target"
                    >
                      Open chat
                    </a>
                  )}
                </div>
              </div>

              {/* Chat thread. Native selection/context menu stays available for copy/paste. */}
              <div
                ref={messageAreaRef}
                className="min-h-0 flex-1 overflow-y-auto px-3 py-3 propai-interaction-area sm:px-5 sm:py-4"
              >
                {conversationMessages.length === 0 && loadingConv ? (
                  <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                    Loading message thread...
                  </div>
                ) : (
                  <div className="space-y-5">
                    {loadingConv && (
                      <div className="sticky top-0 z-20 mx-auto w-fit rounded-full border border-white/10 bg-black/80 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 backdrop-blur">
                        Loading latest context...
                      </div>
                    )}
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
                            const isSelf = first.from_me === 1 || first.from_me === true || first.sender === "seed-bot" || first.sender === "system" || first.sender === "owner";
                            // WhatsApp Groups is evidence only.  Splitting a raw
                            // WhatsApp post into opportunities belongs solely in
                            // Market Inbox, never in the source mirror.
                            const blockHasSplitListings = !isGroupsView && block.some((m) => splitDelimitedListingText(m.message).length > 1);
                            const bubbleBg = isSelf
                              ? "bg-[#005c4b] rounded-2xl rounded-tr-none ml-auto"
                              : "bg-[#1f2c34] rounded-2xl rounded-tl-none";

                            return (
                              <div
                                key={first.id}
                                className={`${
                                  blockHasSplitListings ? "w-full rounded-none border-0 bg-transparent p-0" : `max-w-[72%] rounded-2xl p-4 ${bubbleBg}`
                                } space-y-2 relative transition-all ${isSelf && !blockHasSplitListings ? "text-right ml-auto" : ""}`}
                              >
<div className={`flex items-center gap-2 text-[10px] text-zinc-500 ${isSelf ? "justify-end" : "justify-between"}`}>
                                   <BrokerTooltip
                                     name={resolveMessageSenderName(first)} 
                                     phone={resolveMessagePhone(first)}
                                   />
                                  <span className="whitespace-nowrap">
                                    {block.length > 1
                                      ? `${messageTimeLabel(first)} - ${messageTimeLabel(last)}`
                                      : messageTimeLabel(first)}
                                  </span>
                                </div>
                                {block.map((m, msgIdx) => {
                                  const mPhone = resolveMessagePhone(m) || extractPhoneFromText(m.message);
                                  const mSenderName = resolveMessageSenderName(m);
                                  const isSelectedMessage = selectedMsg?.id === m.id;
                                  const useInnerCard = block.length > 1;
                                  const listingChunks = splitDelimitedListingText(m.message);
                                  const formatIssue = classifyFormatIssue(m);
                                  const suppressAsOpportunity = Boolean(formatIssue && formatIssue.severity === "high");
                                  const mBadges = (() => {
                                    const badges: { label: string }[] = [];
                                    if (suppressAsOpportunity) return badges;
                                    const intent = (m as api.InboxThread).parsed_intent || m.parsed_intent || inferredMessageIntent(m);
                                    const marketLabel = marketOpportunityLabel({ intent, text: m.message || "" });
                                    if (marketLabel && marketLabel !== "Market") {
                                      badges.push({ label: marketLabel });
                                    }
                                    if (m.attachments) {
                                      try {
                                        const att = typeof m.attachments === "string" ? JSON.parse(m.attachments) : m.attachments;
                                        if (att.image) badges.push({ label: "Image" });
                                        if (att.video) badges.push({ label: "Video" });
                                        if (att.document) badges.push({ label: "Document" });
                                      } catch {}
                                    }
                                    return badges;
                                  })();
                                   if (isGroupsView) {
                                    return (
                                      <div
                                        key={m.id}
                                        ref={el => { messageRefs.current[m.id] = el; }}
                                        onClick={() => selectMessage(m)}
                                        className="rounded-xl rounded-tl-none bg-[#1f2c34] px-3 py-2 max-w-[85%] cursor-pointer hover:bg-[#243241] transition-colors"
                                      >
                                        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                                          <span className="font-semibold text-[#3EE88A]">{mSenderName || "WhatsApp sender"}</span>
                                          <span className="whitespace-nowrap">{messageTimeLabel(m)}</span>
                                        </div>
                                        <div className="text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed text-left propai-message-content">
                                          {actualWhatsAppMessageText(m) || (
                                            <span className="italic text-zinc-500">This WhatsApp event has no text body.</span>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  }
                                  return (
                                    <div
                                      key={m.id}
                                      ref={el => { messageRefs.current[m.id] = el; }}
                                      onClick={() => selectMessage(m)}
                                      className={`relative group/message transition-all cursor-pointer ${
                                        listingChunks.length > 1
                                          ? "w-full"
                                          : useInnerCard
                                            ? "rounded-lg border border-transparent px-2.5 py-2 hover:bg-white/[0.025] hover:border-white/[0.06]"
                                            : ""
                                      }`}
                                    >
                                      {formatIssue && <MissingDetailsNotice issue={formatIssue} />}
                                      {listingChunks.length > 1 ? (
                                        <div className="space-y-2">
                                          <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                                            <div className="min-w-0">
                                              <div className="text-[11px] font-semibold text-zinc-300">{mSenderName || resolveMessageSenderName(first)}</div>
                                              <span className="font-semibold uppercase tracking-wider">
                                                Split into {listingChunks.length} codes
                                              </span>
                                            </div>
                                            <span className="text-zinc-600">Original WhatsApp post</span>
                                          </div>
                                          <div className="divide-y divide-white/[0.06]">
                                          {listingChunks.map((chunk, chunkIndex) => {
                                            const signedChunk = stripEmojis(appendBrokerSignature(chunk, mSenderName || resolveMessageSenderName(first), mPhone || resolveMessagePhone(first)));
                                            const code = splitCode(m.id, chunkIndex);
                                            const chunkIntent = inferredMessageIntent({ ...m, message: signedChunk });
                                            const chunkLabel = marketOpportunityLabel({
                                              intent: chunkIntent || (m as api.InboxThread).parsed_intent || m.parsed_intent,
                                              text: signedChunk,
                                            });
                                            return (
                                              <div
                                                key={`${m.id}-chunk-${chunkIndex}`}
                                                className="py-3 first:pt-2 last:pb-2"
                                              >
                                                <div className="mb-2 flex items-center justify-between gap-2">
                                                  <div className="flex items-center gap-1.5">
                                                    {chunkLabel && chunkLabel !== "Market" && (
                                                      <span className={`badge ${marketOpportunityColor(chunkLabel)} text-[8px] px-1.5 py-0.5`}>
                                                        {chunkLabel}
                                                      </span>
                                                    )}
                                                    <span className="text-[8px] font-bold uppercase tracking-wider text-zinc-500">
                                                      {code}
                                                    </span>
                                                  </div>
                                                </div>
                                                <div className="text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed text-left propai-message-content">
                                                  <WhatsAppMessage
                                                    text={signedChunk}
                                                    sender={mSenderName}
                                                    senderPhone={mPhone}
                                                    entities={buildMessageEntities({ ...m, message: signedChunk })}
                                                    onEntityClick={handleEntityClick}
                                                    flatMultiBlocks
                                                  />
                                                </div>
                                                <MoneySignalChips text={signedChunk} label={chunkLabel} />
                                                <div className="mt-2 flex items-center justify-end gap-2">
                                                  {mPhone && (
                                                    <a
                                                      href={getWaLinkWithRecall(mPhone, signedChunk)}
                                                      target="_blank"
                                                      rel="noopener noreferrer"
                                                      className="inline-flex items-center gap-1.5 rounded-md border border-[#3EE88A]/20 bg-[#3EE88A]/10 px-2 py-1 text-[10px] font-bold text-[#3EE88A] hover:bg-[#3EE88A]/15"
                                                      title="Send this full item to the broker on WhatsApp"
                                                      onClick={(e) => e.stopPropagation()}
                                                    >
                                                      <MessageSquare className="h-3 w-3" strokeWidth={1.8} />
                                                      WhatsApp
                                                    </a>
                                                  )}
                                                  <button
                                                    onClick={(e) => { e.stopPropagation(); selectMessage(m); }}
                                                    className="text-[10px] font-semibold text-[#3EE88A] hover:underline"
                                                  >
                                                    Analyze
                                                  </button>
                                                </div>
                                              </div>
                                            );
                                          })}
                                          </div>
                                        </div>
                                      ) : (
                                        <div>
                                          {mBadges.length > 0 && (
                                            <div className="mb-2 flex flex-wrap gap-1">
                                              {mBadges.map((b, bi) => (
                                                <span key={bi} className="badge badge-neutral text-[8px] px-1.5 py-0.5">
                                                  {b.label}
                                                </span>
                                              ))}
                                            </div>
                                          )}
                                          <div className="text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed text-left propai-message-content">
                                            <WhatsAppMessage
                                              text={m.message || ""}
                                              sender={mSenderName}
                                              senderPhone={mPhone}
                                              entities={buildMessageEntities(m)}
                                              onEntityClick={handleEntityClick}
                                              flatMultiBlocks={listingChunks.length > 1}
                                            />
                                          </div>
                                          <MoneySignalChips text={m.message || ""} label={mBadges[0]?.label} />
                                        </div>
                                      )}
                                      {(m.duplicate_count || 0) > 1 && (
                                        <div className="mt-2 flex flex-wrap items-center gap-1 text-[9px] text-zinc-500">
                                          <span>Repeated {m.duplicate_count}x</span>
                                          {(m.duplicate_group_names || []).slice(0, 3).map((groupName) => (
                                            <span key={groupName} className="rounded-full border border-white/10 bg-zinc-900 px-1.5 py-0.5">
                                              {displayGroupName(groupName)}
                                            </span>
                                          ))}
                                        </div>
                                      )}

                                      <div className={`${listingChunks.length > 1 ? "hidden" : "flex"} items-center justify-end gap-2 pt-1.5 mt-1.5 border-t border-white/5`}>
                                        <div className="hidden">
                                          {mBadges.map((b, bi) => (
                                            <span key={bi} className="badge badge-neutral text-[8px] px-1 py-0">
                                              {b.label}
                                            </span>
                                          ))}
                                        </div>

                                        <div className="flex items-center gap-2">
                                          {mPhone && (
                                            <a
                                              href={getWaLinkWithRecall(mPhone, m.message || "")}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="inline-flex items-center gap-1.5 rounded-md border border-[#3EE88A]/20 bg-[#3EE88A]/10 px-2 py-1 text-[10px] font-bold text-[#3EE88A] hover:bg-[#3EE88A]/15"
                                              title="Message this broker on WhatsApp"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <MessageSquare className="w-3 h-3" strokeWidth={1.8} />
                                              WhatsApp
                                            </a>
                                          )}
                                          <button
                                            type="button"
                                            onClick={async (e) => {
                                              e.stopPropagation();
                                              try {
                                                await navigator.clipboard.writeText(m.message || "");
                                                setCopiedMessageId(m.id);
                                                window.setTimeout(() => setCopiedMessageId((current) => current === m.id ? null : current), 1500);
                                              } catch {
                                                setCopiedMessageId(null);
                                              }
                                            }}
                                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-zinc-900 text-zinc-400 transition-colors hover:border-[#3EE88A]/40 hover:text-[#3EE88A]"
                                            title={copiedMessageId === m.id ? "Copied" : "Copy message"}
                                            aria-label={copiedMessageId === m.id ? "Copied" : "Copy message"}
                                          >
                                            {copiedMessageId === m.id
                                              ? <Check className="h-3.5 w-3.5 text-[#3EE88A]" />
                                              : <Copy className="h-3.5 w-3.5" />}
                                          </button>
                                          <button
                                            onClick={(e) => { e.stopPropagation(); selectMessage(m); }}
                                            className="text-[10px] font-semibold text-[#3EE88A] hover:underline"
                                          >
                                            Analyze
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
              <div className="shrink-0 border-t border-white/10 bg-black/90 px-3 py-2.5 pb-[env(safe-area-inset-bottom)] sm:px-4 sm:py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 hidden items-center justify-between gap-3 sm:flex">
                      <div className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-500">
                        Reply in PropAI workspace
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {selectedConversationJid
                          ? isGroupConversationSelected
                            ? "Group reply"
                            : "Direct reply"
                          : "No destination"}
                      </div>
                    </div>

                    {replyTargetMessage && (
                      <div className="mb-2 rounded-xl border border-white/10 bg-zinc-950 px-3 py-2 text-[11px] text-zinc-400">
                        <div className="font-semibold text-zinc-200">
                          Replying to {resolveMessageSenderName(replyTargetMessage)}
                        </div>
                        <div className="mt-0.5 line-clamp-2">
                          {(replyTargetMessage.message || "").trim() || "Selected conversation"}
                        </div>
                      </div>
                    )}
                    {sessionCountdown && !isGroupConversationSelected && (
                      <div className={`mb-2 rounded-xl px-3 py-2 text-[11px] ${
                        sessionStatus?.expired
                          ? "border border-red-500/20 bg-red-500/10 text-red-300"
                          : sessionStatus && sessionStatus.remaining_seconds < 3600
                            ? "border border-amber-500/20 bg-amber-500/10 text-amber-300"
                            : "border border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                      }`}>
                        {sessionStatus?.expired
                          ? "24h session expired — waiting for customer to message again"
                          : `Reply window: ${sessionCountdown}`}
                      </div>
                    )}
                    {replyAccessLoading ? (
                      <div className="rounded-xl border border-white/10 bg-zinc-950 px-3 py-3 text-[11px] text-zinc-400">
                        Checking reply access...
                      </div>
                    ) : !whatsappConnected && !wabaConfigured ? (
                      <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3 text-[11px] text-amber-100">
                        <div className="font-semibold">WhatsApp is not connected yet.</div>
                        <div className="mt-1 text-amber-100/75">
                          Wait for WhatsApp to reconnect. If it keeps failing, reopen QR pairing.
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <a
                            href="/whatsapp?tab=numbers"
                            className="inline-flex h-8 items-center justify-center rounded-lg bg-[#3EE88A] px-3 text-[10px] font-bold text-black transition-colors hover:bg-[#35d47c]"
                          >
                            Open Connection Center
                          </a>
                        </div>
                      </div>
                    ) : !canReplyWhatsApp ? (
                      <div className="rounded-xl border border-white/10 bg-zinc-950 px-3 py-3 text-[11px] text-zinc-400">
                        <div className="font-semibold text-white">Reply access is disabled for your role.</div>
                        <div className="mt-1 text-zinc-500">
                          This composer needs the <span className="font-mono text-zinc-300">reply_whatsapp</span> permission.
                          Ask an owner or admin to enable it in Team roles.
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <a
                            href="/profile/team"
                            className="inline-flex h-8 items-center justify-center rounded-lg bg-[#3EE88A] px-3 text-[10px] font-bold text-black transition-colors hover:bg-[#35d47c]"
                          >
                            Open Team Roles
                          </a>
                        </div>
                      </div>
                    ) : canReplyWhatsApp ? (
                      <>
                        <input
                          ref={attachmentInputRef}
                          type="file"
                          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.rtf,.csv,.xls,.xlsx,.ppt,.pptx"
                          className="hidden"
                          onChange={(event) => {
                            const file = event.target.files?.[0] || null;
                            if (!file) return;
                            setReplyAttachment(file);
                            setReplyError("");
                            setReplyStatus("");
                          }}
                        />
                        <div className="rounded-2xl border border-white/10 bg-zinc-950/95 px-3 pb-2.5 pt-2 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
                          {replyAttachment && (
                            <FileAttachment name={replyAttachment.name} meta={`${inferAttachmentMediaType(replyAttachment).toUpperCase()} · ${formatFileSize(replyAttachment.size)}`} onRemove={() => { setReplyAttachment(null); if (attachmentInputRef.current) attachmentInputRef.current.value = ""; }} className="mb-2" />
                          )}
                          <div className="relative">
                            <textarea
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              onInput={(e) => {
                                e.currentTarget.style.height = "auto";
                                e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 160)}px`;
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  void handleSendReply();
                                }
                              }}
                              placeholder={
                                selectedConversationJid
                                  ? "Type a reply. Shift+Enter adds a new line."
                                  : "Select a conversation to reply."
                              }
                              rows={1}
                              disabled={sendingReply || !selectedConversationJid}
                              className="min-h-8 max-h-40 w-full resize-none rounded-xl border-0 bg-transparent px-1 py-1.5 pl-10 pr-12 text-sm text-white placeholder-zinc-500 outline-none transition-colors focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <button
                              type="button"
                              onClick={() => attachmentInputRef.current?.click()}
                              disabled={sendingReply || !selectedConversationJid}
                              className="absolute bottom-2 left-2 flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-zinc-400 transition-colors hover:border-[#3EE88A]/40 hover:text-[#3EE88A] disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label="Attach a file"
                              title="Attach a file"
                            >
                              <Paperclip className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleSendReply()}
                              disabled={sendingReply || (!replyText.trim() && !replyAttachment) || !selectedConversationJid}
                              className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-lg bg-[#3EE88A] text-black transition-colors hover:bg-[#35d47c] disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label={sendingReply ? "Sending reply" : "Send reply"}
                            >
                              <Send className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="mt-2 flex items-center justify-between gap-3">
                          <div className="min-h-[1rem] text-[11px]">
                            {replyError ? (
                              <span className="text-red-400">{replyError}</span>
                            ) : replyStatus ? (
                              <span className="text-[#3EE88A]">{replyStatus}</span>
                            ) : selectedConversationJid ? (
                              <span className="text-zinc-500 hidden sm:inline">Replies are sent through the connected WhatsApp number.</span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            {replyFallbackPhone && (
                              <a
                                href={getWaLinkWithRecall(replyFallbackPhone, replyText || replyTargetMessage?.message || "")}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-800 px-3 text-[10px] font-semibold text-zinc-200 transition-colors hover:border-[#3EE88A]/40 hover:text-[#3EE88A]"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
                                Open chat
                              </a>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3 text-[11px] text-amber-100">
                        <div className="font-semibold">Direct sending is disabled for your account.</div>
                        <div className="mt-1 text-amber-100/75">
                          You can still open WhatsApp and continue there, or ask an admin to grant Reply from WhatsApp.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-zinc-500 space-y-2">
              <MessageSquare className="h-8 w-8 text-zinc-700" strokeWidth={1.5} />
              <h3 className="text-sm font-semibold text-zinc-300">No conversation selected</h3>
              <p className="text-xs max-w-xs">
                Select a WhatsApp group or broker to see market messages, evidence, and workspace context.
              </p>
            </div>
          )}
        </div>

      </div>
      </div>
  );
}

/* eslint-enable */

export default function BrokerWorkspacePage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
      <InboxPageInner />
    </Suspense>
  );
}

export function WhatsAppGroupsWorkspacePage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
      <InboxPageInner defaultView="groups" />
    </Suspense>
  );
}
