"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, Send, ShieldCheck } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type Message = { role: "user" | "assistant"; content: string };
type Status = { configured: boolean; reachable?: boolean; health_error?: string | null; api_url: string; model: string; approval_required: boolean; scope: string };

export default function HermesAdminPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJSON<Status>("/admin/hermes/status").then(setStatus).catch((e) => setError(e.message));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setError(null);
    setPrompt("");
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const result = await fetchJSON<{ content: string }>("/admin/hermes/chat", {
        method: "POST",
        body: JSON.stringify({ prompt: text, messages }),
      });
      setMessages([...next, { role: "assistant", content: result.content }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hermes request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-none p-6 lg:p-8">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin" className="text-zinc-400 hover:text-white"><ArrowLeft className="w-5 h-5" /></Link>
        <div>
          <p className="propai-kicker text-[10px] font-semibold">Super admin only</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em] text-white flex items-center gap-3"><Bot className="text-amber-400" /> Hermes Operations Agent</h1>
          <p className="text-sm text-zinc-500">Coding and infrastructure assistance for PropAI</p>
        </div>
      </div>

      <div className="mb-6 rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-4 text-sm text-zinc-300">
        <div className="flex items-center gap-2 text-amber-300 font-medium"><ShieldCheck className="w-4 h-4" /> Approval boundary</div>
        <p className="mt-2 text-zinc-400">Use Hermes to inspect the repo, draft migrations, edit in an isolated workspace, and run tests. Production database changes and destructive commands must remain explicit approvals in the Hermes environment.</p>
      </div>

      <div className="mb-4 rounded-xl border border-white/10 p-4 text-sm text-zinc-400">
        {status?.configured && status.reachable
          ? `Connected to ${status.api_url} · model ${status.model}`
          : status?.configured
            ? `Hermes is configured but unreachable (${status.health_error || "health check failed"}). Verify the Hermes service is running, its network alias is hermes, and API_SERVER_KEY matches HERMES_API_KEY.`
            : "Hermes is not configured yet. Set HERMES_API_URL and HERMES_API_KEY on the API service."}
      </div>

      <section className="flex h-[calc(100vh-12rem)] min-h-[520px] flex-col overflow-hidden rounded-2xl border border-white/10 p-5">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
          {messages.length === 0 && <p className="text-sm text-zinc-500">Try: “Inspect the current migration status and propose a safe repair plan. Do not apply anything.”</p>}
          {messages.map((message, index) => (
            <div key={index} className={`rounded-xl p-4 whitespace-pre-wrap text-sm ${message.role === "user" ? "ml-8 bg-emerald-400/10 text-zinc-200" : "mr-8 bg-white/[0.04] text-zinc-300"}`}>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{message.role}</div>
              {message.content}
            </div>
          ))}
        </div>
        {error && <p className="my-3 text-sm text-red-400">{error}</p>}
        <form onSubmit={submit} className="relative mt-5 w-full">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask Hermes to investigate or prepare a change…"
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
