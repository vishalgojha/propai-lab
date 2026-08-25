"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ConversationProvider, useConversation, type ClientTools } from "@elevenlabs/react";
import { EyeOff, MicOff, Send, ShieldCheck, Square, X } from "lucide-react";
import {
  getOnboardingGroups,
  getPhones,
  logWorkspaceActivity,
  type OnboardingGroupState,
  type Phone,
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
] as const;

const TOOL_NAMES = new Set(VOICE_ASSISTANT_TOOL_DEFINITIONS.map((tool) => tool.name));
// ElevenLabs keeps the client tool call open while this promise resolves. Keep
// the connection read comfortably below its own timeout; group directory data
// is optional enrichment and must never block the core status answer.
const VOICE_STATUS_TOOL_TIMEOUT_MS = 6500;
const VOICE_ASSISTANT_HIDDEN_KEY = "propai.workspace-copilot-hidden";

const PROPAI_UI_GUIDE = `
AUTHORITATIVE PROPAI UI GUIDE — use this for explanatory questions. Answer directly in one or two concise sentences; do not call a tool just to explain a visible control. Only use the three registered client tools when the broker asks you to open a screen or read live WhatsApp setup status.

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

Boundaries:
- You can explain pages, labels, statuses, and visible controls; guide the broker step by step; navigate only through the registered tools; and read current WhatsApp setup status through the registered status tool.
- You cannot edit or save listings or requirements, change budgets/prices/BHK, select groups, confirm consent, scan QR codes, send messages, delete anything, or access passwords/API keys.
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

function describeSetup(phones: Phone[], state: OnboardingGroupState | null) {
  if (!phones.length) return "No WhatsApp number has been added yet. I can open the Connect screen, but you must add and authorize the number yourself.";
  const phoneSummary = phones.map((phone) => describePhone(phone)).join(", ");
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

  const runTool = useCallback(async (name: string) => {
    if (!TOOL_NAMES.has(name as (typeof VOICE_ASSISTANT_TOOL_DEFINITIONS)[number]["name"])) {
      addLog("error", `I blocked an unapproved action: ${name}.`);
      audit("voice_assistant.blocked_tool", name);
      return "That action is not available in the PropAI voice pilot.";
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
      const { phones } = await withTimeout(getPhones(false, remaining()), remaining());
      const activePhone = phones.find((phone) => phone.is_active) || phones[0];
      let setup: OnboardingGroupState | null = null;
      if (activePhone) {
        try {
          setup = await withTimeout(getOnboardingGroups(activePhone.id, remaining()), remaining());
        } catch {
          setup = null;
        }
      }
      const summary = describeSetup(phones, setup);
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
  }, [addLog, audit, router]);

  const clientTools = useMemo<ClientTools>(() => ({
    open_whatsapp_connect: () => runTool("open_whatsapp_connect"),
    get_whatsapp_setup_status: () => runTool("get_whatsapp_setup_status"),
    open_group_selection: () => runTool("open_group_selection"),
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

  const sendTextMessage = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = textInput.trim();
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
  }, [enabled]);

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
      <div className="fixed bottom-20 right-4 z-[90] sm:bottom-6 sm:right-6">
        <button
          type="button"
          onClick={restoreAssistant}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-300/25 bg-[#091410]/95 text-emerald-300 shadow-[0_12px_30px_rgba(0,0,0,0.28)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-emerald-300/50 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-background"
          aria-label="Show workspace copilot"
          title="Show workspace copilot"
        >
          <VoiceAgentMark className="h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-20 right-4 z-[90] flex flex-col items-end gap-3 sm:bottom-6 sm:right-6">
      {open && <section id="propai-workspace-copilot" aria-label="PropAI voice assistant" className="w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-[1.35rem] border border-emerald-300/20 bg-[#091410] !text-[#f3f8f5] shadow-[0_24px_70px_rgba(0,0,0,0.42)] backdrop-blur-xl">
        <header className="relative overflow-hidden border-b border-white/10 px-4 pb-4 pt-4">
          <div className="pointer-events-none absolute -right-12 -top-16 h-36 w-36 rounded-full bg-emerald-300/10 blur-3xl" />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80"><VoiceAgentMark className="h-3.5" /> PropAI assistant</div>
              <h2 className="mt-1 !text-base font-semibold tracking-tight !text-[#f3f8f5]">Workspace copilot</h2>
              <p className="mt-1 text-xs !text-[#a9bdb2]">Context-aware help for WhatsApp setup and your workspace.</p>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={hideAssistant} className="rounded-lg border !border-[#385548] !bg-transparent p-2 !text-[#a9bdb2] transition hover:!border-[#5a806d] hover:!bg-[#12251e] hover:!text-[#f3f8f5]" aria-label="Hide workspace copilot" title="Hide workspace copilot"><EyeOff className="h-4 w-4" /></button>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg border !border-[#385548] !bg-transparent p-2 !text-[#a9bdb2] transition hover:!border-[#5a806d] hover:!bg-[#12251e] hover:!text-[#f3f8f5]" aria-label="Close voice assistant panel" title="Close panel"><X className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="relative mt-4 flex items-center justify-between rounded-xl border border-[#294238] bg-[#12251e] px-3 py-2.5">
            <div className="flex items-center gap-2.5"><span className="relative flex h-2.5 w-2.5"><span className={`absolute inline-flex h-full w-full rounded-full opacity-70 ${active ? "animate-ping bg-emerald-400" : voiceState === "error" ? "bg-amber-400" : "bg-white/30"}`} /><span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${active ? "bg-emerald-300" : voiceState === "error" ? "bg-amber-300" : "bg-white/40"}`} /></span><div><div className="text-xs font-medium !text-[#f3f8f5]">{stateLabel}</div><div className="text-[10px] !text-[#a9bdb2]">{stateMessage}</div></div></div>
            <span className="rounded-full border border-emerald-300/20 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-emerald-200/75">Pilot</span>
          </div>
        </header>
        <div className="px-4 pb-2 pt-3"><div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] !text-[#789286]"><span>Activity</span><span>{logs.length} events</span></div></div>
        <div className="max-h-56 space-y-2 overflow-y-auto px-4 pb-4" aria-live="polite">{logs.map((entry) => <div key={entry.id} className="flex gap-2.5 rounded-xl border border-[#294238] bg-[#0f1f18] px-3 py-2.5"><span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${entry.kind === "error" ? "bg-amber-300" : entry.kind === "action" ? "bg-emerald-300" : entry.kind === "heard" ? "bg-sky-300" : "bg-[#789286]"}`} /><p className={`text-xs leading-relaxed ${entry.kind === "error" ? "!text-[#f6d28a]" : entry.kind === "action" ? "!text-[#b9f5d2]" : entry.kind === "heard" ? "!text-[#bfe7ff]" : "!text-[#c2d1c8]"}`}>{entry.text}</p></div>)}</div>
        <form onSubmit={sendTextMessage} className="border-t border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 rounded-xl border border-[#385548] bg-[#07100c] p-1.5 transition focus-within:border-emerald-300/60 focus-within:ring-1 focus-within:ring-emerald-300/20">
            <input value={textInput} onChange={(event) => setTextInput(event.target.value)} placeholder="Ask anything about PropAI…" aria-label="Message PropAI voice assistant" className="min-w-0 flex-1 bg-transparent px-2 text-xs !text-[#f3f8f5] outline-none placeholder:!text-[#789286]" />
            <button type="submit" disabled={!textInput.trim()} aria-label="Send message to PropAI" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg !bg-[#3ee88a] !text-[#092016] transition hover:!bg-[#74f0a5] disabled:cursor-not-allowed disabled:!bg-[#263a31] disabled:!text-[#789286]"><Send className="h-3.5 w-3.5" /></button>
          </div>
          <div className="mt-2 flex items-center justify-between px-1 text-[10px] !text-[#789286]"><span>Voice or text input</span><span>Hinglish okay</span></div>
        </form>
        <div className="flex gap-2 border-t border-white/10 px-4 py-3 text-[10px] leading-relaxed !text-[#a9bdb2]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300/80" /><span>Protected actions stay with you: QR linking, group consent, and data edits are never automatic.</span></div>
      </section>}
      <div className="flex items-center gap-2">{open && <span className="rounded-full border border-white/10 bg-[#091410]/95 px-3 py-2 text-xs text-white/80 shadow-lg backdrop-blur">{active ? "Talk to PropAI" : "Open copilot"}</span>}<button type="button" onClick={() => { setOpen(true); toggleCall(); }} className={`flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 text-white shadow-[0_14px_36px_rgba(0,0,0,0.3)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_42px_rgba(0,0,0,0.38)] focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-background ${active ? "bg-rose-500" : "bg-emerald-500"}`} aria-label={active ? "Stop voice assistant" : "Start voice assistant"} aria-controls="propai-workspace-copilot">{active ? <Square className="h-5 w-5 fill-current" /> : voiceState === "error" ? <MicOff className="h-5 w-5" /> : <VoiceAgentMark className="h-6" />}</button></div>
    </div>
  );
}

export function VoiceAssistant({ enabled = true }: { enabled?: boolean }) {
  return <ConversationProvider><VoiceAssistantInner enabled={enabled} /></ConversationProvider>;
}
