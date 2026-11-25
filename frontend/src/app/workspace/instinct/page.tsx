import Link from "next/link";
import InstinctManualSetup from "@/components/InstinctManualSetup";
import { INSTINCT_SETUP_MESSAGE, INSTINCT_WHATSAPP_URL } from "@/lib/instinctHandoff";
import { ArrowRight, CheckCircle2, ExternalLink, KeyRound, MessageCircle } from "lucide-react";

export default function InstinctWorkspacePage() {
  return (
    <section className="mx-auto max-w-4xl px-4 pb-12 pt-8 lg:px-6">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Broker assistant</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Connect Instinct to your workspace</h1>
        <p className="mt-3 text-base leading-7 text-zinc-400">Instinct helps with the whole brokerage workflow. Connect PropAI when you want Instinct to use your permitted property evidence and workspace records.</p>
      </div>
      <div className="mt-8 rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.07] p-6 sm:p-7">
        <div className="flex items-start gap-4"><div className="rounded-xl border border-emerald-300/25 bg-emerald-300/10 p-3 text-emerald-200"><MessageCircle className="h-6 w-6" aria-hidden="true" /></div><div><h2 className="text-xl font-semibold text-white">Three quick steps</h2><p className="mt-1 text-sm leading-6 text-zinc-400">You do not need to create, copy, or paste an API key for the normal connection.</p></div></div>
        <ol className="mt-6 grid gap-3 sm:grid-cols-3">
          {[["1", "Send the request", "Tap the WhatsApp button below. Review the prefilled message, then tap Send."], ["2", "Open the approval link", "Your assistant sends a secure PropAI link. Open that link, not Instinct account settings."], ["3", "Sign in and approve", "Sign in at app.propai.live, check the requested access and code, then tap Approve. Return to your chat for the connection check."]].map(([number, title, copy]) => <li key={number} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-center gap-3"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-300 text-sm font-bold text-black">{number}</span><span className="font-semibold text-white">{title}</span></div><p className="mt-3 text-sm leading-6 text-zinc-400">{copy}</p></li>)}
        </ol>
        <a href={INSTINCT_WHATSAPP_URL} style={{ color: "#052e24" }} target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-2 rounded-lg bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-black hover:bg-emerald-200">Open Instinct in WhatsApp <ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
        <p className="mt-3 text-sm leading-6 text-zinc-400">This opens WhatsApp with a message ready to send. Nothing is sent or connected until you act.</p>
        <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-sm font-semibold text-white">Already use Instinct on iMessage or another channel?</p><p className="mt-2 text-sm leading-6 text-zinc-400">Send this in your existing Instinct chat. You do not need to add a website in Instinct account settings.</p><p className="mt-3 select-all break-words rounded-lg border border-white/10 p-3 text-sm leading-6 text-emerald-200">{INSTINCT_SETUP_MESSAGE}</p></div>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><div className="flex items-center gap-2 text-sm font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" aria-hidden="true" /> Instinct can work like a broker colleague</div><p className="mt-3 text-sm leading-6 text-zinc-400">Search listings, requirements, matches, buildings, brokers, and market signals; read the original WhatsApp group evidence; explain why a result matched; and compare options.</p></div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><div className="flex items-center gap-2 text-sm font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" aria-hidden="true" /> PropAI stays scoped</div><p className="mt-3 text-sm leading-6 text-zinc-400">When connected, PropAI provides this workspace and its permitted group evidence. Private WhatsApp chats are not captured or exposed.</p></div>
      </div>
      <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-base font-semibold text-white">Useful things to ask it to do</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {["Find 2 BHK rentals in Bandra under ₹1.5 lakh and show the source groups.", "Turn this WhatsApp thread into listing, buyer, and follow-up candidates.", "Match this buyer requirement to my workspace and broker-network inventory.", "Save this confirmed requirement or listing privately in my CRM.", "Set a callback or site-visit follow-up for this lead.", "Create WhatsApp, Instagram, and portal ad drafts—do not send or publish them."].map((prompt) => <p key={prompt} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm leading-5 text-zinc-300">“{prompt}”</p>)}
        </div>
      </div>
      <div className="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.04] p-5">
        <h2 className="text-base font-semibold text-white">What remains under your control</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">CRM saves, sensitive details, and other protected changes can require your approval. The assistant cannot see another tenant&apos;s private data, send WhatsApp messages, delete records, change permissions, or publish directly just because it was asked in chat.</p>
      </div>
      <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.04] p-5">
        <h2 className="text-base font-semibold text-white">Help across the whole brokerage</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">Use Instinct for client briefs, visits, negotiation, paperwork, marketing, administration, web and project research, spreadsheet analysis, Excel-ready reports, broker emails, and property photo or video work. PropAI is one connected workspace inside that wider assistant workflow.</p>
      </div>
      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5"><h2 className="text-base font-semibold text-white">Try this after connecting</h2><p className="mt-2 rounded-lg border border-white/10 bg-black/20 px-4 py-3 text-sm text-emerald-200">“Find me a 2 BHK for rent in Bandra West from my WhatsApp groups.”</p></div>
      <details className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5"><summary className="flex cursor-pointer list-none items-center gap-3 text-sm font-semibold text-zinc-300"><KeyRound className="h-4 w-4 text-zinc-500" aria-hidden="true" /> Advanced/manual connection settings</summary><div className="mt-4 border-t border-white/10 pt-4 text-sm leading-6 text-zinc-400"><p>Manual API-key setup is only for technical integrations or troubleshooting. It is not required for the normal Instinct approval flow.</p><div className="mt-4"><InstinctManualSetup /></div><Link href="/workspace/mcp" className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/[0.06]">Open advanced integrations <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link></div></details>
    </section>
  );
}
