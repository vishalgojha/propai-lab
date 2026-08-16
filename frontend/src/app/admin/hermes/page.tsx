"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, LoaderCircle, Send, ShieldCheck } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type Message = { role: "user" | "assistant"; content: string };
type Status = { configured: boolean; reachable?: boolean; health_error?: string | null; api_url: string; model: string; approval_required: boolean; scope: string };
const HISTORY_KEY = "propai.operations-agent.history";

function normalizeMessages(items: Message[]): Message[] {
  const normalized: Message[] = [];
  for (const item of items) {
    const content = item.content.trim();
    if (!content) continue;
    const previous = normalized[normalized.length - 1];
    if (previous?.role === item.role && previous.content === content) continue;
    normalized.push({ role: item.role, content });
  }
  return normalized.slice(-20);
}

export default function HermesAdminPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAgentNotice, setShowAgentNotice] = useState(true);

  useEffect(() => {
    fetchJSON<Status>("/admin/hermes/status").then(setStatus).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(HISTORY_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const restored = parsed.filter((item: unknown): item is Message => {
            if (!item || typeof item !== "object") return false;
            const candidate = item as { role?: unknown; content?: unknown };
            return (candidate.role === "user" || candidate.role === "assistant") && typeof candidate.content === "string";
          });
          setMessages(normalizeMessages(restored));
        }
      }
    } catch {
      // Ignore malformed or unavailable browser storage.
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (historyLoaded) {
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-20)));
      } catch {
        // Ignore unavailable or full browser storage.
      }
    }
  }, [historyLoaded, messages]);

  useEffect(() => {
    if (!status?.reachable) return;
    const timeout = window.setTimeout(() => setShowAgentNotice(false), 4500);
    return () => window.clearTimeout(timeout);
  }, [status?.reachable]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setError(null);
    setPrompt("");
    const previous = normalizeMessages(messages);
    const next = [...previous, { role: "user" as const, content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const result = await fetchJSON<{ content: string }>("/admin/hermes/chat", {
        method: "POST",
        body: JSON.stringify({ prompt: text, messages: previous }),
      });
      setMessages([...next, { role: "assistant", content: result.content }].slice(-20));
    } catch (e) {
      setError(e instanceof Error ? e.message : "PropAI Operations Agent request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full max-w-none flex-col overflow-hidden p-6 lg:p-8">
      <div className="flex shrink-0 items-center gap-4 mb-6">
        <Link href="/admin" className="text-zinc-400 hover:text-white"><ArrowLeft className="w-5 h-5" /></Link>
        <div>
          <p className="propai-kicker text-[10px] font-semibold">Super admin only</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em] text-white flex items-center gap-3"><Bot className="text-emerald-400" /> PropAI Operations Agent</h1>
        </div>
      </div>

      {showAgentNotice && <div className="mb-6 shrink-0 rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-4 text-sm text-zinc-300">
        <div className="flex items-center gap-2 text-amber-300 font-medium"><ShieldCheck className="w-4 h-4" /> Approval boundary</div>
        <p className="mt-2 text-zinc-400">Use the PropAI Operations Agent with its full enabled coding and operations toolset to inspect the repo, edit isolated workspaces, investigate schemas, draft migrations, and run tests. Production database writes, deployments, secret changes, and destructive commands require your explicit approval.</p>
      </div>}

      {(showAgentNotice || Boolean(status && !status.reachable)) && <div className="mb-4 shrink-0 rounded-xl border border-white/10 p-4 text-sm text-zinc-400">
          {status?.configured && status.reachable
            ? "Connected"
            : status?.configured
            ? `PropAI Operations Agent is configured but unreachable (${status.health_error || "health check failed"}). Verify the agent service is running and its API connection variables match.`
            : "PropAI Operations Agent is not configured yet. Set the agent service connection variables on the API service."}
      </div>}

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 p-5">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-2">
          {messages.length === 0 && <p className="text-sm text-zinc-500">Try: “Inspect the current migration status and propose a safe repair plan. Do not apply anything.”</p>}
          {messages.map((message, index) => (
            <div key={index} className={`rounded-xl p-4 whitespace-pre-wrap text-sm ${message.role === "user" ? "ml-8 bg-emerald-400/10 text-zinc-200" : "mr-8 bg-white/[0.04] text-zinc-300"}`}>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{message.role}</div>
              {message.content}
            </div>
          ))}
          {busy && <div className="mr-8 rounded-xl bg-white/[0.04] p-4 text-sm text-zinc-400" aria-live="polite">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">assistant</div>
            <div className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-emerald-400" /> PropAI Operations Agent is working on your request…</div>
          </div>}
        </div>
        {error && <p className="my-3 text-sm text-red-400">{error}</p>}
        <form onSubmit={submit} className="relative mt-5 w-full shrink-0">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask the PropAI Operations Agent to investigate or prepare a change…"
            rows={3}
            className="min-h-20 max-h-40 w-full resize-none overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-3 pr-16 text-sm text-white placeholder-zinc-600 outline-none focus:border-amber-400/50"
          />
          <div className="pointer-events-none absolute bottom-3 left-3 text-[10px] text-zinc-600">Ctrl+Enter to send</div>
          <button type="submit" disabled={busy || !prompt.trim()} className="absolute bottom-3 right-3 rounded-xl bg-amber-400 px-4 py-3 font-semibold text-black disabled:opacity-40" aria-label="Send message">{busy ? "Working…" : <Send className="h-4 w-4" />}</button>
        </form>
      </section>
    </div>
  );
}
