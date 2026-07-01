"use client";

import { useEffect, useState, useRef, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import * as api from "@/lib/api";
import WhatsAppMessage, { MessageEntity } from "@/components/WhatsAppMessage";
import TextSelectionMenu from "@/components/TextSelectionMenu";
import { CombinedLocalityDialog } from "@/components/CombinedLocalityDialog";
import AddToClientBucket from "@/components/AddToClientBucket";
import ResizablePanel from "@/components/ResizablePanel";
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
} from "lucide-react";

const PAGE_SIZE = 100;
const RIGHT_TABS = [
  { key: "analysis", label: "🎯 Analysis" },
  { key: "broker", label: "🤝 Broker" },
  { key: "building", label: "🏢 Building" },
] as const;

function detectPropertyType(parsed: any): "residential" | "commercial" | "retail" | "industrial" {
  const intent = (parsed.intent || "").toUpperCase();
  const msg = (parsed.raw_payload?.full_text || "").toLowerCase();
  if (intent === "COMMERCIAL" || /commercial|office|shop|showroom|warehouse|godown|retail/.test(msg)) {
    if (/warehouse|godown|industrial|loading|truck/.test(msg)) return "industrial";
    if (/shop|showroom|retail|frontage|ground\s*floor/.test(msg)) return "retail";
    return "commercial";
  }
  return "residential";
}

function stripEmojis(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{231A}-\u{23FF}\u{25A0}-\u{25FF}\u{2934}-\u{2935}\u{2B05}-\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{2122}\u{2139}\u{24C2}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2600}-\u{27EB}]/gu, "").trim();
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

