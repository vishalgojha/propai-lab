"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, FileUp, Image as ImageIcon, MessageSquare, Music2, RefreshCw, Send, Sticker, Video, FileText, MapPin, Contact } from "lucide-react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";

type Group = {
  conversation_jid?: string;
  conversation_name?: string;
  conversation_type?: string;
  broker_id?: string;
  display_name?: string;
  name?: string;
  message_count?: number;
  last_message_at?: string;
  metadata?: { participants?: number };
  search_match?: boolean;
};

type GroupMember = { name?: string; phone?: string; jid?: string };
type MessageAttachment = {
  kind: string;
  mimeType: string;
  fileName: string;
  fileLength?: number;
  storagePath: string;
  captureError: string;
  deferred: boolean;
};
const MESSAGE_PAGE_SIZE = 300;

function messageText(message: api.RawMessage) {
  if (message.message?.trim()) return message.message.trim();
  try {
    const payload = typeof message.raw_payload === "string"
      ? JSON.parse(message.raw_payload)
      : message.raw_payload || {};
    const candidates = [
      payload?.data?.message,
      payload?.message,
      payload?.data,
      payload,
    ];
    for (const body of candidates) {
      const text = body?.conversation
        || body?.extendedTextMessage?.text
        || body?.imageMessage?.caption
        || body?.videoMessage?.caption
        || body?.documentMessage?.caption;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
    return "";
  } catch {
    return "";
  }
}

function displayMessageText(message: api.RawMessage) {
  const text = messageText(message);
  if (!text) return "";
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\t+/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \f\v]{2,}/g, " ").trimEnd())
    .join("\n")
    .trim();
}

function attachmentFromMessage(message: api.RawMessage): MessageAttachment | null {
  try {
    const payload = typeof message.raw_payload === "string" ? JSON.parse(message.raw_payload) : message.raw_payload;
    const data = payload?.data || payload || {};
    const attachments = Array.isArray(data.attachments) ? data.attachments[0] || {} : data.attachments || {};
    const media = data.media || {};
    const kind =
      (data.message_type as string | undefined) ||
      (media.kind as string | undefined) ||
      (attachments.image ? "image" : attachments.video ? "video" : attachments.audio ? "audio" : attachments.document ? "document" : attachments.sticker ? "sticker" : "") ||
      (data.message?.imageMessage ? "image" : data.message?.videoMessage ? "video" : data.message?.audioMessage ? "audio" : data.message?.documentMessage ? "document" : data.message?.stickerMessage ? "sticker" : "");
    if (!kind || kind === "text" || kind === "unknown") return null;
    return {
      kind,
      mimeType: String(attachments.mime_type || media.mime_type || data.message?.imageMessage?.mimetype || data.message?.videoMessage?.mimetype || data.message?.audioMessage?.mimetype || data.message?.documentMessage?.mimetype || ""),
      fileName: String(attachments.file_name || media.file_name || data.message?.documentMessage?.fileName || ""),
      fileLength: typeof attachments.file_length === "number" ? attachments.file_length : typeof media.file_length === "number" ? media.file_length : undefined,
      storagePath: String(attachments.storage_path || media.storage_path || ""),
      captureError: String(attachments.capture_error || media.error || ""),
      deferred: Boolean(media.deferred),
    };
  } catch {
    return null;
  }
}

function kindIcon(kind: string) {
  switch (kind) {
    case "image":
      return <ImageIcon className="h-4 w-4" />;
    case "video":
      return <Video className="h-4 w-4" />;
    case "audio":
      return <Music2 className="h-4 w-4" />;
    case "document":
      return <FileText className="h-4 w-4" />;
    case "sticker":
      return <Sticker className="h-4 w-4" />;
    case "location":
    case "live_location":
      return <MapPin className="h-4 w-4" />;
    case "contact":
    case "contacts_array":
      return <Contact className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
}

function kindLabel(kind: string) {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "document":
      return "Document";
    case "sticker":
      return "Sticker";
    case "location":
      return "Location";
    case "live_location":
      return "Live location";
    case "contact":
      return "Contact card";
    case "contacts_array":
      return "Contact array";
    default:
      return kind || "Media";
  }
}

