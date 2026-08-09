"use client";

import { FormEvent, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Megaphone, ShieldCheck, Sparkles } from "lucide-react";
import { getAccessToken } from "@/lib/auth";

type SdkResponse = {
  ok?: boolean;
  data?: any;
  error?: { message?: string } | null;
  meta?: { requiresApproval?: boolean; approvalToken?: string | null };
};

async function sdkRequest(path: string, method = "GET", body?: Record<string, unknown>) {
  const token = await getAccessToken();
  const response = await fetch(`/api/social-flow${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as SdkResponse;
  if (!response.ok) throw new Error(payload.error?.message || "Social Flow service is unavailable.");
  return payload;
}

export default function SocialFlowPage() {
  const [brief, setBrief] = useState("");
  const [budget, setBudget] = useState("500");
  const [destination, setDestination] = useState("whatsapp");
  const [pageId, setPageId] = useState("");
  const [adAccountId, setAdAccountId] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [metaToken, setMetaToken] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);

  useEffect(() => {
    sdkRequest("/api/sdk/actions", "GET").catch((error) => setStatus(error.message));
  }, []);

  async function run(action: string, event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setStatus(action === "realtor_create_campaign" ? "Creating paused campaign…" : "Working…");
    try {
      const payload = {
        text: brief,
        dailyBudgetInr: Number(budget) || 500,
        destination,
        status: "PAUSED",
        pageId,
        adAccountId,
        whatsappNumber: whatsapp,
      };
      const shouldExecute = action === "realtor_create_campaign" && Boolean(approvalToken);
      const response = await sdkRequest(`/api/sdk/actions/${shouldExecute ? "execute" : "plan"}`, "POST", {
        action,
        params: payload,
        ...(shouldExecute ? { approvalToken, approvalReason: "Approved by PropAI broker" } : {}),
      });
      setResult(response.data ?? response);
      setApprovalToken(shouldExecute ? null : response.meta?.approvalToken || response.data?.approvalToken || null);
      setStatus(response.meta?.requiresApproval ? "Review required before campaign creation" : "Completed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveMetaSetup(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("Saving Meta connection…");
    try {
      const response = await sdkRequest("/api/config/update", "POST", {
        defaultApi: "facebook",
        tokens: metaToken ? { facebook: metaToken } : {},
        defaults: { facebookPageId: pageId, marketingAdAccountId: adAccountId },
      });
      setMetaToken("");
      setResult(response.data ?? response);
      setStatus("Meta connection saved securely");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save Meta connection");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
            <Megaphone className="h-4 w-4" /> Growth
          </div>
          <h1 className="text-2xl font-semibold text-white">Realtor Ads Studio</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">Turn a PropAI listing or plain property brief into a housing-compliant Meta campaign. Review everything first; campaigns are created paused.</p>
        </div>
          <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
          <ShieldCheck className="h-4 w-4" /> Meta policy checks enabled
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <form onSubmit={(event) => run("realtor_build", event)} className="rounded-2xl border border-white/10 bg-surface p-5">
          <div className="mb-4 flex items-center justify-between">
            <div><h2 className="font-medium text-white">Campaign brief</h2><p className="mt-1 text-xs text-zinc-500">Use a saved listing description or write the property details.</p></div>
            <Sparkles className="h-5 w-5 text-accent" />
          </div>
          <textarea value={brief} onChange={(event) => setBrief(event.target.value)} required rows={7} className="w-full resize-y rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-accent" placeholder="3 BHK at Deepak Silverline, Bandra West. Fully furnished, sea view, ₹2.5 lakh/month. Contact on WhatsApp." />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-zinc-400">Daily budget (₹)<input value={budget} onChange={(event) => setBudget(event.target.value)} type="number" min="100" className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /></label>
            <label className="text-xs text-zinc-400">Destination<select value={destination} onChange={(event) => setDestination(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white"><option value="whatsapp">WhatsApp</option><option value="lead_form">Lead form</option></select></label>
            <label className="text-xs text-zinc-400">Facebook Page ID<input value={pageId} onChange={(event) => setPageId(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="Optional" /></label>
            <label className="text-xs text-zinc-400">Ad Account ID<input value={adAccountId} onChange={(event) => setAdAccountId(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="act_…" /></label>
            <label className="text-xs text-zinc-400 sm:col-span-2">WhatsApp destination<input value={whatsapp} onChange={(event) => setWhatsapp(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="+91…" /></label>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-50">Build brief</button>
            <button type="button" disabled={busy} onClick={() => run("realtor_preview")} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white disabled:opacity-50">Preview campaign</button>
            <button type="button" disabled={busy} onClick={() => run("realtor_create_campaign")} className="rounded-lg border border-amber-400/30 px-4 py-2 text-sm text-amber-200 disabled:opacity-50">Create paused campaign</button>
          </div>
          {approvalToken && <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">Approval token received. Press “Create paused campaign” again to confirm.</div>}
        </form>

        <div className="space-y-4">
          <form onSubmit={saveMetaSetup} className="rounded-2xl border border-white/10 bg-surface p-5"><h2 className="font-medium text-white">Meta connection</h2><p className="mt-1 text-xs leading-5 text-zinc-500">Your token is sent only to the protected Social Flow service and is never rendered back to the browser.</p><label className="mt-3 block text-xs text-zinc-400">Meta access token<input value={metaToken} onChange={(event) => setMetaToken(event.target.value)} type="password" autoComplete="off" className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="EAAG…" /></label><button disabled={busy || !metaToken} className="mt-3 rounded-lg border border-white/10 px-3 py-2 text-xs text-white disabled:opacity-50">Save Meta connection</button></form>
          <div className="rounded-2xl border border-white/10 bg-surface p-5"><h2 className="font-medium text-white">Studio status</h2><div className="mt-3 flex items-center gap-2 text-sm text-zinc-300"><CheckCircle2 className="h-4 w-4 text-accent" /> {status}</div><p className="mt-3 text-xs leading-5 text-zinc-500">Meta credentials stay on the protected Social Flow service. PropAI only sends the campaign brief and displays the approval result.</p></div>
          <div className="rounded-2xl border border-white/10 bg-surface p-5"><h2 className="font-medium text-white">What happens next?</h2><ol className="mt-3 space-y-2 text-xs leading-5 text-zinc-400"><li>1. PropAI builds a campaign plan and applies Meta&apos;s applicable policy checks.</li><li>2. You inspect the targeting and payload.</li><li>3. Campaign is created paused and can be activated from Meta.</li></ol></div>
        </div>
      </div>
      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-5"><div className="mb-3 flex items-center justify-between"><h2 className="font-medium text-white">Studio response</h2><ExternalLink className="h-4 w-4 text-zinc-500" /></div><pre className="max-h-[520px] overflow-auto whitespace-pre-wrap text-xs leading-5 text-zinc-400">{result ? JSON.stringify(result, null, 2) : "Build a brief or preview a campaign to see the structured result here."}</pre></div>
    </div>
  );
}
