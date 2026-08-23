"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConversationProvider, useConversation, type ClientTools } from "@elevenlabs/react";
import { Mic, MicOff, Radio, Send, ShieldCheck, Square, Sparkles, X } from "lucide-react";
import {
  getOnboardingGroups,
  getPhones,
  logWorkspaceActivity,
  type OnboardingGroupState,
  type Phone,
} from "@/lib/api";

type VoiceState = "idle" | "listening" | "thinking" | "acting" | "error";
type LogKind = "heard" | "action" | "info" | "error";
type VoiceLog = { id: number; kind: LogKind; text: string };

/** Keep these names/descriptions identical to the client tools in ElevenLabs. */
export const VOICE_ASSISTANT_TOOL_DEFINITIONS = [
  { name: "open_whatsapp_connect", description: "Open PropAI's WhatsApp numbers connection screen. Do not scan or authorize anything." },
  { name: "get_whatsapp_setup_status", description: "Read the signed-in broker's WhatsApp connection and group setup status." },
  { name: "open_group_selection", description: "Open group selection for the broker to review. Never select or confirm groups." },
] as const;

const TOOL_NAMES = new Set(VOICE_ASSISTANT_TOOL_DEFINITIONS.map((tool) => tool.name));

function describePhone(phone: Phone) {
  if (phone.connected) return "connected";
  if (phone.qr_available) return "waiting for QR scan";
  if (phone.connection_state) return phone.connection_state.replaceAll("_", " ");
  return "not connected";
}

function describeSetup(phones: Phone[], state: OnboardingGroupState | null) {
  if (!phones.length) return "No WhatsApp number has been added yet. I can open the Connect screen, but you must add and authorize the number yourself.";
  const phoneSummary = phones.map((phone) => describePhone(phone)).join(", ");
  if (!state) return `WhatsApp number status: ${phoneSummary}. No group status is available yet.`;
  const selected = state.groups.filter((group) => !group.opted_out && group.selectable !== false).length;
  const visibleNames = state.groups.filter((group) => !group.opted_out).slice(0, 3).map((group) => group.group_name).filter(Boolean);
  const names = visibleNames.length ? ` Groups visible: ${visibleNames.join(", ")}${state.groups.length > 3 ? ", and more." : "."}` : "";
  const cap = state.cap == null ? "no group cap" : `${state.selected_count} of ${state.cap} groups selected`;
  return `WhatsApp number status: ${phoneSummary}. Extraction is ${state.extraction_status}. ${cap}; ${selected} groups are available to review.${names} I will not select or confirm groups for you.`;
}

