"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useRef, useCallback, useMemo, Suspense, lazy } from "react";
import nextDynamic from "next/dynamic";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import * as api from "@/lib/api";
import BrokerAvatar from "@/components/BrokerAvatar";
import WhatsAppMessage, { MessageEntity } from "@/components/WhatsAppMessage";
import TextSelectionMenu from "@/components/TextSelectionMenu";
import NotesPanel from "@/components/notes/NotesPanel";
const CombinedLocalityDialog = nextDynamic(() => import("@/components/CombinedLocalityDialog").then((m) => ({ default: m.CombinedLocalityDialog })), { ssr: false });
const AddToClientBucket = nextDynamic(() => import("@/components/AddToClientBucket"), { ssr: false });
import ResizablePanel from "@/components/ResizablePanel";
import { InboxChatPanel } from "@/components/InboxChatPanel";
import { entityProfileHref } from "@/lib/entity-links";
import { classifyFormatIssue, type FormatIssue } from "@/lib/format-issues";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import {
  Users,
  User,
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
  EyeOff,
  Eye,
  TrendingUp,
  Home,
  ChevronLeft,
} from "lucide-react";

const PAGE_SIZE = 100;
const BROKER_PAGE_SIZE = 25;

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
  if (!text) return "";
  return text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{231A}-\u{23FF}\u{25A0}-\u{25FF}\u{2934}-\u{2935}\u{2B05}-\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{2122}\u{2139}\u{24C2}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2600}-\u{27EB}]/gu, "").trim();
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

function observationTypeColor(_type?: string): string {
  return "badge-neutral";
}

