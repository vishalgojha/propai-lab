"use client";

export const dynamic = 'force-dynamic';

import * as api from "@/lib/api";
import { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useAuth } from "@/lib/AuthProvider";
import { Plus, MessageSquare, Trash2 } from "lucide-react";

function buildChipLabels(s: api.ChatSuggestions | null): string[] {
  const chips: string[] = [];
  if (s?.top_supply_market) chips.push(`Owner listings in ${s.top_supply_market}`);
  if (s?.top_demand_market) chips.push(`Requirements in ${s.top_demand_market}`);
  if (s?.top_commercial_market) chips.push(`Who deals in ${s.top_commercial_market} offices?`);
  if (s?.top_building) chips.push(`Show all ${s.top_building} listings`);
  if (s?.top_rental_market) chips.push(`Brokers active in ${s.top_rental_market} rentals`);
  chips.push("Duplicate brokers in database");
  if (s?.top_broker_building) chips.push(`Which brokers post ${s.top_broker_building} most?`);
  chips.push("Show me this week's price trends");
  return chips;
}

function messageText(message: { content?: string; parts?: Array<{ type?: string; text?: string }> }) {
  if (typeof message.content === "string" && message.content) return message.content;
  return (message.parts || [])
    .map((part) => (part?.type === "text" ? part.text || "" : ""))
    .join("");
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

export default function ChatPage() {
  const { user } = useAuth();
  const [input, setInput] = useState("");
  const [suggestionsData, setSuggestionsData] = useState<api.ChatSuggestions | null>(null);
  const [brokerPhone, setBrokerPhone] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Session state
  const [sessionId, setSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<api.ChatSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

  const { messages, sendMessage, status, setMessages, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/ai/chat",
      body: () => ({ broker_phone: brokerPhone, session_id: sessionId }),
    }),
  });

  // Load broker phone from profile
  useEffect(() => {
    const phone = user?.phone || "";
    if (phone) {
      api.getProfile(phone).then((profile: any) => {
        if (profile?.phone) setBrokerPhone(profile.phone);
      }).catch(() => {});
    }
  }, [user]);

  // Load sessions once brokerPhone is available
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
    loadSessions(brokerPhone).then((data) => {
      setSessionsLoaded(true);
      // Auto-resume most recent session
      if (data.length > 0 && !sessionId) {
        const mostRecent = data[0];
        setSessionId(mostRecent.id);
        api.getChatSessionMessages(mostRecent.id).then((msgs) => {
          setMessages(msgs.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
          })));
        }).catch(() => {});
      }
    });
  }, [brokerPhone]);

  // Load suggestions
  useEffect(() => {
    api.getChatSuggestions().then(setSuggestionsData).catch(() => {});
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  // Create a new session
  const handleNewChat = useCallback(async () => {
    if (!brokerPhone) return;
    try {
      const session = await api.createChatSession(brokerPhone);
      setSessionId(session.id);
      setMessages([]);
      const updated = await loadSessions(brokerPhone);
      setSessions(updated);
    } catch {}
  }, [brokerPhone, loadSessions, setMessages]);

  // Switch to an existing session
  const handleSwitchSession = useCallback(async (id: string) => {
    if (id === sessionId) return;
    setSessionId(id);
    try {
      const msgs = await api.getChatSessionMessages(id);
      setMessages(msgs.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
      })));
    } catch {
      setMessages([]);
    }
  }, [sessionId, setMessages]);

  // Delete a session
  const handleDeleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
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
    } catch {}
  }, [brokerPhone, sessionId, loadSessions, handleSwitchSession, handleNewChat]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || status === "submitted") return;
    // Create session on first message if none exists
    if (!sessionId && brokerPhone) {
      api.createChatSession(brokerPhone, input.trim().slice(0, 80)).then((session) => {
        setSessionId(session.id);
        sendMessage({ text: input.trim() });
        setInput("");
        loadSessions(brokerPhone);
      }).catch(() => {});
      return;
    }
    sendMessage({ text: input.trim() });
    setInput("");
  }

  return (
    <div className="flex h-[calc(100dvh-160px)] lg:h-[calc(100vh-160px)] max-w-6xl mx-auto px-4 lg:px-0">
      <style>{`
        @keyframes typing-bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-6px); }
        }
        .typing-dot { width: 6px; height: 6px; border-radius: 50%; background: #a1a1aa; animation: typing-bounce 1.4s infinite both; }
        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }
        .typing-dot:nth-child(3) { animation-delay: 0s; }
      `}</style>

      {/* ═══════ Session Sidebar ═══════ */}
      <aside className="hidden lg:flex w-52 flex-col border-r border-white/10 shrink-0 mr-4">
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
            <button
              key={s.id}
              onClick={() => handleSwitchSession(s.id)}
              className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors group flex items-start gap-2 ${
                s.id === sessionId
                  ? "bg-white/5 text-white"
                  : "text-zinc-400 hover:text-white hover:bg-white/5"
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-50" />
              <div className="flex-1 min-w-0">
                <div className="truncate leading-tight">{s.title}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">{formatSessionTime(s.updated_at)}</div>
              </div>
              <button
                onClick={(e) => handleDeleteSession(s.id, e)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/10 hover:text-red-400 transition-all shrink-0"
                title="Delete chat"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </button>
          ))}
          {sessionsLoaded && sessions.length === 0 && (
            <div className="text-[11px] text-zinc-600 px-2.5 py-4 text-center">
              No chats yet. Ask a question to start.
            </div>
          )}
        </div>
      </aside>

      {/* ═══════ Chat Area ═══════ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile: new chat button */}
        <div className="lg:hidden mb-3 flex justify-end">
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-blue-500/30 hover:text-white"
          >
            <Plus className="w-3 h-3" />
            New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
          {messages.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-3xl mb-3">🤖</div>
              <h2 className="text-sm font-semibold text-white mb-2">Ask PropAI anything</h2>
              <p className="text-xs text-zinc-500 mb-6 max-w-md mx-auto">
                Natural-language search across market listings, requirements, brokers, buildings, and markets.
              </p>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg mx-auto">
                {buildChipLabels(suggestionsData).map((q) => (
                  <button
                    key={q}
                    onClick={() => setInput(q)}
                    className="text-xs text-zinc-400 border border-white/10 hover:border-blue-500/30 hover:text-white rounded-lg px-2.5 py-1.5 lg:px-3 lg:py-2 transition-colors min-h-[36px]"
                  >
                    {q}
                  </button>
                ))}
              </div>
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
                    <div className="max-w-[90%] w-full">
                      <div className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{messageText(m)}</div>
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
              <div className="bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-sm text-zinc-400 flex items-center gap-1.5 min-w-[60px]">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
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

        <form onSubmit={handleSubmit} className="flex gap-2 items-end border-t border-white/10 pt-3 lg:pt-4 pb-2 lg:pb-0">
          <textarea
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
        </form>
      </div>
    </div>
  );
}
