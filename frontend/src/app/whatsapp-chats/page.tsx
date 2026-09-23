"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageCircle, RefreshCw, Search, UserRound, X } from "lucide-react";
import { getChatMessages, getChats, getPhones, type InboxThread, type RawMessage } from "@/lib/api";

function digits(value?: string) {
  return (value || "").replace(/\D/g, "").slice(-10);
}

function chatKey(thread: InboxThread) {
  return thread.conversation_key || thread.chat_id || "";
}

function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatMessageTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function WhatsAppSelfChatPage() {
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [active, setActive] = useState<InboxThread | null>(null);
  const [messages, setMessages] = useState<RawMessage[]>([]);
  const [chatVariants, setChatVariants] = useState<Record<string, string[]>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [messageLoading, setMessageLoading] = useState(false);
  const [error, setError] = useState("");

  const loadSelfChat = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [{ phones }, rows] = await Promise.all([getPhones(false), getChats(500, 0)]);
      const ownNumbers = new Set((phones || []).flatMap((phone) => [
        phone.phone_number,
        phone.phone_number_live,
        phone.registered_phone_number,
      ]).map(digits).filter(Boolean));
      const isOwnNumber = (value?: string) => ownNumbers.has(digits(value));
      const candidates = rows.filter((thread) => {
        if (thread.conversation_type !== "direct") return false;
        // An account's own number is the remote JID of its "Message yourself"
        // thread. Matching the sender instead pulls in every 1:1 conversation
        // the account ever sent a message in, because the account is the
        // sender of its own outgoing messages there.
        const chat = digits(chatKey(thread));
        if (isOwnNumber(chat)) return true;
        // Privacy-mode accounts key message-yourself by their own @lid
        // identity, where the chat id equals the sender id. Require the
        // sender to be the connected account so newsletters/bots (@bot,
        // @newsletter self-keyed jids) never leak in.
        const sender = digits(thread.sender_jid || thread.sender_phone);
        return chat && sender && chat === sender && isOwnNumber(sender);
      });
      const grouped = new Map<string, InboxThread>();
      const variants: Record<string, string[]> = {};
      for (const thread of candidates) {
        const ownerNumber = digits(chatKey(thread));
        const existing = grouped.get(ownerNumber);
        if (existing) existing.message_count += thread.message_count || 0;
        else grouped.set(ownerNumber, { ...thread });
        variants[ownerNumber] = Array.from(new Set([...(variants[ownerNumber] || []), chatKey(thread), thread.sender_phone || "", thread.sender_jid || ""].filter(Boolean)));
      }
      const mergedThreads = Array.from(grouped.values());
      // get_chats only scans the newest raw messages per tenant, so a quiet
      // message-yourself thread can fall out of its window on a busy account
      // even though the rows still exist. Rebuild the thread directly from
      // message history for any connected number not already present.
      const covered = new Set<string>();
      for (const thread of mergedThreads) covered.add(digits(chatKey(thread)));
      for (const phone of phones || []) {
        const raw = [phone.phone_number, phone.phone_number_live, phone.registered_phone_number]
          .find((value) => value && !/^Unpaired:/i.test(value)) || "";
        const num = raw.replace(/\D/g, "");
        if (!num || covered.has(num.slice(-10))) continue;
        const jid = `${num}@s.whatsapp.net`;
        const parts = await Promise.all([num, jid].map((key) => getChatMessages(key, 500, 0).catch(() => [])));
        const unique = new Map<number, RawMessage>();
        parts.flat().forEach((row, index) => unique.set(Number(row.id) || index, row));
        const history = [...unique.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        if (history.length === 0) continue;
        const latest = history[history.length - 1];
        mergedThreads.push({
          ...latest,
          conversation_type: "direct",
          conversation_key: jid,
          conversation_name: String(latest.conversation_name || ""),
          chat_id: jid,
          message_count: history.length,
          sender_jid: jid,
          sender_phone: raw,
        });
        covered.add(num.slice(-10));
        variants[num.slice(-10)] = [jid, raw, jid];
      }
      mergedThreads.sort((a, b) => new Date(b.latest_message_at || b.timestamp).getTime() - new Date(a.latest_message_at || a.timestamp).getTime());
      setChatVariants(variants);
      setThreads(mergedThreads);
      setActive((current) => current && mergedThreads.some((row) => chatKey(row) === chatKey(current)) ? current : mergedThreads[0] || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load WhatsApp self-chat history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSelfChat(); }, [loadSelfChat]);

  useEffect(() => {
    if (!active) { setMessages([]); return; }
    setMessageLoading(true);
    const ownerNumber = digits(chatKey(active));
    const keys = chatVariants[ownerNumber] || [chatKey(active), active.sender_phone || "", active.sender_jid || ""];
    void Promise.all(keys.map((key) => getChatMessages(key, 500, 0).catch(() => [])))
      .then((parts) => {
        const unique = new Map<number, RawMessage>();
        parts.flat().forEach((row, index) => unique.set(Number(row.id) || index, row));
        setMessages([...unique.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load self-chat messages"))
      .finally(() => setMessageLoading(false));
  }, [active, chatVariants]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? threads.filter((thread) => `${thread.message || ""} ${thread.conversation_name || ""}`.toLowerCase().includes(needle)) : threads;
  }, [query, threads]);

  return (
    <main className="flex h-[calc(100dvh-44px)] min-h-[620px] flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4 lg:px-8">
        <div><h1 className="text-xl font-semibold tracking-tight text-text-primary">WhatsApp Self Chat</h1><p className="mt-1 text-xs text-text-muted">Your message-yourself history from the connected WhatsApp account</p></div>
        <button type="button" onClick={() => void loadSelfChat()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-secondary transition hover:bg-surface-hover disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh</button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className={`flex min-h-0 w-full flex-col border-b border-border lg:w-[22rem] lg:border-b-0 lg:border-r ${active ? "hidden lg:flex" : "flex"}`} aria-label="WhatsApp self-chat history">
          <div className="border-b border-border p-3"><label className="relative block"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search self-chat history" className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-8 text-sm text-text-primary placeholder:text-text-muted" />{query && <button type="button" onClick={() => setQuery("")} className="absolute right-2 top-2 rounded p-0.5 text-text-muted" aria-label="Clear search"><X className="h-4 w-4" /></button>}</label></div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && <p className="px-4 py-8 text-center text-xs text-text-muted">Loading self-chat history…</p>}
            {!loading && error && <div className="m-3 rounded-lg border border-red-300/30 bg-red-50/60 p-3 text-xs text-red-800"><p>{error}</p><button type="button" onClick={() => void loadSelfChat()} className="mt-2 font-semibold underline">Try again</button></div>}
            {!loading && !error && filtered.length === 0 && <div className="px-5 py-12 text-center"><MessageCircle className="mx-auto h-8 w-8 text-text-muted" /><p className="mt-3 text-sm font-medium text-text-secondary">No WhatsApp self-chat found</p><p className="mt-1 text-xs text-text-muted">This page only shows messages sent to the connected account’s own number.</p></div>}
            {filtered.map((thread) => <button type="button" key={chatKey(thread)} onClick={() => setActive(thread)} className={`flex w-full gap-3 border-b border-border px-4 py-3 text-left transition hover:bg-surface-hover ${active && chatKey(active) === chatKey(thread) ? "bg-[var(--sidebar-accent)]" : ""}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--info-bg)] text-[var(--info-foreground)]"><UserRound className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="flex items-baseline justify-between gap-2"><span className="truncate text-sm font-semibold text-text-primary">Message yourself</span><span className="shrink-0 text-[10px] text-text-muted">{formatTime(thread.latest_message_at || thread.timestamp)}</span></span><span className="mt-1 block truncate text-xs text-text-secondary">{thread.message || "No preview available"}</span><span className="mt-1 block text-[10px] uppercase tracking-[.12em] text-text-muted">{thread.message_count} messages</span></span></button>)}
          </div>
        </section>
        <section className={`min-h-0 flex-1 flex-col ${active ? "flex" : "hidden lg:flex"}`} aria-label="WhatsApp self-chat messages">
          {!active ? <div className="m-auto max-w-sm px-6 text-center"><UserRound className="mx-auto h-10 w-10 text-text-muted" /><h2 className="mt-4 text-lg font-semibold text-text-primary">No self-chat selected</h2><p className="mt-2 text-sm text-text-secondary">Messages sent to your own WhatsApp number will appear here.</p></div> : <><header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3 lg:px-6"><button type="button" onClick={() => setActive(null)} className="rounded-md p-1 text-text-muted hover:bg-surface-hover lg:hidden" aria-label="Back to self-chat list">←</button><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--info-bg)] text-[var(--info-foreground)]"><UserRound className="h-4 w-4" /></span><div><h2 className="text-sm font-semibold text-text-primary">Message yourself</h2><p className="text-xs text-text-muted">{active.message_count} captured messages</p></div></header><div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">{messageLoading && <p className="text-center text-xs text-text-muted">Loading messages…</p>}{!messageLoading && messages.length === 0 && <p className="text-center text-xs text-text-muted">No message history is available.</p>}{!messageLoading && messages.map((message, index) => <article key={`${message.id}-${index}`} className="mx-auto mb-4 max-w-3xl"><div className="mb-1 text-[10px] uppercase tracking-[.1em] text-text-muted">{message.from_me ? "You" : "WhatsApp self chat"} · {formatMessageTime(message.timestamp)}</div><div className="rounded-xl border border-border bg-card px-4 py-3 text-sm leading-6 text-card-foreground shadow-sm whitespace-pre-wrap">{message.message || "[Media or unsupported message]"}</div></article>)}</div></>}
        </section>
      </div>
    </main>
  );
}