function inferOpportunityKind(input: { intent?: string; observation_type?: string; text?: string }) {
  const intent = (input.intent || "").toUpperCase();
  const type = (input.observation_type || "").toUpperCase();
  const text = (input.text || "").toLowerCase();
  const hasRequirementSignal = /\b(requirement|required|wanted|looking|need|client wants|buyer|tenant)\b/.test(text);
  const hasListingSignal = /\b(available|on rent|for rent|rent only|for sale|on sale|distress|outright|asking|inspection|call|contact)\b/.test(text);
  if (
    type === "REQUIREMENT" ||
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

function inferOpportunitySide(input: { intent?: string; text?: string }) {
  const intent = (input.intent || "").toUpperCase();
  const text = (input.text || "").toLowerCase();
  const rentSignal = /\b(on rent|for rent|rent only|rent\s*:|rental|lease|leave\s*&\s*license|l\s*&\s*l|per month|p\.?m\.?)\b/.test(text);
  const saleSignal = /\b(for sale|on sale|distress sale|outright|sale price|reserve price)\b/.test(text);
  if (rentSignal) return "Rent";
  if (saleSignal) return "Sale";
  if (["RENT", "LEASE", "RENTAL_SEEKER"].includes(intent)) return "Rent";
  if (["SELL", "SALE"].includes(intent)) return "Sale";
  if (["BUY", "BUYER", "REQUIREMENT", "WANTED"].includes(intent)) {
    if (/\b(rent|rental|lease|tenant)\b/.test(text)) return "Rent";
    return "Buy";
  }
  if (/\b(rent|rental|lease|tenant)\b/.test(text)) return "Rent";
  if (/\b(sale|sell|outright|distress|asking|reserve price|for sale)\b/.test(text)) return "Sale";
  return "";
}

function marketOpportunityLabel(input: { intent?: string; observation_type?: string; text?: string }) {
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

function toInboxThread(message: api.RawMessage): api.InboxThread {
  const conversationType =
    message.conversation_type ||
    message.chat_type ||
    (message.group_name && message.group_name !== "seed" && message.group_name !== "seed-bot" ? "group" : "direct");
  const conversationKey = (
    message.conversation_key ||
    message.chat_id ||
    message.sender_jid ||
    message.group_name ||
    ""
  ).trim();

  return {
    ...message,
    conversation_type: conversationType === "group" ? "group" : "direct",
    conversation_key: conversationKey,
    conversation_name: message.conversation_name || message.chat_name || message.group_name || message.sender || "Conversation",
    message_count: message.message_count || 1,
    chat_id: message.chat_id,
    chat_type: message.chat_type,
    chat_name: message.chat_name,
    latest_message_at: message.latest_message_at,
  } as api.InboxThread;
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
  latest_parsed_id?: string | number;
  listing_index?: string | number;
  latest_raw_message_id?: string | number;
  raw_message_id?: string | number;
  raw_message?: string;
  summary_title?: string;
  broker_phone?: string;
  broker_name?: string;
  evidence_list?: BrokerEvidenceItem[];
  first_seen?: string;
  last_seen?: string;
  observation_type?: string;
  intent?: string;
  property_type?: string;
  bhk?: string;
  price?: number;
  price_unit?: string;
  area_sqft?: number;
  furnishing?: string;
  location_raw?: string;
  micro_market?: string;
  alternate_intent?: string;
  times_seen?: number;
  building_name?: string;
};

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

interface InboxPageInnerProps {
  defaultView?: string;
}

function InboxPageInner({ defaultView }: InboxPageInnerProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
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
  const [teachingMsgId, setTeachingMsgId] = useState<number | null>(null);
  
  // Center Panel States
  const [conversationMessages, setConversationMessages] = useState<api.RawMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [replyText, setReplyText] = useState("");
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
  const [chatPanelCollapsed, setChatPanelCollapsed] = useState(false);
  const [chatPanelWidth, setChatPanelWidth] = useState(540);
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
        primaryHref: "/connections",
        primaryCta: "Open Connection Center",
        secondaryHref: "/connections",
        secondaryCta: "Open Connections",
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
        href: "/audit",
        cta: "Open Audit",
      };
    }
    return {
      title: "Connect WhatsApp first",
      description:
        marketAccess?.message ||
        "Connect WhatsApp and start your trial to unlock your personalized broker market feed.",
      href: "/connections",
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
        primaryHref: "/connections",
        primaryCta: "Open Connection Center",
        secondaryHref: "/connections",
        secondaryCta: "Open Connections",
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
      const parsedItemId = (obs as any).latest_parsed_id || obs.id || "";
      const listingIndex = (obs as any).listing_index;
      const opportunitySignature = normalizeMessageForDedupe(
        [
          parsedItemId,
          listingIndex != null ? `item ${listingIndex}` : "",
          obs.summary_title,
          obs.intent,
          obs.bhk,
          obs.building_name,
          obs.micro_market,
          obs.location_raw,
          obs.price,
          obs.price_unit,
        ].filter(Boolean).join(" ")
      );
      const normalizedText = opportunitySignature || normalizeMessageForDedupe(obs.raw_message || "");
      const brokerKey = normalizeMessageForDedupe(
        [obs.broker_phone, obs.broker_name, selectedBroker?.phone, selectedBroker?.canonical_name].filter(Boolean).join(" ")
      );
      const key = normalizedText
        ? `${brokerKey || "broker"}::${rawMessageId || "raw"}::${normalizedText}`
        : `${rawMessageId || "raw"}::${parsedItemId || listingIndex || ""}`;
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
    const intent = (obs.intent || obs.alternate_intent || "").toUpperCase();
    const text = `${obs.summary_title || ""} ${obs.raw_message || ""}`.toLowerCase();
    return (
      ["BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER", "WANTED"].includes(intent)
      || /\b(requirement|required|wanted|looking|need|buyer|tenant)\b/.test(text)
    );
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
  const [actionUndo, setActionUndo] = useState<{phone: string; name: string} | null>(null);
  const [openMenuBroker, setOpenMenuBroker] = useState<string | null>(null);
  const autoSelectedThreadRef = useRef<string>("");

  const handleHideBroker = async (phone: string) => {
    try {
      const res = await api.hideBroker(phone);
      setActionMessage(`Hidden: ${res.broker_name}`);
      setActionUndo({ phone, name: res.broker_name });
      setBrokerFeed((prev) => prev.filter((b: any) => b.primary_phone !== phone));
      const selectedBrokerPhone = normalizeRealPhone(selectedBroker?.phone || selectedBroker?.id || "");
      if (selectedBrokerPhone === normalizeRealPhone(phone)) {
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
  const pathname = usePathname();
  const msgParam = searchParams.get("message");
  const brokerParam = searchParams.get("broker");
  const observationParam = searchParams.get("observation");
  const isGroupsView = defaultView === "groups" || searchParams.get("view") === "groups" || currentSlug === "groups";

  useEffect(() => {
    if (searchParams.get("view") === "groups") {
      router.replace("/whatsapp-groups");
    }
  }, [searchParams, router]);

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

  // Auto-navigate to broker or observation from URL params
  const initialNavDone = useRef(false);
  useEffect(() => {
    if (initialNavDone.current) return;
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
        // A deep-linked broker does not need to be present on the current
        // feed page. Resolve the canonical identity directly so name-only
        // brokers remain usable while the left list paginates independently.
        const fallbackName = brokerParam.replace(/^name:/i, "").trim();
        selectBroker({
          id: brokerParam,
          identity_key: brokerParam,
          primary_phone: brokerParamPhone || brokerParam,
          canonical_name: fallbackName || (brokerParamPhone ? `+91 ${brokerParamPhone}` : "Broker"),
          observation_count: 0,
          listing_count: 0,
          requirement_count: 0,
          building_count: 0,
          channels: [],
        });
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
              (brokerPhone && String(b.identity_key || b.primary_phone || b.id || "").trim().toLowerCase() === brokerPhone.toLowerCase()) ||
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
  const loadFeed = useCallback(async (append = false, requestedOffset = offset) => {
    setLoadingLeft(true);
    try {
      const threadMsgs = await api.getInboxThreads(PAGE_SIZE, requestedOffset);
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
      try {
        const rawMsgs = await api.getRaw(PAGE_SIZE, requestedOffset);
        const fallbackThreads = rawMsgs.map(toInboxThread);
        setMessages((prev) => (append ? [...prev, ...fallbackThreads] : fallbackThreads));
        if (!append) {
          setGroups([]);
          setAllSuggestions([]);
        }
      } catch (fallbackError) {
        console.error("Failed to load raw inbox fallback:", fallbackError);
      }
    } finally {
      setLoadingLeft(false);
    }
  }, [marketAccess, offset]);

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
      const data = await api.getBrokersFeed(BROKER_PAGE_SIZE, requestedOffset);
      setBrokerFeed(data);
    } catch (e) {
      console.error("Failed to load broker feed:", e);
    } finally {
      setLoadingBrokerFeed(false);
    }
  }, [connectionPending, brokerOffset]);

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
    return text;
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
      if (isLikelyBrokerDisplayName(sender)) return sender;
      return displayPhoneString(phone) || "Direct Message";
    }
    const knownGroupName = resolveKnownGroupName(rawConversation);
    if (knownGroupName && !isExplicitDirect) return knownGroupName;
    if (isExplicitGroup && rawConversation) return displayGroupName(rawConversation);
    const sender = (msg.sender || "").trim();
    const phone = resolveMessagePhone(msg);
    if (isRawWhatsAppId(sender)) return displayPhoneString(phone) || "Direct Message";
    if (isLikelyBrokerDisplayName(sender)) return sender;
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
    const explicitType = conversationTypeFor(msg);
    if (explicitType === "direct") return false;
    if (explicitType === "group") return true;
    const candidates = [
      msg.group_name,
      msg.chat_name,
      msg.conversation_name,
      msg.chat_id,
      msg.conversation_key,
      msg.sender_jid,
    ]
      .map((value) => (value || "").trim())
      .filter(Boolean);
    if (candidates.some(isGroupJidLike)) return true;
    return candidates.some((value) => Boolean(resolveKnownGroupName(value)));
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
      return msg.broker_name || sender;
    }
    return msg.broker_name || (phone ? displayPhoneString(phone) : "");
  };

  const appendBrokerSignature = (text: string, brokerName?: string, brokerPhone?: string) => {
    const cleanText = String(text || "").trim();
    const name = stripEmojis(brokerName || "").trim();
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
      const existing = await api.fetchJSON<any[]>(`/trainer/terms?status=combined_locality`);
      const alreadyExists = existing.some((t: any) => t.term.toLowerCase() === surface.toLowerCase());
      
      let termId: number;
      if (alreadyExists) {
        const term = existing.find((t: any) => t.term.toLowerCase() === surface.toLowerCase());
        termId = term.id;
      } else {
        // Add to trainer
        const context = selectedMsgDetails?.raw?.message?.slice(0, 120) || "";
        const addData = await api.fetchJSON<any>("/trainer/inline-resolve", {
          method: "POST",
          body: JSON.stringify({
            text: surface,
            raw_message_id: selectedMsg?.id,
            status: "combined_locality",
            expands_to: expandsTo,
          }),
        });
        if (!addData.status || addData.status === "error") {
          alert("Failed to save combined locality");
          return;
        }
        // Get the term ID
        const terms = await api.fetchJSON<any[]>(`/trainer/terms?status=combined_locality`);
        const term = terms.find((t: any) => t.term.toLowerCase() === surface.toLowerCase());
        termId = term?.id;
      }
      
      if (termId) {
        // Resolve with expands_to
        await api.fetchJSON(`/trainer/resolve`, {
          method: "POST",
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
  const hasSearchQuery = query.length > 0;

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
    .filter((m) => isLikelyGroupConversation(m))
    .map((m) => ({
      conversationKey: m.chat_id || m.conversation_key || m.group_name,
      rawGroupName: m.group_name,
      groupLabel: displayGroupName(m.chat_name || m.conversation_name || m.group_name),
      title: displayChatTitle(m),
      latest: m,
      count: m.message_count || 0,
    }))
    .sort((a, b) => (messageDateValue(b.latest)?.getTime() || 0) - (messageDateValue(a.latest)?.getTime() || 0));

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
  const filteredBrokerFeed = !query
    ? brokerFeed
    : brokerFeed.filter((b: any) => {
        const haystack = [
          b.canonical_name,
          b.name,
          b.primary_phone,
          b.identity_key,
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

  const threadFallbackItems: ThreadFallbackItem[] = [
    ...((searchParams.get("view") === "groups" || currentSlug === "groups")
      ? groupChats.map((chat) => ({
          key: String(chat.conversationKey || ""),
          title: chat.title,
          subtitle: chat.groupLabel && chat.groupLabel !== chat.title ? chat.groupLabel : "WhatsApp group",
          latest: chat.latest,
          count: chat.count,
          type: "group" as const,
        }))
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
  const showThreadFallback = !isBrokerView || (!loadingBrokerFeed && filteredBrokerFeed.length === 0);
  const brokerHasMore = brokerFeed.length >= BROKER_PAGE_SIZE;
  const brokerPage = Math.floor(brokerOffset / BROKER_PAGE_SIZE) + 1;
  const messagePage = Math.floor(offset / PAGE_SIZE) + 1;

  const leftListEmpty = (() => {
    if (loadingSlugs || loadingLeft || (isBrokerView && loadingBrokerFeed)) return false;
    if (isBrokerView) return filteredBrokerFeed.length === 0 && threadFallbackItems.length === 0;
    return threadFallbackItems.length === 0;
  })();
  const initialLeftPanelLoading = isBrokerView
    ? brokerFeed.length === 0 && (loadingBrokerFeed || loadingSlugs)
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
    if (!text || sendingReply || !selectedConversationJid || !canReplyWhatsApp || (!whatsappConnected && !wabaConfigured)) return;

    setSendingReply(true);
    setReplyError("");
    setReplyStatus("");

    const nowIso = new Date().toISOString();

    try {
      await api.sendWabaMessage({
        to: replyFallbackPhone || "",
        text,
        remote_jid: selectedConversationJid,
      });

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
        message: text,
        message_type: "text",
        timestamp: nowIso,
        source: "WABA_OUTBOUND",
        event_id: `local-${Date.now()}`,
        message_uid: `local-${Date.now()}`,
        raw_payload: JSON.stringify({ local: true, remote_jid: selectedConversationJid }),
        synced_at: nowIso,
        pipeline_version: "propai-web-send",
        from_me: true,
        created_at: nowIso,
      };
      setConversationMessages((prev) => [...prev, optimisticMessage]);
      setReplyText("");
      if (replyDraftKey) {
        try {
          window.localStorage.removeItem(replyDraftKey);
        } catch {
          // Ignore local storage failures.
        }
      }
      setReplyStatus("Message sent");
    } catch (e: any) {
      const message = e?.message || "Failed to send reply";
      setReplyError(message);
      if (/whatsapp|ingestor|connect/i.test(message)) {
        setReplyStatus("WhatsApp is disconnected. Open QR to reconnect.");
      } else if (replyFallbackPhone) {
        setReplyStatus("Send failed. Open WhatsApp to continue.");
      }
    } finally {
      setSendingReply(false);
    }
  }, [
    isGroupConversationSelected,
    replyFallbackPhone,
    replyTargetMessage,
    replyText,
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
    if (isMobile) setMobileView("conversation");
    loadMessageDetails(msg.id);
    updateUrlMessage((msg as any).chat_id || (msg as any).conversation_key || msg.group_name || "", msg.id);
    const el = messageRefs.current[msg.id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isMobile, updateUrlMessage]);

  // 3c. Select a broker card -> show observations in the center workspace
  const selectBroker = useCallback(async (broker: any, focusObsRawId?: number) => {
    if (isMobile) setMobileView("conversation");
    setOpportunityFilter("all");
    const brokerPhone = normalizeRealPhone(broker.primary_phone || broker.phone || broker.identity_key || broker.id || "");
    const rawBrokerName = stripEmojis(broker.canonical_name || broker.name || "").trim();
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
    // Load observations for center timeline. One broker selection maps to one
    // canonical request; equivalent phone/name retries previously multiplied
    // slow scans and left the UI spinning for minutes.
    brokerObservationRequestRef.current?.abort();
    const request = new AbortController();
    brokerObservationRequestRef.current = request;
    setBrokerObsError("");
    setSelectedBrokerObservations([]);
    setLoadingBrokerObs(true);
    try {
      const observationKey = brokerPhone
        || (/^name:/i.test(brokerIdentityKey) ? brokerIdentityKey : "")
        || (brokerName ? `name:${brokerName}` : brokerIdentityKey);
      const obs = await api.getObservationsFeed(200, 0, observationKey, request.signal);
      if (request.signal.aborted || brokerObservationRequestRef.current !== request) return;
      setSelectedBrokerObservations(obs);
      const rawId = focusObsRawId || obs?.[0]?.latest_raw_message_id || obs?.[0]?.raw_message_id;
      if (rawId) {
        updateUrlObservation(rawId);
        loadMessageDetails(rawId, { setSelectedRaw: true, preserveProfiles: true });
      }
    } catch (e) {
      if (request.signal.aborted || brokerObservationRequestRef.current !== request) return;
      console.error("Failed to load broker observations:", e);
      setSelectedBrokerObservations([]);
      setBrokerObsError("Market items could not be loaded. Please retry.");
    } finally {
      if (brokerObservationRequestRef.current === request) {
        setLoadingBrokerObs(false);
        brokerObservationRequestRef.current = null;
      }
    }
  }, [updateUrlBroker, updateUrlObservation]);

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
    }
  };

  const selectBrokerObservation = (obs: any) => {
    const rawId = obs.latest_raw_message_id || obs.raw_message_id;
    if (!rawId) return;
    if (isMobile) setMobileView("conversation");
    updateUrlObservation(rawId);
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
    <div className="flex flex-col h-[calc(100dvh-104px)] min-h-0 max-h-[calc(100dvh-104px)] overflow-hidden bg-black lg:h-full lg:max-h-full lg:rounded-2xl lg:border lg:border-white/10">
      
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
          <div className="p-3 sm:p-4 border-b border-white/10 space-y-2 sm:space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold tracking-wider text-white uppercase">
                  {isGroupsView ? "WhatsApp Groups" : "Market Inbox"}
                </div>
                <div className="hidden sm:block text-[10px] text-zinc-500 mt-0.5">
                  {isGroupsView
                    ? "Raw WhatsApp groups with inline PropAI composer"
                    : "WhatsApp conversations with PropAI memory"}
                </div>
              </div>
              <button
                onClick={() => {
                  resetSelectionForPageChange();
                  setOffset(0);
                  prevOffsetRef.current = 0;
                  loadFeed(false, 0);
                }}
                className="text-[10px] sm:text-xs text-[#3EE88A] hover:underline"
                disabled={loadingLeft}
              >
                {loadingLeft ? "Refreshing..." : <><span className="sm:hidden">↻</span><span className="hidden sm:inline">Refresh</span></>}
              </button>
            </div>
            
            <input
              type="text"
              placeholder="Search messages, brokers, localities"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-zinc-900 border border-white/10 rounded-lg text-xs text-white focus:border-[#3EE88A] focus:outline-none transition-colors"
            />

            {/* Slug-based View Tabs */}
            <div className="flex gap-1 bg-zinc-900 p-0.5 rounded-lg border border-[rgba(255,255,255,0.03)]" style={{ gridTemplateColumns: `repeat(${Math.min(slugs.length, 5)}, 1fr)` }}>
              {slugs.length === 0 ? (
                <>
                  <div className="flex-1 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider text-center text-zinc-500 bg-zinc-800">
                    {isGroupsView ? "Groups" : "Brokers"}
                  </div>
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
            {GATING_ENABLED && loadingMarketAccess ? (
              <div className="p-8 text-center text-xs text-zinc-500">Checking workspace access...</div>
            ) : connectionPending ? (
              <div className="p-5 text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300">
                  <MessageSquare className="h-4 w-4" strokeWidth={1.6} />
                </div>
                <div className="text-sm font-bold text-white">
                  {whatsappDisconnected ? "Scan WhatsApp QR to continue" : accessHealthGate.title}
                </div>
                <p className="mx-auto mt-2 max-w-[260px] text-xs leading-relaxed text-zinc-500">
                  {whatsappDisconnected
                    ? "Scan the QR code in Connection Center to unlock Market Inbox and WhatsApp Groups."
                    : accessHealthGate.description}
                </p>
                <div className="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
                  <Link
                    href="/connections"
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
            ) : hasSearchQuery ? (
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
                  const title = stripEmojis(result.group_name || result.sender || result.sender_phone || "Conversation");
                  const subtitle = stripEmojis(
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
                      className="w-full text-left p-2.5 lg:p-3 transition-colors select-none hover:bg-white/5"
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
                      <div className="text-[10px] text-zinc-400 leading-relaxed line-clamp-2">
                        {snippet || "No text content"}
                      </div>
                    </button>
                  );
                })
              )
            ) : initialLeftPanelLoading ? (
              <div className="p-8 text-center text-xs text-zinc-500">Loading inbox feed...</div>
            ) : leftListEmpty ? (
              <div className="p-8 text-center text-xs text-zinc-500">
                {isBrokerView
                  ? "No broker entities extracted from group messages yet."
                  : "No chats found"}
              </div>
            ) : (
              <>
                {isBrokerView && loadingBrokerFeed && brokerFeed.length > 0 && (
                  <div className="px-3 py-2 text-center text-[10px] text-zinc-600">Refreshing broker feed...</div>
                )}
                {isBrokerView &&
                  filteredBrokerFeed.map((b) => {
                    const isSelected =
                      (selectedBroker?.identity_key && selectedBroker.identity_key === (b.identity_key || b.primary_phone || b.id)) ||
                      (normalizeRealPhone(selectedBroker?.phone || selectedBroker?.id || "") === normalizeRealPhone(b.primary_phone || "")) ||
                      (selectedBroker?.id && selectedBroker.id === (b.identity_key || b.primary_phone || b.id));
                    const menuOpen = openMenuBroker === b.primary_phone;
                    const isActiveNow = b.last_active && now - new Date(b.last_active).getTime() < 300000;
                    const latestIntent = b.latest_intent || (b.latest_title || "").match(/^(Sale|Rent|Lease|Buy|Requirement)/i)?.[1];
                    const brokerPhoneDigits = normalizeRealPhone(b.primary_phone || "");
                    const brokerIdentityHint = brokerPhoneDigits ? `Phone ending ${brokerPhoneDigits.slice(-4)}` : "No phone anchor";
                    return (
                      <div key={b.primary_phone} className="relative">
                        <button
                          onClick={() => selectBroker(b)}
                          className={`w-full text-left p-2.5 lg:p-3 transition-colors select-none ${
                            isSelected ? "bg-white/[0.055] border-l border-white/40" : "hover:bg-white/[0.035]"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="relative">
                                <BrokerAvatar phone={b.primary_phone} size="sm" />
                                {isActiveNow && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 border border-[#0a0e13]" />}
                              </div>
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
                          <div className="mb-1 text-[9px] font-medium text-zinc-600">
                            {brokerIdentityHint}
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
                    const selectedKey = threadKeyFor(selectedMsg);
                    const isSelected = Boolean(selectedKey && selectedKey === item.key);
                    return (
                      <button
                        key={`${item.type}-${item.key}`}
                        onClick={() => selectConversation(item.latest)}
                        className={`w-full text-left p-2.5 lg:p-3 transition-colors select-none ${
                          isSelected ? "bg-white/[0.055] border-l border-white/40" : "hover:bg-white/[0.035]"
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
                        {item.latest.market_scope === "shared" && (
                          <div className="mb-1 inline-flex rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-400">
                            Shared market
                          </div>
                        )}
                        <div className="text-[10px] text-zinc-500 leading-relaxed truncate mb-1">
                          {stripEmojis(resolveMessageSenderName(item.latest) || item.subtitle)}
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
              Page {isBrokerView ? brokerPage : messagePage}
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
                  {whatsappDisconnected ? "Scan WhatsApp QR to continue" : accessHealthGate.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                  {whatsappDisconnected
                    ? "Scan the QR code in Connection Center to unlock Market Inbox and WhatsApp Groups."
                    : accessHealthGate.description}
                </p>
                <div className="mt-5 flex flex-col items-center justify-center gap-2 sm:flex-row">
                  <Link
                    href="/connections"
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
                  <BrokerAvatar phone={resolvedBrokerPhone} size="md" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white truncate max-w-[340px]">
                      {selectedBroker.canonical_name || selectedBroker.name || selectedMsgDetails?.parsed?.broker_name || selectedMsgDetails?.parsed?.profile_name || "Broker"}
                    </h3>
                    <div className="text-[10px] text-zinc-500 flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="truncate">{displayPhoneString(resolvedBrokerPhone) || "Number not resolved"}</span>
                      <span>•</span>
                      <span>
                        {loadingBrokerObs
                          ? (selectedBroker.observation_count || 0)
                          : selectedBrokerObservations.length} market items
                      </span>
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
                  <div className="p-8 text-center text-xs text-zinc-500">Loading market items...</div>
                ) : brokerObsError ? (
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-5 text-center">
                    <div className="text-sm font-semibold text-amber-200">Market items did not load</div>
                    <div className="mx-auto mt-1 max-w-[360px] text-xs leading-relaxed text-zinc-500">
                      Your broker card is safe. Retry the item lookup without leaving Market Inbox.
                    </div>
                    <button
                      type="button"
                      onClick={() => void selectBroker(selectedBroker)}
                      className="mt-4 h-8 rounded-md border border-white/15 bg-white/[0.06] px-3 text-[11px] font-semibold text-white hover:bg-white/[0.1]"
                    >
                      Retry
                    </button>
                  </div>
                ) : groupedBrokerObservations.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-zinc-950/60 p-5 text-center">
                    <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-white/[0.035] text-zinc-400">
                      <ClipboardList className="h-5 w-5" strokeWidth={1.6} />
                    </div>
                    <div className="mt-3 text-sm font-semibold text-white">No matching items yet</div>
                    <div className="mx-auto mt-1 max-w-[360px] text-xs leading-relaxed text-zinc-500">
                      {selectedBroker.latest_title
                        ? "We found a recent post, but it has not been split into matching items yet."
                        : "This broker card has not resolved to parsed items yet. The feed item is still usable for navigation and WhatsApp actions."}
                    </div>
                    {selectedBroker.latest_title && (
                      <div className="mx-auto mt-4 max-w-[560px] text-left text-xs leading-relaxed text-zinc-500">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                          Latest item
                        </div>
                        <div className="mt-1 text-sm font-semibold text-zinc-200">
                          <WhatsAppMessage
                            text={
                              selectedMsgDetails?.raw?.message ||
                              selectedMsgDetails?.raw?.raw_message ||
                              selectedBroker.latest_title ||
                              ""
                            }
                            sender={selectedMsgDetails?.raw?.sender || selectedBroker.canonical_name || selectedBroker.name || ""}
                            senderPhone={resolvedBrokerPhone || selectedMsgDetails?.raw?.broker_phone || ""}
                            truncate
                            maxLines={6}
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
                          <span>{selectedBroker.observation_count || 0} market items</span>
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
                    const opportunityLabel = marketOpportunityLabel({
                      intent: obs.intent,
                      observation_type: obs.observation_type,
                      text: `${obs.summary_title || ""} ${obs.raw_message || ""}`,
                    });
                    return (
                      <div key={group.key}>
                        {/* Time Divider */}
                        <div className="flex items-center gap-3 mb-3">
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                          <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">{timeLabel}</span>
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                        </div>
                        {/* Opportunity Card */}
                        <button
                          type="button"
                          onClick={() => selectBrokerObservation(obs)}
                          className={`w-full overflow-hidden rounded-md border bg-zinc-950/70 text-left transition-colors hover:border-white/25 ${
                            isSelected ? "border-white/40 bg-white/[0.035]" : "border-white/10"
                          }`}
                        >
                          {/* Bubble Header — Primary Type */}
                          <div className="px-4 py-2.5 border-b border-white/5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-base">{observationTypeIcon(obs.observation_type)}</span>
                                <span className={`badge ${marketOpportunityColor(opportunityLabel)} text-[10px]`}>
                                  {opportunityLabel}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full ${observationTypeColor(obs.observation_type)}`}>
                                  {observationTypeLabel(obs.observation_type)}
                                </span>
                                <span className="text-[9px] text-zinc-500 tabular-nums">{timeLabel}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-zinc-400">
                              {obs.property_type && <span className="font-medium text-zinc-300">{obs.property_type}</span>}
                              {obs.bhk && <><span className="text-zinc-700">·</span><span>{obs.bhk}</span></>}
                              {obs.price != null && <><span className="text-zinc-700">·</span><span className="font-semibold text-white">{formatCurrency(obs.price, obs.price_unit)}</span></>}
                              {obs.area_sqft && <><span className="text-zinc-700">·</span><span>{obs.area_sqft} sqft</span></>}
                              {obs.micro_market && <><span className="text-zinc-700">·</span><span>{obs.micro_market}</span></>}
                              {obs.alternate_intent && (
                                <span className="text-[9px] text-zinc-400 italic ml-1">
                                  Also {obs.alternate_intent === "RENT" ? "Rent" : "Sale"}
                                </span>
                              )}
                            </div>
                          </div>
                          {/* Bubble Body */}
                          <div className="px-4 py-3 space-y-2">
                            {obs.summary_title && (
                              <div className="text-[12px] font-semibold leading-relaxed text-zinc-100">
                                {stripEmojis(obs.summary_title)}
                              </div>
                            )}
                            {obs.raw_message && (
                              <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2">
                                <WhatsAppMessage
                                  text={obs.raw_message}
                                  sender={selectedBroker.canonical_name || selectedBroker.name || ""}
                                  senderPhone={resolvedBrokerPhone || obs.broker_phone || ""}
                                  truncate
                                  maxLines={8}
                                  flatMultiBlocks
                                  className="text-[11px] text-zinc-200"
                                />
                              </div>
                            )}
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
                              {obs.area_sqft && (
                                <span className="text-[10px] bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full border border-white/5">
                                  {obs.area_sqft} sqft
                                </span>
                              )}
                              {obs.furnishing && (
                                <span className="text-[10px] bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full border border-white/5">
                                  {stripEmojis(obs.furnishing)}
                                </span>
                              )}
                              {obs.times_seen && obs.times_seen > 1 && (
                                <span className="text-[9px] text-zinc-500 px-1 py-0.5">
                                  Seen {obs.times_seen}x
                                </span>
                              )}
                              {group.duplicateCount > 1 && (
                                <span className="text-[9px] text-zinc-500 px-1 py-0.5">
                                  Repeated {group.duplicateCount}x
                                </span>
                              )}
                              {group.observations.length > 1 && (
                                <span className="text-[9px] text-zinc-500 px-1 py-0.5">
                                  Linked {group.observations.length} items
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
                          </div>
                          {/* WhatsApp CTA */}
                          {resolvedBrokerPhone && (
                            <div
                              className="border-t border-white/5 px-4 py-2 flex items-center gap-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <a
                                href={getWaLinkWithRecall(resolvedBrokerPhone, obs.raw_message || obs.summary_title || "")}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => trackBrokerWhatsAppOpen(resolvedBrokerPhone, "market_item")}
                                className="flex items-center gap-1.5 text-[10px] font-semibold text-zinc-400 transition-colors hover:text-white touch-target"
                              >
                                <MessageSquare className="w-3 h-3" strokeWidth={1.8} />
                                <span>Contact on WhatsApp</span>
                              </a>
                            </div>
                          )}
                        </button>
                      </div>
                    );
                    })}
                  </>
                )}
              </div>
              <div className="border-t border-white/10 bg-black/90 px-4 py-3">
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
                    <textarea
                      value={brokerReplyText}
                      onChange={(e) => setBrokerReplyText(e.target.value)}
                      rows={3}
                      placeholder="Write a short note, question, or follow-up..."
                      className="w-full resize-none rounded-md border border-white/10 bg-zinc-950 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none transition-colors focus:border-white/35"
                    />
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="text-[11px] text-zinc-500">
                        {whatsappConnected
                          ? "Sends inside PropAI and records the action in workspace analytics."
                          : "Connect your WhatsApp phone to send from PropAI."}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleSendBrokerReply()}
                        disabled={!brokerReplyText.trim() || sendingReply || !whatsappConnected || replyAccessLoading}
                        className="inline-flex h-9 items-center gap-1.5 rounded bg-white px-4 text-[11px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        {sendingReply ? "Sending..." : "Send message"}
                      </button>
                    </div>
                    {replyError && <div className="mt-2 text-[11px] text-red-400">{replyError}</div>}
                    {replyStatus && <div className="mt-2 text-[11px] text-zinc-300">{replyStatus}</div>}
                  </>
                ) : (
                  <div className="rounded-xl border border-white/10 bg-zinc-950 px-3 py-3 text-[11px] text-zinc-400">
                    No WhatsApp number was found in this broker&apos;s captured evidence yet. You can keep reviewing the clean market items above; PropAI will link the number automatically when it appears in a future post.
                  </div>
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
                      Open WhatsApp
                    </a>
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
                            const blockHasSplitListings = block.some((m) => splitDelimitedListingText(m.message).length > 1);
                            const bubbleBg = isSelf
                              ? "bg-emerald-950/40 border border-emerald-800/30 ml-auto"
                              : "border border-white/10";

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
                                                      title="Message this broker with this item recalled"
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
              <div className="border-t border-white/10 bg-black/90 px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-500">
                        Reply inside PropAI
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
                            href="/connections"
                            className="inline-flex h-8 items-center justify-center rounded-lg bg-[#3EE88A] px-3 text-[10px] font-bold text-black transition-colors hover:bg-[#35d47c]"
                          >
                            Open Connection Center
                          </a>
                          <a
                            href="/connections"
                            className="inline-flex h-8 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 px-3 text-[10px] font-bold text-zinc-200 transition-colors hover:border-[#3EE88A]/40 hover:text-[#3EE88A]"
                          >
                            Open Connections
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
                            href="/team"
                            className="inline-flex h-8 items-center justify-center rounded-lg bg-[#3EE88A] px-3 text-[10px] font-bold text-black transition-colors hover:bg-[#35d47c]"
                          >
                            Open Team Roles
                          </a>
                        </div>
                      </div>
                    ) : canReplyWhatsApp ? (
                      <>
                        <textarea
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
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
                          rows={3}
                          disabled={sendingReply || !selectedConversationJid}
                          className="w-full resize-none rounded-xl border border-white/10 bg-zinc-950 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none transition-colors focus:border-[#3EE88A]/50 focus:ring-1 focus:ring-[#3EE88A]/30 disabled:cursor-not-allowed disabled:opacity-60"
                        />

                        <div className="mt-2 flex items-center justify-between gap-3">
                          <div className="min-h-[1rem] text-[11px]">
                            {replyError ? (
                              <span className="text-red-400">{replyError}</span>
                            ) : replyStatus ? (
                              <span className="text-[#3EE88A]">{replyStatus}</span>
                            ) : selectedConversationJid ? (
                              <span className="text-zinc-500">Replies are sent through the connected WhatsApp number.</span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            {replyFallbackPhone && (
                              <a
                                href={getWaLinkWithRecall(replyFallbackPhone, replyText || replyTargetMessage?.message || "")}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-800 px-3 text-[11px] font-semibold text-zinc-200 transition-colors hover:border-[#3EE88A]/40 hover:text-[#3EE88A]"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
                                Open WhatsApp
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleSendReply()}
                              disabled={sendingReply || !replyText.trim() || !selectedConversationJid}
                              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#3EE88A] px-4 text-[11px] font-bold text-black transition-colors hover:bg-[#35d47c] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Send className="h-3.5 w-3.5" />
                              {sendingReply ? "Sending..." : "Send"}
                            </button>
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
                Select a WhatsApp group or broker to see messages, evidence, and PropAI actions.
              </p>
            </div>
          )}
        </div>

        {/* Right panel: global AI Chat, optionally enriched with selected context */}
        {!chatPanelCollapsed && (
          <div
            className="hidden lg:flex h-full min-h-0 min-w-0 shrink-0 border-l border-white/10 bg-[#070b0e] relative"
            style={{ width: chatPanelWidth }}
          >
            {/* Drag handle on left edge */}
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = chatPanelWidth;
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  const newW = Math.min(720, Math.max(320, startW + delta));
                  setChatPanelWidth(newW);
                };
                const onUp = () => {
                  document.removeEventListener("mousemove", onMove);
                  document.removeEventListener("mouseup", onUp);
                  document.body.style.cursor = "";
                  document.body.style.userSelect = "";
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
              className="absolute top-0 left-0 w-[5px] h-full cursor-col-resize group z-20 flex items-center justify-center"
            >
              <div className="w-[1px] h-full bg-[rgba(255,255,255,0.06)] group-hover:bg-[#3EE88A]/40 transition-colors" />
              <div className="absolute w-2 h-8 rounded-full bg-transparent group-hover:bg-[#3EE88A]/20 transition-colors" />
            </div>
            <InboxChatPanel
              selectedBroker={selectedBroker}
              selectedMsgDetails={selectedMsgDetails}
              selectedConversationJid={selectedConversationJid}
              collapsed={false}
              globalMode={true}
              onToggleCollapse={() => setChatPanelCollapsed(true)}
            />
          </div>
        )}
        {chatPanelCollapsed && (
          <div className="hidden lg:flex h-full min-h-0 w-10 shrink-0 border-l border-white/10 bg-black/40">
            <InboxChatPanel
              collapsed={true}
              onToggleCollapse={() => setChatPanelCollapsed(false)}
            />
          </div>
        )}
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

export function WhatsAppGroupsWorkspacePage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
      <InboxPageInner defaultView="groups" />
    </Suspense>
  );
}
