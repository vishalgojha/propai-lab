"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  LayoutDashboard,
  Megaphone,
  Rocket,
  Send,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { getAccessToken } from "@/lib/auth";

type ChatMessage = { role: "assistant" | "user"; text: string };
type Draft = Record<string, any>;
type CampaignParams = { text: string } & Record<string, any>;

const SDK_ACTIONS = "/social-flow-studio/api/sdk/actions";

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value) return "I couldn't build a campaign draft from that yet.";
  return String((value as any).formatted || (value as any).message || "Your campaign draft is ready to review.");
}

function listingUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.!?]+$/, "") : null;
}

function ingestedBrief(value: unknown): string {
  const result = value as any;
  const brief = result?.brief ?? result?.text ?? result?.formatted ?? result?.description ?? result;
  if (typeof brief === "string") return brief;
  if (brief && typeof brief === "object") {
    return Object.entries(brief)
      .filter(([, field]) => field !== null && field !== undefined && field !== "")
      .map(([field, fieldValue]) => `${field}: ${typeof fieldValue === "string" ? fieldValue : JSON.stringify(fieldValue)}`)
      .join("\n");
  }
  return String(brief || "");
}

export default function SocialFlowPage() {
  const [token, setToken] = useState("");
  const [tokenReady, setTokenReady] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The SDK returns a presentation object from realtor_build. Preview and
  // create must receive the original request payload, not that response.
  const [campaignParams, setCampaignParams] = useState<CampaignParams | null>(null);
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
  const [activeView, setActiveView] = useState<"control-center" | "assistant">("control-center");

  useEffect(() => {
    getAccessToken().then((value) => {
      const nextToken = value || "";
      setToken(nextToken);
      // The embedded SDK Studio talks to the same-origin proxy. Keeping the
      // short-lived PropAI access token in sessionStorage lets the Studio use
      // the user's existing session without ever exposing a Meta token.
      if (nextToken) window.sessionStorage.setItem("propai_social_flow_token", nextToken);
      setTokenReady(true);
    });
  }, []);

  const quickPrompts = useMemo(
    () => [
      "Create an ad for my latest listing",
      "I have a 2 BHK for rent in Bandra West at ₹1.3 lakh",
      "Write 3 ad versions for this property",
      "How are my Meta ads doing this week?",
      "Check for creative fatigue and weak ads",
      "Suggest a safer budget shift from weak ads to winners",
    ],
    [],
  );

  async function sdkAction(action: string, params: Draft, approvalToken?: string, approvalReason?: string) {
    if (!token) throw new Error("Your PropAI session is still connecting. Please try again.");
    const response = await fetch(`${SDK_ACTIONS}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, params, ...(approvalToken ? { approvalToken, approvalReason } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) throw new Error(body?.error?.message || body?.message || `The ad assistant returned ${response.status}.`);
    return body?.data || body;
  }

  function isReportRequest(text: string): boolean {
    return /meta ads|campaign report|how are my ads|daily ads|performance|fatigue|weak ads|bleeder|winners|budget shift|optimi[sz]e.*budget|spend pacing/i.test(text);
  }

  function reportParams(text: string): Draft {
    const level = /creative|ad-level|ad level|fatigue|bleeder|winner/i.test(text) ? "ad" : "campaign";
    const preset = /today|daily/i.test(text) ? "today" : /30 days|last month/i.test(text) ? "last_30d" : "last_7d";
    return { adAccountId: "", campaignId: "", preset, level, limit: 20 };
  }

  async function runReport(text: string) {
    setBusy(true);
    setError("");
    try {
      const data = await sdkAction("realtor_report", reportParams(text));
      const report = data?.report || data;
      const narrative = String(report?.narrative || "Your report is ready to review.");
      const recommendations = Array.isArray(report?.recommendations) ? report.recommendations : [];
      setMessages((items) => [...items, {
        role: "assistant",
        text: `${narrative}${recommendations.length ? `\n\nRecommendations:\n${recommendations.slice(0, 5).map((item: unknown) => `• ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n")}` : ""}`,
      }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The Meta report could not be loaded.");
      setMessages((items) => [...items, { role: "assistant", text: "I couldn't load the Meta report. Please finish the secure Meta account setup, then try again." }]);
    } finally {
      setBusy(false);
    }
  }

  async function buildDraft(text: string) {
    setBusy(true);
    setError("");
    try {
      const params: CampaignParams = { text };
      const data = await sdkAction("realtor_build", params);
      setCampaignParams(params);
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

  async function ingestListing(url: string) {
    setBusy(true);
    setError("");
    try {
      const data = await sdkAction("realtor_ingest_listing", { url });
      const extracted = ingestedBrief(data);
      if (!extracted) throw new Error("The listing page did not return a usable property brief.");
      setMessages((items) => [...items, { role: "assistant", text: "I read the listing page. I’m structuring the property details now—please review the ad before anything is sent to Meta." }]);
      await buildDraft(`Create a Meta ad from this extracted listing brief:\n${extracted}`);
      setCampaignParams((current) => current ? { ...current, listingUrl: url } : current);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "I couldn't read that listing page.";
      setError(message);
      setMessages((items) => [...items, { role: "assistant", text: "I couldn't read that listing page. You can paste the property details here instead." }]);
      setBusy(false);
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((items) => [...items, { role: "user", text }]);
    if (isReportRequest(text)) await runReport(text);
    else if (listingUrl(text)) await ingestListing(listingUrl(text) as string);
    else await buildDraft(text);
  }

  async function preview() {
    if (!draft || !campaignParams || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await sdkAction("realtor_preview", campaignParams);
      setDraft((current) => ({ ...current, preview: data }));
      setMessages((items) => [...items, { role: "assistant", text: "Preview ready. The campaign is still only a draft—nothing has been published." }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preview could not be generated.");
    } finally {
      setBusy(false);
    }
  }

  async function requestCreate() {
    if (!draft || !campaignParams || busy) return;
    setBusy(true);
    setError("");
    try {
      const planResponse = await fetch(`${SDK_ACTIONS}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "realtor_create_campaign", params: campaignParams }),
      });
      const plan = await planResponse.json().catch(() => ({}));
      const approvalToken = plan?.data?.approvalToken || plan?.meta?.approvalToken;
      if (!planResponse.ok || !approvalToken) throw new Error(plan?.error?.message || "Could not prepare the campaign for approval.");
      setApproval({ token: String(approvalToken), params: campaignParams });
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

      <nav aria-label="Ads workspace" className="flex shrink-0 gap-1 border-b border-white/10 bg-[#0d1117] px-4 py-2 sm:px-6">
        <button type="button" onClick={() => setActiveView("control-center")} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ${activeView === "control-center" ? "bg-emerald-400 text-black" : "text-zinc-400 hover:bg-white/5 hover:text-white"}`}>
          <LayoutDashboard className="h-3.5 w-3.5" /> Ads control center
        </button>
        <button type="button" onClick={() => setActiveView("assistant")} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ${activeView === "assistant" ? "bg-emerald-400 text-black" : "text-zinc-400 hover:bg-white/5 hover:text-white"}`}>
          <Sparkles className="h-3.5 w-3.5" /> AI campaign assistant
        </button>
      </nav>

      {activeView === "control-center" ? (
        <main className="flex min-h-0 flex-1 flex-col bg-[#090b0f]">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-8">
            <div><p className="text-sm font-semibold text-zinc-100">Everything Meta Ads</p><p className="mt-1 text-xs text-zinc-500">Connect accounts, create and publish campaigns, manage spend, and read performance in one workspace.</p></div>
            <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[11px] font-medium text-emerald-300">Meta tokens stay server-side</span>
          </div>
          {tokenReady && token ? <iframe title="PropAI Meta Ads control center" src="/social-flow-studio/index.html" className="min-h-[calc(100dvh-142px)] w-full flex-1 border-0" /> : <div className="flex min-h-[calc(100dvh-142px)] items-center justify-center text-sm text-zinc-400">{tokenReady ? "Your PropAI session is unavailable. Sign in again to manage Meta Ads." : "Connecting your secure PropAI session…"}</div>}
        </main>
      ) : <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-4 sm:px-8">
        <div className="mb-3 flex items-center gap-2 text-sm"><Sparkles className="h-4 w-4 text-emerald-300" /><span className="font-semibold text-zinc-100">AI campaign assistant</span><span className="text-zinc-500">· turns your property brief into an ad</span></div>

        <section className="min-h-[150px] max-h-[calc(100dvh-250px)] space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.02] p-3 sm:p-5">
          {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}><div className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-emerald-400 text-black" : "border border-white/10 bg-[#11151c] text-zinc-200"}`}>{message.text}</div></div>)}
          {busy && <div className="flex items-center gap-2 px-2 py-2 text-sm text-zinc-400"><WandSparkles className="h-4 w-4 animate-pulse text-emerald-400" /> Thinking through your campaign…</div>}
          {draft && <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-400">Campaign draft</p><h3 className="mt-1 text-base font-semibold">Ready for your review</h3></div><Check className="h-5 w-5 text-emerald-300" /></div><p className="whitespace-pre-wrap text-sm leading-6 text-zinc-300">{readable(draft)}</p>{Array.isArray(draft.missing) && draft.missing.length > 0 && <p className="mt-3 text-xs text-amber-300">Still needed: {draft.missing.join(", ")}</p>}<div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={preview} disabled={busy || !campaignParams} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-white/5 disabled:opacity-50">Review ad</button><button type="button" onClick={requestCreate} disabled={busy || !campaignParams || (Array.isArray(draft.missing) && draft.missing.length > 0)} className="inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black hover:bg-emerald-300 disabled:opacity-50"><Rocket className="h-3.5 w-3.5" /> Create paused campaign</button></div></div>}
          {approval && <div className="rounded-2xl border border-amber-300/30 bg-amber-300/[0.08] p-4"><p className="font-semibold text-amber-200">Ready to create this campaign?</p><p className="mt-1 text-sm text-zinc-300">It will be created paused. Nothing will start spending until you activate it in Meta.</p><div className="mt-3 flex gap-2"><button type="button" onClick={createPausedCampaign} disabled={busy} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">Yes, create paused</button><button type="button" onClick={() => setApproval(null)} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300">Cancel</button></div></div>}
        </section>

        {error && <div className="mt-3 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</div>}
        <div className="mt-3 flex flex-wrap gap-2">{quickPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => setInput(prompt)} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-400 hover:border-emerald-400/40 hover:text-zinc-200">{prompt}</button>)}</div>
        <form onSubmit={submit} className="mt-3 flex items-end gap-2 rounded-2xl border border-white/15 bg-[#11151c] px-3 py-2 shadow-2xl shadow-black/20"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} rows={1} placeholder="Tell PropAI what you want to advertise…" className="max-h-36 min-h-10 flex-1 resize-none bg-transparent py-2 text-sm text-white outline-none placeholder:text-zinc-500" /><button type="submit" disabled={!input.trim() || busy} aria-label="Send" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-400 text-black hover:bg-emerald-300 disabled:opacity-40"><Send className="h-4 w-4" /></button></form>

        <div className="mt-4 border-t border-white/10 pt-3"><button type="button" onClick={() => setShowAdvanced((value) => !value)} className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300"><ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`} /> Advanced account setup</button>{showAdvanced && <div className="mt-2 flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 text-xs text-zinc-400"><span>Connect or update your Meta account in the secure setup screen.</span><a href="/social-flow-studio/index.html" target="_blank" rel="noreferrer" className="text-emerald-300 hover:text-emerald-200">Open setup <ExternalLink className="ml-1 inline h-3 w-3" /></a></div>}</div>
      </main>}
    </div>
  );
}
