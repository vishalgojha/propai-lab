"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, FileUp, RefreshCw, Send, Users } from "lucide-react";
import * as api from "@/lib/api";

type Group = {
  conversation_jid?: string;
  conversation_name?: string;
  conversation_type?: string;
  display_name?: string;
  name?: string;
  message_count?: number;
  last_message_at?: string;
  metadata?: { participants?: number };
};

function messageText(message: api.RawMessage) {
  if (message.message?.trim()) return message.message.trim();
  if (typeof message.raw_payload !== "string") return "";
  try {
    const payload = JSON.parse(message.raw_payload);
    const body = payload?.data?.message || payload?.message || payload;
    return body?.conversation || body?.extendedTextMessage?.text || body?.imageMessage?.caption || body?.videoMessage?.caption || "";
  } catch {
    return "";
  }
}

function isFromCurrentPhone(message: api.RawMessage) {
  if (typeof message.raw_payload !== "string") return false;
  try {
    const payload = JSON.parse(message.raw_payload);
    return Boolean(payload?.data?.fromMe ?? payload?.fromMe ?? payload?.key?.fromMe);
  } catch {
    return false;
  }
}

function timeLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function dateLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export default function WhatsAppGroupsMirror() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedJid, setSelectedJid] = useState("");
  const [messages, setMessages] = useState<api.RawMessage[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showConversation, setShowConversation] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const directory = await api.getWhatsAppConversations("group");
      const liveGroups = directory
        .filter((group) => group?.conversation_type === "group" && String(group?.conversation_jid || "").endsWith("@g.us"))
        .sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
      setGroups(liveGroups);
      setSelectedJid((current) => current && liveGroups.some((group) => group.conversation_jid === current)
        ? current
        : String(liveGroups[0]?.conversation_jid || ""));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your WhatsApp groups.");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshLiveGroups = async () => {
    setError("");
    setNotice("Refreshing your live WhatsApp group directory…");
    try {
      await api.refreshWhatsAppGroupDirectory();
      window.setTimeout(() => void loadGroups(), 2_500);
      window.setTimeout(() => void loadGroups(), 7_500);
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "Could not refresh the live WhatsApp group directory.");
    }
  };

  const loadMessages = useCallback(async () => {
    if (!selectedJid) {
      setMessages([]);
      return;
    }
    setLoadingMessages(true);
    try {
      const rows = await api.getChatMessages(selectedJid, 300);
      setMessages([...rows].sort((a, b) => String(a.timestamp || a.created_at || "").localeCompare(String(b.timestamp || b.created_at || ""))));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load this group’s messages.");
    } finally {
      setLoadingMessages(false);
    }
  }, [selectedJid]);

  useEffect(() => { void loadGroups(); }, [loadGroups]);
  useEffect(() => { void loadMessages(); }, [loadMessages]);
  useEffect(() => {
    const id = window.setInterval(() => { void loadGroups(); void loadMessages(); }, 30_000);
    return () => window.clearInterval(id);
  }, [loadGroups, loadMessages]);

  const selected = groups.find((group) => group.conversation_jid === selectedJid);
  const visibleGroups = useMemo(() => groups.filter((group) => {
    const name = String(group.display_name || group.conversation_name || group.name || "").toLowerCase();
    return name.includes(query.trim().toLowerCase());
  }), [groups, query]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedJid || (!draft.trim() && !file) || sending) return;
    setSending(true);
    setError("");
    setNotice("");
    try {
      if (file) {
        const mediaType = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "document";
        await api.sendMediaMessage({ remote_jid: selectedJid, media_type: mediaType, caption: draft.trim(), file, file_name: file.name, mime_type: file.type });
      } else {
        await api.sendMessage({ remote_jid: selectedJid, text: draft.trim() });
      }
      setDraft("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setNotice("Sent to WhatsApp.");
      window.setTimeout(() => void loadMessages(), 800);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "WhatsApp could not send this message.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[520px] overflow-hidden rounded-2xl border border-white/10 bg-[#0b141a]">
      <aside className={`${showConversation ? "hidden md:flex" : "flex"} w-full max-w-sm shrink-0 flex-col border-r border-white/10 bg-[#111b21] md:w-80`}>
        <div className="border-b border-white/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <div><h1 className="text-base font-semibold text-white">WhatsApp Groups</h1><p className="mt-0.5 text-xs text-zinc-400">Live group mirror</p></div>
            <button onClick={() => void refreshLiveGroups()} className="rounded-lg p-2 text-zinc-300 hover:bg-white/10" title="Refresh live groups"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search groups" className="mt-3 h-9 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-emerald-400" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? <p className="p-4 text-sm text-zinc-400">Loading your joined groups…</p> : visibleGroups.length === 0 ? <p className="p-4 text-sm text-zinc-400">No joined WhatsApp groups yet.</p> : visibleGroups.map((group) => {
            const jid = String(group.conversation_jid || "");
            const name = String(group.display_name || group.conversation_name || group.name || "WhatsApp Group");
            return <button key={jid} onClick={() => { setSelectedJid(jid); setShowConversation(true); }} className={`w-full border-b border-white/[0.06] px-4 py-3 text-left hover:bg-white/[0.05] ${selectedJid === jid ? "bg-white/[0.08]" : ""}`}>
              <div className="flex items-center gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300"><Users className="h-5 w-5" /></div><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-white">{name}</div><div className="mt-1 text-xs text-zinc-500">{Number(group.metadata?.participants || 0) ? `${group.metadata?.participants} participants` : `${group.message_count || 0} messages`}</div></div><span className="text-[10px] text-zinc-500">{dateLabel(group.last_message_at)}</span></div>
            </button>;
          })}
        </div>
      </aside>
      <main className={`${showConversation ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {selected ? <><header className="flex items-center gap-3 border-b border-white/10 bg-[#202c33] px-5 py-3"><button onClick={() => setShowConversation(false)} className="rounded-lg p-1 text-zinc-300 hover:bg-white/10 md:hidden" aria-label="Back to groups"><ChevronLeft className="h-5 w-5" /></button><div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300"><Users className="h-5 w-5" /></div><div className="min-w-0"><div className="truncate font-semibold text-white">{selected.display_name || selected.conversation_name || selected.name}</div><div className="text-xs text-zinc-400">WhatsApp group</div></div></header><div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-[#0b141a] p-5">{loadingMessages ? <p className="text-sm text-zinc-400">Loading messages…</p> : messages.length === 0 ? <p className="text-sm text-zinc-400">No captured messages in this group yet.</p> : messages.map((message) => { const fromMe = isFromCurrentPhone(message); return <div key={message.id} className={`flex ${fromMe ? "justify-end" : "justify-start"}`}><div className={`max-w-[78%] rounded-lg px-3 py-2 text-sm text-zinc-100 ${fromMe ? "bg-[#005c4b]" : "bg-[#202c33]"}`}><div className="mb-1 text-xs font-semibold text-emerald-300">{fromMe ? "You" : message.sender || "WhatsApp member"}</div><div className="whitespace-pre-wrap break-words">{messageText(message) || "Media message"}</div><div className="mt-1 text-right text-[10px] text-zinc-400">{timeLabel(message.timestamp || message.created_at)}</div></div></div>; })}</div><form onSubmit={send} className="border-t border-white/10 bg-[#202c33] p-3"><div className="flex items-center gap-2"><input ref={fileInput} type="file" className="hidden" onChange={(event) => setFile(event.target.files?.[0] || null)} /><button type="button" onClick={() => fileInput.current?.click()} className="rounded-lg p-2 text-zinc-300 hover:bg-white/10" title="Attach media"><FileUp className="h-5 w-5" /></button><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={file ? `Attach: ${file.name}` : "Message"} className="h-10 min-w-0 flex-1 rounded-lg bg-[#2a3942] px-3 text-sm text-white outline-none focus:ring-1 focus:ring-emerald-400" /><button disabled={sending || (!draft.trim() && !file)} className="rounded-lg bg-emerald-400 p-2.5 text-black disabled:opacity-40" aria-label="Send">{sending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button></div>{file && <p className="mt-1 text-xs text-zinc-400">{file.name}</p>}{error && <p className="mt-2 text-xs text-red-300">{error}</p>}{notice && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}</form></> : <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">Select a WhatsApp group.</div>}
      </main>
    </div>
  );
}
