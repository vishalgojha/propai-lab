"use client";

export const dynamic = 'force-dynamic';

import * as api from "@/lib/api";
import { getAccessToken } from "@/lib/auth";
import { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ListingCard, { type ListingItem } from "@/components/ListingCard";
import { useAuth } from "@/lib/AuthProvider";
import { Plus, MessageSquare, Trash2, PanelLeft, PanelLeftClose } from "lucide-react";

function messageText(message: { parts?: Array<{ type?: string; text?: string }>; content?: string }) {
  if (typeof message.content === "string" && message.content) return message.content;
  return (message.parts || [])
    .map((part) => (part?.type === "text" ? part.text || "" : ""))
    .join("");
}

function toUIMessage(m: { id: string; role: "user" | "assistant"; content: string }) {
  return {
    id: m.id,
    role: m.role,
    parts: [{ type: "text" as const, text: m.content }],
  };
}

function inlineMarkdown(text: string, keyPrefix: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).map((part, index) => {
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
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isMarkdownDivider(line: string) {
  const cells = markdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
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
  const [brokerPhone, setBrokerPhone] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef("");

  // Session state
  const [sessionId, setSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<api.ChatSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [showSessions, setShowSessions] = useState(true);

  const { messages, sendMessage, status, setMessages, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/ai/chat",
      body: () => ({ broker_phone: brokerPhone, session_id: sessionIdRef.current || sessionId }),
      headers: async () => {
        const headers: Record<string, string> = {};
        const token = await getAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
      },
    }),
  });
  const previousStatus = useRef(status);

  // Load broker phone from profile
  useEffect(() => {
    const phone = user?.phone || "";
    if (!phone) return;
    setBrokerPhone(phone);
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
    let cancelled = false;
    void (async () => {
      const data = await loadSessions(brokerPhone);
      if (cancelled) return;
      setSessionsLoaded(true);
      if (data.length > 0 && !sessionId) {
        const mostRecent = data[0];
        sessionIdRef.current = mostRecent.id;
        setSessionId(mostRecent.id);
        try {
          const msgs = await api.getChatSessionMessages(mostRecent.id);
          if (cancelled) return;
          setMessages(msgs.map((m) => toUIMessage({ id: m.id, role: m.role as "user" | "assistant", content: m.content })));
        } catch {
          // Ignore resume failures and start from an empty thread.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brokerPhone, loadSessions, sessionId, setMessages]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  // Refresh the sidebar after a response finishes so newly created chats
  // appear immediately instead of only after a full page reload.
  useEffect(() => {
    const wasBusy = previousStatus.current === "submitted" || previousStatus.current === "streaming";
    if (wasBusy && status === "ready" && brokerPhone) {
      void loadSessions(brokerPhone);
    }
    previousStatus.current = status;
  }, [brokerPhone, loadSessions, status]);

  // Create a new session
  const handleNewChat = useCallback(async () => {
    if (!brokerPhone) return;
    try {
      sessionIdRef.current = "";
      setSessionId("");
      setMessages([]);
      const session = await api.createChatSession(brokerPhone);
      if (!session?.id) throw new Error("Could not create a new chat session.");
      sessionIdRef.current = session.id;
      setSessionId(session.id);
      const updated = await loadSessions(brokerPhone);
      setSessions(updated);
    } catch {}
  }, [brokerPhone, loadSessions, setMessages]);

  // Switch to an existing session
  const handleSwitchSession = useCallback(async (id: string) => {
    if (id === sessionId) return;
    setSessionId(id);
    sessionIdRef.current = id;
    try {
      const msgs = await api.getChatSessionMessages(id);
      setMessages(msgs.map((m) => toUIMessage({ id: m.id, role: m.role as "user" | "assistant", content: m.content })));
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
        sessionIdRef.current = session.id;
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
      {showSessions && <aside className="hidden lg:flex w-52 flex-col border-r border-white/10 shrink-0 mr-4">
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
        </div>
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
              <p className="text-xs text-zinc-500 max-w-md mx-auto">
                Natural-language search across market listings, requirements, brokers, buildings, and markets.
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
                    <div className="max-w-[90%] w-full space-y-3">
                      {(() => {
                        const textParts = (m.parts || []).filter(
                          (p: any) => p.type === "text" && p.text
                        );
                        const listingParts = (m.parts || []).filter(
                          (p: any) => p.type === "data-listing_cards"
                        );
                        return (
                          <>
                            {(() => {
                              const hasCards = listingParts.length > 0;
                              if (hasCards && textParts.length > 0) {
                                // Render AI summary line with bold counts
                                const summaryText = textParts[0].text || "";
                                return <div key="ai-summary" className="mb-3 text-xs text-zinc-400"><MarkdownMessage text={summaryText} /></div>;
                              }
                              return textParts.map((p: any, i: number) => (
                                <MarkdownMessage key={i} text={p.text} />
                              ));
                            })()}
                            {listingParts.map((p: any, i: number) => {
                              const items: ListingItem[] = p.data?.items || [];
                              if (items.length === 0) return null;
                              return (
                                <div key={`cards-${i}`} className="flex flex-col gap-2.5">
                                  {items.map((item, j) => (
                                    <ListingCard key={item.fingerprint || j} item={item} />
                                  ))}
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
