"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Bot, Check, Clock3, Copy, LoaderCircle, Paperclip, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { AssistantUiOpsChat } from "@/components/admin/AssistantUiOpsChat";

type Message = { role: "user" | "assistant"; content: string };
type AgentAttachment = { file_name: string; mime_type: string; data_url: string; size: number };
type Session = { id: string; title: string; messages: Message[]; updatedAt: number };
type RemoteSession = { id: string; title: string; created_at: string; updated_at: string };
type RemoteMessage = { role: "user" | "assistant"; content: string };
type Status = { configured: boolean; reachable?: boolean; health_error?: string | null; api_url: string; model: string; approval_required: boolean; scope: string };

const SESSIONS_KEY = "propai.operations-agent.sessions.v1";
const LEGACY_HISTORY_KEY = "propai.operations-agent.history.v2";
const ACTIVE_SESSION_KEY = "propai.operations-agent.active-session.v1";

function validMessages(items: unknown): Message[] {
  if (!Array.isArray(items)) return [];
  const result: Message[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { role?: unknown; content?: unknown };
    if ((candidate.role !== "user" && candidate.role !== "assistant") || typeof candidate.content !== "string") continue;
    const content = candidate.content.trim();
    if (!content) continue;
    const previous = result[result.length - 1];
    if (previous?.role === candidate.role && previous.content === content) continue;
    result.push({ role: candidate.role, content });
  }
  return result.slice(-100);
}

// The transcript can stay long in the browser. Only the latest 12k chars are sent to the API.
function contextMessages(items: Message[]): Message[] {
  const result: Message[] = [];
  let budget = 12000;
  for (let index = items.length - 1; index >= 0 && budget > 0; index -= 1) {
    const item = items[index];
    const content = item.content.slice(0, Math.min(3000, budget));
    if (!content) continue;
    result.unshift({ role: item.role, content });
    budget -= content.length;
  }
  return result;
}

function newSession(): Session {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: "New session", messages: [], updatedAt: Date.now() };
}

function titleFor(messages: Message[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content.trim();
  if (!firstUserMessage) return "New session";
  return firstUserMessage.replace(/\s+/g, " ").slice(0, 56) + (firstUserMessage.length > 56 ? "…" : "");
}

function inlineMarkdown(value: string): React.ReactNode {
  const tokens = value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index} className="font-semibold text-[var(--text-primary)]">{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={index} className="rounded bg-[var(--surface-raised)] px-1 py-0.5 text-[12px] text-[var(--accent)]">{token.slice(1, -1)}</code>;
    }
    return <span key={index}>{token}</span>;
  });
}

function MarkdownMessage({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
      blocks.push(<Tag key={`heading-${index}`} className={`${level <= 2 ? "mt-4 text-sm" : "mt-3 text-[13px]"} font-semibold text-[var(--text-primary)] first:mt-0`}>{inlineMarkdown(heading[2])}</Tag>);
      index += 1;
      continue;
    }

    const listMatch = line.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`} className="my-2 list-disc space-y-1 pl-5">{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }

    const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(<ol key={`ordered-${index}`} className="my-2 list-decimal space-y-1 pl-5">{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+|^[-*]\s+|^\d+[.)]\s+/.test(lines[index].trim())) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`} className="my-2 whitespace-pre-wrap leading-6">{inlineMarkdown(paragraph.join(" "))}</p>);
  }

  return <div className="space-y-1">{blocks}</div>;
}