function Field({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-[10px] text-[#64748b] block uppercase tracking-wider">{label}</span>
      <span className={`mt-0.5 block leading-normal ${accent ? "font-bold text-[#3EE88A]" : "font-semibold text-white"}`}>
        {value}
      </span>
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

function PropertyDetails({ parsed }: { parsed: any }) {
  const type = detectPropertyType(parsed);
  const intent = parsed.intent || "TEXT";
  const price = parsed.price ? formatCurrency(parsed.price, parsed.price_unit) : null;
  const area = parsed.area_sqft ? `${parsed.area_sqft} sqft` : null;
  const location = parsed.location_raw || parsed.micro_market || null;
  const building = parsed.building_name || null;
  const furnishing = parsed.furnishing || null;
  const bhk = parsed.bhk || null;

  const typeLabels = {
    residential: "Residential",
    commercial: "Commercial Office",
    retail: "Retail",
    industrial: "Industrial",
  };

  const typeColors = {
    residential: "badge-blue",
    commercial: "badge-purple",
    retail: "badge-yellow",
    industrial: "badge-orange",
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">Property Details</span>
        <span className={`badge ${typeColors[type]} text-[9px]`}>{typeLabels[type]}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <Field label="Intent" value={<span className="badge badge-blue">{intent}</span>} />
        <Field label="Price" value={price} accent />
        {type === "residential" && <Field label="BHK" value={bhk} />}
        <Field label="Carpet" value={area} />
        <Field label="Location" value={location} />
        {building && <Field label="Building" value={building} />}
        {furnishing && <Field label="Furnishing" value={furnishing} />}
        {type === "commercial" && furnishing && <Field label="Fit-out" value={furnishing} />}
      </div>
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
      <span className="font-semibold text-[#cbd5e1] truncate max-w-[220px] block">{name}</span>
      {visible && data && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 min-w-[220px] rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#111820] p-3 shadow-xl pointer-events-none">
          <div className="text-[11px] text-[#e2e8f0] font-semibold mb-1.5">{name}</div>
          <div className="space-y-1 text-[10px] text-[#94a3b8]">
            <div className="flex justify-between"><span>Market Posts</span><span className="text-[#e2e8f0]">{data.total_listings}</span></div>
            {data.price_range_rent && <div className="flex justify-between"><span>Rent range</span><span className="text-[#e2e8f0]">{data.price_range_rent}</span></div>}
            {data.price_range_sale && <div className="flex justify-between"><span>Sale range</span><span className="text-[#e2e8f0]">{data.price_range_sale}</span></div>}
            {data.markets?.length > 0 && <div className="flex justify-between"><span>Markets</span><span className="text-[#e2e8f0] text-right max-w-[120px] truncate">{data.markets.join(", ")}</span></div>}
            {data.team_members?.length > 0 && (
              <div className="border-t border-[rgba(255,255,255,0.06)] pt-1.5 mt-1.5">
                <div className="text-[9px] text-[#64748b] uppercase tracking-wider mb-1">Team</div>
                {data.team_members.map((tm: any, i: number) => (
                  <div key={i} className="flex justify-between text-[10px]">
                    <span>{tm.name}</span>
                    <span className="text-[#e2e8f0]">{tm.phone}</span>
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
  // Left Panel States
  const [messages, setMessages] = useState<api.InboxThread[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loadingLeft, setLoadingLeft] = useState(false);
  const [offset, setOffset] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [viewMode, setViewMode] = useState<"people" | "brokers" | "groups" | "direct">("brokers");
  const [brokerFeed, setBrokerFeed] = useState<any[]>([]);
  const [loadingBrokerFeed, setLoadingBrokerFeed] = useState(false);
  const [selectedBrokerObservations, setSelectedBrokerObservations] = useState<any[]>([]);
  const [loadingBrokerObs, setLoadingBrokerObs] = useState(false);

  // Selection States
  const [selectedMsg, setSelectedMsg] = useState<api.RawMessage | api.InboxThread | null>(null);
  
  // Center Panel States
  const [conversationMessages, setConversationMessages] = useState<api.RawMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Right Panel States
  const [activeRightTab, setActiveRightTab] = useState<"analysis" | "broker" | "building">("analysis");
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
  
  // Interaction/UI States
  const [revealedPhone, setRevealedPhone] = useState<Record<string, boolean>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);

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

  // Sync selected message to URL
  const updateUrlMessage = useCallback((conversationKey: string, msgId: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("conversation", conversationKey);
    url.searchParams.set("message", String(msgId));
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

  // 1. Initial Load of Feed & Suggestions
  const loadFeed = useCallback(async () => {
    setLoadingLeft(true);
    try {
      const threadMsgs = await api.getInboxThreads(PAGE_SIZE, offset);
      setMessages(threadMsgs);
      const groupData = await api.getGroups();
      setGroups(groupData);
      const sugData = await api.getSuggestions("pending", 100);
      setAllSuggestions(sugData);
    } catch (e) {
      console.error("Failed to load feed:", e);
    } finally {
      setLoadingLeft(false);
    }
  }, [offset]);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

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

  // Load broker feed when switching to brokers or people tabs
  useEffect(() => {
    if ((viewMode === "brokers" || viewMode === "people") && brokerFeed.length === 0) {
      loadBrokerFeed();
    }
  }, [viewMode, loadBrokerFeed, brokerFeed.length]);

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

  const displayGroupName = (value?: string) => {
    const text = (value || "").trim();
    if (!text || text === "seed" || text === "seed-bot") return "";
    const knownGroup = groups.find((g) => g?.jid === text);
    if (knownGroup?.name) return knownGroup.name;
    if (isRawWhatsAppId(text)) {
      const raw = text.split("@")[0];
      const suffix = raw.includes("-") ? raw.split("-").pop()?.slice(-4) : raw.slice(-4);
      return suffix ? `WhatsApp Group ${suffix}` : "WhatsApp Group";
    }
    return text;
  };

  const displayChatTitle = (msg: api.InboxThread | api.RawMessage) => {
    const conversationName = "conversation_name" in msg ? msg.conversation_name : "";
    const group = displayGroupName(conversationName || msg.group_name);
    if (group) return group;
    const brokerName = (msg.broker_name || "").trim();
    if (brokerName) return brokerName;
    const sender = (msg.sender || "").trim();
    const phone = resolveMessagePhone(msg);
    if (isRawWhatsAppId(sender)) return displayPhoneString(phone) || "Direct Message";
    return sender || displayPhoneString(phone) || "Direct Message";
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
      phoneFromJid((msg as Partial<api.InboxThread>)?.conversation_key)
    );
  };

  const resolveMessageSenderName = (msg?: Partial<api.RawMessage> | null) => {
    if (!msg) return "";
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

    if (entity.exists === false) {
      window.location.href = entityCreateUrl(entity);
      return;
    }

    if (entity.type === "broker" || entity.type === "phone") {
      setActiveRightTab("broker");
      loadBrokerDetails(entity.type === "broker" ? entity.text : "", entity.phone || entity.text);
      return;
    }

    if (entity.type === "building" || entity.type === "society") {
      setActiveRightTab("building");
      loadBuildingDetails(entity.text);
      return;
    }

    if (entity.type === "locality") {
      setActiveRightTab("analysis");
      loadPriceStats(entity.text, selectedMsgDetails?.parsed?.bhk || "", "listing");
      return;
    }

    if (entity.type === "listing" && entity.id) {
      window.location.href = `/market/listings?listing=${encodeURIComponent(String(entity.id))}`;
      return;
    }

    if (entity.type === "requirement" && entity.id) {
      window.location.href = `/requirements?requirement=${encodeURIComponent(String(entity.id))}`;
      return;
    }

    setActiveRightTab("analysis");
  };

  const entityCreateUrl = (entity: MessageEntity) => {
    const params = new URLSearchParams({ term: entity.text, type: entity.type });
    if (entity.rawMessageId) params.set("message", String(entity.rawMessageId));
    return `/trainer?${params.toString()}`;
  };

  const toggleRevealPhone = (phone: string) => {
    setRevealedPhone(prev => ({ ...prev, [phone]: !prev[phone] }));
  };

  // Context Action Handlers
  const handleTextAction = (text: string, action: string) => {
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
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "building").then(() =>
          alert(`"${text}" saved as Building`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "training-society":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "society").then(() =>
          alert(`"${text}" saved as Society`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "training-landmark":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "landmark").then(() =>
          alert(`"${text}" saved as Landmark`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "training-locality":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "locality").then(() =>
          alert(`"${text}" saved as Locality`)
        ).catch(e => alert("Error: " + e.message));
        break;
      case "training-combined-locality":
        setCombinedLocalitySurfaceText(text);
        setShowCombinedLocalityDialog(true);
        break;
      case "training-ignore":
        api.inlineResolveTrainerTerm(text, selectedMsg?.id, "ignored").then(() =>
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
        m.conversation_key || m.group_name || `${m.sender || "unknown"}:${m.timestamp}`,
        m,
      ])
    ).values()
  );

  const groupChats = uniqueThreads
    .filter((m) => m.conversation_type === "group")
    .map((m) => ({
      conversationKey: m.conversation_key || m.group_name,
      rawGroupName: m.group_name,
      title: displayGroupName(m.conversation_name || m.group_name),
      latest: m,
      count: m.message_count || 0,
    }))
    .sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());

  const directChats = uniqueThreads
    .filter((m) => m.conversation_type === "direct")
    .map((m) => ({
      senderKey: m.conversation_key,
      name: displayChatTitle(m),
      latest: m,
      count: m.message_count || 0,
    }))
    .sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());

  const leftListEmpty =
    viewMode === "brokers"
      ? brokerFeed.length === 0
      : viewMode === "groups"
      ? groupChats.length === 0
      : viewMode === "direct"
      ? directChats.length === 0
      : uniqueThreads.length === 0 && brokerFeed.length === 0 && directChats.length === 0;

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
    !!selectedMsg?.group_name && selectedMsg.group_name !== "seed" && selectedMsg.group_name !== "seed-bot";
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
    setSelectedMsg(msg);
    setLoadingConv(true);
    try {
      let thread: api.RawMessage[] = [];
      const groupName =
        "conversation_type" in msg && msg.conversation_type === "group"
          ? (msg.conversation_key || msg.group_name || "").trim()
          : "";
      if (groupName && groupName !== "seed" && groupName !== "seed-bot") {
        // Group Conversation
        thread = await api.getRaw(80, 0, groupName);
      } else {
        // Direct Chat Conversation
        const resolvedPhone = resolveMessagePhone(msg);
        const phone = isRealPhoneDigits(resolvedPhone) ? resolvedPhone : undefined;
        const jid = msg.sender_jid || msg.group_name || ("conversation_key" in msg ? msg.conversation_key : "") || undefined;
        thread = await api.getRaw(80, 0, undefined, undefined, phone, jid);
      }
      // Threads come newest first, reverse to show chronological top-to-bottom
      const chronologicalThread = thread.slice().reverse();
      setConversationMessages(chronologicalThread);

      // Inactive group rows use a synthetic row; analyze the latest real thread item instead.
      const detailTarget = msg.id ? msg : chronologicalThread[chronologicalThread.length - 1];
      if (detailTarget?.id) {
        setSelectedMsg({
          ...detailTarget,
          ...("conversation_key" in msg
            ? {
                conversation_type: msg.conversation_type,
                conversation_key: msg.conversation_key,
                conversation_name: msg.conversation_name,
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
    updateUrlMessage((msg as any).conversation_key || msg.group_name || "", msg.id);
    const el = messageRefs.current[msg.id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [updateUrlMessage]);

  // 3c. Select a broker card -> show observations in center + profile in right panel
  const selectBroker = useCallback(async (broker: any) => {
    setActiveRightTab("broker");
    setSelectedBroker({
      id: broker.primary_phone,
      phone: broker.primary_phone,
      canonical_name: broker.canonical_name,
      building_count: broker.building_count || 0,
      active_days_30: broker.active_days_30 || 0,
      first_seen: broker.first_seen,
      last_seen: broker.last_active,
    });
    setSelectedMsgDetails(null);
    // Load observations for center timeline
    setLoadingBrokerObs(true);
	    try {
	      const obs = await api.getObservationsFeed(50, 0, broker.primary_phone);
	      setSelectedBrokerObservations(obs);
	      const latestRawId = obs?.[0]?.latest_raw_message_id || obs?.[0]?.raw_message_id;
	      if (latestRawId) {
	        loadMessageDetails(latestRawId, { setSelectedRaw: true, preserveProfiles: true });
	      }
	    } catch (e) {
	      console.error("Failed to load broker observations:", e);
	      setSelectedBrokerObservations([]);
    } finally {
      setLoadingBrokerObs(false);
    }
  }, []);

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

    // 1. Missing building / Unresolved building
    if (parsed.building_name && (!resolver.building_name || resolver.method === "unresolved")) {
      signals.push({
        type: "warning",
        title: "Missing Building Mapping",
        desc: `Building "${parsed.building_name}" needs confirmation before it can be used reliably.`
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

    const prompts: { text: string; question: string; actions: { label: string; action: string }[] }[] = [];
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
    <div className="flex flex-col h-[calc(100vh-80px)] border border-[rgba(255,255,255,0.06)] rounded-2xl overflow-hidden bg-[#090d12]">
      
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
        <div className="bg-[#1e293b] border-b border-[#3EE88A]/30 text-[#3EE88A] px-4 py-2 text-xs font-semibold text-center transition-all animate-pulse">
          🚀 {actionMessage}
        </div>
      )}

      {/* Main Layout Grid */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* ================= LEFT PANEL: INBOX ================= */}
        <ResizablePanel
          defaultWidth={320}
          minWidth={240}
          maxWidth={500}
          storageKey="propai-inbox-left-width"
          className="border-r border-[rgba(255,255,255,0.06)] bg-[#0a0e14]"
        >
          <div className="flex flex-col h-full">
          {/* Panel Search & Header */}
          <div className="p-4 border-b border-[rgba(255,255,255,0.06)] space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold tracking-wider text-[#e2e8f0] uppercase">Market Inbox</div>
                <div className="text-[10px] text-[#64748b] mt-0.5">WhatsApp conversations with PropAI memory</div>
              </div>
              <button
                onClick={loadFeed}
                className="text-xs text-[#3EE88A] hover:underline"
                disabled={loadingLeft}
              >
                {loadingLeft ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            
            <input
              type="text"
              placeholder="Search chats, brokers, buildings..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-full px-3 py-1.5 bg-[#0d1117] border border-[rgba(255,255,255,0.1)] rounded-lg text-xs text-[#e2e8f0] focus:border-[#3EE88A] focus:outline-none transition-colors"
            />

            {/* Filter Toggle Buttons */}
            <div className="grid grid-cols-4 gap-1 bg-[#0d1117] p-0.5 rounded-lg border border-[rgba(255,255,255,0.03)]">
              {(["brokers", "groups", "direct", "people"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors ${
                    viewMode === mode
                      ? "bg-[#111820] text-[#3EE88A] shadow-sm"
                      : "text-[#64748b] hover:text-white"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* List Content */}
          <div className="flex-1 overflow-y-auto divide-y divide-[rgba(255,255,255,0.04)]">
            {loadingLeft && messages.length === 0 && groups.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#64748b]">Loading inbox feed...</div>
            ) : leftListEmpty ? (
              <div className="p-8 text-center text-xs text-[#64748b]">No chats found</div>
            ) : (
              <>
                {/* 1. People view: Broker cards + Direct chats (identity stream) */}
                {viewMode === "people" && (
                  <>
                    {brokerFeed.length > 0 && (
                      <>
                        <div className="px-3.5 py-2 text-[9px] text-[#64748b] uppercase tracking-wider font-bold">
                          Brokers
                        </div>
                        {brokerFeed.slice(0, 20).map((b: any) => (
                          <button
                            key={"broker-" + b.primary_phone}
                            onClick={() => selectBroker(b)}
                            className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1.5 select-none ${
                              selectedBroker?.id === b.primary_phone && viewMode === "people"
                                ? "bg-blue-600/10 border-l-2 border-[#3b82f6]"
                                : "hover:bg-[rgba(255,255,255,0.02)]"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-bold text-[#e2e8f0] truncate max-w-[160px] flex items-center gap-1">
                                <User className="w-3 h-3 text-[#64748b]" strokeWidth={1.5} />
                                {stripEmojis(b.canonical_name) || "Unknown"}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[9px] bg-[#111820] text-[#64748b] px-1.5 py-0.5 rounded-full">
                                  {b.observation_count} obs
                                </span>
                              </div>
                            </div>
                            {b.latest_title && (
                              <div className="text-[10px] text-[#94a3b8] line-clamp-1 leading-relaxed">
                                {stripEmojis(b.latest_title)}
                              </div>
                            )}
                          </button>
                        ))}
                      </>
                    )}
                    {directChats.length > 0 && (
                      <>
                        <div className="px-3.5 py-2 text-[9px] text-[#64748b] uppercase tracking-wider font-bold border-t border-[rgba(255,255,255,0.04)]">
                          Direct Messages
                        </div>
                        {directChats.map((d) => {
                          const latestPhone = resolveMessagePhone(d.latest);
                          return (
                            <button
                              key={"direct-" + d.senderKey}
                              onClick={() => selectConversation(d.latest)}
                              className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1 select-none ${
                                resolveMessagePhone(selectedMsg) === latestPhone
                                  ? "bg-blue-600/10 border-l-2 border-[#3b82f6]"
                                  : "hover:bg-[rgba(255,255,255,0.02)]"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-bold text-[#e2e8f0] truncate max-w-[180px]">
                                  <User className="w-3 h-3 text-[#64748b]" strokeWidth={1.5} /> {d.name}
                                </span>
                                <span className="text-[9px] bg-[#111820] text-[#64748b] px-1.5 py-0.5 rounded-full">
                                  {d.count} msg
                                </span>
                              </div>
                              {latestPhone && (
                                <div className="text-[9px] text-[#64748b] font-mono">
                                  {displayPhoneString(latestPhone)}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </>
                    )}
                    {brokerFeed.length === 0 && directChats.length === 0 && (
                      <div className="p-8 text-center text-xs text-[#64748b]">No identities found</div>
                    )}
                  </>
                )}

                {/* 2. Group Chats View */}
                {viewMode === "groups" &&
                  groupChats.map((g) => {
                    const isSelected =
                      selectedMsg &&
                      "conversation_key" in selectedMsg &&
                      selectedMsg.conversation_key === g.conversationKey;
                    return (
                      <button
                        key={g.rawGroupName}
                        onClick={() => selectConversation(g.latest)}
                        className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1 select-none ${
                          isSelected ? "bg-blue-600/10 border-l-2 border-[#3b82f6]" : "hover:bg-[rgba(255,255,255,0.02)]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-[#e2e8f0] truncate max-w-[180px]">
                            <Users className="w-3 h-3 text-[#64748b]" strokeWidth={1.5} /> {g.title}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {g.latest.lag_seconds != null && (
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  g.latest.lag_seconds < 30 ? "bg-emerald-500" :
                                  g.latest.lag_seconds < 300 ? "bg-yellow-500" :
                                  g.latest.lag_seconds < 3600 ? "bg-orange-500" : "bg-red-500"
                                }`}
                                title={`Lag: ${g.latest.lag_seconds < 60 ? `${g.latest.lag_seconds}s` : `${Math.round(g.latest.lag_seconds / 60)}m`}`}
                              />
                            )}
                            <span className="text-[9px] bg-[#111820] text-[#64748b] px-1.5 py-0.5 rounded-full">
                              {g.count} msg
                            </span>
                          </div>
                        </div>
                        <div className="text-[10px] text-[#64748b] truncate mt-1">
                          Last: {resolveMessageSenderName(g.latest)}
                        </div>
                        <div className="text-[11px] text-[#94a3b8] line-clamp-1 italic">
                          &quot;<WhatsAppMessage
                            text={g.latest.message || ""}
                            entities={buildMessageEntities(g.latest)}
                            onEntityClick={handleEntityClick}
                            truncate
                            maxLines={1}
                          />&quot;
                        </div>
                      </button>
                    );
                  })}

                {/* 3. Direct Chats View */}
                {viewMode === "direct" &&
                  directChats.map((d) => {
                    const latestPhone = resolveMessagePhone(d.latest);
                    const isSelected =
                      selectedMsg?.sender === d.name ||
                      (selectedMsg && "conversation_key" in selectedMsg && selectedMsg.conversation_key === d.senderKey) ||
                      resolveMessagePhone(selectedMsg) === latestPhone;
                    return (
                      <button
                        key={d.senderKey}
                        onClick={() => selectConversation(d.latest)}
                        className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1 select-none ${
                          isSelected ? "bg-blue-600/10 border-l-2 border-[#3b82f6]" : "hover:bg-[rgba(255,255,255,0.02)]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-[#e2e8f0] truncate max-w-[180px]">
                            <User className="w-3 h-3 text-[#64748b]" strokeWidth={1.5} /> {d.name}
                          </span>
                          <span className="text-[9px] bg-[#111820] text-[#64748b] px-1.5 py-0.5 rounded-full">
                            {d.count} msg
                          </span>
                        </div>
                        {latestPhone && (
                          <div className="text-[9px] text-[#64748b] font-mono">
                            {displayPhoneString(latestPhone)}
                          </div>
                        )}
                        <div className="text-[11px] text-[#94a3b8] line-clamp-1 italic mt-1">
                          &quot;<WhatsAppMessage
                            text={d.latest.message || ""}
                            entities={buildMessageEntities(d.latest)}
                            onEntityClick={handleEntityClick}
                            truncate
                            maxLines={1}
                          />&quot;
                        </div>
                      </button>
                    );
                  })}

                {/* 4. Broker Feed View */}
                {viewMode === "brokers" && loadingBrokerFeed && (
                  <div className="p-8 text-center text-xs text-[#64748b]">Loading broker feed...</div>
                )}
                {viewMode === "brokers" && !loadingBrokerFeed &&
                  brokerFeed.map((b: any) => {
                    const isSelected = selectedBroker?.id === b.primary_phone;
                    return (
                        <button
                          key={b.primary_phone}
                          onClick={() => selectBroker(b)}
                          className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1.5 select-none ${
                            isSelected ? "bg-blue-600/10 border-l-2 border-[#3b82f6]" : "hover:bg-[rgba(255,255,255,0.02)]"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-[#e2e8f0] truncate max-w-[160px] flex items-center gap-1">
                              <User className="w-3 h-3 text-[#64748b]" strokeWidth={1.5} />
                              {stripEmojis(b.canonical_name) || "Unknown"}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] bg-[#111820] text-[#64748b] px-1.5 py-0.5 rounded-full">
                                {b.observation_count} obs
                              </span>
                              <span className={`text-[9px] rounded-full px-1.5 py-0.5 ${
                                b.active_days_30 > 0
                                  ? "bg-emerald-900/40 text-emerald-400"
                                  : "bg-[#111820] text-[#64748b]"
                              }`}>
                                {b.active_days_30 || 0}d
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] text-[#64748b] font-mono">
                              {displayPhoneString(b.primary_phone)}
                            </span>
                            <span className="text-[9px] text-[#64748b]">
                              {b.last_active ? new Date(b.last_active).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                            </span>
                          </div>
                          {b.latest_title && (
                            <div className="text-[10px] text-[#94a3b8] line-clamp-1 leading-relaxed">
                              {stripEmojis(b.latest_title)}
                            </div>
                          )}
                          {/* Observed In chips */}
                          {b.channels && b.channels.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {b.channels.slice(0, 5).map((ch: any, i: number) => (
                                <span
                                  key={i}
                                  className={`text-[8px] px-1.5 py-0.5 rounded-full border ${
                                    ch.type === "group"
                                      ? "bg-[#111820] border-[rgba(255,255,255,0.06)] text-[#94a3b8]"
                                      : "bg-[#111820] border-[rgba(62,232,138,0.15)] text-[#3EE88A]"
                                  }`}
                                >
                                  {ch.type === "group" ? displayGroupName(ch.source) || ch.source.slice(-8) : "DM"}
                                </span>
                              ))}
                              {b.unique_channel_count > 5 && (
                                <span className="text-[8px] text-[#64748b] px-1 py-0.5">
                                  +{b.unique_channel_count - 5}
                                </span>
                              )}
                            </div>
                          )}
                          {/* Evidence counts */}
                          <div className="flex items-center gap-2 text-[9px] text-[#64748b]">
                            {b.group_evidence_count > 0 && (
                              <span>{b.group_evidence_count} group</span>
                            )}
                            {b.dm_evidence_count > 0 && (
                              <span>{b.dm_evidence_count} dm</span>
                            )}
                            {b.unique_channel_count > 0 && (
                              <span>{b.unique_channel_count} channel{b.unique_channel_count !== 1 ? "s" : ""}</span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  }
              </>
            )}
          </div>
          
          {/* Left panel footer / Pagination */}
          <div className="p-3 border-t border-[rgba(255,255,255,0.06)] flex items-center justify-between bg-[#0a0e14]">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-2 py-1 text-[10px] font-bold bg-[#111820] text-[#94a3b8] border border-[rgba(255,255,255,0.06)] rounded disabled:opacity-30"
            >
              Prev
            </button>
            <span className="text-[10px] text-[#64748b]">
              Showing {offset + 1}–{offset + messages.length}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={messages.length < PAGE_SIZE}
              className="px-2 py-1 text-[10px] font-bold bg-[#111820] text-[#94a3b8] border border-[rgba(255,255,255,0.06)] rounded disabled:opacity-30"
            >
              Next
            </button>
          </div>
          </div>
        </ResizablePanel>

        {/* ================= CENTER PANEL: CONVERSATION ================= */}
        <div className="flex-1 flex flex-col bg-[#070b0e] overflow-hidden">
          {(viewMode === "brokers" || viewMode === "people") && selectedBroker ? (
            <>
              {/* Observation Timeline Header */}
              <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.06)] flex items-center justify-between bg-[#0a0e14]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-600/20 text-[#3b82f6] flex items-center justify-center font-bold text-sm shadow-inner">
                    <User className="w-4 h-4 text-[#64748b]" strokeWidth={1.5} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-[#e2e8f0] truncate max-w-[340px]">
                      {selectedBroker.canonical_name || "Unknown Broker"}
                    </h3>
                    <div className="text-[10px] text-[#64748b] flex items-center gap-2 mt-0.5 flex-wrap">
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
                <button
                  onClick={() => window.open(getWaLink(selectedBroker.phone), '_blank')}
                  className="h-7 px-3 rounded-md border border-[rgba(255,255,255,0.06)] bg-[#111820] text-[#3EE88A] hover:text-white transition-colors text-[10px] font-bold flex items-center gap-1"
                >
                  <MessageSquare className="w-3 h-3" strokeWidth={1.5} />
                  WhatsApp
                </button>
              </div>

              {/* Observation Timeline */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {loadingBrokerObs ? (
                  <div className="p-8 text-center text-xs text-[#64748b]">Loading observations...</div>
                ) : selectedBrokerObservations.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[#64748b]">No observations yet</div>
                ) : (
                  selectedBrokerObservations.map((obs: any) => {
                    const ev: any[] = obs.evidence_list || [];
                    const groupChannels: string[] = [...new Set<string>(ev.filter((e: any) => e.type === "group").map((e: any) => e.source))];
                    const dmCount = ev.filter((e: any) => e.type === "dm").length;
                    return (
	                      <button
	                        key={obs.id}
	                        type="button"
	                        onClick={() => selectBrokerObservation(obs)}
	                        className="w-full text-left bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl overflow-hidden transition-colors hover:border-[#3b82f6]/40 hover:bg-[#101722]"
	                      >
                        {/* Title Bar */}
                        <div className="px-4 py-3 border-b border-[rgba(255,255,255,0.04)] space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <h4 className="text-xs font-bold text-[#e2e8f0] leading-relaxed">
                              {stripEmojis(obs.summary_title) || "(no title)"}
                            </h4>
                            {obs.intent && (
                              <span className={`badge badge-${
                                ({ SELL: "green", BUY: "purple", RENT: "yellow" } as Record<string, string>)[obs.intent?.toUpperCase()] || "blue"
                              } text-[9px] px-1.5 py-0.5 shrink-0`}>
                                {obs.intent}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[9px] text-[#64748b]">
                            <span>Seen {obs.times_seen} time{obs.times_seen !== 1 ? "s" : ""}</span>
                            {obs.last_seen && (
                              <>
                                <span>·</span>
                                <span>Last: {new Date(obs.last_seen).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                              </>
                            )}
                          </div>
                          {/* Posted In chips */}
                          {(groupChannels.length > 0 || dmCount > 0) && (
                            <div className="flex flex-wrap gap-1 items-center">
                              <span className="text-[8px] text-[#64748b] uppercase tracking-wider">Posted in:</span>
                              {groupChannels.slice(0, 5).map((src: string, i: number) => (
                                <span key={i} className="text-[8px] bg-[#111820] border border-[rgba(255,255,255,0.06)] text-[#94a3b8] px-1.5 py-0.5 rounded-full">
                                  {displayGroupName(src) || src.slice(-8)}
                                </span>
                              ))}
                              {groupChannels.length > 5 && (
                                <span className="text-[8px] text-[#64748b]">+{groupChannels.length - 5}</span>
                              )}
                              {dmCount > 0 && (
                                <span className="text-[8px] bg-[#111820] border border-[rgba(62,232,138,0.15)] text-[#3EE88A] px-1.5 py-0.5 rounded-full">
                                  {dmCount} DM{dmCount > 1 ? "s" : ""}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Original Broker Message */}
                        {obs.raw_message && (
                          <div className="px-4 py-3 border-b border-[rgba(255,255,255,0.04)]">
                            <div className="text-[8px] text-[#64748b] uppercase tracking-wider font-bold mb-1.5">Original Broker Message</div>
                            <div className="text-[11px] text-[#cbd5e1] whitespace-pre-wrap leading-relaxed font-mono bg-[#05070b] rounded-lg p-3 border border-[rgba(255,255,255,0.03)]">
                              {obs.raw_message}
                            </div>
                            {obs.raw_sender && (
                              <div className="text-[9px] text-[#64748b] mt-1">
                                — {obs.raw_sender}
                              </div>
                            )}
                          </div>
                        )}

                        {/* AI Extracted Fields */}
                        <div className="px-4 py-3">
                          <div className="text-[8px] text-[#64748b] uppercase tracking-wider font-bold mb-2">AI Extracted</div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px]">
                            <Field label="Intent" value={stripEmojis(obs.intent)} />
                            <Field label="Price" value={obs.price != null ? formatCurrency(obs.price, obs.price_unit) : null} />
                            <Field label="Building" value={stripEmojis(obs.building_name) || "—"} />
                            <Field label="Locality" value={stripEmojis(obs.micro_market) || "—"} />
                            <Field label="BHK" value={stripEmojis(obs.bhk) || "—"} />
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          ) : selectedMsg ? (
            <>
              {/* Chat Thread Header */}
              <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.06)] flex items-center justify-between bg-[#0a0e14]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-600/20 text-[#3b82f6] flex items-center justify-center font-bold text-sm shadow-inner">
                    {selectedMsg.group_name && selectedMsg.group_name !== "seed" ? (
                      <Users className="w-4 h-4 text-[#64748b]" strokeWidth={1.5} />
                    ) : (
                      <User className="w-4 h-4 text-[#64748b]" strokeWidth={1.5} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-[#e2e8f0] truncate max-w-[340px]">
                      {selectedTitle}
                    </h3>
                    <div className="text-[10px] text-[#64748b] flex items-center gap-2 mt-0.5 flex-wrap">
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
                  <button className="h-7 w-7 rounded-md border border-[rgba(255,255,255,0.06)] bg-[#111820] text-[#64748b] hover:text-white transition-colors flex items-center justify-center">
                    <Search className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                  <button className="h-7 w-7 rounded-md border border-[rgba(255,255,255,0.06)] bg-[#111820] text-[#64748b] hover:text-white transition-colors flex items-center justify-center">
                    <Phone className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                  <button className="h-7 w-7 rounded-md border border-[rgba(255,255,255,0.06)] bg-[#111820] text-[#64748b] hover:text-white transition-colors flex items-center justify-center">
                    <Video className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                  <button className="h-7 w-7 rounded-md border border-[rgba(255,255,255,0.06)] bg-[#111820] text-[#64748b] hover:text-white transition-colors flex items-center justify-center">
                    <Info className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                  {!isGroupConversationSelected && resolveMessagePhone(selectedMsg) && (
                    <a
                      href={getWaLink(resolveMessagePhone(selectedMsg))}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1 bg-[#166534] text-green-100 hover:bg-[#15803d] rounded text-[10px] font-bold uppercase tracking-wider transition-colors"
                    >
                      Open WhatsApp
                    </a>
                  )}
                  {selectedBroker && (
                    <button
                      onClick={() => setActiveRightTab("broker")}
                      className="px-2.5 py-1 bg-[#1e293b] text-[#cbd5e1] hover:text-white rounded text-[10px] font-bold uppercase tracking-wider transition-colors"
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
                  <div className="h-full flex items-center justify-center text-xs text-[#64748b]">
                    Loading message thread...
                  </div>
                ) : (
                  <div className="space-y-5">
                    {groupedConversationMessages.map(([dateLabel, dayMessages]) => (
                      <div key={dateLabel} className="space-y-3">
                        <div className="flex items-center gap-3">
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                          <span className="text-[10px] uppercase tracking-[0.3em] text-[#64748b]">{dateLabel}</span>
                          <div className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" />
                        </div>
                        <div className="space-y-3">
                          {dayMessages.map((block) => {
                            const first = block[0];
                            const last = block[block.length - 1];
                            const allBlocks = groupedConversationMessages.flatMap(([, b]) => b);
                            const isLatestBlock = block === allBlocks[allBlocks.length - 1];
                            const isSelf = first.sender === "seed-bot" || first.sender === "system" || first.sender === "owner";
                            const bubbleBg = isLatestBlock
                              ? "bg-[#1d4ed8]/10 border border-[#3b82f6]/30"
                              : isSelf
                              ? "bg-emerald-950/40 border border-emerald-800/30 ml-auto"
                              : "bg-[#0d1117] border border-[rgba(255,255,255,0.06)]";

                            return (
                              <div
                                key={first.id}
                                className={`max-w-[72%] rounded-2xl p-4 space-y-2 relative transition-all ${
                                  isSelf ? "text-right ml-auto" : ""
                                } ${bubbleBg}`}
                              >
<div className={`flex items-center gap-2 text-[10px] text-[#64748b] ${isSelf ? "justify-end" : "justify-between"}`}>
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
                                  const mIntentBadgeColor =
                                    ({ SELL: "green", BUY: "purple", RENT: "yellow" } as Record<string, string>)[m.message_type?.toUpperCase()] || "blue";
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
                                        <div className="absolute -left-4 top-1/2 -translate-y-1/2 text-[#3b82f6]">
                                          <div className="w-2 h-2 rounded-full bg-[#3b82f6] shadow-[0_0_6px_rgba(59,130,246,0.6)]" />
                                        </div>
                                      )}
                                      <div className="text-xs text-[#e2e8f0] whitespace-pre-wrap leading-relaxed text-left propai-message-content">
                                        <WhatsAppMessage
                                          text={m.message || ""}
                                          sender={mSenderName}
                                          senderPhone={mPhone}
                                          entities={buildMessageEntities(m)}
                                          onEntityClick={handleEntityClick}
                                        />
                                      </div>
                                      <div className="flex items-center justify-between pt-1.5 mt-1.5 border-t border-[rgba(255,255,255,0.04)]">
                                        <div>
                                          {m.message_type && (
                                            <span className={`badge badge-${mIntentBadgeColor} text-[8px] px-1 py-0`}>
                                              {m.message_type}
                                            </span>
                                          )}
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
                                        <div className="my-2 border-t border-[rgba(255,255,255,0.04)]" />
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
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-[#64748b] space-y-2">
              <span className="text-4xl">💬</span>
              <h3 className="text-sm font-semibold text-[#cbd5e1]">No conversation selected</h3>
              <p className="text-xs max-w-xs">
                Select a WhatsApp group or direct chat to see messages, evidence, and PropAI actions.
              </p>
            </div>
          )}
        </div>

        {/* ================= RIGHT PANEL: INTELLIGENCE PANEL ================= */}
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
          presets={[
            { label: "Compact", width: 280 },
            { label: "Default", width: 384 },
            { label: "Deep Analysis", width: 560 },
          ]}
          className={
            rightPoppedOut
              ? "fixed z-50 top-6 right-6 bottom-6 left-[28%] border border-[rgba(255,255,255,0.08)] rounded-2xl shadow-2xl bg-[#0a0e14]"
              : "border-l border-[rgba(255,255,255,0.06)] bg-[#0a0e14]"
          }
        >
          <div className="flex flex-col h-full">
          {/* Tab Switcher */}
          <div className="flex border-b border-[rgba(255,255,255,0.06)] bg-[#070b0e]">
            {RIGHT_TABS.map(({ key: tab, label }) => {
              return (
                <button
                  key={tab}
                  onClick={() => setActiveRightTab(tab)}
                  className={`flex-1 py-3 text-xs font-bold text-center border-b-2 transition-colors ${
                    activeRightTab === tab
                      ? "border-[#3EE88A] text-[#3EE88A] bg-[#0a0e14]/50"
                      : "border-transparent text-[#64748b] hover:text-white"
                  }`}
                >
                  {label}
                </button>
              );
            })}
            <button
              onClick={() => setRightPoppedOut((prev) => !prev)}
              className="px-3 py-3 text-[#64748b] hover:text-white border-l border-[rgba(255,255,255,0.06)] transition-colors"
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
              <div className="h-full flex items-center justify-center text-xs text-[#64748b]">
                Updating workspace intelligence...
              </div>
            ) : !selectedMsgDetails ? (
              <div className="h-full flex items-center justify-center text-xs text-[#64748b] text-center p-6">
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
                        <div className="text-[10px] font-bold text-[#64748b] uppercase tracking-wider">
                          AI Signals & Notifications
                        </div>
                        {signals.map((s, idx) => {
                          const bg = s.type === "alert" ? "bg-red-950/20 border-red-500/30 text-red-200" : s.type === "warning" ? "bg-amber-950/20 border-amber-500/30 text-amber-200" : "bg-blue-950/20 border-blue-500/30 text-blue-200";
                          return (
                            <div key={idx} className={`p-3 rounded-xl border text-xs leading-relaxed space-y-2 ${bg}`}>
                              <div className="font-bold flex items-center gap-1.5">
                                {s.type === "alert" ? "🚨" : s.type === "warning" ? "⚠️" : "💡"} {s.title}
                              </div>
                              <p className="text-[11px] text-[#94a3b8]">{s.desc}</p>
                              
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
                    <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-1.5">
                      <div className="flex justify-between items-center text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                        <span>Original text</span>
                        <button
                          onClick={() => navigator.clipboard.writeText(selectedMsgDetails.raw?.message || "")}
                          className="hover:text-white"
                        >
                          Copy
                        </button>
                      </div>
                      <div className="text-xs text-[#cbd5e1] whitespace-pre-wrap leading-relaxed">
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
                      <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-3">
                        <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                          Conversation Context
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="flex justify-between gap-3">
                            <span className="text-[#64748b]">Type</span>
                            <span className="badge badge-blue">DIRECT MESSAGE</span>
                          </div>
                          <div className="flex justify-between gap-3">
                            <span className="text-[#64748b]">Contact</span>
                            <span className="text-right font-semibold text-white">
                              {resolveMessageSenderName(selectedMsgDetails.raw) || "Unknown contact"}
                            </span>
                          </div>
                          {resolveMessagePhone(selectedMsgDetails.raw) && (
                            <div className="flex justify-between gap-3">
                              <span className="text-[#64748b]">Phone</span>
                              <span className="font-mono text-[#cbd5e1]">
                                {displayPhoneString(resolveMessagePhone(selectedMsgDetails.raw))}
                              </span>
                            </div>
                          )}
                          <div className="rounded-lg bg-[#05070b] border border-[rgba(255,255,255,0.04)] p-3 text-[11px] leading-relaxed text-[#94a3b8]">
                            PropAI did not find enough property context in this message. It is kept as a conversation until it is linked to a broker, client, listing, or requirement.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Structured Details Panel — Property-Type Aware */}
                    {selectedHasMarketContext && (
                      <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-3">
                        {selectedMsgDetails.parsed && Object.keys(selectedMsgDetails.parsed).length > 0 ? (
                          <PropertyDetails parsed={selectedMsgDetails.parsed} />
                        ) : (
                          <div className="text-xs text-[#64748b] italic py-2">No property details found.</div>
                        )}
                      </div>
                    )}

                    {/* Extracted Listings as Individual WhatsApp-style Messages */}
	                    {selectedHasMarketContext && selectedMsgDetails.listings && selectedMsgDetails.listings.length > 1 && (
	                      <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                        <div className="flex items-center justify-between text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
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
                                <div className="flex-1 text-xs text-[#cbd5e1]">
                                  <div className="flex items-center gap-1.5 mb-1">
                                    <span className={`badge badge-${intentColor} text-[8px]`}>
                                      {intentLabel || "TEXT"}
                                    </span>
                                    {listing.bhk && (
                                      <span className="text-[10px] text-[#e2e8f0] font-semibold">
                                        {listing.bhk}
                                      </span>
                                    )}
                                    {listing.area_sqft && (
                                      <span className="text-[10px] text-[#94a3b8]">
                                        {listing.area_sqft.toLocaleString("en-IN")} sqft
                                      </span>
                                    )}
                                    {listing.furnishing && (
                                      <span className="text-[10px] text-[#94a3b8]">{listing.furnishing}</span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-[#cbd5e1] whitespace-pre-wrap leading-relaxed">
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

	                    {trainingPrompts.length > 0 && (
	                      <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(62,232,138,0.14)] space-y-3">
	                        <div className="flex items-center gap-2 text-[10px] text-[#3EE88A] uppercase tracking-wider font-bold">
	                          <Sparkles className="w-3 h-3" strokeWidth={1.7} />
	                          <span>Teach PropAI</span>
	                        </div>
	                        <div className="space-y-2">
	                          {trainingPrompts.map((prompt, idx) => (
	                            <div key={`${prompt.text}-${idx}`} className="rounded-lg bg-[#05070b] border border-[rgba(255,255,255,0.05)] p-2.5">
	                              <div className="text-[10px] text-[#64748b] mb-1">{prompt.question}</div>
	                              <div className="text-xs font-semibold text-[#e2e8f0] break-words">{prompt.text}</div>
	                              <div className="mt-2 flex flex-wrap gap-1.5">
	                                {prompt.actions.map(action => (
	                                  <button
	                                    key={action.action}
	                                    type="button"
	                                    onClick={() => handleTextAction(prompt.text, action.action)}
	                                    className="rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-2 py-1 text-[10px] font-semibold text-[#cbd5e1] hover:border-[#3EE88A]/40 hover:text-[#3EE88A]"
	                                  >
	                                    {action.label}
	                                  </button>
	                                ))}
	                              </div>
	                            </div>
	                          ))}
	                        </div>
	                      </div>
	                    )}
	
	                    {/* Location Match Panel */}
	                    {selectedHasMarketContext && (
                      <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-3">
                        <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                          Location Match
                        </div>

                        {selectedMsgDetails.resolver ? (
                          <div className="space-y-2.5 text-xs">
                            <div className="flex justify-between items-center">
                              <span className="text-[#64748b]">Status</span>
                              <span className={`badge ${
                                selectedMsgDetails.resolver.method === "resolved" ? "badge-green" : "badge-yellow"
                              } font-bold`}>
                                {selectedMsgDetails.resolver.method?.toUpperCase()}
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-[#64748b] block uppercase">Building</span>
                              <span className="font-bold text-white block mt-0.5">
                                {selectedMsgDetails.resolver.building_name || "—"}
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-[#64748b] block uppercase">Confidence Level</span>
                              <div className="flex items-center gap-2 mt-1">
                                <div className="flex-1 h-2 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-blue-500 rounded-full"
                                    style={{ width: `${Math.round((selectedMsgDetails.resolver.final_confidence || 0) * 100)}%` }}
                                  />
                                </div>
                                <span className="font-mono text-[10px] text-[#cbd5e1] font-bold">
                                  {Math.round((selectedMsgDetails.resolver.final_confidence || 0) * 100)}%
                                </span>
                              </div>
                            </div>
                            {selectedMsgDetails.resolver.method_detail && (
                              <div>
                                <span className="text-[10px] text-[#64748b] block uppercase">Match Notes</span>
                                <span className="text-[#cbd5e1] block mt-0.5 leading-relaxed text-[11px]">
                                  {selectedMsgDetails.resolver.method_detail}
                                </span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-xs text-[#64748b] italic py-2">No location match recorded.</div>
                        )}
                      </div>
                    )}

                    {/* Price Stats Comparison Widget */}
                    {priceStats && selectedMsgDetails.parsed?.price && (
                      <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-3">
                        <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                          Market Price Benchmarking
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="text-[11px] text-[#94a3b8] font-bold">
                            {selectedMsgDetails.parsed.bhk} in {selectedMsgDetails.parsed.micro_market}
                          </div>
                          <div className="flex justify-between text-[11px] border-b border-[rgba(255,255,255,0.04)] pb-1.5">
                            <span className="text-[#64748b]">Listing Price:</span>
                            <span className="font-bold text-[#3EE88A]">{formatCurrency(selectedMsgDetails.parsed.price)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-[#64748b]">Market Median:</span>
                            <span className="font-semibold text-white">{formatCurrency(priceStats.median)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-[#64748b]">25th Percentile (p25):</span>
                            <span className="text-[#cbd5e1]">{formatCurrency(priceStats.p25)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-[#64748b]">75th Percentile (p75):</span>
                            <span className="text-[#cbd5e1]">{formatCurrency(priceStats.p75)}</span>
                          </div>
                          <div className="text-[10px] text-[#64748b] pt-1.5 italic text-center">
                            Based on {priceStats.count} market listings
                          </div>
                        </div>
                      </div>
                    )}

                  </div>
                )}

                {/* ================= TAB 2: BROKER PROFILE ================= */}
                {activeRightTab === "broker" && (
                  <div className="space-y-4 animate-fadeIn">
                    {loadingBroker ? (
                      <div className="text-center text-xs text-[#64748b] py-8">Loading broker profile...</div>
                    ) : !selectedBroker ? (
                      <div className="text-center text-xs text-[#64748b] py-8">
                        No broker profile found for this contact.
                      </div>
                    ) : (
                      <div className="space-y-4 text-xs">
                        
                        {/* Broker Basic Info */}
                        <div className="bg-[#0d1117] rounded-xl p-4 border border-[rgba(255,255,255,0.04)] flex flex-col gap-2">
                          <h4 className="text-sm font-bold text-white">{selectedBroker.name}</h4>
                          
                          <div className="flex items-center justify-between text-[11px] border-t border-[rgba(255,255,255,0.04)] pt-2.5">
                            <span className="text-[#64748b]">Primary Phone</span>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[#cbd5e1]">
                                {revealedPhone[selectedBroker.phone] ? displayPhoneString(selectedBroker.phone) : maskPhoneString(selectedBroker.phone)}
                              </span>
                              <button
                                onClick={() => toggleRevealPhone(selectedBroker.phone)}
                                className="text-[9.5px] text-[#3b82f6] hover:underline"
                              >
                                {revealedPhone[selectedBroker.phone] ? "Hide" : "Reveal"}
                              </button>
                            </div>
                          </div>

                          {selectedBroker.first_seen_at && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-[#64748b]">First Seen</span>
                              <span className="text-[#cbd5e1]">
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
                              <span className="text-[#64748b]">Last Activity</span>
                              <span className="text-[#cbd5e1]">
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
                            <div key={stat.label} className="bg-[#0d1117] rounded-xl p-2.5 border border-[rgba(255,255,255,0.04)]">
                              <div className="text-sm font-bold text-white">{stat.value}</div>
                              <div className="text-[9px] text-[#64748b] uppercase mt-0.5">{stat.label}</div>
                            </div>
                          ))}
                        </div>

                        {/* Aliases */}
                        {selectedBroker.aliases?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Known Aliases
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {selectedBroker.aliases.map((a: any, idx: number) => (
                                <span key={idx} className="bg-[#111820] px-2 py-0.5 rounded text-[10px] text-[#cbd5e1] border border-[rgba(255,255,255,0.03)]">
                                  {a.alias}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Top Micro-Markets */}
                        {selectedBroker.markets?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Core Micro Markets
                            </div>
                            <div className="space-y-1.5">
                              {selectedBroker.markets.slice(0, 3).map((m: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center">
                                  <span className="font-semibold text-[#cbd5e1]">{m.micro_market}</span>
                                  <span className="text-[10px] text-[#64748b]">
                                    {m.listing_count} listings · {m.requirement_count} requirements
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Top Buildings */}
                        {selectedBroker.buildings?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Frequent Buildings
                            </div>
                            <div className="space-y-1.5">
                              {selectedBroker.buildings.slice(0, 3).map((b: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center">
                                  <span className="font-semibold text-[#cbd5e1]">{b.building_name}</span>
                                  <span className="text-[10px] text-[#64748b]">
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

                {/* ================= TAB 3: BUILDING PROFILE ================= */}
                {activeRightTab === "building" && (
                  <div className="space-y-4 animate-fadeIn">
                    {loadingBuilding ? (
                      <div className="text-center text-xs text-[#64748b] py-8">Resolving building metrics...</div>
                    ) : !selectedBuilding ? (
                      <div className="text-center text-xs text-[#64748b] py-8">
                        No building profile matched for this message.
                      </div>
                    ) : (
                      <div className="space-y-4 text-xs">
                        
                        {/* Building basic info */}
                        <div className="bg-[#0d1117] rounded-xl p-4 border border-[rgba(255,255,255,0.04)] flex flex-col gap-2">
                          <h4 className="text-sm font-bold text-white">{selectedBuilding.name}</h4>
                          
                          <div className="flex justify-between text-[11px] border-t border-[rgba(255,255,255,0.04)] pt-2.5">
                            <span className="text-[#64748b]">Database Observations</span>
                            <span className="font-mono text-[#cbd5e1] font-bold">{selectedBuilding.observation_count}</span>
                          </div>

                          <div className="flex justify-between text-[11px]">
                            <span className="text-[#64748b]">Active Brokers</span>
                            <span className="font-mono text-[#cbd5e1] font-bold">{selectedBuilding.broker_count}</span>
                          </div>

                          {selectedBuilding.markets?.length > 0 && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-[#64748b]">Micro Market</span>
                              <span className="text-white font-semibold">{selectedBuilding.markets[0].micro_market}</span>
                            </div>
                          )}
                        </div>

                        {/* Co-occurring landmarks */}
                        {selectedBuilding.landmarks?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Nearby Landmarks
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {selectedBuilding.landmarks.map((l: any, idx: number) => (
                                <span key={idx} className="bg-[#111820] px-2 py-0.5 rounded text-[10px] text-[#cbd5e1] border border-[rgba(255,255,255,0.03)]">
                                  {l.landmark_name}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Building Price Statistics */}
                        {selectedBuilding.price_stats?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Building Price Benchmarks
                            </div>
                            <div className="space-y-2">
                              {selectedBuilding.price_stats.map((s: any, idx: number) => (
                                <div key={idx} className="border-b border-[rgba(255,255,255,0.04)] pb-2 last:border-b-0 last:pb-0">
                                  <div className="flex justify-between text-[11px] font-bold text-[#e2e8f0]">
                                    <span>{s.bhk} - {s.intent?.toUpperCase()}</span>
                                    <span className="text-[#3EE88A]">Avg: {formatCurrency(s.avg_price)}</span>
                                  </div>
                                  <div className="flex justify-between text-[9.5px] text-[#64748b] mt-0.5">
                                    <span>Range: {formatCurrency(s.min_price)} – {formatCurrency(s.max_price)}</span>
                                    <span>{s.sample_count} listings</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Active brokers in building */}
                        {selectedBuilding.brokers?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Brokers active here
                            </div>
                            <div className="space-y-2 divide-y divide-[rgba(255,255,255,0.04)]">
                              {selectedBuilding.brokers.slice(0, 4).map((b: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center pt-2 first:pt-0">
                                  <div>
                                    <span className="font-semibold text-[#cbd5e1] block">{b.name}</span>
                                    <span className="text-[9px] text-[#64748b] font-mono">{maskPhoneString(b.phone)}</span>
                                  </div>
                                  <span className="text-[10.5px] text-[#94a3b8] font-bold">
                                    {b.observation_count} posts
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
              </>
            )}
          </div>
          </div>
        </ResizablePanel>

        {/* Combined Localities Dialog */}
        <CombinedLocalityDialog
          isOpen={showCombinedLocalityDialog}
          onClose={() => setShowCombinedLocalityDialog(false)}
          surfaceText={combinedLocalitySurfaceText}
          onSave={handleCombinedLocalitySave}
        />

      </div>
    </div>
  );
}

export default function BrokerWorkspacePage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[#64748b] text-sm">Loading...</div>}>
      <InboxPageInner />
    </Suspense>
  );
}
