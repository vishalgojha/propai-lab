"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "@/lib/api";
import { getAccessToken } from "@/lib/auth";
import {
  Send,
  Sparkles,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Trash2,
  MessageSquare,
  Plus,
  Brain,
} from "lucide-react";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  blocks?: api.WorkspaceBlock[];
  sources?: string[];
}

interface InboxChatPanelProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedBroker?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedMsgDetails?: any;
  selectedConversationJid?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  globalMode?: boolean;
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

function buildContextPrefix(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedBroker: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedMsgDetails: any,
): string {
  const parts: string[] = [];
  if (selectedBroker) {
    const name = selectedBroker.canonical_name || selectedBroker.name || "";
    // Skip group names — they are WhatsApp group names, not broker names.
    // Group JIDs end with @g.us; group entries won't have a real broker phone.
    const isGroup = selectedBroker.chat_type === "group"
      || (selectedBroker.id && String(selectedBroker.id).includes("@g.us"))
      || (!selectedBroker.phone && !selectedBroker.primary_phone && !selectedBroker.identity_key);
    if (name && !isGroup) parts.push(`Broker: ${name}`);
    if (selectedBroker.city) parts.push(`City: ${selectedBroker.city}`);
  }
  if (selectedMsgDetails) {
    const parsed = selectedMsgDetails.parsed || {};
    const raw = selectedMsgDetails.raw || {};
    if (parsed.building_name) parts.push(`Building: ${parsed.building_name}`);
    if (parsed.micro_market) parts.push(`Area: ${parsed.micro_market}`);
    if (parsed.bhk) parts.push(`BHK: ${parsed.bhk}`);
    if (parsed.price) parts.push(`Price: ₹${Number(parsed.price).toLocaleString("en-IN")}`);
    if (parsed.area_sqft) parts.push(`Area: ${parsed.area_sqft} sqft`);
    if (parsed.furnishing) parts.push(`Furnishing: ${parsed.furnishing}`);
    if (parsed.intent) parts.push(`Intent: ${parsed.intent}`);
    if (raw.message) {
      const snippet = raw.message.slice(0, 200);
      parts.push(`Original message: "${snippet}"`);
    }
  }
  if (parts.length === 0) return "";
  return `Context:\n${parts.join("\n")}\n\n---\n\n`;
}

function renderAssistantMessage(msg: ChatMsg) {
  return (
    <div className="space-y-2">
      <div className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
        {msg.content || "No assistant text returned."}
      </div>
      {msg.sources && msg.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {msg.sources.map((source, idx) => (
            <span
              key={`${source}-${idx}`}
              className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-zinc-400"
            >
              {source}
            </span>
          ))}
        </div>
      )}
      {msg.blocks && msg.blocks.length > 0 && (
        <div className="text-[10px] text-zinc-500">
          Structured response received. Open the workspace view for the full breakdown.
        </div>
      )}
    </div>
  );
}

