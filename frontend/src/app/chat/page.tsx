"use client";

export const dynamic = 'force-dynamic';

import * as api from "@/lib/api";
import { getAccessToken } from "@/lib/auth";
import { useEffect, useState, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ListingCard, { type ListingItem } from "@/components/ListingCard";
import { useAuth } from "@/lib/AuthProvider";
import { Check, Pencil, Plus, MessageSquare, Trash2, PanelLeft, PanelLeftClose, X } from "lucide-react";

function messageText(message: { parts?: Array<{ type?: string; text?: string }>; content?: string }) {
  if (typeof message.content === "string" && message.content) return message.content;
  return (message.parts || [])
    .map((part) => (part?.type === "text" ? part.text || "" : ""))
    .join("");
}

const CHAT_CARD_BLOCK_TYPES = new Set(["listing_cards", "buyer_cards", "broker_cards", "matching_buyers"]);

function toUIMessage(m: { id: string; role: "user" | "assistant"; content: string; blocks?: Array<{ type: string; title?: string; items?: unknown[] }> }) {
  const parts: Array<{ type: string; text?: string; data?: unknown }> = [{ type: "text" as const, text: m.content }];
  if (m.blocks) {
    for (const block of m.blocks) {
      if (block && CHAT_CARD_BLOCK_TYPES.has(block.type)) {
        parts.push({ type: `data-${block.type}` as const, data: block });
      }
    }
  }
  return { id: m.id, role: m.role, parts };
}

function inlineMarkdown(text: string, keyPrefix: string) {
  return text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).map((part, index) => {
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={`${keyPrefix}-l-${index}`}
          href={linkMatch[2]}
          target="_blank"
          rel="noreferrer"
          className="text-emerald-300 underline underline-offset-2"
        >
          {linkMatch[1]}
        </a>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${keyPrefix}-b-${index}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={`${keyPrefix}-i-${index}`}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${keyPrefix}-c-${index}`} className="rounded bg-white/10 px-1 py-0.5 text-[0.9em]">{part.slice(1, -1)}</code>;
    }
    return <span key={`${keyPrefix}-t-${index}`}>{part}</span>;
  });
}

function markdownTableRow(line: string) {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  const source = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (const character of source) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function isMarkdownDivider(line: string) {
  const cells = markdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function textHasTable(text: string) {
  return /^\s*\|.*\|\s*$/m.test(text);
}

function removeMarkdownTables(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].includes("|") && index + 1 < lines.length && isMarkdownDivider(lines[index + 1])) {
      index += 2;
      while (index < lines.length && lines[index].includes("|")) index += 1;
      continue;
    }
    kept.push(lines[index]);
    index += 1;
  }
  return kept.join("\n").trim();
}

function csvEscapeCell(value: unknown) {
  const text = value == null ? "" : String(value);
  const escaped = text.replace(/"/g, '""');
  return /[",\n\r]/.test(text) ? `"${escaped}"` : escaped;
}

function csvLine(values: unknown[]) {
  return values.map(csvEscapeCell).join(",");
}

function exportRowsFromParts(parts: Array<{ type?: string; text?: string; data?: any }>) {
  const rows: Array<Array<string>> = [];
  for (const part of parts || []) {
    if (part?.type !== "data-listing_cards") continue;
    const items = Array.isArray(part?.data?.items) ? part.data.items : [];
    for (const item of items) {
      const listing = item as ListingItem;
      rows.push([
        listing.building_name || "—",
        listing.micro_market || listing.location_label || listing.landmark_name || "—",
        listing.bhk || listing.property_type || "—",
        listing.price_formatted || "—",
        listing.area_sqft ? `${listing.area_sqft} sqft` : "—",
        listing.furnishing || "—",
        listing.broker_name || "—",
        buildWhatsAppLink(listing) || "—",
        listing.last_seen || "—",
      ]);
    }
  }
  return rows;
}

function tableExportCsv(parts: Array<{ type?: string; text?: string; data?: any }>) {
  const headers = ["Building", "Locality", "Type", "Rent/Sale", "Carpet", "Furnishing", "Broker", "WhatsApp Link", "Last Seen"];
  const rows = exportRowsFromParts(parts);
  const body = [csvLine(headers), ...rows.map(csvLine)].join("\n");
  return `${body}\n`;
}

function MarkdownMessage({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.includes("|") && index + 1 < lines.length && isMarkdownDivider(lines[index + 1])) {
      const headers = markdownTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(markdownTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div key={`table-${index}`} className="my-2 overflow-x-auto rounded-lg border border-white/10">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-white/[0.05] text-zinc-300"><tr>{headers.map((cell, cellIndex) => <th key={cellIndex} className="px-3 py-2 font-semibold">{inlineMarkdown(cell, `h-${index}-${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-white/10">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 text-zinc-400">{inlineMarkdown(cell, `r-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const Heading = heading[1].length <= 2 ? "h3" : "h4";
      blocks.push(<Heading key={`heading-${index}`} className="mt-2 font-semibold text-white">{inlineMarkdown(heading[2], `heading-${index}`)}</Heading>);
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`} className="my-1 list-disc space-y-1 pl-5">{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `item-${index}-${itemIndex}`)}</li>)}</ul>);
      continue;
    } else {
      blocks.push(<p key={`paragraph-${index}`} className="whitespace-pre-wrap">{inlineMarkdown(line, `paragraph-${index}`)}</p>);
    }
    index += 1;
  }
  return <div className="space-y-1 text-sm text-zinc-300">{blocks}</div>;
}

function escapeMarkdownTableCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function normalizeWhatsappPhone(phone?: string | null) {
  const key = normalizePhoneKey(phone || "");
  return key ? `91${key}` : "";
}

function buildWhatsAppLink(item: ListingItem) {
  const phone = normalizeWhatsappPhone(item.broker_phone || item.sender_phone || "");
  if (!phone) return "";
  const building = item.building_name || "the listing";
  const configuration = item.bhk || item.property_type || "property";
  const price = item.price_formatted || "";
  const carpet = item.area_sqft ? `${item.area_sqft} sqft` : "";
  const furnishing = item.furnishing || "Unspecified";
  const locality = item.micro_market || item.location_label || item.landmark_name || "Unknown locality";
  const message = [
    `Hi ${item.broker_name || "there"},`,
    "",
    "I found your listing through PropAI.",
    "",
    "Property:",
    `• ${building}`,
    `• ${configuration}`,
    carpet ? `• ${carpet}` : "",
    price ? `• ${price}` : "",
    `• ${furnishing}`,
    `• ${locality}`,
    "",
    "Is this still available?",
    "",
    "If yes, please share:",
    "• Photos",
    "• Availability",
    "• Inspection timing",
    "• Brokerage",
    "",
    "Sent via PropAI",
  ].filter(Boolean).join("\n");
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function listingTableMarkdown(items: ListingItem[]) {
  const lines = [
    "| Building | Locality | Type | Rent/Sale | Carpet | Furnishing | Broker | WhatsApp |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of items) {
    const whatsapp = buildWhatsAppLink(item);
    lines.push(
      [
        escapeMarkdownTableCell(item.building_name || "—"),
        escapeMarkdownTableCell(item.micro_market || item.location_label || item.landmark_name || "—"),
        escapeMarkdownTableCell(item.bhk || item.property_type || "—"),
        escapeMarkdownTableCell(item.price_formatted || "—"),
        escapeMarkdownTableCell(item.area_sqft ? `${item.area_sqft} sqft` : "—"),
        escapeMarkdownTableCell(item.furnishing || "—"),
        escapeMarkdownTableCell(item.broker_name || "—"),
        whatsapp ? `[💬 Open Chat](${whatsapp})` : "💬 Open Chat",
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

function brokerTableMarkdown(items: BrokerCardItem[]) {
  const lines = [
    "| Broker | Phone | Posts | Listings | Requirements | Groups | Last Seen | WhatsApp |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of items) {
    const phone = normalizeWhatsappPhone(item.phone || "");
    lines.push(
      [
        escapeMarkdownTableCell(item.name || "Broker"),
        escapeMarkdownTableCell(item.phone || "—"),
        escapeMarkdownTableCell(item.observations ?? "—"),
        escapeMarkdownTableCell(item.listings ?? "—"),
        escapeMarkdownTableCell(item.requirements ?? "—"),
        escapeMarkdownTableCell(item.groups ?? "—"),
        escapeMarkdownTableCell(item.last_seen || "—"),
        phone ? `[💬 Open Chat](https://wa.me/${phone})` : "💬 Open Chat",
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

function genericCardTableMarkdown(items: Array<Record<string, unknown>>, titleMap: Array<[string, string]>) {
  const lines = [
    `| ${titleMap.map((pair) => pair[0]).join(" | ")} |`,
    `| ${titleMap.map(() => "---").join(" | ")} |`,
  ];
  for (const item of items) {
    lines.push(
      [
        ...titleMap.map(([, key]) => escapeMarkdownTableCell(item[key] || "—")),
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

function workspaceBlockToMarkdown(part: { type?: string; data?: any }, hiddenBrokerPhones: Set<string>, hiddenMarketKeys: Set<string>) {
  const blockType = part.type?.replace(/^data-/, "") || "";
  const block = part.data || {};
  const items = Array.isArray(block.items) ? block.items : [];

  if (!CHAT_CARD_BLOCK_TYPES.has(blockType)) return "";

  if (blockType === "broker_cards") {
    const visibleItems = (items as BrokerCardItem[]).filter((item) => {
      const key = normalizePhoneKey(item.phone || "");
      return !key || !hiddenBrokerPhones.has(key);
    });
    if (visibleItems.length === 0) return "";
    const lines = [];
    if (block.title) lines.push(`### ${block.title}`);
    if (block.subtitle) lines.push(block.subtitle);
    if (block.body) lines.push(block.body);
    lines.push("", brokerTableMarkdown(visibleItems));
    return lines.join("\n");
  }

  const visibleItems = (items as GroupMirrorItem[]).filter((item) => {
    const key = normalizePhoneKey(item.broker_phone || item.sender_phone || "");
    if (key && hiddenBrokerPhones.has(key)) return false;
    const listingKey = hiddenListingKey(item);
    const requirementKey = hiddenRequirementKey(item);
    if (listingKey && hiddenMarketKeys.has(listingKey)) return false;
    if (requirementKey && hiddenMarketKeys.has(requirementKey)) return false;
    return true;
  });
  if (visibleItems.length === 0) return "";

  const lines = [];
  if (block.title) lines.push(`### ${block.title}`);
  if (block.subtitle) lines.push(block.subtitle);
  if (block.body) lines.push(block.body);
  lines.push("");

  if (blockType === "listing_cards") {
    lines.push(listingTableMarkdown(visibleItems as ListingItem[]));
  } else if (blockType === "buyer_cards" || blockType === "matching_buyers") {
    lines.push(
      genericCardTableMarkdown(visibleItems as Array<Record<string, unknown>>, [
        ["Buyer", "name"],
        ["Locality", "micro_market"],
        ["BHK", "bhk"],
        ["Budget", "price_formatted"],
        ["Broker", "broker_name"],
        ["Last Seen", "last_seen_text"],
      ]),
    );
  } else {
    lines.push(
      genericCardTableMarkdown(visibleItems as Array<Record<string, unknown>>, [
        ["Name", "name"],
        ["Locality", "micro_market"],
        ["BHK", "bhk"],
        ["Price", "price_formatted"],
        ["Broker", "broker_name"],
      ]),
    );
  }

  return lines.join("\n");
}

function formatSessionTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function chatSessionSlug(title: string, id: string) {
  const label = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chat";
  return `${label}--${id}`;
}

function sessionIdFromParam(value: string | null) {
  if (!value) return "";
  const match = value.match(/--([0-9a-f-]{36})$/i);
  return match?.[1] || (/^[0-9a-f-]{36}$/i.test(value) ? value : "");
}

function normalizePhoneKey(value?: string | null) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length >= 12 && digits.startsWith("91")) return digits.slice(-10);
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

type ChatSourceMode = "parsed" | "inbox" | "";
type GroupMirrorItem = ListingItem & {
  original_message?: string;
  duplicate_count?: number;
  duplicate_group_names?: string[];
  source?: string;
  last_seen_text?: string;
  sender_phone?: string;
  match_reasons?: string[];
};

type BrokerCardItem = {
  name?: string;
  phone?: string;
  observations?: number | string;
  listings?: number | string;
  requirements?: number | string;
  groups?: number | string;
  last_seen?: string;
};

function hiddenListingKey(item: { listing_id?: number | null }) {
  return item.listing_id ? `listing:${item.listing_id}` : "";
}

function hiddenRequirementKey(item: { raw_message_id?: number | null }) {
  return item.raw_message_id ? `requirement:${item.raw_message_id}` : "";
}

function getAssistantSourceMode(message: { parts?: Array<{ type?: string; data?: any }> }) {
  const contextPart = (message.parts || []).find((part) => part?.type === "data-chat_context");
  const sourceMode = contextPart?.data?.source_mode;
  return sourceMode === "parsed" || sourceMode === "inbox" ? sourceMode : "";
}
export default function ChatPage() {
  const { user, loading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const sessionParam = searchParams.get("session");
  const [input, setInput] = useState("");
  const [brokerPhone, setBrokerPhone] = useState("");
  const searchSource: "parsed" = "parsed";
  const [hiddenBrokerPhones, setHiddenBrokerPhones] = useState<Set<string>>(() => new Set());
  const [hiddenMarketKeys, setHiddenMarketKeys] = useState<Set<string>>(() => new Set());
  const [brokerActionMessage, setBrokerActionMessage] = useState("");
  const [copiedTable, setCopiedTable] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionIdRef = useRef("");
  const sessionCreationInFlightRef = useRef(false);
  const pendingMessageRef = useRef("");
  const brokerActionTimer = useRef<number | null>(null);

  // Session state
  const [sessionId, setSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<api.ChatSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [contactingListingId, setContactingListingId] = useState<number | null>(null);
  const [showFreshChatNotice, setShowFreshChatNotice] = useState(false);

  const activeSessionStorageKey = user?.id ? `propai_active_chat_session:${user.id}` : "";
  const { messages, sendMessage, status, setMessages, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/ai/chat",
      body: () => ({ broker_phone: brokerPhone, session_id: sessionIdRef.current || sessionId, source: searchSource }),
      headers: async () => {
        const headers: Record<string, string> = {};
        const token = await getAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
      },
    }),
  });
  const previousStatus = useRef(status);

  const hideBrokerLocally = useCallback(async (phone: string, label: string) => {
    const key = normalizePhoneKey(phone);
    if (!key) return;
    setHiddenBrokerPhones((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      await api.hideBroker(key);
      setBrokerActionMessage(`Hidden broker: ${label}`);
    } catch {
      setHiddenBrokerPhones((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setBrokerActionMessage("Failed to hide broker");
    } finally {
      if (brokerActionTimer.current) window.clearTimeout(brokerActionTimer.current);
      brokerActionTimer.current = window.setTimeout(() => setBrokerActionMessage(""), 3000);
    }
  }, []);

  const hideListingLocally = useCallback(async (item: ListingItem) => {
    const key = hiddenListingKey(item);
    if (!key || !item.listing_id) return;
    setHiddenMarketKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      await api.hideMarketItem({
        item_kind: "listing",
        listing_id: item.listing_id,
        raw_message_id: item.raw_message_id || null,
        broker_phone: item.broker_phone || null,
        broker_name: item.broker_name || null,
        source_label: item.building_name || item.micro_market || item.location_label || null,
        hidden_reason: "hidden_from_chat",
      });
      setBrokerActionMessage(`Hidden listing: ${item.building_name || "listing"}`);
    } catch {
      setHiddenMarketKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setBrokerActionMessage("Failed to hide listing");
    } finally {
      if (brokerActionTimer.current) window.clearTimeout(brokerActionTimer.current);
      brokerActionTimer.current = window.setTimeout(() => setBrokerActionMessage(""), 3000);
    }
  }, []);

  const hideRequirementLocally = useCallback(async (item: ListingItem) => {
    const key = hiddenRequirementKey(item);
    if (!key || !item.raw_message_id) return;
    setHiddenMarketKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      await api.hideMarketItem({
        item_kind: "requirement",
        raw_message_id: item.raw_message_id,
        broker_phone: item.broker_phone || null,
        broker_name: item.broker_name || null,
        source_label: item.building_name || item.micro_market || item.location_label || null,
        hidden_reason: "hidden_from_chat",
      });
      setBrokerActionMessage(`Hidden requirement: ${item.building_name || "item"}`);
    } catch {
      setHiddenMarketKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setBrokerActionMessage("Failed to hide requirement");
    } finally {
      if (brokerActionTimer.current) window.clearTimeout(brokerActionTimer.current);
      brokerActionTimer.current = window.setTimeout(() => setBrokerActionMessage(""), 3000);
    }
  }, []);

  const loadHiddenBrokerState = useCallback(async () => {
    try {
      const data = await api.fetchJSON<{ brokers?: Array<{ primary_phone?: string; phone?: string }> }>("/brokers/hidden");
      const phones = new Set<string>();
      for (const broker of data?.brokers || []) {
        const key = normalizePhoneKey(broker.primary_phone || broker.phone || "");
        if (key) phones.add(key);
      }
      setHiddenBrokerPhones(phones);
    } catch {
      // Best effort only.
    }
  }, []);

  const loadHiddenMarketState = useCallback(async () => {
    try {
      const data = await api.listHiddenMarketItems();
      const keys = new Set<string>();
      for (const item of data.items || []) {
        if (typeof item?.hidden_key === "string" && item.hidden_key) {
          keys.add(item.hidden_key);
          continue;
        }
        if (item?.item_kind === "listing" && item?.listing_id) keys.add(`listing:${item.listing_id}`);
        if (item?.item_kind === "requirement" && item?.raw_message_id) keys.add(`requirement:${item.raw_message_id}`);
      }
      setHiddenMarketKeys(keys);
    } catch {
      // Best effort only.
    }
  }, []);

  useEffect(() => {
    return () => {
      if (brokerActionTimer.current) window.clearTimeout(brokerActionTimer.current);
    };
  }, []);

  useEffect(() => {
    void loadHiddenBrokerState();
    void loadHiddenMarketState();
  }, [loadHiddenBrokerState, loadHiddenMarketState, user?.id]);

  // The phone is only conversational broker context. Session ownership is
  // derived server-side from the authenticated user and must never switch
  // between auth UUID and profile phone while this page is mounted.
  useEffect(() => {
    setBrokerPhone(user?.phone || "");
    let cancelled = false;
    void (async () => {
      try {
        const profile = await api.getProfile();
        if (!cancelled && profile?.phone) setBrokerPhone(profile.phone);
      } catch {
        // Ignore profile hydration failures here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const updateUrlSession = useCallback((id: string, title?: string) => {
    const url = new URL(window.location.href);
    const session = sessions.find((item) => item.id === id);
    url.searchParams.set("session", title ? chatSessionSlug(title, id) : (session?.slug || chatSessionSlug("chat", id)));
    window.history.replaceState({}, "", url.toString());
  }, [sessions]);

  const clearUrlSession = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.listChatSessions();
      setSessions(data);
      return data;
    } catch {
      setSessions([]);
      return [];
    }
  }, []);

  useEffect(() => {
    if (authLoading || !user?.id) return;
    let cancelled = false;
    void (async () => {
      const data = await loadSessions();
      if (cancelled) return;
      setSessionsLoaded(true);
      if (data.length > 0 && !sessionId) {
        const savedId = activeSessionStorageKey
          ? window.localStorage.getItem(activeSessionStorageKey)
          : null;
        const saved = data.find((item) => item.id === savedId);
        const active = saved || data.find((item) => item.source === "parsed") || data[0];
        sessionIdRef.current = active.id;
        setSessionId(active.id);
        try {
          const msgs = await api.getChatSessionMessages(active.id);
          if (cancelled) return;
          setMessages(msgs.map((m) => toUIMessage({ id: m.id, role: m.role as "user" | "assistant", content: m.content, blocks: m.blocks })));
        } catch (e) {
          setSessionError(e instanceof Error ? e.message : "Could not resume previous chat");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionStorageKey, authLoading, loadSessions, sessionId, setMessages, user?.id]);

  // Keep the selected thread stable across tab switches, refreshes, and route
  // remounts. Messages themselves remain persisted in Supabase by the API.
  useEffect(() => {
    if (!activeSessionStorageKey || !sessionId) return;
    window.localStorage.setItem(activeSessionStorageKey, sessionId);
  }, [activeSessionStorageKey, sessionId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  // Refresh the sidebar after a response finishes so newly created chats
  // appear immediately instead of only after a full page reload.
  useEffect(() => {
    const wasBusy = previousStatus.current === "submitted" || previousStatus.current === "streaming";
    if (wasBusy && status === "ready" && user?.id) {
      void loadSessions();
      import("@/lib/sounds").then(({ playChatResponse }) => playChatResponse());
    }
    previousStatus.current = status;
  }, [loadSessions, status, user?.id]);

  // Copy the full answer as CSV built from structured listing blocks.
  const copyAnswer = useCallback(async (parts: Array<{ type?: string; text?: string; data?: any }>) => {
    try {
      await navigator.clipboard.writeText(tableExportCsv(parts));
      setCopiedTable(true);
      setTimeout(() => setCopiedTable(false), 1500);
    } catch {
      setCopiedTable(false);
    }
  }, []);

  // Download the full answer as CSV built from structured listing blocks.
  const exportAnswer = useCallback((parts: Array<{ type?: string; text?: string; data?: any }>) => {
    const csv = tableExportCsv(parts);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `propai-listings-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  // Create a new session
  const handleNewChat = useCallback(async () => {
    // Create the durable row immediately. The thread must exist before the
    // first message, provider call, navigation, or browser refresh.
    setShowFreshChatNotice(true);
    sessionIdRef.current = "";
    setSessionId("");
    setMessages([]);
    setInput("");
    setSessionError("");
    inputRef.current?.focus();
    clearUrlSession();
    try {
      const session = await api.createChatSession("New chat", "parsed");
      if (!session?.id) throw new Error("Could not create a new chat session.");
      sessionIdRef.current = session.id;
      setSessionId(session.id);
      updateUrlSession(session.id, session.title);
      const updated = await loadSessions();
      setSessions(updated);
    } catch (error) {
      setShowFreshChatNotice(false);
      setSessionError(error instanceof Error ? error.message : "Could not create a chat session.");
    }
  }, [clearUrlSession, loadSessions, setMessages, updateUrlSession]);

  // Switch to an existing session
  const handleSwitchSession = useCallback(async (id: string) => {
    if (id === sessionId) return;
    setShowFreshChatNotice(false);
    updateUrlSession(id);
    setSessionId(id);
    setSessionError("");
    sessionIdRef.current = id;
    if (activeSessionStorageKey) window.localStorage.setItem(activeSessionStorageKey, id);
    try {
      const msgs = await api.getChatSessionMessages(id);
      setMessages(msgs.map((m) => toUIMessage({ id: m.id, role: m.role as "user" | "assistant", content: m.content, blocks: m.blocks })));
    } catch (e) {
      setMessages([]);
      setSessionError(e instanceof Error ? e.message : "Could not load this chat");
    }
  }, [activeSessionStorageKey, sessionId, setMessages, updateUrlSession]);

  // Delete a session
  const handleDeleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.deleteChatSession(id);
      const updated = await loadSessions();
      setSessions(updated);
      if (id === sessionId) {
        if (updated.length > 0) {
          handleSwitchSession(updated[0].id);
        } else {
          handleNewChat();
        }
      }
    } catch {}
  }, [sessionId, loadSessions, handleSwitchSession, handleNewChat]);

  const handleRenameSession = useCallback(async (id: string) => {
    const title = renameValue.trim();
    if (!title) return;
    try {
      const renamed = await api.renameChatSession(id, title);
      setSessions((current) => current.map((session) => session.id === id ? renamed : session));
      if (id === sessionId) updateUrlSession(id, renamed.title);
      setRenamingSessionId("");
      setRenameValue("");
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Could not rename this chat");
    }
  }, [renameValue, sessionId, updateUrlSession]);

  const handleContactBroker = useCallback(async (listingId: number) => {
    setContactingListingId(listingId);
    const contactWindow = window.open("", "_blank");
    try {
      const { contact_url } = await api.resolveBrokerContact(listingId);
      if (contactWindow) {
        contactWindow.opener = null;
        contactWindow.location.assign(contact_url);
      } else {
        window.location.assign(contact_url);
      }
    } catch (error) {
      contactWindow?.close();
      setSessionError(error instanceof Error ? error.message : "Broker contact could not be opened");
    } finally {
      setContactingListingId(null);
    }
  }, []);

  // Navigate to session from URL on initial load
  const initialNavDone = useRef(false);
  useEffect(() => {
    if (initialNavDone.current) return;
    if (!sessionsLoaded) return;
    initialNavDone.current = true;
    const requestedSessionId = sessionIdFromParam(sessionParam);
    if (requestedSessionId && sessions.length > 0) {
      const target = sessions.find((s) => s.id === requestedSessionId);
      if (target) {
        handleSwitchSession(target.id);
      }
    }
  }, [sessionParam, sessions, sessionsLoaded, handleSwitchSession]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || status === "submitted") return;
    setSessionError("");
    if (!sessionIdRef.current) {
      // Guard: only one createChatSession() call per burst.
      if (sessionCreationInFlightRef.current) {
        const queued = input.trim();
        pendingMessageRef.current = queued;
        setInput("");
        return;
      }
      sessionCreationInFlightRef.current = true;
      const text = input.trim();
      api.createChatSession(text.slice(0, 80), "parsed").then((session) => {
        if (!session?.id) throw new Error("Could not create a chat session.");
        sessionIdRef.current = session.id;
        setSessionId(session.id);
        updateUrlSession(session.id, session.title);
        sendMessage({ text });
        setInput("");
        setShowFreshChatNotice(false);
        import("@/lib/sounds").then((s) => s.playMessageSent());
        return loadSessions().then(setSessions);
      }).catch((error) => {
        setSessionError(error instanceof Error ? error.message : "Could not create a chat session.");
      }).finally(() => {
        sessionCreationInFlightRef.current = false;
        const queued = pendingMessageRef.current;
        if (queued) {
          pendingMessageRef.current = "";
          sendMessage({ text: queued });
        }
      });
      return;
    }
    sendMessage({ text: input.trim() });
    setInput("");
    setShowFreshChatNotice(false);
    import("@/lib/sounds").then((s) => s.playMessageSent());
  }

  return (
    <div className="relative flex h-[calc(100svh-96px)] lg:h-[calc(100vh-96px)] max-w-[1800px] mx-auto px-4 lg:px-6">
      <style>{`
        @keyframes typing-bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-6px); }
        }
        .typing-dot { width: 6px; height: 6px; border-radius: 50%; background: #a1a1aa; animation: typing-bounce 1.4s infinite both; }
        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }
        .typing-dot:nth-child(3) { animation-delay: 0s; }
        @keyframes table-shimmer {
          0% { background-position: -400px 0; }
          100% { background-position: 400px 0; }
        }
        .table-skeleton-line,
        .table-skeleton-bar {
          background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.05) 75%);
          background-size: 800px 100%;
          animation: table-shimmer 1.4s infinite linear;
          border-radius: 4px;
        }
        .table-skeleton-line { height: 8px; }
        .table-skeleton-bar { height: 14px; }
      `}</style>

      {/* ═══════ Session Sidebar ═══════ */}
      {showSessions && <aside className="hidden lg:flex w-64 flex-col border-r border-white/10 shrink-0 mr-2">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.15em]">Chats</span>
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1 text-[10px] font-medium text-zinc-400 hover:text-white px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
          >
            <Plus className="w-3 h-3" />
            New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5">
          {sessions.map((s) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => void handleSwitchSession(s.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void handleSwitchSession(s.id);
                }
              }}
              className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors group flex items-start gap-2 border-l-2 cursor-pointer ${
                s.id === sessionId
                  ? "bg-white/10 text-white border-l-2 border-[#3EE88A]"
                  : "text-zinc-400 hover:text-white hover:bg-white/5 border-l-2 border-transparent"
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full shrink-0 mt-1 bg-blue-400" />
              <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-50" />
              <div className="flex-1 min-w-0">
                {renamingSessionId === s.id ? (
                  <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleRenameSession(s.id);
                        if (event.key === "Escape") setRenamingSessionId("");
                      }}
                      aria-label="Chat name"
                      className="min-w-0 flex-1 rounded border border-white/20 bg-black px-1.5 py-1 text-xs text-white outline-none"
                    />
                    <button type="button" onClick={() => void handleRenameSession(s.id)} className="p-1 text-emerald-300" aria-label="Save chat name"><Check className="h-3 w-3" /></button>
                    <button type="button" onClick={() => setRenamingSessionId("")} className="p-1 text-zinc-400" aria-label="Cancel rename"><X className="h-3 w-3" /></button>
                  </div>
                ) : <div className={`truncate leading-tight ${s.id === sessionId ? "font-medium" : ""}`}>{s.title}</div>}
                <div className="text-[10px] text-zinc-600 mt-0.5">{formatSessionTime(s.updated_at)}</div>
              </div>
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); setRenamingSessionId(s.id); setRenameValue(s.title); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all shrink-0"
                title="Rename chat"
                aria-label="Rename chat"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={(e) => handleDeleteSession(s.id, e)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/10 hover:text-red-400 transition-all shrink-0"
                title="Delete chat"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          {sessionsLoaded && sessions.length === 0 && (
            <div className="text-[11px] text-zinc-600 px-2.5 py-4 text-center">
              No chats yet. Ask a question to start.
            </div>
          )}
        </div>
      </aside>}

      {/* ═══════ Chat Area ═══════ */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="hidden lg:flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={() => setShowSessions((visible) => !visible)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-zinc-400 hover:border-white/20 hover:text-white"
          >
            {showSessions ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeft className="h-3.5 w-3.5" />}
            {showSessions ? "Hide chats" : "Show chats"}
          </button>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-zinc-400">
            Markdown output
          </div>
        </div>
        {sessionError && (
          <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            Chat session could not be saved: {sessionError}
          </div>
        )}
        {brokerActionMessage && (
          <div className="mb-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            {brokerActionMessage}
          </div>
        )}
        {/* Mobile: new chat button */}
        <div className="lg:hidden mb-3 flex justify-between">
          <button
            type="button"
            onClick={() => setShowSessions((visible) => !visible)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-400"
          >
            <PanelLeft className="h-3.5 w-3.5" />
            {showSessions ? "Hide chats" : "Chats"}
          </button>
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-blue-500/30 hover:text-white"
          >
            <Plus className="w-3 h-3" />
            New chat
          </button>
        </div>
        <div className="lg:hidden mb-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-zinc-400">
          Markdown output
        </div>
        {showSessions && (
          <div className="absolute inset-x-4 top-11 z-30 max-h-[55dvh] overflow-y-auto rounded-xl border border-white/10 bg-black/95 p-2 shadow-2xl lg:hidden">
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => { void handleSwitchSession(s.id); setShowSessions(false); }}
                role="button"
                tabIndex={0}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs border-l-2 cursor-pointer ${
                  s.id === sessionId ? "bg-white/10 text-white border-l-2 border-[#3EE88A]" : "text-zinc-400 border-l-2 border-transparent"
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-blue-400" />
                <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                {renamingSessionId === s.id ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleRenameSession(s.id);
                        if (event.key === "Escape") setRenamingSessionId("");
                      }}
                      aria-label="Chat name"
                      className="min-w-0 flex-1 rounded border border-white/20 bg-black px-1.5 py-1 text-xs text-white outline-none"
                    />
                    <button type="button" onClick={() => void handleRenameSession(s.id)} className="p-1 text-emerald-300" aria-label="Save chat name"><Check className="h-3 w-3" /></button>
                  </div>
                ) : <span className={`min-w-0 flex-1 truncate ${s.id === sessionId ? "font-medium" : ""}`}>{s.title}</span>}
                {renamingSessionId !== s.id && <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); setRenamingSessionId(s.id); setRenameValue(s.title); }}
                  className="p-1 text-zinc-400"
                  aria-label="Rename chat"
                ><Pencil className="h-3 w-3" /></button>}
                <span className="text-[10px] text-zinc-600">{formatSessionTime(s.updated_at)}</span>
              </div>
            ))}
            {sessionsLoaded && sessions.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-zinc-500">No saved chats yet.</div>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto space-y-3 mb-2 pr-2">
          {messages.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-3xl mb-3">🤖</div>
              <h2 className="text-sm font-semibold text-white mb-2">Ask PropAI anything</h2>
              <p className="text-xs text-zinc-500 max-w-md mx-auto">
                Search the parsed inventory index. Results are grounded in database rows and rendered as markdown tables.
              </p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {messages.map((m, i) => (
                <motion.div
                  key={m.id || i}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                  className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}
                >
                  {m.role === "assistant" && <span className="text-lg mt-1">🤖</span>}
                  {m.role === "user" ? (
                    <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm bg-blue-600 text-white whitespace-pre-wrap">
                      {messageText(m)}
                    </div>
                  ) : (
                    <div className="max-w-[95%] w-full space-y-3">
                      {(() => {
                        const parts = (m.parts || []) as Array<{ type?: string; text?: string; data?: any }>;
                        const textParts = (m.parts || []).filter(
                          (p: any) => p.type === "text" && p.text
                        ) as Array<{ text: string }>;
                        const dataParts = parts.filter((p) => {
                          const type = p.type || "";
                          return type.startsWith("data-") && CHAT_CARD_BLOCK_TYPES.has(type.slice(5));
                        });
                        const structuredItems = dataParts.flatMap((part) => {
                          const block = part.data || {};
                          return Array.isArray(block.items) ? block.items : [];
                        }) as ListingItem[];
                        const hasStructuredItems = structuredItems.length > 0;
                        const hasTable = textParts.some((p) => textHasTable(p.text));
                        return (
                          <>
                            {(hasTable || hasStructuredItems) && (
                              <div className="flex items-center gap-2">
                                <span className="inline-flex items-center rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-200">
                                  Parsed inventory
                                </span>
                                <div className="ml-auto flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setInput("more");
                                      setTimeout(() => {
                                        handleSubmit({ preventDefault: () => {} } as any);
                                      }, 50);
                                    }}
                                    className="rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-blue-200 hover:bg-blue-500/20"
                                  >
                                    Next 10 →
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => copyAnswer(parts)}
                                    className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-400 hover:text-zinc-200 hover:border-white/25"
                                  >
                                    {copiedTable ? "Copied" : "Copy CSV"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => exportAnswer(parts)}
                                    className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-400 hover:text-zinc-200 hover:border-white/25"
                                  >
                                    Export CSV
                                  </button>
                                </div>
                              </div>
                            )}
                            {textParts.map((p: any, i: number) => (
                              <MarkdownMessage key={i} text={hasStructuredItems ? removeMarkdownTables(p.text) : p.text} />
                            ))}
                            {dataParts.map((part: any, blockIndex: number) => {
                              const block = part.data || {};
                              const items = Array.isArray(block.items) ? block.items as ListingItem[] : [];
                              const visibleItems = items.filter((item) => {
                                const phone = normalizePhoneKey(item.broker_phone || item.sender_phone || "");
                                if (phone && hiddenBrokerPhones.has(phone)) return false;
                                const listingKey = hiddenListingKey(item);
                                const requirementKey = hiddenRequirementKey(item);
                                return (!listingKey || !hiddenMarketKeys.has(listingKey))
                                  && (!requirementKey || !hiddenMarketKeys.has(requirementKey));
                              });
                              if (!visibleItems.length) return null;
                              return (
                                <div key={`structured-${blockIndex}`} className="space-y-3">
                                  {block.title && <h3 className="mt-2 font-semibold text-white">{block.title}</h3>}
                                  <div className="grid gap-3 xl:grid-cols-2">
                                    {visibleItems.map((item, itemIndex) => (
                                      <ListingCard
                                        key={`${item.listing_id || item.raw_message_id || "item"}-${itemIndex}`}
                                        item={item}
                                        onHideBroker={hideBrokerLocally}
                                        onHideListing={hideListingLocally}
                                        onHideRequirement={hideRequirementLocally}
                                      />
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </>
                        );
                      })()}
                    </div>
                  )}
                  {m.role === "user" && <span className="text-lg mt-1">👤</span>}
                </motion.div>
              ))}
            </AnimatePresence>
          )}

          {(status === "submitted" || status === "streaming") && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="flex gap-3"
            >
              <span className="text-lg mt-1">🤖</span>
              <div className="flex-1 max-w-[95%] rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="table-skeleton-line w-28" />
                  <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Searching the market…</span>
                </div>
                <div className="flex gap-3">
                  {["Building", "Locality", "Type", "Rent/Sale", "Broker", "Last seen"].map((h) => (
                    <div key={h} className="flex-1 table-skeleton-line" />
                  ))}
                  <div className="w-16 table-skeleton-line" />
                </div>
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className="flex gap-3 mt-3">
                    <div className="flex-1 table-skeleton-bar" />
                    <div className="flex-1 table-skeleton-bar" />
                    <div className="flex-1 table-skeleton-bar" />
                    <div className="flex-1 table-skeleton-bar" />
                    <div className="flex-1 table-skeleton-bar" />
                    <div className="flex-1 table-skeleton-bar" />
                    <div className="w-16 table-skeleton-bar" />
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="flex gap-3"
            >
              <span className="text-lg mt-1">⚠️</span>
              <div className="bg-red-900/20 border border-red-500/20 rounded-xl px-4 py-2.5 text-sm text-red-300">
                {error instanceof Error ? error.message : "Something went wrong"}
              </div>
            </motion.div>
          )}

          <div ref={chatEndRef} />
        </div>

        <form onSubmit={handleSubmit} className="mt-auto border-t border-white/10 pt-2 pb-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-zinc-500">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full border px-2 py-1 font-medium uppercase tracking-[0.14em] ${
                  showFreshChatNotice && messages.length === 0
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
                    : "border-white/10 bg-white/[0.03] text-zinc-400"
                }`}
              >
                {showFreshChatNotice && messages.length === 0 ? "Saved in history" : "History saved"}
              </span>
              <span className="text-zinc-500">
                {showFreshChatNotice && messages.length === 0
                  ? "New chat thread created. The first reply will be stored automatically."
                  : "Replies are saved to history automatically."}
              </span>
            </div>
          </div>
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="Ask a question about your market data..."
              rows={2}
              className="flex-1 bg-zinc-900 border border-white/10 rounded-xl px-3 lg:px-4 py-2.5 text-sm text-white placeholder-[#64748b] resize-none max-h-[120px]"
            />
            <button
              type="submit"
              disabled={status === "submitted" || status === "streaming" || !input.trim()}
              className="px-3 lg:px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-xl text-sm font-medium min-h-[44px]"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
