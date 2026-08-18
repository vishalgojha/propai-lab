"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Bot, Check, Clock3, LoaderCircle, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type Message = { role: "user" | "assistant"; content: string };
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

export default function HermesAdminPage() {
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

  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);

  async function loadStatus() {
    setStatusLoading(true);
    try {
      setStatus(await fetchJSON<Status>("/admin/hermes/status"));
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
        const remote = await fetchJSON<RemoteSession[]>("/admin/hermes/sessions");
        let restored: Session[] = remote.map((item) => ({
          id: item.id,
          title: item.title || "New session",
          messages: [],
          updatedAt: Date.parse(item.updated_at) || Date.now(),
        }));
        if (!restored.length) {
          const created = await fetchJSON<RemoteSession>("/admin/hermes/sessions", {
            method: "POST",
            body: JSON.stringify({ title: "New session" }),
          });
          restored = [{ id: created.id, title: created.title || "New session", messages: [], updatedAt: Date.parse(created.updated_at) || Date.now() }];
        }
        const active = restored[0];
        const remoteMessages = await fetchJSON<RemoteMessage[]>(`/admin/hermes/sessions/${encodeURIComponent(active.id)}/messages`);
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
    void fetchJSON<RemoteSession>("/admin/hermes/sessions", { method: "POST", body: JSON.stringify({ title: "New session" }) })
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
    void fetchJSON<RemoteMessage[]>(`/admin/hermes/sessions/${encodeURIComponent(session.id)}/messages`)
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
    if (!text || busy || !activeSessionId) return;
    setError(null);
    setPrompt("");
    const previous = contextMessages(messages);
    const next = [...messages, { role: "user" as const, content: text }];
    updateCurrentSession(next);
    setBusy(true);
    try {
      const result = await fetchJSON<{ content: string }>("/admin/hermes/chat", {
        method: "POST",
        body: JSON.stringify({ prompt: text, session_id: activeSessionId, messages: previous }),
      });
      updateCurrentSession([...next, { role: "assistant", content: result.content }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PropAI Operations Agent request failed");
    } finally {
      setBusy(false);
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
            <h1 className="truncate text-base font-semibold tracking-[-0.02em] text-[var(--text-primary)]">PropAI Operations Agent</h1>
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
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 pr-2 sm:p-5">
              {messages.length === 0 && <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center px-4 text-center"><div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] text-[var(--accent)]"><Check className="h-5 w-5" /></div><h2 className="text-base font-semibold text-[var(--text-primary)]">What should we inspect?</h2><p className="mt-2 max-w-md text-sm leading-6 text-[var(--text-muted)]">Ask about data quality, deployments, extraction, or a safe implementation plan. Hermes will explain evidence and approval points before changes.</p><p className="mt-5 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-left text-xs text-[var(--text-secondary)]">Try: “Inspect the current migration status and propose a safe repair plan.”</p></div>}
              {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`max-w-4xl whitespace-pre-wrap rounded-lg border p-3 text-sm leading-6 ${message.role === "user" ? "ml-auto border-[var(--accent)]/25 bg-[var(--accent)]/10 text-[var(--text-primary)]" : "mr-auto border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-secondary)]"}`}><div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{message.role}</div>{message.content}</div>)}
              {busy && <div className="mr-auto max-w-4xl rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--text-muted)]" aria-live="polite"><div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">assistant</div><div className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent)]" /> Working on your request…</div></div>}
            </div>
            {errorText && <div className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-red-400/30 bg-red-400/8 px-3 py-2.5 text-xs text-red-300 sm:mx-5"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><div className="min-w-0 flex-1"><p className="font-medium">The operations agent did not complete that request.</p><p className="mt-0.5 break-words text-red-200/75">{errorText}</p></div><button type="button" onClick={() => void loadStatus()} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-300/25 px-2 py-1 text-[11px] hover:bg-red-300/10"><RefreshCw className="h-3 w-3" /> Retry</button></div>}
            <form onSubmit={submit} className="relative shrink-0 border-t border-[var(--border)] p-2 sm:p-3">
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} placeholder={agentReady ? "Ask PropAI to investigate or prepare a change…" : "Operations agent unavailable"} disabled={!agentReady || busy} rows={2} className="min-h-14 max-h-32 w-full resize-none overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 pr-14 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)]/60 focus:ring-2 focus:ring-[var(--accent)]/15 disabled:cursor-not-allowed disabled:opacity-60" />
              <div className="pointer-events-none absolute bottom-4 left-5 text-[10px] text-[var(--text-muted)]">Ctrl+Enter</div>
              <button type="submit" disabled={!agentReady || busy || !prompt.trim()} className="absolute bottom-4 right-5 rounded-md bg-[var(--accent)] px-3 py-2.5 font-semibold text-[#07120c] transition-opacity disabled:opacity-40" aria-label="Send message">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
