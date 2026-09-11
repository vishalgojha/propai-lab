"use client";

import { useEffect, useMemo, useState } from "react";
import { MessageCircle, RefreshCw, Search, Users, X } from "lucide-react";
import { getChatMessages, getChats, type InboxThread, type RawMessage } from "@/lib/api";

function displayName(thread: InboxThread) {
  return thread.conversation_name || thread.chat_name || thread.group_name || thread.sender || "Unnamed chat";
}

function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function dayLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export default function WhatsAppChatsPage() {
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [active, setActive] = useState<InboxThread | null>(null);
  const [messages, setMessages] = useState<RawMessage[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [messageLoading, setMessageLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadThreads() {
    setLoading(true);
    setError("");
    try {
      const rows = await getChats(500, 0);
      setThreads(rows);
      setActive((current) => current && rows.some((row) => (row.conversation_key || row.chat_id) === (current.conversation_key || current.chat_id)) ? current : rows[0] || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load WhatsApp chats");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadThreads(); }, []);

  useEffect(() => {
    if (!active) { setMessages([]); return; }
    const id = active.conversation_key || active.chat_id || "";
    setMessageLoading(true);
    void getChatMessages(id, 300, 0)
      .then((rows) => setMessages([...rows].reverse()))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load this conversation"))
      .finally(() => setMessageLoading(false));
  }, [active]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) => [displayName(thread), thread.sender, thread.group_name, thread.message].join(" ").toLowerCase().includes(needle));
  }, [query, threads]);

  return (
    <main className="flex h-[calc(100dvh-44px)] min-h-[620px] flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4 lg:px-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">WhatsApp Chats</h1>
          <p className="mt-1 text-xs text-text-muted">Captured conversations for this workspace</p>
        </div>
        <button type="button" onClick={() => void loadThreads()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-secondary transition hover:bg-surface-hover disabled:opacity-50" aria-label="Refresh WhatsApp chats">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className={`flex min-h-0 w-full flex-col border-b border-border lg:w-[22rem] lg:border-b-0 lg:border-r ${active ? "hidden lg:flex" : "flex"}`} aria-label="WhatsApp chat list">
          <div className="border-b border-border p-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-8 text-sm text-text-primary placeholder:text-text-muted" />
              {query && <button type="button" onClick={() => setQuery("")} className="absolute right-2 top-2 rounded p-0.5 text-text-muted hover:text-text-primary" aria-label="Clear chat search"><X className="h-4 w-4" /></button>}
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && <p className="px-4 py-8 text-center text-xs text-text-muted">Loading workspace chats…</p>}
            {!loading && error && <div className="m-3 rounded-lg border border-red-300/30 bg-red-50/60 p-3 text-xs text-red-800"><p>{error}</p><button type="button" onClick={() => void loadThreads()} className="mt-2 font-semibold underline">Try again</button></div>}
            {!loading && !error && filtered.length === 0 && <div className="px-5 py-12 text-center"><MessageCircle className="mx-auto h-7 w-7 text-text-muted" /><p className="mt-3 text-sm font-medium text-text-secondary">No WhatsApp chats found</p><p className="mt-1 text-xs text-text-muted">Only conversations captured in this workspace appear here.</p></div>}
            {filtered.map((thread) => {
              const key = thread.conversation_key || thread.chat_id || String(thread.id);
              const selected = (active?.conversation_key || active?.chat_id) === key;
              return <button type="button" key={key} onClick={() => setActive(thread)} className={`flex w-full gap-3 border-b border-border px-4 py-3 text-left transition hover:bg-surface-hover ${selected ? "bg-[var(--sidebar-accent)]" : ""}`}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--info-bg)] text-[var(--info-foreground)]"><Users className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1"><span className="flex items-baseline justify-between gap-2"><span className="truncate text-sm font-semibold text-text-primary">{displayName(thread)}</span><span className="shrink-0 text-[10px] text-text-muted">{formatTime(thread.latest_message_at || thread.timestamp)}</span></span><span className="mt-1 block truncate text-xs text-text-secondary">{thread.message || "No preview available"}</span><span className="mt-1 block text-[10px] uppercase tracking-[.12em] text-text-muted">{thread.conversation_type === "group" ? "Group" : "Direct"} · {thread.message_count} messages</span></span>
              </button>;
            })}
          </div>
        </section>

        <section className={`min-h-0 flex-1 flex-col ${active ? "flex" : "hidden lg:flex"}`} aria-label="WhatsApp conversation">
          {!active ? <div className="m-auto max-w-sm px-6 text-center"><MessageCircle className="mx-auto h-10 w-10 text-text-muted" /><h2 className="mt-4 text-lg font-semibold text-text-primary">Choose a conversation</h2><p className="mt-2 text-sm text-text-secondary">Review the original WhatsApp messages without leaving the workspace.</p></div> : <>
            <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3 lg:px-6"><button type="button" onClick={() => setActive(null)} className="rounded-md p-1 text-text-muted hover:bg-surface-hover lg:hidden" aria-label="Back to chat list">←</button><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--info-bg)] text-[var(--info-foreground)]"><Users className="h-4 w-4" /></span><div className="min-w-0"><h2 className="truncate text-sm font-semibold text-text-primary">{displayName(active)}</h2><p className="text-xs text-text-muted">{active.conversation_type === "group" ? "WhatsApp group" : "Direct conversation"} · {active.message_count} captured messages</p></div></header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">{messageLoading && <p className="text-center text-xs text-text-muted">Loading messages…</p>}{!messageLoading && messages.length === 0 && <p className="text-center text-xs text-text-muted">No message history is available for this conversation.</p>}{!messageLoading && messages.map((message, index) => <article key={`${message.id}-${index}`} className="mx-auto mb-4 max-w-3xl"><div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[.1em] text-text-muted"><span>{message.sender || (message.from_me ? "You" : "WhatsApp contact")}</span><span>·</span><time dateTime={message.timestamp}>{dayLabel(message.timestamp)} · {new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.timestamp))}</time></div><div className="rounded-xl border border-border bg-card px-4 py-3 text-sm leading-6 text-card-foreground shadow-sm whitespace-pre-wrap">{message.message || "[Media or unsupported message]"}</div></article>)}</div>
          </>}
        </section>
      </div>
    </main>
  );
}
