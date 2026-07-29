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

type ChatSourceMode = "groups" | "parsed" | "inbox" | "";
type GroupMirrorItem = ListingItem & {
  original_message?: string;
  duplicate_count?: number;
  duplicate_group_names?: string[];
  source?: string;
  last_seen_text?: string;
};

function getAssistantSourceMode(message: { parts?: Array<{ type?: string; data?: any }> }) {
  const contextPart = (message.parts || []).find((part) => part?.type === "data-chat_context");
  const sourceMode = contextPart?.data?.source_mode;
  return sourceMode === "groups" || sourceMode === "parsed" || sourceMode === "inbox" ? sourceMode : "";
}

function GroupMirrorCard({ item }: { item: GroupMirrorItem }) {
  const message = (item.original_message || item.building_name || "").trim();
  const groupNames = Array.from(new Set((item.duplicate_group_names || []).map((group) => group.trim()).filter(Boolean)));
  const senderLabel = item.broker_name || "WhatsApp member";
  const locationLabel = item.location_label || item.micro_market || "WhatsApp group";
  const duplicateLabel = item.duplicate_count && item.duplicate_count > 1
    ? `${item.duplicate_count} posts collapsed`
    : "Single group post";

  return (
    <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/[0.04] shadow-[0_0_0_1px_rgba(16,185,129,0.04)]">
      <div className="flex items-start justify-between gap-3 border-b border-white/5 px-4 py-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
            WhatsApp group mirror
          </div>
          <div className="mt-1 text-sm font-semibold text-white">{senderLabel}</div>
          <div className="text-[11px] text-zinc-500">{locationLabel}</div>
        </div>
        <div className="text-right text-[11px] text-zinc-500">
          {item.last_seen_text ? <div>{item.last_seen_text}</div> : null}
          <div>{duplicateLabel}</div>
        </div>
      </div>
      <div className="px-4 py-3">
        <div className="whitespace-pre-wrap text-sm leading-6 text-zinc-100">
          {message || "No message body available."}
        </div>
        {groupNames.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {groupNames.slice(0, 4).map((group) => (
              <span
                key={group}
                className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-200"
              >
                {group}
              </span>
            ))}
            {groupNames.length > 4 && (
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-zinc-400">
                +{groupNames.length - 4} more
              </span>
            )}
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-zinc-500">
          <span>{duplicateLabel}</span>
          <span className="truncate">{item.micro_market || item.location_label || ""}</span>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const { user, loading: authLoading } = useAuth();
  const [input, setInput] = useState("");
  const [brokerPhone, setBrokerPhone] = useState("");
  const [searchSource, setSearchSource] = useState<"groups" | "parsed">("parsed");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionIdRef = useRef("");

  // Session state
  const [sessionId, setSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<api.ChatSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sessionError, setSessionError] = useState("");

  const activeSessionStorageKey = user?.id ? `propai_active_chat_session:${user.id}` : "";
  const searchSourceStorageKey = user?.id ? `propai_chat_search_source:${user.id}` : "";

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

  useEffect(() => {
    if (!searchSourceStorageKey) return;
    const saved = window.localStorage.getItem(searchSourceStorageKey);
    if (saved === "groups" || saved === "parsed") {
      setSearchSource(saved);
    }
  }, [searchSourceStorageKey]);

  useEffect(() => {
    if (!searchSourceStorageKey) return;
    window.localStorage.setItem(searchSourceStorageKey, searchSource);
  }, [searchSource, searchSourceStorageKey]);

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
        const active = data.find((item) => item.id === savedId) || data[0];
        sessionIdRef.current = active.id;
        setSessionId(active.id);
        try {
          const msgs = await api.getChatSessionMessages(active.id);
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
    }
    previousStatus.current = status;
  }, [loadSessions, status, user?.id]);

  // Create a new session
  const handleNewChat = useCallback(async () => {
    // Create the durable row immediately. The thread must exist before the
    // first message, provider call, navigation, or browser refresh.
    sessionIdRef.current = "";
    setSessionId("");
    setMessages([]);
    setInput("");
    setSessionError("");
    inputRef.current?.focus();
    try {
      const session = await api.createChatSession();
      if (!session?.id) throw new Error("Could not create a new chat session.");
      sessionIdRef.current = session.id;
      setSessionId(session.id);
      const updated = await loadSessions();
      setSessions(updated);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Could not create a chat session.");
    }
  }, [loadSessions, setMessages]);

  // Switch to an existing session
  const handleSwitchSession = useCallback(async (id: string) => {
    if (id === sessionId) return;
    setSessionId(id);
    sessionIdRef.current = id;
    if (activeSessionStorageKey) window.localStorage.setItem(activeSessionStorageKey, id);
    try {
      const msgs = await api.getChatSessionMessages(id);
      setMessages(msgs.map((m) => toUIMessage({ id: m.id, role: m.role as "user" | "assistant", content: m.content })));
    } catch {
      setMessages([]);
    }
  }, [activeSessionStorageKey, sessionId, setMessages]);

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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || status === "submitted") return;
    setSessionError("");
    // Create session on first message if none exists
    if (!sessionId) {
      const text = input.trim();
      api.createChatSession(text.slice(0, 80)).then((session) => {
        if (!session?.id) throw new Error("Could not create a chat session.");
        sessionIdRef.current = session.id;
        setSessionId(session.id);
        sendMessage({ text });
        setInput("");
        return loadSessions().then(setSessions);
      }).catch((error) => {
        setSessionError(error instanceof Error ? error.message : "Could not create a chat session.");
      });
      return;
    }
    sendMessage({ text: input.trim() });
    setInput("");
  }

  return (
    <div className="relative flex h-[calc(100svh-160px)] lg:h-[calc(100vh-160px)] max-w-7xl mx-auto px-4 lg:px-0">
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
      {showSessions && <aside className="hidden lg:flex w-40 flex-col border-r border-white/10 shrink-0 mr-2">
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
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-1">
            <span className="px-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500">Search</span>
            <button
              type="button"
              onClick={() => setSearchSource("groups")}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
                searchSource === "groups"
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "text-zinc-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              WhatsApp groups
            </button>
            <button
              type="button"
              onClick={() => setSearchSource("parsed")}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
                searchSource === "parsed"
                  ? "bg-blue-500/15 text-blue-300"
                  : "text-zinc-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              Parsed data
            </button>
          </div>
        </div>
        {sessionError && (
          <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            Chat session could not be saved: {sessionError}
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
        <div className="lg:hidden mb-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-1">
          <button
            type="button"
            onClick={() => setSearchSource("groups")}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              searchSource === "groups"
                ? "bg-emerald-500/15 text-emerald-300"
                : "text-zinc-400"
            }`}
          >
            WhatsApp groups
          </button>
          <button
            type="button"
            onClick={() => setSearchSource("parsed")}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              searchSource === "parsed"
                ? "bg-blue-500/15 text-blue-300"
                : "text-zinc-400"
            }`}
          >
            Parsed data
          </button>
        </div>
        {showSessions && (
          <div className="absolute inset-x-4 top-11 z-30 max-h-[55dvh] overflow-y-auto rounded-xl border border-white/10 bg-black/95 p-2 shadow-2xl lg:hidden">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { void handleSwitchSession(s.id); setShowSessions(false); }}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${s.id === sessionId ? "bg-white/10 text-white" : "text-zinc-400"}`}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="text-[10px] text-zinc-600">{formatSessionTime(s.updated_at)}</span>
              </button>
            ))}
            {sessionsLoaded && sessions.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-zinc-500">No saved chats yet.</div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
          {messages.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-3xl mb-3">🤖</div>
              <h2 className="text-sm font-semibold text-white mb-2">Ask PropAI anything</h2>
              <p className="text-xs text-zinc-500 max-w-md mx-auto">
                {searchSource === "groups"
                  ? "Search the live WhatsApp group feed first. Switch to parsed data when you want the deduped inventory index."
                  : "Search the deduped inventory index first. Switch to WhatsApp groups when you want raw broker posts."}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setSearchSource("groups")}
                  className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${
                    searchSource === "groups"
                      ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                      : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-white"
                  }`}
                >
                  Search WhatsApp groups
                </button>
                <button
                  type="button"
                  onClick={() => setSearchSource("parsed")}
                  className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${
                    searchSource === "parsed"
                      ? "border-blue-400/40 bg-blue-500/15 text-blue-200"
                      : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-white"
                  }`}
                >
                  Search parsed data
                </button>
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
                    <div className="max-w-[90%] w-full space-y-3">
                      {(() => {
                        const assistantMode = (getAssistantSourceMode(m) || searchSource) as ChatSourceMode;
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
                                return (
                                  <div key="ai-summary" className="mb-3 text-xs text-zinc-400">
                                    <MarkdownMessage text={summaryText} />
                                  </div>
                                );
                              }
                              return textParts.map((p: any, i: number) => (
                                <MarkdownMessage key={i} text={p.text} />
                              ));
                            })()}
                            {listingParts.length > 0 && (
                              <div className="flex items-center gap-2">
                                <span
                                  className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
                                    assistantMode === "groups"
                                      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
                                      : "border-blue-500/20 bg-blue-500/10 text-blue-200"
                                  }`}
                                >
                                  {assistantMode === "groups" ? "Live WhatsApp groups" : "Parsed inventory"}
                                </span>
                              </div>
                            )}
                            {listingParts.map((p: any, i: number) => {
                              const items: GroupMirrorItem[] = p.data?.items || [];
                              if (items.length === 0) return null;
                              return (
                                <div key={`cards-${i}`} className="flex flex-col gap-2.5">
                                  {items.map((item, j) => (
                                    assistantMode === "groups"
                                      ? <GroupMirrorCard key={item.fingerprint || j} item={item} />
                                      : <ListingCard key={item.fingerprint || j} item={item} />
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
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder={searchSource === "groups" ? "Ask about WhatsApp groups..." : "Ask a question about your market data..."}
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