function formatBytes(value?: number) {
  if (!value || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
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

function identityKeys(value: unknown) {
  const text = String(value || "").trim();
  const digits = text.split("@")[0].replace(/\D/g, "");
  return [text.toLowerCase(), digits].filter(Boolean);
}

function explicitSenderName(message: api.RawMessage) {
  try {
    const payload = typeof message.raw_payload === "string" ? JSON.parse(message.raw_payload) : {};
    const data = payload?.data || payload || {};
    const sender = data.sender || {};
    const name = sender.name || data.pushName || payload.pushName;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    // Older history rows can have malformed or incomplete raw payloads.
  }
  if (message.sender?.trim() && !/^\+?[\d\s()-]+$/.test(message.sender.trim())) return message.sender.trim();
  return "";
}

function senderLabel(message: api.RawMessage, memberNames: Record<string, string>) {
  const explicitName = explicitSenderName(message);
  if (explicitName) return explicitName;
  for (const key of [message.sender_jid, message.sender_phone, message.sender].flatMap(identityKeys)) {
    if (memberNames[key]) return memberNames[key];
  }
  // LIDs are WhatsApp-internal IDs, not a useful person identity. Do not
  // present one as if it were a contact number when WhatsApp did not provide
  // a display/push name.
  const identities = [message.sender_jid, message.sender_phone, message.sender].map((value) => String(value || ""));
  if (identities.some((value) => value.includes("@lid"))) return "Unnamed WhatsApp member";
  const digits = String(message.sender_phone || "").split("@")[0].replace(/\D/g, "");
  return digits ? `+${digits}` : "Unnamed WhatsApp member";
}

function senderSearchValue(message: api.RawMessage, memberNames: Record<string, string>, messageNames: Record<string, string>) {
  const explicitName = explicitSenderName(message);
  if (explicitName) return explicitName;
  for (const key of [message.sender_jid, message.sender_phone, message.sender].flatMap(identityKeys)) {
    if (memberNames[key]) return memberNames[key];
    if (messageNames[key]) return messageNames[key];
  }
  const digits = String(message.sender_phone || message.sender_jid || message.sender || "").split("@")[0].replace(/\D/g, "");
  return digits.length >= 10 ? `+${digits.slice(-10)}` : "";
}

function messageDateTimeLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function dateTimeLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return `${new Intl.DateTimeFormat("en-IN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(date)} IST`;
}

function messagePhone(message: api.RawMessage) {
  for (const value of [message.sender_phone, message.sender_jid]) {
    const raw = String(value || "").split("@")[0].replace(/\D/g, "");
    const local = raw.startsWith("91") && raw.length >= 12 ? raw.slice(-10) : raw;
    if (/^[6-9]\d{9}$/.test(local)) return `91${local}`;
  }
  return "";
}

function whatsappRecallLink(message: api.RawMessage, text: string) {
  const phone = messagePhone(message);
  if (!phone) return "";
  const cleanText = text.trim();
  if (!cleanText) return "";
  const prefilled = `Hi, I found this on PropAI Live:\n\n${cleanText}\n\nIs this still available?`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(prefilled)}`;
}

export default function WhatsAppGroupsMirror() {
  const router = useRouter();
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedJid, setSelectedJid] = useState("");
  const [messages, setMessages] = useState<api.RawMessage[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingGroups, setRefreshingGroups] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [messageNames, setMessageNames] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showConversation, setShowConversation] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const hasLoadedGroups = useRef(false);

  const loadGroups = useCallback(async (manual = false, searchTerm = "") => {
    if (!hasLoadedGroups.current) setLoading(true);
    if (manual) setRefreshingGroups(true);
    try {
      const directory = await api.getWhatsAppConversations("group", searchTerm, true);
      const liveGroups = directory
        .map((group) => ({
          ...group,
          conversation_type: group?.conversation_type || group?.type,
          conversation_jid: group?.conversation_jid || group?.jid || group?.id,
          display_name: group?.display_name || group?.conversation_name || group?.name,
        }))
        .filter((group) => group?.conversation_type === "group" && String(group?.conversation_jid || "").endsWith("@g.us"))
        .sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
      setGroups(liveGroups);
      setSelectedJid((current) => current && liveGroups.some((group) => group.conversation_jid === current)
        ? current
        : String(liveGroups[0]?.conversation_jid || ""));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your WhatsApp groups.");
    } finally {
      hasLoadedGroups.current = true;
      setLoading(false);
      setRefreshingGroups(false);
    }
  }, []);

  const refreshLiveGroups = async () => {
    setError("");
    setNotice("Refreshing your live WhatsApp group directory…");
    try {
      await api.refreshWhatsAppGroupDirectory();
      window.setTimeout(() => void loadGroups(true), 2_500);
      window.setTimeout(() => void loadGroups(true), 7_500);
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "Could not refresh the live WhatsApp group directory.");
    }
  };

  const loadMessages = useCallback(async (offset = 0, append = false) => {
    if (!selectedJid) {
      setMessages([]);
      return;
    }
    if (append) setLoadingOlder(true);
    else setLoadingMessages(true);
    try {
      const rows = await api.getChatMessages(selectedJid, MESSAGE_PAGE_SIZE, offset);
      setHasMoreHistory(rows.length >= MESSAGE_PAGE_SIZE);
      setMessageNames((current) => {
        const names = { ...current };
        for (const row of rows) {
          const name = explicitSenderName(row);
          if (!name) continue;
          for (const key of [row.sender_jid, row.sender_phone, row.sender].flatMap(identityKeys)) names[key] = name;
        }
        return names;
      });
      setMessages((current) => {
        const byKey = new Map<string, api.RawMessage>();
        for (const row of [...current, ...rows]) byKey.set(row.message_uid || String(row.id), row);
        return [...byKey.values()].sort((a, b) => String(a.timestamp || a.created_at || "").localeCompare(String(b.timestamp || b.created_at || "")));
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load this group’s messages.");
    } finally {
      setLoadingMessages(false);
      setLoadingOlder(false);
    }
  }, [selectedJid]);

  const loadMembers = useCallback(async () => {
    if (!selectedJid) {
      setMemberNames({});
      return;
    }
    try {
      const members = await api.getGroupMembers(selectedJid) as GroupMember[];
      const names: Record<string, string> = {};
      for (const member of members) {
        const name = String(member.name || "").trim();
        if (!name || name === "Unknown") continue;
        for (const key of [member.jid, member.phone].flatMap(identityKeys)) names[key] = name;
      }
      setMemberNames(names);
    } catch {
      setMemberNames({});
    }
  }, [selectedJid]);

  useEffect(() => { void loadGroups(); }, [loadGroups]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadGroups(false, query), 300);
    return () => window.clearTimeout(timer);
  }, [loadGroups, query]);
  useEffect(() => {
    setMessages([]);
    setHasMoreHistory(true);
    setMessageNames({});
    void loadMessages();
    void loadMembers();
  }, [loadMessages, loadMembers]);
  useEffect(() => {
    const id = window.setInterval(() => { void loadGroups(false, query); void loadMessages(); }, 30_000);
    return () => window.clearInterval(id);
  }, [loadGroups, loadMessages, query]);

  const selected = groups.find((group) => group.conversation_jid === selectedJid);
  const normalizedGroupQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = useMemo(() => groups.filter((group) => {
    const normalizedQuery = normalizedGroupQuery;
    if (!normalizedQuery) return true;
    if (group.search_match) return true;
    const searchable = [
      group.display_name,
      group.conversation_name,
      group.name,
      group.conversation_jid,
    ].map((value) => String(value || "").toLocaleLowerCase());
    return searchable.some((value) => value.includes(normalizedQuery));
  }), [groups, normalizedGroupQuery]);

  const messageViews = useMemo(() => messages.map((message) => ({
    message,
    attachment: attachmentFromMessage(message),
    text: displayMessageText(message),
  })).filter(({ text }) => Boolean(text)), [messages]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedJid || (!draft.trim() && !file) || sending) return;
    setSending(true);
    setError("");
    setNotice("");
    try {
      let sendResult: any = null;
      if (file) {
        const mediaType = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "document";
        sendResult = await api.sendMediaMessage({ remote_jid: selectedJid, media_type: mediaType, caption: draft.trim(), file, file_name: file.name, mime_type: file.type, broker_id: selected?.broker_id });
      } else {
        sendResult = await api.sendMessage({ remote_jid: selectedJid, text: draft.trim(), broker_id: selected?.broker_id });
      }
      const nowIso = new Date().toISOString();
      const messageUid = String(sendResult?.message_id || `local-${Date.now()}`);
      setMessages((current) => {
        const optimistic: api.RawMessage = {
          id: -Date.now(),
          chat_id: selectedJid,
          chat_type: "group",
          chat_name: selected?.display_name || selected?.conversation_name || selected?.name || "",
          conversation_type: "group",
          conversation_key: selectedJid,
          conversation_name: selected?.display_name || selected?.conversation_name || selected?.name || "",
          group_name: selected?.display_name || selected?.conversation_name || selected?.name || selectedJid,
          sender: "You",
          sender_jid: selectedJid,
          sender_phone: "",
          broker_name: "",
          broker_phone: "",
          building_name: "",
          micro_market: "",
          landmark_name: "",
          parsed_intent: "",
          message_count: 0,
          latest_message_at: nowIso,
          duplicate_count: 1,
          duplicate_group_names: [],
          message: draft.trim() || (file ? `Attachment: ${file.name}` : ""),
          message_type: file ? file.type.split("/")[0] || "document" : "text",
          timestamp: sendResult?.timestamp || nowIso,
          created_at: nowIso,
          source: "WHATSAPP_OUTBOUND",
          event_id: messageUid,
          message_uid: messageUid,
          raw_payload: JSON.stringify({
            local: true,
            fromMe: true,
            message: {
              conversation: draft.trim() || (file ? `Attachment: ${file.name}` : ""),
            },
          }),
          synced_at: nowIso,
          pipeline_version: "propai-web-send",
          from_me: true,
          delivery_status: "sent",
          delivery_updated_at: nowIso,
        };
        return [...current.filter((item) => (item.message_uid || String(item.id)) !== messageUid), optimistic];
      });
      setDraft("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setNotice("Sent to WhatsApp.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "WhatsApp could not send this message.");
    } finally {
      setSending(false);
    }
  };

  const openSenderSearch = (message: api.RawMessage) => {
    if (isFromCurrentPhone(message)) return;
    const queryValue = senderSearchValue(message, memberNames, messageNames);
    if (!queryValue) return;
    router.push(`/brokers?q=${encodeURIComponent(queryValue)}`);
  };

  return (
    <div className="flex h-[calc(100dvh-44px)] min-h-[540px] w-full overflow-hidden rounded-xl border border-white/10 bg-black">
      <aside className={`${showConversation ? "hidden md:flex" : "flex"} w-full max-w-sm shrink-0 flex-col border-r border-white/10 bg-black md:w-80`}>
        <div className="border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-sm font-bold uppercase tracking-wider text-white">WhatsApp Groups</h1>
              <p className="mt-1 text-xs text-zinc-500">All joined groups · {groups.length} groups</p>
            </div>
            <button onClick={() => void refreshLiveGroups()} className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-zinc-300 transition-colors hover:bg-white/5 hover:text-white" title="Refresh live groups"><RefreshCw className={`h-4 w-4 ${refreshingGroups ? "animate-spin" : ""}`} /></button>
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search groups" className="mt-3 h-9 w-full rounded-lg border border-white/10 bg-transparent px-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-400" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? <p className="p-4 text-sm text-zinc-500">Loading your joined groups…</p> : visibleGroups.length === 0 ? <p className="p-4 text-sm text-zinc-500">{query.trim() ? "No groups match your search." : "No joined WhatsApp groups yet."}</p> : visibleGroups.map((group) => {
            const jid = String(group.conversation_jid || "");
            const name = String(group.display_name || group.conversation_name || group.name || "WhatsApp Group");
            return <button key={jid} onClick={() => { setSelectedJid(jid); setShowConversation(true); }} className={`w-full border-b border-white/[0.06] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] ${selectedJid === jid ? "border-l-2 border-l-emerald-400 bg-white/[0.04] pl-[14px]" : ""}`}>
            <div className="flex items-center gap-3"><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-white">{name}</div><div className="mt-1 text-xs text-zinc-400">{Number(group.metadata?.participants || 0) ? `${group.metadata?.participants} participants` : `${group.message_count || 0} messages`}</div></div><span className="text-[10px] text-zinc-300">{dateTimeLabel(group.last_message_at)}</span></div>
            </button>;
          })}
        </div>
      </aside>
      <main className={`${showConversation ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {selected ? (
          <>
            <header className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
              <button onClick={() => setShowConversation(false)} className="rounded-lg p-1 text-zinc-300 hover:bg-white/10 md:hidden" aria-label="Back to groups">
                <ChevronLeft className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white">{selected.display_name || selected.conversation_name || selected.name}</div>
                <div className="mt-0.5 text-xs text-zinc-400">WhatsApp group · messages shown in IST</div>
              </div>
            </header>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5 md:px-5">
              {hasMoreHistory && messages.length > 0 && (
                <button type="button" onClick={() => void loadMessages(messages.length, true)} disabled={loadingOlder} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/5 disabled:opacity-50">
                  {loadingOlder ? "Loading older messages…" : "Load older messages"}
                </button>
              )}
              {loadingMessages && messages.length === 0 ? <p className="text-sm text-zinc-500">Loading messages…</p> : messageViews.length === 0 ? <p className="text-sm text-zinc-500">No text posts captured in this group yet.</p> : messageViews.map(({ message, attachment, text }) => {
                const fromMe = isFromCurrentPhone(message);
                const sender = fromMe ? "You" : senderLabel(message, { ...memberNames, ...messageNames });
                const senderClickable = !fromMe && Boolean(senderSearchValue(message, memberNames, messageNames));
                const kind = attachment?.kind || message.message_type || "text";
                const body = text;
                const recallLink = whatsappRecallLink(message, text);
                return <div key={message.message_uid || message.id} className={`flex ${fromMe ? "justify-end" : "justify-start"}`}>
                  <div className={`w-full max-w-[min(900px,86%)] rounded-2xl border border-l-4 px-4 py-3 text-sm shadow-sm ${fromMe ? "border-emerald-400/30 bg-emerald-400/[0.08] text-zinc-100" : "border-white/10 bg-white/[0.03] text-zinc-100"}`}>
                    <div className="mb-2 flex items-center gap-2">
                      <button type="button" onClick={() => senderClickable ? openSenderSearch(message) : undefined} disabled={!senderClickable} className={`min-w-0 truncate text-left text-xs font-semibold ${fromMe ? "text-emerald-300" : "text-zinc-200"} ${senderClickable ? "hover:text-emerald-200 hover:underline" : "cursor-default"}`}>{sender}</button>
                      {attachment && <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] text-zinc-300">{kindIcon(kind)}{kindLabel(kind)}</span>}
                      {recallLink && <a href={recallLink} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-400/20" title="Open WhatsApp with this post prefilled"><MessageSquare className="h-3 w-3" />WhatsApp</a>}
                    </div>
                    <div className="whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]">{body}</div>
                    <div className="mt-2 flex justify-end text-[10px] text-zinc-400">{messageDateTimeLabel(message.timestamp || message.created_at)}</div>
                  </div>
                </div>;
              })}
            </div>
            <form onSubmit={send} className="border-t border-white/10 p-3">
              <div className="flex items-center gap-2">
                <input ref={fileInput} type="file" className="hidden" onChange={(event) => setFile(event.target.files?.[0] || null)} />
                <button type="button" onClick={() => fileInput.current?.click()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5" title="Attach media"><FileUp className="h-4 w-4" /></button>
                <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={file ? `Attach: ${file.name}` : "Message this group"} className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-transparent px-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-400" />
                <button disabled={sending || (!draft.trim() && !file)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white bg-white text-black disabled:opacity-40" aria-label="Send"><Send className="h-4 w-4" /></button>
              </div>
              {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
              {notice && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}
            </form>
          </>
        ) : <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Select a WhatsApp group.</div>}
      </main>
    </div>
  );
}