export default function OpsAdminPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [copiedMessage, setCopiedMessage] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);

  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);

  async function loadStatus() {
    setStatusLoading(true);
    try {
      setStatus(await fetchJSON<Status>("/admin/ops/status"));
      setError(null);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : "Could not check the operations agent");
    } finally {
      setStatusLoading(false);
    }
  }

  useEffect(() => { void loadStatus(); }, []);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      if (cancelled) return;
      try {
        const remote = await fetchJSON<RemoteSession[]>("/admin/ops/sessions");
        let restored: Session[] = remote.map((item) => ({
          id: item.id,
          title: item.title || "New session",
          messages: [],
          updatedAt: Date.parse(item.updated_at) || Date.now(),
        }));
        if (!restored.length) {
          const created = await fetchJSON<RemoteSession>("/admin/ops/sessions", {
            method: "POST",
            body: JSON.stringify({ title: "New session" }),
          });
          restored = [{ id: created.id, title: created.title || "New session", messages: [], updatedAt: Date.parse(created.updated_at) || Date.now() }];
        }
        const requestedSessionId = new URLSearchParams(window.location.search).get("session_id");
        const active = restored.find((session) => session.id === requestedSessionId) || restored[0];
        const remoteMessages = await fetchJSON<RemoteMessage[]>(`/admin/ops/sessions/${encodeURIComponent(active.id)}/messages`);
        active.messages = validMessages(remoteMessages);
        setSessions(restored);
        setActiveSessionId(active.id);
        setMessages(active.messages);
      } catch {
        // Keep the old browser cache as a migration/offline fallback. New
        // sessions are server-owned whenever the API is available.
        const saved = window.localStorage.getItem(SESSIONS_KEY);
        const parsed = saved ? JSON.parse(saved) : null;
        let restored: Session[] = Array.isArray(parsed)
          ? parsed.flatMap((item: unknown) => {
              if (!item || typeof item !== "object") return [];
              const candidate = item as Partial<Session>;
              const restoredMessages = validMessages(candidate.messages);
              if (typeof candidate.id !== "string") return [];
              return [{ id: candidate.id, title: titleFor(restoredMessages), messages: restoredMessages, updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now() }];
            })
          : [];

        // Migrate the previous single-transcript storage key once.
        if (!restored.length) {
          const legacy = window.localStorage.getItem(LEGACY_HISTORY_KEY);
          const legacyMessages = legacy ? validMessages(JSON.parse(legacy)) : [];
          if (legacyMessages.length) restored = [{ ...newSession(), title: titleFor(legacyMessages), messages: legacyMessages }];
        }

        const activeId = window.localStorage.getItem(ACTIVE_SESSION_KEY);
        const active = restored.find((session) => session.id === activeId) || restored[0] || newSession();
        if (!restored.some((session) => session.id === active.id)) restored = [active, ...restored];
        setSessions(restored.slice(0, 30));
        setActiveSessionId(active.id);
        setMessages(active.messages);
      } finally {
        setSessionsLoaded(true);
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!sessionsLoaded) return;
    try {
      window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 30)));
      if (activeSessionId) window.localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
    } catch {
      // Ignore unavailable or full browser storage.
    }
  }, [activeSessionId, sessions, sessionsLoaded]);

  function updateCurrentSession(nextMessages: Message[]) {
    if (!activeSessionId) return;
    const updatedAt = Date.now();
    setMessages(nextMessages);
    setSessions((current) => current.map((session) => session.id === activeSessionId
      ? { ...session, title: titleFor(nextMessages), messages: nextMessages, updatedAt }
      : session));
  }

  function startNewSession() {
    if (busy) return;
    const session = newSession();
    setSessions((current) => [session, ...current].slice(0, 30));
    void fetchJSON<RemoteSession>("/admin/ops/sessions", { method: "POST", body: JSON.stringify({ title: "New session" }) })
      .then((remote) => {
        setSessions((current) => current.map((item) => item.id === session.id ? { ...item, id: remote.id, updatedAt: Date.parse(remote.updated_at) || Date.now() } : item));
        setActiveSessionId(remote.id);
      })
      .catch(() => setActiveSessionId(session.id));
    setActiveSessionId(session.id);
    setMessages([]);
    setError(null);
    setView("chat");
  }

  function openSession(session: Session) {
    if (busy) return;
    setActiveSessionId(session.id);
    setMessages(session.messages);
    void fetchJSON<RemoteMessage[]>(`/admin/ops/sessions/${encodeURIComponent(session.id)}/messages`)
      .then((remote) => {
        const loaded = validMessages(remote);
        setMessages(loaded);
        setSessions((current) => current.map((item) => item.id === session.id ? { ...item, messages: loaded } : item));
      })
      .catch(() => undefined);
    setError(null);
    setView("chat");
  }

  function removeSession(id: string) {
    if (busy) return;
    const remaining = sessions.filter((session) => session.id !== id);
    const next = remaining[0] || newSession();
    setSessions(remaining.length ? remaining : [next]);
    if (activeSessionId === id) {
      setActiveSessionId(next.id);
      setMessages(next.messages);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || busy || !activeSessionId) return;
    if (!agentReady) {
      setError("OpenClaw is currently unavailable. Your request is still in the box; retry after the agent is online.");
      return;
    }
    setError(null);
    const attachmentLabel = attachments.length
      ? `\n[Attached: ${attachments.map((item) => item.file_name).join(", ")}]`
      : "";
    const displayText = `${text || "Please inspect the attached image."}${attachmentLabel}`;
    const selectedAttachments = attachments;
    setPrompt("");
    setAttachments([]);
    const previous = contextMessages(messages);
    const next = [...messages, { role: "user" as const, content: displayText }];
    updateCurrentSession(next);
    setBusy(true);
    try {
      const result = await fetchJSON<{ content: string }>("/admin/ops/chat", {
        method: "POST",
        body: JSON.stringify({
          prompt: text,
          attachments: selectedAttachments,
          session_id: activeSessionId,
          messages: previous,
        }),
      });
      updateCurrentSession([...next, { role: "assistant", content: result.content }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PropAI Operations Agent request failed");
    } finally {
      setBusy(false);
    }
  }

  function addAttachments(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    const available = Math.max(0, 4 - attachments.length);
    if (!available) {
      setError("You can attach up to 4 images per request.");
      return;
    }
    const accepted = files.slice(0, available);
    const oversized = accepted.find((file) => file.size > 8 * 1024 * 1024);
    const unsupported = accepted.find((file) => !file.type.startsWith("image/"));
    if (oversized) {
      setError("Each image must be 8 MB or smaller.");
      return;
    }
    if (unsupported) {
      setError("OpenClaw attachments currently support images only.");
      return;
    }
    Promise.all(accepted.map((file) => new Promise<AgentAttachment>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ file_name: file.name, mime_type: file.type, data_url: String(reader.result), size: file.size });
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    }))).then((loaded) => {
      setAttachments((current) => [...current, ...loaded]);
      setError(null);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not read that image."));
  }

  async function copyMessage(index: number, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessage(index);
      window.setTimeout(() => setCopiedMessage((current) => current === index ? null : current), 1600);
    } catch {
      setError("Could not copy the assistant response. Please select the text and copy it manually.");
    }
  }

  const agentReady = status?.reachable === true;
  const errorText = error?.replace(/^\d+\s[^:]+:\s*/, "") || null;

  return (
    <div className="propai-page-stage flex h-full min-h-0 w-full max-w-none flex-col overflow-hidden p-3 sm:p-4 lg:p-6">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] pb-3">
        <Link href="/admin" className="rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label="Back to admin"><ArrowLeft className="h-4 w-4" /></Link>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]"><Bot className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-[-0.02em] text-[var(--text-primary)]">PropAI OpenClaw Agent</h1>
            <span className={`hidden shrink-0 items-center gap-1 text-[10px] sm:flex ${agentReady ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${agentReady ? "bg-[var(--accent)]" : "bg-[var(--border-strong)]"}`} />
              {statusLoading ? "checking" : agentReady ? "connected" : status?.configured ? "unavailable" : "not configured"}
            </span>
          </div>
          <p className="truncate text-[10px] text-[var(--text-muted)]">Super admin · approval-gated operations · context capped before each request</p>
        </div>
        <button type="button" onClick={startNewSession} disabled={busy} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)] disabled:opacity-40"><Plus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">New chat</span></button>
      </header>

      <nav className="flex shrink-0 items-center gap-1 py-2" aria-label="Operations agent views">
        <button type="button" onClick={() => setView("chat")} className={`rounded-md px-3 py-1.5 text-xs ${view === "chat" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"}`}>Chat</button>
        <button type="button" onClick={() => setView("history")} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs ${view === "history" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"}`}><Clock3 className="h-3.5 w-3.5" /> History <span className="text-[10px] text-[var(--text-muted)]">{sessions.length}</span></button>
      </nav>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {view === "history" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
            <div className="mb-4 flex items-center justify-between"><div><h2 className="text-sm font-medium text-[var(--text-primary)]">Session history</h2><p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Saved in PropAI for this workspace. Browser storage is only an offline fallback.</p></div><button type="button" onClick={startNewSession} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-xs font-medium text-[#07120c]"><Plus className="h-3.5 w-3.5" /> New</button></div>
            <div className="space-y-1.5">
              {sortedSessions.map((session) => <div key={session.id} className={`flex items-center gap-2 rounded-lg border p-3 ${session.id === activeSessionId ? "border-[var(--accent)]/40 bg-[var(--accent)]/8" : "border-[var(--border)] bg-[var(--surface-raised)]"}`}><button type="button" onClick={() => openSession(session)} className="min-w-0 flex-1 text-left"><p className="truncate text-sm text-[var(--text-primary)]">{session.title}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{session.messages.length} messages · {new Date(session.updatedAt).toLocaleString()}</p></button><button type="button" onClick={() => removeSession(session.id)} className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-red-400/10 hover:text-red-300" aria-label={`Delete ${session.title}`}><Trash2 className="h-3.5 w-3.5" /></button></div>)}
            </div>
          </div>
        ) : (
          <>
            <AssistantUiOpsChat key={`${activeSessionId || "pending"}:${messages.length}`} sessionId={activeSessionId} agentReady={agentReady} onError={setError} initialMessages={messages} />
            <div className="hidden">
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2.5 pr-2 sm:p-4">
          {messages.length === 0 && <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center px-4 text-center"><div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] text-[var(--accent)]"><Check className="h-4 w-4" /></div><h2 className="text-sm font-semibold text-[var(--text-primary)]">What should we inspect?</h2><p className="mt-1.5 max-w-md text-xs leading-5 text-[var(--text-muted)]">Ask about data quality, deployments, extraction, or a safe implementation plan. OpenClaw will explain evidence and approval points before changes.</p><p className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5 text-left text-[11px] text-[var(--text-secondary)]">Try: “Inspect the current migration status and propose a safe repair plan.”</p></div>}
              {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`flex w-full gap-2.5 ${message.role === "user" ? "justify-end pl-10" : "justify-start pr-4"}`}>{message.role === "assistant" && <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]" aria-hidden="true"><Bot className="h-3.5 w-3.5" /></span>}<div className={`w-fit max-w-2xl px-0.5 py-0.5 text-[13px] ${message.role === "user" ? "whitespace-pre-wrap text-right text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}><div className="mb-0.5 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wider text-[var(--text-muted)]"><span>{message.role}</span>{message.role === "assistant" && <button type="button" onClick={() => void copyMessage(index, message.content)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 normal-case tracking-normal text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label="Copy assistant response" title="Copy response">{copiedMessage === index ? <Check className="h-3 w-3 text-[var(--accent)]" /> : <Copy className="h-3 w-3" />}<span>{copiedMessage === index ? "Copied" : "Copy"}</span></button>}</div>{message.role === "assistant" ? <MarkdownMessage content={message.content} /> : message.content}</div></div>)}
              {busy && <div className="flex w-full gap-2.5 pr-4" aria-live="polite"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[var(--accent)]" aria-hidden="true"><Bot className="h-3.5 w-3.5" /></span><div className="w-fit max-w-2xl px-0.5 py-0.5 text-[13px] text-[var(--text-muted)]"><div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">assistant</div><div className="flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" /> Working on your request…</div></div></div>}
            </div>
            {errorText && <div className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-red-400/30 bg-red-400/8 px-3 py-2.5 text-xs text-red-300 sm:mx-5"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><div className="min-w-0 flex-1"><p className="font-medium">The operations agent did not complete that request.</p><p className="mt-0.5 break-words text-red-200/75">{errorText}</p></div><button type="button" onClick={() => void loadStatus()} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-300/25 px-2 py-1 text-[11px] hover:bg-red-300/10"><RefreshCw className="h-3 w-3" /> Retry</button></div>}
            {!agentReady && !statusLoading && !errorText && <div className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2.5 text-xs text-[var(--text-secondary)] sm:mx-5" role="status" aria-live="polite"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" /><div className="min-w-0 flex-1"><p className="font-medium text-[var(--text-primary)]">OpenClaw is unavailable right now.</p><p className="mt-0.5">You can type your request below; it will stay here until the agent is online.</p></div><button type="button" onClick={() => void loadStatus()} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)]"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Check again</button></div>}
            <form onSubmit={submit} className="shrink-0 border-t border-[var(--border)] p-2 sm:p-2.5">
              <input type="file" accept="image/*" multiple onChange={addAttachments} className="sr-only" id="openclaw-attachment-input" />
              {attachments.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Attached images">
                {attachments.map((item, index) => <span key={`${item.file_name}-${index}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--accent)]/25 bg-[var(--accent)]/8 px-2 py-1 text-[11px] text-[var(--text-secondary)]"><span className="max-w-48 truncate">{item.file_name}</span><button type="button" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label={`Remove ${item.file_name}`}><X className="h-3 w-3" /></button></span>)}
                <span className="text-[10px] text-[var(--text-muted)]">Images are sent to OpenClaw for this request.</span>
              </div>}
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} placeholder="Ask about PropAI, or attach an image to inspect" disabled={busy} rows={1} className="min-h-11 max-h-28 w-full resize-none overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)]/60 focus:ring-2 focus:ring-[var(--accent)]/15 disabled:cursor-not-allowed disabled:opacity-60" />
              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]"><label htmlFor="openclaw-attachment-input" className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1.5 transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)]"><Paperclip className="h-3.5 w-3.5" /> Attach image</label><span className="hidden sm:inline">Ctrl+Enter to send</span></div>
                <button type="submit" disabled={busy || (!prompt.trim() && attachments.length === 0)} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[#07120c] transition-opacity disabled:opacity-40" aria-label="Send message">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}<span className="hidden sm:inline">Send</span></button>
              </div>
            </form>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
