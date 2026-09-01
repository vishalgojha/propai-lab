"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ConversationProvider, useConversation, useScribe, type ClientTools } from "@elevenlabs/react";
import { Orb } from "orb-ui";
import { ArrowUpRight, EyeOff, GripVertical, Mic, ShieldCheck, Sparkles, Square, X } from "lucide-react";
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
import { ConversationBar } from "@/components/ui/conversation-bar";

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
const VOICE_ASSISTANT_WIDTH_KEY = "propai.workspace-copilot-width";
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
  const { user, session } = useAuth();
  const sessionAccessToken = session?.access_token || "";
  const logIdRef = useRef(0);
  const lastStatusReadRef = useRef<{ at: number; summary: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [assistantHidden, setAssistantHidden] = useState(false);
  const [assistantPosition, setAssistantPosition] = useState(() => ({ right: 24, bottom: pathname === "/chat" ? 112 : 24 }));
  const [panelWidth, setPanelWidth] = useState(380);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const panelWidthRef = useRef(panelWidth);
  const dragOriginRef = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  const resizeOriginRef = useRef<{ x: number; width: number } | null>(null);
  const assistantPositionRef = useRef(assistantPosition);

  // Desktop uses the agent as a persistent work rail, like a modern
  // operator console. Mobile keeps the compact launcher to protect space for
  // the feed and keyboard.
  useEffect(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) setOpen(true);
  }, []);

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
  const [sessionMode, setSessionMode] = useState<"voice" | "text" | null>(null);
  const [textInput, setTextInput] = useState("");
  const [heardTranscript, setHeardTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
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

  const { connect: connectScribe, disconnect: disconnectScribe } = useScribe({
    modelId: "scribe_v2_realtime",
    onPartialTranscript: ({ text }) => setPartialTranscript(text),
    onCommittedTranscript: ({ text }) => {
      setHeardTranscript(text);
      setPartialTranscript("");
    },
    onError: () => {
      setPartialTranscript("");
      addLog("info", "Live words are unavailable right now; the voice conversation is still connected.");
    },
  });

  const conversation = useConversation({
    clientTools,
    onConnect: () => setVoiceState("listening"),
    onDisconnect: () => {
      setSessionMode(null);
      setVoiceState("idle");
    },
    onError: () => {
      setVoiceState("error");
      addLog("error", "Voice connection failed. Check microphone permission or try again.");
    },
    onMessage: (message) => {
      if (message.role === "user") {
        setHeardTranscript(message.message);
        addLog("heard", `You: ${message.message}`);
        setVoiceState("thinking");
      }
    },
    onModeChange: ({ mode }) => setVoiceState(mode === "listening" ? "listening" : "thinking"),
    onAgentToolRequest: ({ tool_name }) => {
      if (TOOL_NAMES.has(tool_name as (typeof VOICE_ASSISTANT_TOOL_DEFINITIONS)[number]["name"])) setVoiceState("acting");
    },
  });
  const { status, endSession, sendContextualUpdate, sendUserMessage, startSession, isListening, getInputByteFrequencyData } = conversation;

  useEffect(() => {
    if (status !== "connected" || !isListening) {
      return;
    }
    let frame = 0;
    const sampleInput = () => {
      try {
        const frequencies = getInputByteFrequencyData();
        const average = frequencies.length
          ? frequencies.reduce((total, value) => total + value, 0) / frequencies.length / 255
          : 0;
        setInputLevel(average);
      } catch {
        setInputLevel(0);
      }
      frame = window.requestAnimationFrame(sampleInput);
    };
    frame = window.requestAnimationFrame(sampleInput);
    return () => window.cancelAnimationFrame(frame);
  }, [getInputByteFrequencyData, isListening, status]);

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
    setSessionMode("text");
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
      disconnectScribe();
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
    setSessionMode("voice");
    setPartialTranscript("");
    setVoiceState("thinking");
    void startSession({ agentId, connectionType: "webrtc" });
    void (async () => {
      if (!sessionAccessToken) return;
      try {
        const response = await fetch("/api/voice/scribe-token", {
          method: "POST",
          headers: { Authorization: `Bearer ${sessionAccessToken}` },
        });
        if (!response.ok) throw new Error("Scribe token request failed");
        const body = await response.json() as { token?: string };
        if (!body.token) throw new Error("Scribe token missing");
        await connectScribe({
          token: body.token,
          microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        addLog("info", "Live words could not be started; the voice conversation is still available.");
      }
    })();
  }, [addLog, connectScribe, disconnectScribe, endSession, sessionAccessToken, startSession, status]);

  useEffect(() => () => {
    disconnectScribe();
    endSession();
  }, [disconnectScribe, endSession]);

  const previousUserIdRef = useRef<string | null>(user?.id ?? null);
  useEffect(() => {
    const previousUserId = previousUserIdRef.current;
    const accountChanged = previousUserId && user?.id && previousUserId !== user.id;
    if (!user || accountChanged) {
      if (status === "connected" || status === "connecting") {
        disconnectScribe();
        endSession();
      }
      pendingTextRef.current = null;
      setOpen(false);
      setTextInput("");
      setSessionMode(null);
      setHeardTranscript("");
      setPartialTranscript("");
      setInputLevel(0);
      setVoiceState("idle");
    }
    previousUserIdRef.current = user?.id ?? null;
  }, [disconnectScribe, endSession, status, user]);

  useEffect(() => {
    if (!enabled) return;
    setAssistantHidden(window.localStorage.getItem(VOICE_ASSISTANT_HIDDEN_KEY) === "1");
    try {
      const saved = JSON.parse(window.localStorage.getItem(VOICE_ASSISTANT_POSITION_KEY) || "null");
      if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) {
        setAssistantPosition({ right: Math.max(8, saved.right), bottom: Math.max(8, saved.bottom) });
      }
      const savedWidth = Number(window.localStorage.getItem(VOICE_ASSISTANT_WIDTH_KEY));
      if (Number.isFinite(savedWidth)) {
        const width = Math.min(560, Math.max(320, savedWidth));
        panelWidthRef.current = width;
        setPanelWidth(width);
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

  const beginResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    resizeOriginRef.current = { x: event.clientX, width: panelWidthRef.current };
    setResizing(true);
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      const origin = resizeOriginRef.current;
      if (!origin) return;
      const maxWidth = Math.min(560, window.innerWidth - 32);
      const width = Math.min(maxWidth, Math.max(320, origin.width + origin.x - event.clientX));
      panelWidthRef.current = width;
      setPanelWidth(width);
    };
    const stop = () => {
      setResizing(false);
      resizeOriginRef.current = null;
      try { window.localStorage.setItem(VOICE_ASSISTANT_WIDTH_KEY, String(panelWidthRef.current)); } catch { /* persistence is optional */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [resizing]);

  const hideAssistant = useCallback(() => {
    if (status === "connected" || status === "connecting") {
      disconnectScribe();
      endSession();
      setVoiceState("idle");
    }
    pendingTextRef.current = null;
    setOpen(false);
    window.localStorage.setItem(VOICE_ASSISTANT_HIDDEN_KEY, "1");
    setAssistantHidden(true);
  }, [disconnectScribe, endSession, status]);

  const restoreAssistant = useCallback(() => {
    window.localStorage.removeItem(VOICE_ASSISTANT_HIDDEN_KEY);
    setAssistantHidden(false);
  }, []);

  if (!enabled) return null;
  const active = status === "connected" || status === "connecting";
  const voiceActive = active && sessionMode === "voice";
  const voiceLive = voiceActive && (status === "connecting" || (status === "connected" && isListening));
  const showVoiceSurface = voiceActive && (voiceLive || voiceState === "thinking");
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
    <div className={`propai-voice-assistant hidden lg:flex ${open ? "propai-copilot-dock-open" : ""} fixed z-[90] flex-col items-end gap-3 ${dragging || resizing ? "select-none" : ""}`} style={{ right: assistantPosition.right, bottom: assistantPosition.bottom, "--copilot-width": `${panelWidth}px` } as React.CSSProperties}>
      {open && <section id="propai-workspace-copilot" aria-label="PropAI workspace agent" className="relative flex w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[1.35rem] border border-emerald-300/20 bg-[#091410] !text-[#f3f8f5] shadow-[0_24px_70px_rgba(0,0,0,0.42)] backdrop-blur-xl max-lg:max-h-[76dvh] max-lg:w-screen max-lg:rounded-b-none max-lg:rounded-t-[1.35rem]">
        <button type="button" onPointerDown={beginResize} className="propai-copilot-resize-handle absolute inset-y-0 left-0 z-10 hidden w-2 cursor-col-resize lg:block" aria-label="Resize Copilot panel" title="Drag to resize Copilot" />
        <header className="relative overflow-hidden border-b border-white/10 px-4 pb-4 pt-4">
          <div className="pointer-events-none absolute -right-12 -top-16 h-36 w-36 rounded-full bg-emerald-300/10 blur-3xl" />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />PropAI workspace agent <span className="rounded-full border border-emerald-300/25 px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-emerald-200/80">BETA</span><span data-copilot-drag-handle onPointerDown={beginDrag} className="ml-auto inline-flex cursor-grab touch-none items-center gap-1 rounded px-1.5 py-1 text-emerald-100/70 hover:bg-white/5 active:cursor-grabbing max-lg:hidden" title="Move agent panel" aria-label="Move agent panel"><GripVertical className="h-3.5 w-3.5" aria-hidden="true" />Move</span></div>
              <h2 className="mt-2 !text-xl font-semibold tracking-tight !text-[#f3f8f5]">Move work forward</h2>
              <p className="mt-1 text-xs !text-[#a9bdb2]">Read status, open the right workspace, or prepare a confirmed CRM action.</p>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={hideAssistant} className="rounded-lg border !border-[#385548] !bg-transparent p-2 !text-[#a9bdb2] transition hover:!border-[#5a806d] hover:!bg-[#12251e] hover:!text-[#f3f8f5]" aria-label="Hide workspace agent" title="Hide agent"><EyeOff className="h-4 w-4" /></button>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg border !border-[#385548] !bg-transparent p-2 !text-[#a9bdb2] transition hover:!border-[#5a806d] hover:!bg-[#12251e] hover:!text-[#f3f8f5]" aria-label="Close workspace agent panel" title="Close panel"><X className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="relative mt-4 flex items-center justify-between rounded-xl border border-[#294238] bg-[#12251e] px-3 py-2.5">
            <div className="flex items-center gap-2.5"><span className="relative flex h-2.5 w-2.5"><span className={`absolute inline-flex h-full w-full rounded-full opacity-70 ${active ? "animate-ping bg-emerald-400" : voiceState === "error" ? "bg-amber-400" : "bg-white/30"}`} /><span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${active ? "bg-emerald-300" : voiceState === "error" ? "bg-amber-300" : "bg-white/40"}`} /></span><div><div className="text-xs font-medium !text-[#f3f8f5]">{status === "connecting" ? "Connecting" : stateLabel}</div><div className="text-[10px] !text-[#a9bdb2]">{status === "connecting" ? "Starting your microphone" : stateMessage}</div></div></div>
            <span className="rounded-full border border-emerald-300/20 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-emerald-200/75">{active ? "LIVE" : "READY"}</span>
          </div>
          {showVoiceSurface && <div className="relative mt-3 rounded-xl border border-emerald-300/25 bg-[#10251a] px-3 py-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-[11px] font-semibold !text-[#d9f8e4]"><Mic className={voiceLive ? "h-3.5 w-3.5 animate-pulse" : "h-3.5 w-3.5"} aria-hidden="true" />{status === "connecting" ? "Preparing to listen" : voiceLive ? "Listening — speak naturally" : "Thinking about that"}</div><span className="text-[10px] !text-[#8fc3a4]">{status === "connecting" ? "" : voiceLive ? "Microphone on" : "Speech received"}</span></div>
            <div className="mt-3 flex h-7 items-center justify-center gap-1" aria-label={voiceLive ? "Microphone activity" : "Voice transcript received"}>
              {Array.from({ length: 18 }, (_, index) => {
                const distance = Math.abs(index - 8.5) / 8.5;
                const waveHeight = 5 + inputLevel * (24 * (1 - distance * 0.45));
                return <span key={index} className="w-1 rounded-full bg-emerald-300/80 transition-[height] duration-75" style={{ height: `${Math.max(5, waveHeight)}px` }} />;
              })}
            </div>
            <p className="mt-2 truncate text-[10px] !text-[#9fcab0]">{partialTranscript ? `Hearing: “${partialTranscript}”` : heardTranscript ? `Heard: “${heardTranscript}”` : "Speak naturally; your words will appear here."}</p>
          </div>}
          <div className="relative mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[10px] !text-[#a9bdb2]"><span className="h-1.5 w-1.5 rounded-full bg-sky-300" /><span className="truncate">Working in {pathname === "/crm" ? "Private CRM" : pathname.replace("/", "") || "Dashboard"}</span><ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-[#789286]" /></div>
        </header>
        <div className="px-4 pb-2 pt-3"><div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] !text-[#789286]"><span>Activity</span><span>{logs.length} events</span></div></div>
        {voiceState === "idle" && <div className="grid grid-cols-2 gap-2 px-4 pb-3"><button type="button" onClick={() => sendPrompt("Check my WhatsApp connection and setup status")} className="rounded-xl border border-[#294238] bg-[#12251e] px-3 py-2.5 text-left text-[11px] font-medium !text-[#cbe8d7] transition hover:border-emerald-300/50 hover:bg-[#173126]">Check setup <span className="mt-1 block text-[10px] !text-[#789286]">Connection & groups</span></button><button type="button" onClick={() => sendPrompt("Help me use my Private CRM")} className="rounded-xl border border-[#294238] bg-[#12251e] px-3 py-2.5 text-left text-[11px] font-medium !text-[#cbe8d7] transition hover:border-emerald-300/50 hover:bg-[#173126]">Use my CRM <span className="mt-1 block text-[10px] !text-[#789286]">Work with inventory</span></button></div>}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4" aria-live="polite">{logs.map((entry) => <div key={entry.id} className="flex gap-2.5 rounded-xl border border-[#294238] bg-[#0f1f18] px-3 py-2.5"><span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${entry.kind === "error" ? "bg-amber-300" : entry.kind === "action" ? "bg-emerald-300" : entry.kind === "heard" ? "bg-sky-300" : "bg-[#789286]"}`} /><p className={`text-xs leading-relaxed ${entry.kind === "error" ? "!text-[#f6d28a]" : entry.kind === "action" ? "!text-[#b9f5d2]" : entry.kind === "heard" ? "!text-[#bfe7ff]" : "!text-[#c2d1c8]"}`}>{entry.text}</p></div>)}</div>
        <ConversationBar value={textInput} onChange={setTextInput} onSubmit={sendTextMessage} onToggleVoice={toggleCall} voiceActive={voiceActive} />
        <div className="flex gap-2 border-t border-white/10 px-4 py-3 text-[10px] leading-relaxed !text-[#a9bdb2]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300/80" /><span>Guardrails: QR linking, group consent, and data edits always require your action.</span></div>
      </section>}
      <div className="flex items-center gap-2">{open && <span className="rounded-full border border-white/10 bg-[#091410]/95 px-3 py-2 text-xs text-white/80 shadow-lg backdrop-blur">{active ? "Talk to PropAI" : "Open copilot"}</span>}<span data-copilot-drag-handle onPointerDown={beginDrag} className="flex h-9 w-9 cursor-grab touch-none items-center justify-center rounded-full border border-white/10 bg-[#091410]/95 text-[#a9bdb2] shadow-lg active:cursor-grabbing" title="Drag copilot" aria-label="Drag copilot"><GripVertical className="h-4 w-4" aria-hidden="true" /></span><button type="button" onClick={() => { setOpen(true); toggleCall(); }} className={`flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 text-white shadow-[0_14px_36px_rgba(0,0,0,0.3)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_42px_rgba(0,0,0,0.38)] focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-background ${active ? "bg-rose-500" : "bg-emerald-500"}`} aria-label={active ? "Stop voice assistant" : "Start voice assistant"} aria-controls="propai-workspace-copilot"><Orb state={orbState} theme="circle" size={58} interactive={false} aria-hidden="true" /></button></div>
    </div>
  );
}

export function VoiceAssistant({ enabled = true }: { enabled?: boolean }) {
  return <ConversationProvider><VoiceAssistantInner enabled={enabled} /></ConversationProvider>;
}