export function InboxChatPanel({
  selectedBroker,
  selectedMsgDetails,
  collapsed = false,
  onToggleCollapse,
  globalMode = false,
}: InboxChatPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [sessionId, setSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<api.ChatSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [brokerPhone] = useState(
    () => (typeof window !== "undefined" ? localStorage.getItem("propai_broker_phone") || "" : "")
  );
  const [showSessions, setShowSessions] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const loadSessions = useCallback(async (phone: string) => {
    try {
      const data = await api.listChatSessions(phone);
      setSessions(data);
      return data;
    } catch {
      setSessions([]);
      return [];
    }
  }, []);

  useEffect(() => {
    if (!brokerPhone) return;
    let cancelled = false;
    void (async () => {
      const data = await loadSessions(brokerPhone);
      if (cancelled) return;
      setSessionsLoaded(true);
      if (data.length > 0 && !sessionId) {
        setSessionId(data[0].id);
        try {
          const msgs = await api.getChatSessionMessages(data[0].id);
          if (cancelled) return;
          setMessages(
            msgs.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            }))
          );
        } catch {
          /* start empty */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerPhone, loadSessions]);

  const handleNewChat = useCallback(async () => {
    if (!brokerPhone) return;
    try {
      const session = await api.createChatSession(brokerPhone);
      setSessionId(session.id);
      setMessages([]);
      const updated = await loadSessions(brokerPhone);
      setSessions(updated);
    } catch {
      /* ignore */
    }
  }, [brokerPhone, loadSessions]);

  const handleSwitchSession = useCallback(
    async (id: string) => {
      if (id === sessionId) return;
      setSessionId(id);
      setMessages([]);
      try {
        const msgs = await api.getChatSessionMessages(id);
        setMessages(
          msgs.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }))
        );
      } catch {
        setMessages([]);
      }
      setShowSessions(false);
    },
    [sessionId]
  );

  const handleDeleteSession = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await api.deleteChatSession(id);
        const updated = await loadSessions(brokerPhone);
        setSessions(updated);
        if (id === sessionId) {
          if (updated.length > 0) {
            handleSwitchSession(updated[0].id);
          } else {
            handleNewChat();
          }
        }
      } catch {
        /* ignore */
      }
    },
    [brokerPhone, sessionId, loadSessions, handleSwitchSession, handleNewChat]
  );

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;
    const rawUserMsg = input.trim();
    setInput("");
    setLoading(true);
    setError(null);

    const contextPrefix = globalMode ? "" : buildContextPrefix(selectedBroker, selectedMsgDetails);
    const fullUserMsg = contextPrefix ? `${contextPrefix}${rawUserMsg}` : rawUserMsg;

    const userMsg: ChatMsg = { role: "user", content: rawUserMsg };
    setMessages((prev) => [...prev, userMsg]);

    const historyForApi = [...messages, { role: "user", content: fullUserMsg }].map((m) => ({
      role: m.role,
      content: m.role === "user" && m === userMsg ? fullUserMsg : m.content,
    }));

    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/ai/chat`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          messages: historyForApi,
          session_id: sessionId || undefined,
          broker_phone: brokerPhone || undefined,
          source: "inbox",
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || errBody.error || `Request failed (${res.status})`);
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(data.message || data.error);
      }

      const assistantMsg: ChatMsg = {
        role: "assistant",
        content: data.content || "",
        blocks: data.blocks || undefined,
        sources: data.sources || undefined,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to get AI response");
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, sessionId, brokerPhone, selectedBroker, selectedMsgDetails, globalMode]);

  if (collapsed) {
    return (
      <div className="h-full flex flex-col items-center justify-center border-l border-white/10 bg-black/40">
        <button
          onClick={onToggleCollapse}
          className="flex flex-col items-center gap-2 text-zinc-500 hover:text-emerald-400 transition-colors p-3"
          title="Expand AI Chat"
        >
          <Brain className="w-5 h-5" />
          <ChevronLeft className="w-3 h-3" />
          <span className="text-[9px] uppercase tracking-widest font-semibold">AI Chat</span>
        </button>
      </div>
    );
  }

  const contextLabel =
    globalMode
      ? undefined
      : selectedBroker
      ? selectedBroker.canonical_name || selectedBroker.name || "Selected broker"
      : selectedMsgDetails
        ? "Selected message"
        : undefined;

  const memoryScopeLabel = globalMode
    ? "Memory: global chat"
    : sessionId
      ? "Memory: broker session"
      : brokerPhone
        ? "Memory: broker inbox"
        : "Memory: sessionless";

  return (
    <div className="relative h-full w-full min-w-0 flex flex-col bg-[#070b0e] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400 shrink-0">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold text-white truncate">AI Chat</div>
            {contextLabel && (
              <div className="text-[9px] text-emerald-400/70 truncate">{contextLabel}</div>
            )}
            <div className="mt-0.5 text-[9px] text-zinc-500 truncate" title={memoryScopeLabel}>
              {memoryScopeLabel}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setShowSessions(!showSessions)}
            className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
            title="Chat sessions"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleNewChat}
            className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
            title="New chat"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
            title="Collapse panel"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Sessions sidebar (overlay) */}
      {showSessions && (
        <div className="absolute top-10 right-0 z-20 w-52 max-h-64 bg-zinc-950 border border-white/10 rounded-lg shadow-xl overflow-y-auto">
          <div className="p-2 space-y-0.5">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => handleSwitchSession(s.id)}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-[11px] transition-colors group flex items-start gap-2 ${
                  s.id === sessionId
                    ? "bg-white/5 text-white"
                    : "text-zinc-400 hover:text-white hover:bg-white/5"
                }`}
              >
                <MessageSquare className="w-3 h-3 mt-0.5 shrink-0 opacity-50" />
                <div className="flex-1 min-w-0">
                  <div className="truncate leading-tight">{s.title}</div>
                  <div className="text-[9px] text-zinc-600 mt-0.5">
                    {formatSessionTime(s.updated_at)}
                  </div>
                </div>
                <button
                  onClick={(e) => handleDeleteSession(s.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/10 hover:text-red-400 transition-all shrink-0"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </button>
            ))}
            {sessionsLoaded && sessions.length === 0 && (
              <div className="text-[10px] text-zinc-600 px-2.5 py-3 text-center">
                No chats yet.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 relative">
        {messages.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-3">
              <Brain className="w-5 h-5 text-emerald-400" />
            </div>
            <p className="text-xs font-semibold text-zinc-300 mb-1">Ask PropAI anything</p>
            <p className="text-[10px] text-zinc-500 max-w-[200px]">
              Search market listings, compare brokers, analyze buildings, or get market insights.
            </p>
            {contextLabel && (
              <div className="mt-3 px-2 py-1.5 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                <p className="text-[9px] text-emerald-400/70">
                  Context-aware: {contextLabel}
                </p>
              </div>
            )}
            <div className="mt-2 text-[9px] text-zinc-500">
              {memoryScopeLabel}
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {msg.role === "user" ? (
                <div className="max-w-[85%] rounded-xl px-3 py-2 text-xs bg-blue-600 text-white whitespace-pre-wrap">
                  {msg.content}
                </div>
              ) : (
                <div className="max-w-full w-full min-w-0">
                  {renderAssistantMessage(msg)}
                </div>
              )}
            </div>
          ))
        )}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-zinc-900 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-zinc-400 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
              <span>Thinking...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="mx-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-3 pb-3 pt-1 border-t border-white/10 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={
              contextLabel
                ? `Ask about ${contextLabel.toLowerCase()}...`
                : "Ask about your market data..."
            }
            rows={2}
            className="flex-1 bg-zinc-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 resize-none max-h-[80px] outline-none transition-colors focus:border-emerald-400/50 focus:ring-1 focus:ring-emerald-400/30"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="px-3 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 rounded-xl text-xs font-bold text-black transition-colors shrink-0 min-h-[36px] flex items-center gap-1.5"
          >
            <Send className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default InboxChatPanel;
