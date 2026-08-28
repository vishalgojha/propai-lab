"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ConversationProvider, useConversation, type ClientTools } from "@elevenlabs/react";
import { Orb } from "orb-ui";
import { ArrowUpRight, EyeOff, GripVertical, Mic, MicOff, Send, ShieldCheck, Sparkles, Square, X } from "lucide-react";
import {
  getOnboardingGroups,
  getPhones,
  getWhatsAppStatus,
  marketSearchListings,
  fetchJSON,
  createCrmInventory,
  createCrmInventoryField,
  updateCrmInventory,
  logWorkspaceActivity,
  type OnboardingGroupState,
  type Phone,
  type WhatsAppStatus,
} from "@/lib/api";
import { useAuth } from "@/lib/AuthProvider";

type VoiceState = "idle" | "listening" | "thinking" | "acting" | "error";
type LogKind = "heard" | "action" | "info" | "error";
type VoiceLog = { id: number; kind: LogKind; text: string };

function VoiceAgentMark({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-flex items-end gap-0.5 ${className}`}><span className="h-2 w-1 rounded-full bg-current" /><span className="h-3.5 w-1 rounded-full bg-current" /><span className="h-2.5 w-1 rounded-full bg-current" /></span>;
}

/** Keep these names/descriptions identical to the client tools in ElevenLabs. */
export const VOICE_ASSISTANT_TOOL_DEFINITIONS = [
  { name: "open_whatsapp_connect", description: "Open PropAI's WhatsApp numbers connection screen. Do not scan or authorize anything." },
  { name: "get_whatsapp_setup_status", description: "Read the signed-in broker's WhatsApp connection and group setup status." },
  { name: "open_group_selection", description: "Open group selection for the broker to review. Never select or confirm groups." },
  { name: "search_market_inventory", description: "Search the signed-in broker's tenant-scoped captured market inventory. Never expose phone numbers." },
  { name: "get_workspace_attention", description: "Read current tenant-scoped dashboard counts for records needing review and extraction coverage." },
  { name: "open_market_search", description: "Open Market Inbox with the broker's search query. Do not modify records." },
  { name: "create_crm_field", description: "Create a custom Private CRM field after the broker explicitly confirms. Never create a field without confirmed=true." },
  { name: "create_crm_row", description: "Create a Private CRM property row after the broker explicitly confirms. Never create a row without confirmed=true." },
  { name: "update_crm_cell", description: "Update one Private CRM cell after the broker explicitly confirms. Never update data without confirmed=true." },
] as const;

const TOOL_NAMES = new Set(VOICE_ASSISTANT_TOOL_DEFINITIONS.map((tool) => tool.name));
const CRM_VOICE_ALLOWED_EMAILS = new Set(["vishal@chaoscraftlabs.com", "ojha007@gmail.com"]);
// ElevenLabs keeps the client tool call open while this promise resolves. Keep
// the connection read comfortably below its own timeout; group directory data
// is optional enrichment and must never block the core status answer.
const VOICE_STATUS_TOOL_TIMEOUT_MS = 6500;
const VOICE_ASSISTANT_HIDDEN_KEY = "propai.workspace-copilot-hidden";
const VOICE_ASSISTANT_POSITION_KEY = "propai.workspace-copilot-position";
export const OPEN_COPILOT_EVENT = "propai:open-copilot";

const PROPAI_UI_GUIDE = `
AUTHORITATIVE PROPAI UI GUIDE — use this for explanatory questions. Answer directly in one or two concise sentences; do not call a tool just to explain a visible control. Use search_market_inventory for natural-language property searches, get_workspace_attention for an operational summary, and open_market_search when the broker wants to inspect results in Market Inbox.

Product navigation:
- Dashboard: workspace overview and broker action shortcuts.
- Market Inbox: live WhatsApp market feed; search listings and requirements, and filter by listings or requirements.
- My Deals: the signed-in broker's saved listings and requirements. Editing fields changes the structured record and keeps the original WhatsApp evidence attached; never edit or save data yourself.
- Auto Matched: experimental suggestions comparing open requirements with active listings. A match is not a guarantee.
- WhatsApp > My Numbers: connect or reconnect WhatsApp numbers. QR scanning and authorization are always done by the broker.
- WhatsApp > Groups: review which groups are eligible for extraction. The broker must personally select and confirm groups.
- Account: profile, team, billing, API/provider settings.
- Reports: workspace reporting and operational summaries.

WhatsApp connection controls:
- Reconnect WhatsApp is the normal recovery path when a connection is offline or needs to reconnect.
- Reset & re-pair is more disruptive: use it only if reconnect fails or the screen says the session is active on another ingestor. It clears the saved WhatsApp session and requires pairing again with a new QR/code.
- Never recommend Reset & re-pair casually when normal reconnect is sufficient. Never claim that pairing, group selection, or extraction is complete unless the app confirms it.

CRM voice permissions:
- For authorized brokers only, you may prepare create_crm_field, create_crm_row, or update_crm_cell actions.
- Always ask for explicit confirmation immediately before a write and send confirmed=true only after confirmation.
- Never delete, publish, bulk-overwrite, or send a WhatsApp message by voice.

Boundaries:
- You can explain pages, labels, statuses, and visible controls; guide the broker step by step; navigate only through the registered tools; and read current WhatsApp setup status through the registered status tool.
- You cannot edit market listings or requirements, select groups, confirm consent, scan QR codes, send messages, delete anything, or access passwords/API keys. Authorized CRM voice writes are limited to the three confirmed CRM tools above.
- Search, attention, and navigation tools are read-only and tenant-scoped. Never expose phone numbers; use the existing contact flow.
- If asked for an unsupported action, explain the safe manual next step instead of inventing a tool or promising that it happened.
`;

function describeCurrentPage(pathname: string) {
  if (pathname.startsWith("/whatsapp")) return "The broker is currently in WhatsApp setup.";
  if (pathname.startsWith("/inbox")) return "The broker is currently in Market Inbox.";
  if (pathname.startsWith("/deals")) return "The broker is currently in My Deals.";
  if (pathname.startsWith("/auto-matched")) return "The broker is currently in experimental Auto Matched.";
  if (pathname.startsWith("/account")) return "The broker is currently in Account settings.";
  if (pathname.startsWith("/reports")) return "The broker is currently in Reports.";
  if (pathname.startsWith("/dashboard")) return "The broker is currently on the Dashboard.";
  return `The broker is currently on the PropAI workspace page at ${pathname}.`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Voice tool timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describePhone(phone: Phone) {
  if (phone.connected) return "connected";
  if (phone.qr_available) return "waiting for QR scan";
  if (phone.connection_state) return phone.connection_state.replaceAll("_", " ");
  return "not connected";
}

function describeSetup(phones: Phone[], state: OnboardingGroupState | null, liveStatus: WhatsAppStatus | null) {
  const liveSummary = liveStatus
    ? `${liveStatus.connected ? "connected" : liveStatus.state || "not connected"}${liveStatus.phone ? ` (${liveStatus.phone})` : ""}`
    : null;
  if (!phones.length && !liveStatus) return "No WhatsApp number has been added yet. I can open the Connect screen, but you must add and authorize the number yourself.";
  const phoneSummary = liveSummary || (phones.length
    ? phones.map((phone) => describePhone(phone)).join(", ")
    : "status unavailable");
  if (!phones.length) return `WhatsApp connection status: ${phoneSummary}. Group setup was not queried; open WhatsApp setup to review groups.`;
  if (phones.length > 1) {
    return `There are ${phones.length} WhatsApp numbers on this account: ${phoneSummary}. I will not guess which number you mean, so I have not read group status. Please open WhatsApp setup and choose the number to review.`;
  }
  if (!state) return `WhatsApp number status: ${phoneSummary}. No group status is available yet.`;
  const selected = state.groups.filter((group) => !group.opted_out && group.selectable !== false).length;
  const visibleNames = state.groups.filter((group) => !group.opted_out).slice(0, 3).map((group) => group.group_name).filter(Boolean);
  const names = visibleNames.length ? ` Groups visible: ${visibleNames.join(", ")}${state.groups.length > 3 ? ", and more." : "."}` : "";
  const cap = state.cap == null ? "no group cap" : `${state.selected_count} of ${state.cap} groups selected`;
  const checkedAt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date());
  return `WhatsApp number status: ${phoneSummary}. Extraction is ${state.extraction_status}. ${cap}; ${selected} groups are available to review.${names} Checked at ${checkedAt}. I will not select or confirm groups for you.`;
}

function VoiceAssistantInner({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const logIdRef = useRef(0);
  const lastStatusReadRef = useRef<{ at: number; summary: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [assistantHidden, setAssistantHidden] = useState(false);
  const [assistantPosition, setAssistantPosition] = useState(() => ({ right: 24, bottom: pathname === "/chat" ? 112 : 24 }));
  const [dragging, setDragging] = useState(false);
  const dragOriginRef = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  const assistantPositionRef = useRef(assistantPosition);

  useEffect(() => {
    assistantPositionRef.current = assistantPosition;
  }, [assistantPosition]);
  useEffect(() => {
    const openFromMobileNav = () => {
      setAssistantHidden(false);
      setOpen(true);
      setAssistantPosition((current) => ({ ...current, bottom: 76 }));
    };
    window.addEventListener(OPEN_COPILOT_EVENT, openFromMobileNav);
    return () => window.removeEventListener(OPEN_COPILOT_EVENT, openFromMobileNav);
  }, []);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [textInput, setTextInput] = useState("");
  const pendingTextRef = useRef<string | null>(null);
  const [logs, setLogs] = useState<VoiceLog[]>([
    { id: 0, kind: "info", text: "WhatsApp setup pilot. I can open screens and read status; consent stays with you." },
  ]);

  const addLog = useCallback((kind: LogKind, text: string) => {
    logIdRef.current += 1;
    setLogs((current) => [...current.slice(-5), { id: logIdRef.current, kind, text }]);
  }, []);

  const audit = useCallback((action: string, targetId: string, details: Record<string, unknown> = {}) => {
    void logWorkspaceActivity({ action, target_type: "voice_assistant", target_id: targetId, details: { ...details, source: "voice_assistant" } }).catch(() => {
      // Logging must not break a visible, safe navigation action.
    });
  }, []);

  const runTool = useCallback(async (name: string, parameters: Record<string, unknown> = {}) => {
    if (!TOOL_NAMES.has(name as (typeof VOICE_ASSISTANT_TOOL_DEFINITIONS)[number]["name"])) {
      addLog("error", `I blocked an unapproved action: ${name}.`);
      audit("voice_assistant.blocked_tool", name);
      return "That action is not available in the PropAI voice pilot.";
    }
    if (name === "search_market_inventory") {
      const query = String(parameters.query || parameters.q || "").trim();
      if (!query) return "Tell me what property you are looking for, such as 2 BHK rent in Bandra.";
      try {
        const result = await withTimeout(marketSearchListings({ q: query, intent: String(parameters.intent || ""), building: String(parameters.building || ""), micro_market: String(parameters.micro_market || ""), bhk: String(parameters.bhk || ""), price_max: Number(parameters.price_max) || undefined, limit: Math.min(Math.max(Number(parameters.limit) || 5, 1), 8) }), VOICE_STATUS_TOOL_TIMEOUT_MS);
        const rows = Array.isArray(result) ? result : result?.results || result?.listings || [];
        const safeRows = rows.slice(0, 8).map((row: Record<string, unknown>) => ({ id: row.id, title: row.summary_title || row.title || "Property record", building: row.building_name || null, locality: row.micro_market || row.location_raw || row.location || null, transaction: row.transaction_type || row.intent || null, asset: row.asset_type || null, bhk: row.bhk || null, area_sqft: row.area_sqft || null, price: row.price || row.total_asking_price || row.budget_max || null, source_schema: row.source_schema || row._typed_table || null }));
        addLog("info", `Searched captured inventory for “${query}” — ${safeRows.length} result${safeRows.length === 1 ? "" : "s"}.`);
        audit("voice_assistant.market_search", query, { result_count: safeRows.length });
        return JSON.stringify({ query, count: safeRows.length, results: safeRows });
      } catch {
        setVoiceState("error");
        addLog("error", "Inventory search is temporarily unavailable.");
        return "I could not search the captured inventory right now. Please try Market Inbox directly.";
      }
    }
    if (name === "get_workspace_attention") {
      try {
        const summary = await withTimeout(fetchJSON<Record<string, unknown>>("/dashboard/time-window?window=all"), VOICE_STATUS_TOOL_TIMEOUT_MS);
        const result = { records_needing_review: Number(summary.total_needs_review || 0), captured_listings: Number(summary.total_supply || 0), captured_requirements: Number(summary.total_demand || 0), raw_messages: Number(summary.total_messages || 0) };
        addLog("info", `Read workspace attention summary — ${result.records_needing_review} record${result.records_needing_review === 1 ? "" : "s"} need review.`);
        audit("voice_assistant.workspace_attention", "dashboard", result);
        return JSON.stringify(result);
      } catch {
        setVoiceState("error");
        addLog("error", "Workspace attention summary is temporarily unavailable.");
        return "I could not read the workspace attention summary right now.";
      }
    }
    if (name === "open_market_search") {
      const query = String(parameters.query || parameters.q || "").trim();
      if (!query) return "Tell me what search you want me to open in Market Inbox.";
      const target = `/inbox?q=${encodeURIComponent(query)}`;
      addLog("action", `Opening Market Inbox for “${query}”.`);
      audit("voice_assistant.navigate", target, { capability: "open_market_search" });
      router.push(target);
      return `Market Inbox is open for: ${query}`;
    }
    if (name === "create_crm_field" || name === "create_crm_row" || name === "update_crm_cell") {
      const email = (user?.email || "").trim().toLowerCase();
      if (!CRM_VOICE_ALLOWED_EMAILS.has(email)) return "CRM voice editing is not enabled for this account.";
      if (parameters.confirmed !== true) return "I have prepared the CRM action, but I need your explicit confirmation before saving it.";
      try {
        if (name === "create_crm_field") {
          const field = await createCrmInventoryField({ label: String(parameters.label || ""), field_type: (String(parameters.field_type || "text") as "text" | "number" | "date" | "select" | "checkbox" | "currency"), options: Array.isArray(parameters.options) ? parameters.options.map(String) : [] });
          addLog("action", `Created CRM field: ${field.label}.`); audit("voice_assistant.crm_create_field", field.field_key); return `Created the CRM field ${field.label}.`;
        }
        if (name === "create_crm_row") {
          const row = await createCrmInventory({ building_name: String(parameters.building_name || "New property"), location: String(parameters.location || ""), transaction_type: String(parameters.transaction_type || ""), asset_type: String(parameters.asset_type || ""), bhk: String(parameters.bhk || ""), quote: String(parameters.quote || ""), custom_fields: typeof parameters.custom_fields === "object" && parameters.custom_fields ? parameters.custom_fields as Record<string, string | number | boolean> : {} });
          addLog("action", `Created CRM row ${row.id}.`); audit("voice_assistant.crm_create_row", String(row.id)); return `Created the private CRM row for ${row.building_name || "the new property"}.`;
        }
        const inventoryId = Number(parameters.inventory_id); const key = String(parameters.field || "");
        if (!Number.isInteger(inventoryId) || !key) return "I need the inventory row ID and field name to update a CRM cell.";
        const baseFields = new Set(["building_name", "location", "transaction_type", "asset_type", "bhk", "tower", "floor", "area_sqft", "quote", "furnishing", "availability", "contact_name", "contact_number", "notes"]);
        const payload = baseFields.has(key) ? { [key]: parameters.value } : { custom_fields: { [key]: parameters.value as string | number | boolean } };
        await updateCrmInventory(inventoryId, payload); addLog("action", `Updated CRM row ${inventoryId}, ${key}.`); audit("voice_assistant.crm_update_cell", String(inventoryId), { field: key }); return `Updated ${key} on CRM row ${inventoryId}.`;
      } catch {
        setVoiceState("error");
        addLog("error", "The CRM action could not be saved. Check the fields and try again.");
        return "The CRM action could not be saved. Please check the field, row, and workspace access, then try again.";
      }
    }
    setVoiceState("acting");
    if (name === "open_whatsapp_connect") {
      const target = "/whatsapp?tab=numbers";
      addLog("action", "Opening WhatsApp connection setup. QR scanning still requires your action.");
      audit("voice_assistant.navigate", target, { capability: "open_whatsapp_connect" });
      router.push(target);
      return "The WhatsApp connection screen is open. Please add or authorize the number yourself; I cannot scan a QR code or complete linking.";
    }
    if (name === "open_group_selection") {
      const target = "/whatsapp?tab=groups";
      addLog("action", "Opening group review. I will not select or confirm groups.");
      audit("voice_assistant.navigate", target, { capability: "open_group_selection" });
      router.push(target);
      return "The group review screen is open. Please choose the groups and tap the confirmation yourself.";
    }
    const recentStatus = lastStatusReadRef.current;
    if (recentStatus && Date.now() - recentStatus.at < 10000) {
      addLog("info", "WhatsApp setup status is unchanged since the last check.");
      return `I already checked the WhatsApp setup status. It is unchanged: ${recentStatus.summary}`;
    }
    try {
      const deadline = Date.now() + VOICE_STATUS_TOOL_TIMEOUT_MS;
      const remaining = () => Math.max(1, deadline - Date.now());

      // Read the lightweight connection endpoint and saved phone metadata in
      // parallel. Either result is enough to answer “is WhatsApp working?”;
      // neither should be held hostage by the group directory.
      const [liveResult, phonesResult] = await withTimeout(
        Promise.allSettled([
          getWhatsAppStatus(Math.min(4000, remaining())),
          getPhones(false, Math.min(4000, remaining())),
        ]),
        Math.min(4500, remaining()),
      );
      const liveStatus = liveResult.status === "fulfilled" ? liveResult.value : null;
      const phones = phonesResult.status === "fulfilled" ? phonesResult.value.phones : [];
      const activePhone = phones.find((phone) => phone.is_active) || phones[0];
      let setup: OnboardingGroupState | null = null;
      // Group status is useful context, but it is a best-effort follow-up. A
      // slow directory must not turn a successful connection check into a
      // failed ElevenLabs client tool call.
      if (activePhone && remaining() > 500) {
        try {
          const timeout = Math.min(2000, remaining());
          setup = await withTimeout(getOnboardingGroups(activePhone.id, timeout), timeout);
        } catch {
          setup = null;
        }
      }
      if (!phones.length && !liveStatus) throw new Error("WhatsApp status endpoints were unavailable");
      const summary = describeSetup(phones, setup, liveStatus);
      lastStatusReadRef.current = { at: Date.now(), summary };
      addLog("info", "Read the current WhatsApp setup status.");
      audit("voice_assistant.read_status", "whatsapp_setup");
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown status read failure";
      const timedOut = message === "Voice tool timed out" || message.toLowerCase().includes("timeout");
      addLog("error", timedOut
        ? "The status check took too long. WhatsApp setup is still available to open directly."
        : "I could not read the WhatsApp setup status. Please try again or open WhatsApp setup directly.");
      audit("voice_assistant.read_status_failed", "whatsapp_setup", { error: message.slice(0, 300) });
      return timedOut
        ? "The status check took too long, so I stopped waiting. Please open WhatsApp setup directly; I can still guide you by text."
        : "I could not read the current WhatsApp setup status right now. Please try again or open WhatsApp setup directly.";
    }
  }, [addLog, audit, router, user]);

  const clientTools = useMemo<ClientTools>(() => ({
    open_whatsapp_connect: () => runTool("open_whatsapp_connect"),
    get_whatsapp_setup_status: () => runTool("get_whatsapp_setup_status"),
    open_group_selection: () => runTool("open_group_selection"),
    search_market_inventory: (parameters) => runTool("search_market_inventory", parameters),
    get_workspace_attention: () => runTool("get_workspace_attention"),
    open_market_search: (parameters) => runTool("open_market_search", parameters),
    create_crm_field: (parameters) => runTool("create_crm_field", parameters),
    create_crm_row: (parameters) => runTool("create_crm_row", parameters),
    update_crm_cell: (parameters) => runTool("update_crm_cell", parameters),
  }), [runTool]);

  const conversation = useConversation({
    clientTools,
    onConnect: () => setVoiceState("listening"),
    onDisconnect: () => setVoiceState("idle"),
    onError: () => {
      setVoiceState("error");
      addLog("error", "Voice connection failed. Check microphone permission or try again.");
    },
    onMessage: (message) => {
      if (message.role === "user") {
        addLog("heard", `You: ${message.message}`);
        setVoiceState("thinking");
      }
    },
    onModeChange: ({ mode }) => setVoiceState(mode === "listening" ? "listening" : "thinking"),
    onAgentToolRequest: ({ tool_name }) => {
      if (TOOL_NAMES.has(tool_name as (typeof VOICE_ASSISTANT_TOOL_DEFINITIONS)[number]["name"])) setVoiceState("acting");
    },
  });
  const { status, endSession, sendContextualUpdate, sendUserMessage, startSession } = conversation;

  useEffect(() => {
    if (status !== "connected") return;
    sendContextualUpdate(`${PROPAI_UI_GUIDE}\nCURRENT PAGE: ${describeCurrentPage(pathname)}`);
  }, [pathname, sendContextualUpdate, status]);

  const sendPrompt = useCallback((prompt: string) => {
    const text = prompt.trim();
    if (!text) return;
    const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
    if (!agentId) {
      setOpen(true);
      setVoiceState("error");
      addLog("error", "Voice setup is not configured yet. Add the ElevenLabs agent ID to the app environment.");
      return;
    }
    setTextInput("");
    setOpen(true);
    setVoiceState("thinking");
    addLog("heard", `You: ${text}`);
    if (status === "connected") {
      sendUserMessage(text);
      return;
    }
    pendingTextRef.current = text;
    void startSession({ agentId, connectionType: "websocket", textOnly: true });
  }, [addLog, sendUserMessage, startSession, status, textInput]);

  const sendTextMessage = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendPrompt(textInput);
  }, [sendPrompt, textInput]);

  useEffect(() => {
    if (status !== "connected" || !pendingTextRef.current) return;
    const text = pendingTextRef.current;
    pendingTextRef.current = null;
    sendUserMessage(text);
  }, [sendUserMessage, status]);

  const toggleCall = useCallback(() => {
    if (status === "connected" || status === "connecting") {
      endSession();
      setVoiceState("idle");
      return;
    }
    const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
    if (!agentId) {
      setOpen(true);
      setVoiceState("error");
      addLog("error", "Voice setup is not configured yet. Add the ElevenLabs agent ID to the app environment.");
      return;
    }
    setOpen(true);
    setVoiceState("thinking");
    void startSession({ agentId, connectionType: "webrtc" });
  }, [addLog, endSession, startSession, status]);

  useEffect(() => () => endSession(), [endSession]);

  const previousUserIdRef = useRef<string | null>(user?.id ?? null);
  useEffect(() => {
    const previousUserId = previousUserIdRef.current;
    const accountChanged = previousUserId && user?.id && previousUserId !== user.id;
    if (!user || accountChanged) {
      if (status === "connected" || status === "connecting") endSession();
      pendingTextRef.current = null;
      setOpen(false);
      setTextInput("");
      setVoiceState("idle");
    }
    previousUserIdRef.current = user?.id ?? null;
  }, [endSession, status, user]);

  useEffect(() => {
    if (!enabled) return;
    setAssistantHidden(window.localStorage.getItem(VOICE_ASSISTANT_HIDDEN_KEY) === "1");
    try {
      const saved = JSON.parse(window.localStorage.getItem(VOICE_ASSISTANT_POSITION_KEY) || "null");
      if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) {
        setAssistantPosition({ right: Math.max(8, saved.right), bottom: Math.max(8, saved.bottom) });
      }
    } catch { /* position persistence is optional */ }
  }, [enabled]);

  const beginDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    dragOriginRef.current = {
      x: event.clientX,
      y: event.clientY,
      right: assistantPositionRef.current.right,
      bottom: assistantPositionRef.current.bottom,
    };
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const maxRight = Math.max(8, window.innerWidth - 72);
      const maxBottom = Math.max(8, window.innerHeight - 72);
      const nextPosition = {
        right: Math.min(maxRight, Math.max(8, origin.right - (event.clientX - origin.x))),
        bottom: Math.min(maxBottom, Math.max(8, origin.bottom - (event.clientY - origin.y))),
      };
      assistantPositionRef.current = nextPosition;
      setAssistantPosition(nextPosition);
    };
    const stop = () => {
      setDragging(false);
      dragOriginRef.current = null;
      try { window.localStorage.setItem(VOICE_ASSISTANT_POSITION_KEY, JSON.stringify(assistantPositionRef.current)); } catch { /* persistence is optional */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [dragging]);

  const hideAssistant = useCallback(() => {
    if (status === "connected" || status === "connecting") {
      endSession();
      setVoiceState("idle");
    }
    pendingTextRef.current = null;
    setOpen(false);
    window.localStorage.setItem(VOICE_ASSISTANT_HIDDEN_KEY, "1");
    setAssistantHidden(true);
  }, [endSession, status]);

  const restoreAssistant = useCallback(() => {
    window.localStorage.removeItem(VOICE_ASSISTANT_HIDDEN_KEY);
    setAssistantHidden(false);
  }, []);

  if (!enabled) return null;
  const active = status === "connected" || status === "connecting";
  const orbState = voiceState === "error" ? "error" : status === "connecting" ? "connecting" : voiceState === "listening" ? "listening" : voiceState === "thinking" || voiceState === "acting" ? "thinking" : "idle";
  const stateLabel = voiceState === "listening" ? "Listening" : voiceState === "thinking" ? "Thinking" : voiceState === "acting" ? "Acting" : voiceState === "error" ? "Needs attention" : "Ready";
  const stateMessage = voiceState === "acting"
    ? "Executing an approved action"
    : voiceState === "thinking"
      ? "Understanding your request"
      : voiceState === "listening"
        ? "Listening for your next request"
        : voiceState === "error"
          ? "Check the activity below"
          : "Ask about the workspace or WhatsApp setup";

  if (assistantHidden) {
    return (
    <div className="propai-voice-assistant pointer-events-none fixed z-[950] max-lg:hidden" style={{ right: assistantPosition.right, bottom: assistantPosition.bottom }}>
        <div className="pointer-events-auto flex items-center gap-2">
          <span data-copilot-drag-handle onPointerDown={beginDrag} className="flex h-9 w-9 cursor-grab touch-none items-center justify-center rounded-full border border-white/10 bg-[#091410]/95 text-[#a9bdb2] shadow-lg active:cursor-grabbing" title="Drag copilot" aria-label="Drag copilot"><GripVertical className="h-4 w-4" aria-hidden="true" /></span>
          <button
            type="button"
            onClick={restoreAssistant}
            className="group flex items-center gap-2 rounded-full border border-emerald-300/30 bg-[#091410]/95 px-3 py-2 text-emerald-200 shadow-[0_14px_36px_rgba(0,0,0,0.38)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-emerald-300/60 hover:bg-[#10251a] focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-background"
            aria-label="Show workspace copilot"
            title="Show workspace copilot"
          >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-400 text-[#092016] shadow-[0_4px_14px_rgba(62,232,138,0.3)]">
            <VoiceAgentMark className="h-3.5" />
          </span>
          <span className="pr-1 text-[11px] font-semibold tracking-wide">Open copilot</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`propai-voice-assistant fixed z-[90] flex flex-col items-end gap-3 ${dragging ? "select-none" : ""} ${open ? "" : "max-lg:hidden"} max-lg:!right-0 max-lg:!bottom-[4.5rem]`} style={{ right: assistantPosition.right, bottom: assistantPosition.bottom }}>
      {open && <section id="propai-workspace-copilot" aria-label="PropAI workspace agent" className="w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-[1.35rem] border border-emerald-300/20 bg-[#091410] !text-[#f3f8f5] shadow-[0_24px_70px_rgba(0,0,0,0.42)] backdrop-blur-xl max-lg:flex max-lg:max-h-[76dvh] max-lg:w-screen max-lg:flex-col max-lg:rounded-b-none max-lg:rounded-t-[1.35rem]">
        <header className="relative overflow-hidden border-b border-white/10 px-4 pb-4 pt-4">
          <div className="pointer-events-none absolute -right-12 -top-16 h-36 w-36 rounded-full bg-emerald-300/10 blur-3xl" />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />PropAI workspace agent <span className="rounded-full border border-emerald-300/25 px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-emerald-200/80">BETA</span><span data-copilot-drag-handle onPointerDown={beginDrag} className="ml-auto inline-flex cursor-grab touch-none items-center gap-1 rounded px-1 py-0.5 text-emerald-100/70 hover:bg-white/5 active:cursor-grabbing max-lg:hidden" title="Drag agent" aria-label="Drag agent"><GripVertical className="h-3.5 w-3.5" aria-hidden="true" />Drag</span></div>
              <h2 className="mt-2 !text-xl font-semibold tracking-tight !text-[#f3f8f5]">Move work forward</h2>
              <p className="mt-1 text-xs !text-[#a9bdb2]">Read status, open the right workspace, or prepare a confirmed CRM action.</p>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={hideAssistant} className="rounded-lg border !border-[#385548] !bg-transparent p-2 !text-[#a9bdb2] transition hover:!border-[#5a806d] hover:!bg-[#12251e] hover:!text-[#f3f8f5]" aria-label="Hide workspace copilot" title="Hide workspace copilot"><EyeOff className="h-4 w-4" /></button>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg border !border-[#385548] !bg-transparent p-2 !text-[#a9bdb2] transition hover:!border-[#5a806d] hover:!bg-[#12251e] hover:!text-[#f3f8f5]" aria-label="Close voice assistant panel" title="Close panel"><X className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="relative mt-4 flex items-center justify-between rounded-xl border border-[#294238] bg-[#12251e] px-3 py-2.5">
            <div className="flex items-center gap-2.5"><span className="relative flex h-2.5 w-2.5"><span className={`absolute inline-flex h-full w-full rounded-full opacity-70 ${active ? "animate-ping bg-emerald-400" : voiceState === "error" ? "bg-amber-400" : "bg-white/30"}`} /><span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${active ? "bg-emerald-300" : voiceState === "error" ? "bg-amber-300" : "bg-white/40"}`} /></span><div><div className="text-xs font-medium !text-[#f3f8f5]">{stateLabel}</div><div className="text-[10px] !text-[#a9bdb2]">{stateMessage}</div></div></div>
            <span className="rounded-full border border-emerald-300/20 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-emerald-200/75">{active ? "LIVE" : "READY"}</span>
          </div>
          <div className="relative mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[10px] !text-[#a9bdb2]"><span className="h-1.5 w-1.5 rounded-full bg-sky-300" /><span className="truncate">Working in {pathname === "/crm" ? "Private CRM" : pathname.replace("/", "") || "Dashboard"}</span><ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-[#789286]" /></div>
        </header>
        <div className="px-4 pb-2 pt-3"><div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] !text-[#789286]"><span>Activity</span><span>{logs.length} events</span></div></div>
        {voiceState === "idle" && <div className="grid grid-cols-2 gap-2 px-4 pb-3"><button type="button" onClick={() => sendPrompt("Check my WhatsApp connection and setup status")} className="rounded-xl border border-[#294238] bg-[#12251e] px-3 py-2.5 text-left text-[11px] font-medium !text-[#cbe8d7] transition hover:border-emerald-300/50 hover:bg-[#173126]">Check setup <span className="mt-1 block text-[10px] !text-[#789286]">Connection & groups</span></button><button type="button" onClick={() => sendPrompt("Help me use my Private CRM")} className="rounded-xl border border-[#294238] bg-[#12251e] px-3 py-2.5 text-left text-[11px] font-medium !text-[#cbe8d7] transition hover:border-emerald-300/50 hover:bg-[#173126]">Use my CRM <span className="mt-1 block text-[10px] !text-[#789286]">Work with inventory</span></button></div>}
        <div className="max-h-56 space-y-2 overflow-y-auto px-4 pb-4 max-lg:min-h-0 max-lg:flex-1 max-lg:max-h-none" aria-live="polite">{logs.map((entry) => <div key={entry.id} className="flex gap-2.5 rounded-xl border border-[#294238] bg-[#0f1f18] px-3 py-2.5"><span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${entry.kind === "error" ? "bg-amber-300" : entry.kind === "action" ? "bg-emerald-300" : entry.kind === "heard" ? "bg-sky-300" : "bg-[#789286]"}`} /><p className={`text-xs leading-relaxed ${entry.kind === "error" ? "!text-[#f6d28a]" : entry.kind === "action" ? "!text-[#b9f5d2]" : entry.kind === "heard" ? "!text-[#bfe7ff]" : "!text-[#c2d1c8]"}`}>{entry.text}</p></div>)}</div>
        <form onSubmit={sendTextMessage} className="border-t border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 rounded-xl border border-[#385548] bg-[#07100c] p-1.5 transition focus-within:border-emerald-300/60 focus-within:ring-1 focus-within:ring-emerald-300/20">
            <input value={textInput} onChange={(event) => setTextInput(event.target.value)} placeholder="Give the agent a task…" aria-label="Message PropAI workspace agent" className="min-w-0 flex-1 bg-transparent px-2 text-xs !text-[#f3f8f5] outline-none placeholder:!text-[#789286]" />
            <button type="button" onClick={toggleCall} aria-label={active ? "Stop voice agent" : "Start voice agent"} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${active ? "!bg-rose-400 !text-[#2b0b0d]" : "!bg-[#19372a] !text-emerald-300 hover:!bg-[#24523b]"}`}>{active ? <Square className="h-3 w-3" /> : <Mic className="h-3.5 w-3.5" />}</button>
            <button type="submit" disabled={!textInput.trim()} aria-label="Send message to PropAI" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg !bg-[#3ee88a] !text-[#092016] transition hover:!bg-[#74f0a5] disabled:cursor-not-allowed disabled:!bg-[#263a31] disabled:!text-[#789286]"><Send className="h-3.5 w-3.5" /></button>
          </div>
          <div className="mt-2 flex items-center justify-between px-1 text-[10px] !text-[#789286]"><span className="inline-flex items-center gap-1"><MicOff className="h-3 w-3" /> Voice or text</span><span>Hinglish okay</span></div>
        </form>
        <div className="flex gap-2 border-t border-white/10 px-4 py-3 text-[10px] leading-relaxed !text-[#a9bdb2]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300/80" /><span>Guardrails: QR linking, group consent, and data edits always require your action.</span></div>
      </section>}
      <div className="flex items-center gap-2">{open && <span className="rounded-full border border-white/10 bg-[#091410]/95 px-3 py-2 text-xs text-white/80 shadow-lg backdrop-blur">{active ? "Talk to PropAI" : "Open copilot"}</span>}<span data-copilot-drag-handle onPointerDown={beginDrag} className="flex h-9 w-9 cursor-grab touch-none items-center justify-center rounded-full border border-white/10 bg-[#091410]/95 text-[#a9bdb2] shadow-lg active:cursor-grabbing" title="Drag copilot" aria-label="Drag copilot"><GripVertical className="h-4 w-4" aria-hidden="true" /></span><button type="button" onClick={() => { setOpen(true); toggleCall(); }} className={`flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 text-white shadow-[0_14px_36px_rgba(0,0,0,0.3)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_42px_rgba(0,0,0,0.38)] focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-background ${active ? "bg-rose-500" : "bg-emerald-500"}`} aria-label={active ? "Stop voice assistant" : "Start voice assistant"} aria-controls="propai-workspace-copilot"><Orb state={orbState} theme="circle" size={58} interactive={false} aria-hidden="true" /></button></div>
    </div>
  );
}

export function VoiceAssistant({ enabled = true }: { enabled?: boolean }) {
  return <ConversationProvider><VoiceAssistantInner enabled={enabled} /></ConversationProvider>;
}
