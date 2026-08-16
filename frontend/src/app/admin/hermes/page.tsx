"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, Clock3, LoaderCircle, Plus, Send, Trash2 } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type Message = { role: "user" | "assistant"; content: string };
type Session = { id: string; title: string; messages: Message[]; updatedAt: number };
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

  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);

  useEffect(() => {
    fetchJSON<Status>("/admin/hermes/status").then(setStatus).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const restore = () => {
      if (cancelled) return;
      try {
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
      } catch {
        const active = newSession();
        setSessions([active]);
        setActiveSessionId(active.id);
        setMessages([]);
      } finally {
        setSessionsLoaded(true);
      }
    };
    window.setTimeout(restore, 0);
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
    setActiveSessionId(session.id);
    setMessages([]);
    setError(null);
    setView("chat");
  }

  function openSession(session: Session) {
    if (busy) return;
    setActiveSessionId(session.id);
    setMessages(session.messages);
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
        body: JSON.stringify({ prompt: text, messages: previous }),
      });
      updateCurrentSession([...next, { role: "assistant", content: result.content }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PropAI Operations Agent request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full max-w-none flex-col overflow-hidden p-3 sm:p-4 lg:p-5">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 pb-2">
        <Link href="/admin" className="text-zinc-500 hover:text-white" aria-label="Back to admin"><ArrowLeft className="h-4 w-4" /></Link>
        <Bot className="h-5 w-5 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-[-0.02em] text-white">PropAI Operations Agent</h1>
            <span className={`hidden shrink-0 items-center gap-1 text-[10px] sm:flex ${status?.reachable ? "text-emerald-300" : "text-zinc-500"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${status?.reachable ? "bg-emerald-400" : "bg-zinc-600"}`} />
              {status?.reachable ? "connected" : status?.configured ? "checking" : "not configured"}
            </span>
          </div>
          <p className="truncate text-[10px] text-zinc-600">Super admin · approval-gated operations · current context capped before each request</p>
        </div>
        <button type="button" onClick={startNewSession} disabled={busy} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-emerald-400/40 hover:text-white disabled:opacity-40"><Plus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">New chat</span></button>
      </header>

      <nav className="flex shrink-0 items-center gap-1 py-2" aria-label="Operations agent views">
        <button type="button" onClick={() => setView("chat")} className={`rounded-lg px-3 py-1.5 text-xs ${view === "chat" ? "bg-emerald-400/15 text-emerald-300" : "text-zinc-500 hover:text-zinc-200"}`}>Chat</button>
        <button type="button" onClick={() => setView("history")} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs ${view === "history" ? "bg-emerald-400/15 text-emerald-300" : "text-zinc-500 hover:text-zinc-200"}`}><Clock3 className="h-3.5 w-3.5" /> History <span className="text-[10px] text-zinc-600">{sessions.length}</span></button>
      </nav>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10">
        {view === "history" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-medium text-white">Session history</h2><p className="mt-0.5 text-[11px] text-zinc-600">Saved in this browser. Long transcripts stay here; only recent context is sent to the agent.</p></div><button type="button" onClick={startNewSession} className="inline-flex items-center gap-1 rounded-lg bg-emerald-400 px-2.5 py-1.5 text-xs font-medium text-black"><Plus className="h-3.5 w-3.5" /> New</button></div>
            <div className="space-y-1.5">
              {sortedSessions.map((session) => <div key={session.id} className={`flex items-center gap-2 rounded-xl border p-3 ${session.id === activeSessionId ? "border-emerald-400/30 bg-emerald-400/[0.06]" : "border-white/10 bg-white/[0.02]"}`}><button type="button" onClick={() => openSession(session)} className="min-w-0 flex-1 text-left"><p className="truncate text-sm text-zinc-200">{session.title}</p><p className="mt-1 text-[10px] text-zinc-600">{session.messages.length} messages · {new Date(session.updatedAt).toLocaleString()}</p></button><button type="button" onClick={() => removeSession(session.id)} className="rounded-md p-1.5 text-zinc-600 hover:bg-red-400/10 hover:text-red-300" aria-label={`Delete ${session.title}`}><Trash2 className="h-3.5 w-3.5" /></button></div>)}
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 pr-2 sm:p-4">
              {messages.length === 0 && <p className="text-sm text-zinc-500">Try: “Inspect the current migration status and propose a safe repair plan. Do not apply anything.”</p>}
              {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`rounded-xl p-3 whitespace-pre-wrap text-sm ${message.role === "user" ? "ml-6 bg-emerald-400/10 text-zinc-200" : "mr-6 bg-white/[0.04] text-zinc-300"}`}><div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">{message.role}</div>{message.content}</div>)}
              {busy && <div className="mr-6 rounded-xl bg-white/[0.04] p-3 text-sm text-zinc-400" aria-live="polite"><div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">assistant</div><div className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-emerald-400" /> Working on your request…</div></div>}
            </div>
            {error && <p className="shrink-0 px-3 pb-1 text-xs text-red-400 sm:px-4">{error}</p>}
            <form onSubmit={submit} className="relative shrink-0 border-t border-white/10 p-2 sm:p-3">
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} placeholder="Ask PropAI to investigate or prepare a change…" rows={2} className="min-h-14 max-h-32 w-full resize-none overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-3 pr-14 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-400/50" />
              <div className="pointer-events-none absolute bottom-4 left-5 text-[10px] text-zinc-600">Ctrl+Enter</div>
              <button type="submit" disabled={busy || !prompt.trim()} className="absolute bottom-4 right-5 rounded-lg bg-emerald-400 px-3 py-2.5 font-semibold text-black disabled:opacity-40" aria-label="Send message">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
