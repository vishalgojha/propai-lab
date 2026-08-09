"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Megaphone,
  Rocket,
  Send,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { getAccessToken } from "@/lib/auth";

type ChatMessage = { role: "assistant" | "user"; text: string };
type Draft = Record<string, any>;

const SDK_ACTIONS = "/social-flow-studio/api/sdk/actions";

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value) return "I couldn't build a campaign draft from that yet.";
  return String((value as any).formatted || (value as any).message || "Your campaign draft is ready to review.");
}

export default function SocialFlowPage() {
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Hi! Main aapke property brief ko ad campaign mein convert karunga. Property ka short description, location, price aur WhatsApp/lead preference bhej dijiye.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ token: string; params: Draft } | null>(null);
  const [error, setError] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    getAccessToken().then((value) => setToken(value || ""));
  }, []);

  const quickPrompts = useMemo(
    () => [
      "Create an ad for my latest listing",
      "I have a 2 BHK for rent in Bandra West at ₹1.3 lakh",
      "Help me promote this property on WhatsApp",
    ],
    [],
  );

  async function sdkAction(action: string, params: Draft, approvalToken?: string, approvalReason?: string) {
    if (!token) throw new Error("Your PropAI session is still connecting. Please try again.");
    const response = await fetch(`${SDK_ACTIONS}/${approvalToken ? "execute" : "execute"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, params, ...(approvalToken ? { approvalToken, approvalReason } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) throw new Error(body?.error?.message || body?.message || `The ad assistant returned ${response.status}.`);
    return body?.data || body;
  }

  async function buildDraft(text: string) {
    setBusy(true);
    setError("");
    try {
      const data = await sdkAction("realtor_build", { text });
      setDraft(data);
      const missing = Array.isArray(data?.missing) && data.missing.length ? ` I still need: ${data.missing.join(", ")}.` : " The draft is ready for your review.";
      setMessages((items) => [...items, { role: "assistant", text: `${readable(data)}${missing}` }]);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "I couldn't build that campaign yet.";
      setError(message);
      setMessages((items) => [...items, { role: "assistant", text: "I couldn't complete that request. Please check the details below and try again." }]);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((items) => [...items, { role: "user", text }]);
    await buildDraft(text);
  }

  async function preview() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await sdkAction("realtor_preview", draft);
      setDraft((current) => ({ ...current, preview: data }));
      setMessages((items) => [...items, { role: "assistant", text: "Preview ready. The campaign is still only a draft—nothing has been published." }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preview could not be generated.");
    } finally {
      setBusy(false);
    }
  }

  async function requestCreate() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const planResponse = await fetch(`${SDK_ACTIONS}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "realtor_create_campaign", params: draft }),
      });
      const plan = await planResponse.json().catch(() => ({}));
      const approvalToken = plan?.data?.approvalToken || plan?.meta?.approvalToken;
      if (!planResponse.ok || !approvalToken) throw new Error(plan?.error?.message || "Could not prepare the campaign for approval.");
      setApproval({ token: String(approvalToken), params: draft });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not prepare the campaign.");
    } finally {
      setBusy(false);
    }
  }

  async function createPausedCampaign() {
    if (!approval || busy) return;
    setBusy(true);
    try {
      await sdkAction("realtor_create_campaign", approval.params, approval.token, "Broker approved a paused campaign draft from PropAI.");
      setApproval(null);
      setMessages((items) => [...items, { role: "assistant", text: "Done. The campaign was created paused. You can inspect it in Meta and activate it when you're ready." }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The campaign could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-44px)] flex-col bg-[#090b0f] text-white">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-300"><Megaphone className="h-4 w-4" /></div>
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-400">Growth</p><h1 className="text-base font-semibold">Realtor Ads Studio</h1></div>
        </div>
        <a href="/social-flow-studio/index.html" target="_blank" rel="noreferrer" className="hidden items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-white/5 sm:flex"><ExternalLink className="h-3.5 w-3.5" /> Advanced setup</a>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 sm:px-6">
        <div className="mb-5 text-center"><div className="mb-2 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300"><Sparkles className="h-3.5 w-3.5" /> AI campaign assistant</div><h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Turn your property brief into an ad.</h2><p className="mx-auto mt-2 max-w-xl text-sm text-zinc-400">Tell me what you want to promote. I’ll structure the campaign, check the details, and keep it paused until you approve it.</p></div>

        <section className="flex-1 space-y-3 rounded-2xl border border-white/10 bg-white/[0.02] p-3 sm:p-5">
          {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}><div className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-emerald-400 text-black" : "border border-white/10 bg-[#11151c] text-zinc-200"}`}>{message.text}</div></div>)}
          {busy && <div className="flex items-center gap-2 px-2 py-2 text-sm text-zinc-400"><WandSparkles className="h-4 w-4 animate-pulse text-emerald-400" /> Thinking through your campaign…</div>}
          {draft && <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-400">Campaign draft</p><h3 className="mt-1 text-base font-semibold">Ready for your review</h3></div><Check className="h-5 w-5 text-emerald-300" /></div><p className="whitespace-pre-wrap text-sm leading-6 text-zinc-300">{readable(draft)}</p>{Array.isArray(draft.missing) && draft.missing.length > 0 && <p className="mt-3 text-xs text-amber-300">Still needed: {draft.missing.join(", ")}</p>}<div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={preview} disabled={busy} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-white/5 disabled:opacity-50">Review ad</button><button type="button" onClick={requestCreate} disabled={busy || (Array.isArray(draft.missing) && draft.missing.length > 0)} className="inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black hover:bg-emerald-300 disabled:opacity-50"><Rocket className="h-3.5 w-3.5" /> Create paused campaign</button></div></div>}
          {approval && <div className="rounded-2xl border border-amber-300/30 bg-amber-300/[0.08] p-4"><p className="font-semibold text-amber-200">Ready to create this campaign?</p><p className="mt-1 text-sm text-zinc-300">It will be created paused. Nothing will start spending until you activate it in Meta.</p><div className="mt-3 flex gap-2"><button type="button" onClick={createPausedCampaign} disabled={busy} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">Yes, create paused</button><button type="button" onClick={() => setApproval(null)} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300">Cancel</button></div></div>}
        </section>

        {error && <div className="mt-3 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</div>}
        <div className="mt-3 flex flex-wrap gap-2">{quickPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => setInput(prompt)} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-400 hover:border-emerald-400/40 hover:text-zinc-200">{prompt}</button>)}</div>
        <form onSubmit={submit} className="mt-3 flex items-end gap-2 rounded-2xl border border-white/15 bg-[#11151c] px-3 py-2 shadow-2xl shadow-black/20"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} rows={1} placeholder="Tell PropAI what you want to advertise…" className="max-h-36 min-h-10 flex-1 resize-none bg-transparent py-2 text-sm text-white outline-none placeholder:text-zinc-500" /><button type="submit" disabled={!input.trim() || busy} aria-label="Send" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-400 text-black hover:bg-emerald-300 disabled:opacity-40"><Send className="h-4 w-4" /></button></form>

        <div className="mt-4 border-t border-white/10 pt-3"><button type="button" onClick={() => setShowAdvanced((value) => !value)} className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300"><ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`} /> Advanced account setup</button>{showAdvanced && <div className="mt-2 flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 text-xs text-zinc-400"><span>Connect or update your Meta account in the secure setup screen.</span><a href="/social-flow-studio/index.html" target="_blank" rel="noreferrer" className="text-emerald-300 hover:text-emerald-200">Open setup <ExternalLink className="ml-1 inline h-3 w-3" /></a></div>}</div>
      </main>
    </div>
  );
}