function VoiceAssistantInner({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const logIdRef = useRef(0);
  const lastStatusReadRef = useRef<{ at: number; summary: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [showIntro, setShowIntro] = useState(false);
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
    const { phones } = await getPhones(false);
    const activePhone = phones.find((phone) => phone.is_active) || phones[0];
    let setup: OnboardingGroupState | null = null;
    if (activePhone) {
      try { setup = await getOnboardingGroups(activePhone.id); } catch { setup = null; }
    }
    const summary = describeSetup(phones, setup);
    lastStatusReadRef.current = { at: Date.now(), summary };
    addLog("info", "Read the current WhatsApp setup status.");
    audit("voice_assistant.read_status", "whatsapp_setup");
    return summary;
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
  const { status, endSession, sendUserMessage, startSession } = conversation;

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

  useEffect(() => {
    if (!enabled || window.localStorage.getItem("propai.voice-assistant-intro-seen") === "1") return;
    const timer = window.setTimeout(() => setShowIntro(true), 0);
    return () => window.clearTimeout(timer);
  }, [enabled]);

  const dismissIntro = useCallback(() => {
    window.localStorage.setItem("propai.voice-assistant-intro-seen", "1");
    setShowIntro(false);
  }, []);

  if (!enabled) return null;
  const active = status === "connected" || status === "connecting";
  const stateLabel = voiceState === "listening" ? "Listening" : voiceState === "thinking" ? "Thinking" : voiceState === "acting" ? "Acting" : voiceState === "error" ? "Needs attention" : "Ready";

  return (
    <div className="fixed bottom-20 right-4 z-[90] flex flex-col items-end gap-3 sm:bottom-6 sm:right-6">
      {open && <section aria-label="PropAI voice assistant" className="w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div><div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-emerald-300" /> PropAI voice assist</div><div className="mt-0.5 text-[11px] text-zinc-400">WhatsApp setup pilot · Hinglish okay</div></div><button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white" aria-label="Close voice assistant panel"><X className="h-4 w-4" /></button></div>
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5 text-xs"><span className={`h-2 w-2 rounded-full ${active ? "bg-emerald-400" : voiceState === "error" ? "bg-amber-400" : "bg-zinc-500"}`} /><span>{stateLabel}</span><span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-white/60">Pilot</span></div>
        <div className="max-h-52 space-y-2 overflow-y-auto px-4 py-3" aria-live="polite">{logs.map((entry) => <p key={entry.id} className={`text-xs leading-relaxed ${entry.kind === "error" ? "text-amber-300" : entry.kind === "action" ? "text-emerald-200" : entry.kind === "heard" ? "text-zinc-300" : "text-zinc-400"}`}>{entry.text}</p>)}</div>
        <form onSubmit={sendTextMessage} className="flex gap-2 border-t border-white/10 px-4 py-3">
          <input
            value={textInput}
            onChange={(event) => setTextInput(event.target.value)}
            placeholder="Type to PropAI…"
            aria-label="Message PropAI voice assistant"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none placeholder:text-zinc-500 focus:border-emerald-300/60 focus:ring-1 focus:ring-emerald-300/40"
          />
          <button type="submit" disabled={!textInput.trim()} aria-label="Send message to PropAI" className="rounded-lg bg-emerald-500 px-3 text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40">
            <Send className="h-4 w-4" />
          </button>
        </form>
        <div className="flex gap-2 border-t border-white/10 px-4 py-3 text-[11px] leading-relaxed text-zinc-400"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /><span>Voice or text can open setup and read status. QR linking and group consent always stay with you.</span></div>
      </section>}
      {showIntro && <aside role="status" aria-label="Voice assistant introduction" className="relative w-[min(19rem,calc(100vw-2rem))] rounded-xl border border-emerald-300/30 bg-zinc-950 px-4 py-3 text-white shadow-2xl">
        <button type="button" onClick={dismissIntro} className="absolute right-2 top-2 rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-white" aria-label="Dismiss voice assistant introduction"><X className="h-3.5 w-3.5" /></button>
        <div className="pr-5 text-sm font-semibold">Voice can help your setup</div>
        <p className="mt-1 pr-2 text-xs leading-relaxed text-zinc-300">Ask PropAI to open WhatsApp setup or read your connection status. If your mic isn’t working, type your request after opening this assistant.</p>
        <button type="button" onClick={() => { dismissIntro(); setOpen(true); }} className="mt-2 text-xs font-medium text-emerald-300 hover:text-emerald-200">Try the assistant →</button>
      </aside>}
      <div className="flex items-center gap-2">{open && <span className="rounded-full border border-white/10 bg-zinc-950 px-3 py-2 text-xs text-white shadow-lg">{active ? "Talk to PropAI" : "Voice assist"}</span>}<button type="button" onClick={() => { setOpen(true); toggleCall(); }} className={`flex h-14 w-14 items-center justify-center rounded-full border border-white/10 text-white shadow-xl transition hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-background ${active ? "bg-rose-500" : "bg-emerald-500"}`} aria-label={active ? "Stop voice assistant" : "Start voice assistant"}>{active ? <Square className="h-5 w-5 fill-current" /> : voiceState === "error" ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}</button></div>
      {!open && <span className="sr-only"><Radio /> Voice assistant available for WhatsApp setup</span>}
    </div>
  );
}

export function VoiceAssistant({ enabled = true }: { enabled?: boolean }) {
  return <ConversationProvider><VoiceAssistantInner enabled={enabled} /></ConversationProvider>;
}
