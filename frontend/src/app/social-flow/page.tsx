"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { Bot, ExternalLink, Paperclip, Send, Sparkles, X } from "lucide-react";
import { getAccessToken } from "@/lib/auth";
import { fetchFormData, fetchJSON } from "@/lib/api";

type Message = { role: "assistant" | "user"; text: string };
type Asset = {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  asset_kind: string;
  url: string;
};
type PendingApproval = { token: string; action: string; params: Record<string, unknown>; summary: string };

const starterPrompts = [
  "Create a campaign for my latest listing",
  "How are my Meta ads doing this week?",
  "Find creative fatigue and suggest the safest next move",
];

function sizeLabel(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function resultText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const item = value as Record<string, unknown>;
  if (typeof item.narrative === "string") return item.narrative;
  if (typeof item.message === "string") return item.message;
  if (item.report && typeof item.report === "object") return resultText(item.report);
  return `\n\n${JSON.stringify(value, null, 2)}`;
}

export default function SocialFlowPage() {
  const [tokenReady, setTokenReady] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text: "I’m Hermes, your Meta Ads agent. Send me a property brief, upload the creative, or ask about an existing campaign. I’ll keep you in one approval-safe conversation.",
    },
  ]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "needs_setup" | "not_connected">("connecting");
  const [activeTab, setActiveTab] = useState<"chat" | "ads">("chat");
  const [currentAds, setCurrentAds] = useState("");
  const [discoveringIds, setDiscoveringIds] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getAccessToken().then((token) => {
      if (token) {
        window.sessionStorage.setItem("propai_social_flow_token", token);
        fetchJSON<{ assets: Asset[] }>("/social-flow/assets")
          .then((result) => setAssets(result.assets || []))
          .catch(() => undefined);
        fetchJSON<{ status: "connected" | "needs_setup" | "not_connected" }>("/social-flow/connection")
          .then((result) => setConnectionStatus(result.status))
          .catch(() => setConnectionStatus("not_connected"));
      } else {
        setConnectionStatus("not_connected");
      }
      setTokenReady(true);
    });
  }, []);

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || busy) return;
    setBusy(true);
    setError("");
    try {
      for (const file of Array.from(files).slice(0, 8)) {
        const form = new FormData();
        form.set("file", file, file.name);
        const result = await fetchFormData<{ asset: Asset }>("/social-flow/assets", form);
        setAssets((current) => [result.asset, ...current.filter((item) => item.id !== result.asset.id)].slice(0, 8));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "I couldn’t upload that file.");
    } finally {
      setBusy(false);
    }
  }

  async function askHermes(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    setInput("");
    setError("");
    const nextMessages = [...messages, { role: "user" as const, text }];
    setMessages(nextMessages);
    setBusy(true);
    try {
      const result = await fetchJSON<{ content: string; approval?: PendingApproval | null; sdk_result?: unknown }>("/social-flow/agent", {
        method: "POST",
        body: JSON.stringify({
          prompt: text,
          asset_ids: assets.map((asset) => asset.id),
          messages: messages.slice(-12),
        }),
      });
      setMessages([...nextMessages, { role: "assistant", text: `${result.content}${resultText(result.sdk_result)}` }]);
      setPendingApproval(result.approval || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Hermes couldn’t complete that request.");
    } finally {
      setBusy(false);
    }
  }

  async function loadCurrentAds() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await fetchJSON<{ content: string; sdk_result?: unknown }>("/social-flow/agent", {
        method: "POST",
        body: JSON.stringify({
          prompt: "Show my current Meta campaigns with status, spend, and leads. Keep it concise.",
          asset_ids: [],
          messages: [],
        }),
      });
      setCurrentAds(`${result.content}${resultText(result.sdk_result)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "I couldn’t load your current ads.");
    } finally {
      setBusy(false);
    }
  }

  async function discoverMetaIds() {
    if (discoveringIds || busy) return;
    setDiscoveringIds(true);
    setError("");
    try {
      const result = await fetchJSON<{ message: string; status: string; ids?: Record<string, string> }>("/social-flow/meta-discovery", { method: "POST" });
      setMessages((current) => [...current, { role: "assistant", text: result.message }]);
      if (result.status === "found") {
        setConnectionStatus("connecting");
        const connection = await fetchJSON<{ status: "connected" | "needs_setup" | "not_connected" }>("/social-flow/connection");
        setConnectionStatus(connection.status);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "I couldn’t open the Meta lookup browser.");
    } finally {
      setDiscoveringIds(false);
    }
  }

  async function approveAction() {
    if (!pendingApproval || busy) return;
    setBusy(true);
    setError("");
    try {
      await fetchJSON("/social-flow/actions/execute", {
        method: "POST",
        body: JSON.stringify({ action: pendingApproval.action, params: pendingApproval.params, approval_token: pendingApproval.token }),
      });
      setMessages((current) => [...current, { role: "assistant", text: "Approved and sent to Social Flow. The requested Meta action completed successfully." }]);
      setPendingApproval(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The approved Meta action failed.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    void askHermes(input);
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    void uploadFiles(event.target.files);
    event.target.value = "";
  }

  return (
    <div className="flex min-h-[calc(100dvh-44px)] flex-col bg-[#090b0f] text-white">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 sm:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-400/15 text-emerald-300"><Bot className="h-5 w-5" /></div>
          <div><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-400">Growth</p><h1 className="text-base font-semibold">PropAI Ads Agent</h1></div>
        </div>
        <div className="hidden items-center gap-2 text-xs text-zinc-500 sm:flex"><span className={`h-2 w-2 rounded-full ${connectionStatus === "connected" ? "bg-emerald-400" : connectionStatus === "connecting" ? "bg-amber-400" : "bg-red-400"}`} /> {connectionStatus === "connected" ? "Meta connected" : connectionStatus === "needs_setup" ? "Setup needed" : connectionStatus === "connecting" ? "Checking Meta" : "Meta needs attention"}</div>
      </header>

      <nav className="flex shrink-0 gap-1 border-b border-white/10 bg-[#0d1117] px-4 py-2 sm:px-8" aria-label="Ads workspace">
        <button type="button" onClick={() => setActiveTab("chat")} className={`rounded-lg px-3 py-2 text-xs font-semibold ${activeTab === "chat" ? "bg-emerald-400 text-black" : "text-zinc-400 hover:bg-white/5 hover:text-white"}`}>Ads assistant</button>
        <button type="button" onClick={() => { setActiveTab("ads"); if (!currentAds) void loadCurrentAds(); }} className={`rounded-lg px-3 py-2 text-xs font-semibold ${activeTab === "ads" ? "bg-emerald-400 text-black" : "text-zinc-400 hover:bg-white/5 hover:text-white"}`}>Current ads</button>
      </nav>

      <main className="mx-auto flex w-full max-w-none flex-none flex-col px-4 py-4 sm:px-8 sm:py-5 lg:px-10">
        {activeTab === "ads" ? (
          <section className="h-[min(60dvh,540px)] min-h-[340px] rounded-3xl border border-white/10 bg-white/[0.02] p-5 sm:p-7">
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold">Current ads</p><p className="mt-1 text-xs text-zinc-500">Live campaign status, spend, and leads from your connected Meta account.</p></div><button type="button" onClick={() => void loadCurrentAds()} disabled={busy} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300 hover:border-emerald-400/40 disabled:opacity-40">Refresh</button></div>
            {currentAds ? <pre className="mt-5 h-[calc(100%-72px)] overflow-auto whitespace-pre-wrap rounded-2xl border border-white/10 bg-[#11151c] p-4 text-sm leading-6 text-zinc-200">{currentAds}</pre> : <div className="mt-16 text-center text-sm text-zinc-500">{connectionStatus === "connected" ? "Loading your live campaigns…" : "Connect Meta setup in the assistant first, then your campaigns will appear here."}</div>}
          </section>
        ) : <>
        <div className="mb-4 flex items-center gap-2 text-sm"><Sparkles className="h-4 w-4 text-emerald-300" /><span className="font-semibold">One conversation for your ads</span><span className="text-zinc-500">· briefs, creatives, reports, approvals</span></div>

        <section className="h-[min(60dvh,540px)] min-h-[340px] space-y-3 overflow-y-auto rounded-3xl border border-white/10 bg-white/[0.02] p-3 sm:p-5">
          {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}><div className={`max-w-[92%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-emerald-400 text-black" : "border border-white/10 bg-[#11151c] text-zinc-200"}`}>{message.text}</div></div>)}
          {busy && <div className="flex items-center gap-2 px-2 text-sm text-zinc-500"><Sparkles className="h-4 w-4 animate-pulse text-emerald-400" /> PropAI is working…</div>}
          {pendingApproval && <div className="rounded-2xl border border-amber-300/30 bg-amber-300/[0.08] p-4"><p className="font-semibold text-amber-200">Approval required</p><p className="mt-1 text-sm text-zinc-300">{pendingApproval.summary}</p><div className="mt-3 flex gap-2"><button type="button" onClick={() => void approveAction()} disabled={busy} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">Approve action</button><button type="button" onClick={() => setPendingApproval(null)} disabled={busy} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300">Cancel</button></div></div>}
        </section>

        {connectionStatus !== "connected" && <div className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] p-4"><p className="text-sm font-semibold text-amber-100">Meta setup needed</p><p className="mt-1 text-xs leading-5 text-zinc-400">PropAI can try to find your IDs in its secure browser, or you can open Meta in another tab and copy them here.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void discoverMetaIds()} disabled={discoveringIds} className="rounded-lg bg-amber-200 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">{discoveringIds ? "Looking up IDs…" : "Find IDs automatically"}</button><button type="button" onClick={() => setInput("Guide me to find my Meta Page ID and Ad Account ID")} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300 hover:border-emerald-400/40">Guide me</button><a href="https://business.facebook.com/settings/accounts" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300 hover:border-emerald-400/40">Meta ad accounts <ExternalLink className="h-3 w-3" /></a><a href="https://www.facebook.com/pages/?category=your_pages" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300 hover:border-emerald-400/40">Facebook Pages <ExternalLink className="h-3 w-3" /></a></div></div>}

        {error && <div className="mt-3 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</div>}

        {assets.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{assets.map((asset) => <div key={asset.id} className="group flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-2 py-1.5 text-xs text-zinc-300">{asset.asset_kind === "image" && asset.url ? <img src={asset.url} alt={asset.filename} className="h-8 w-8 rounded-lg object-cover" /> : <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-[9px] uppercase">{asset.asset_kind}</span>}<span className="max-w-36 truncate" title={asset.filename}>{asset.filename}</span><span className="text-zinc-600">{sizeLabel(asset.size_bytes)}</span><button type="button" aria-label={`Remove ${asset.filename}`} onClick={() => setAssets((current) => current.filter((item) => item.id !== asset.id))} className="text-zinc-600 hover:text-white"><X className="h-3.5 w-3.5" /></button></div>)}</div>}

        <div className="mt-3 flex flex-wrap gap-2">{starterPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => setInput(prompt)} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-400 hover:border-emerald-400/40 hover:text-zinc-200">{prompt}</button>)}</div>

        <form onSubmit={submit} className="mt-3 flex items-end gap-2 rounded-2xl border border-white/15 bg-[#11151c] p-2 shadow-2xl shadow-black/20">
          <input ref={fileInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,application/pdf" className="hidden" onChange={handleFiles} />
          <button type="button" aria-label="Attach creative media" onClick={() => fileInputRef.current?.click()} disabled={busy} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-500 hover:bg-white/5 hover:text-emerald-300 disabled:opacity-40"><Paperclip className="h-4 w-4" /></button>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} rows={1} placeholder={assets.length ? "Ask Hermes about the attached creative…" : "Tell Hermes what you want to do with your Meta Ads…"} className="max-h-36 min-h-10 flex-1 resize-none bg-transparent py-2 text-sm text-white outline-none placeholder:text-zinc-500" />
          <button type="submit" disabled={!input.trim() || busy || !tokenReady} aria-label="Send" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-400 text-black hover:bg-emerald-300 disabled:opacity-40"><Send className="h-4 w-4" /></button>
        </form>
        <p className="mt-2 text-center text-[11px] text-zinc-600">PropAI prepares actions for approval. Meta credentials stay server-side.</p>
        </>}
      </main>
    </div>
  );
}
