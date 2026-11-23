import Link from "next/link";
import { ArrowRight, CheckCircle2, ExternalLink, KeyRound, MessageCircle } from "lucide-react";

export default function InstinctWorkspacePage() {
  return (
    <section className="mx-auto max-w-4xl px-4 pb-12 pt-8 lg:px-6">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Assistant connection</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Connect Instinct to PropAI</h1>
        <p className="mt-3 text-base leading-7 text-zinc-400">Ask Instinct to connect, approve the request once, and then search your selected WhatsApp groups from Instinct.</p>
      </div>
      <div className="mt-8 rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.07] p-6 sm:p-7">
        <div className="flex items-start gap-4"><div className="rounded-xl border border-emerald-300/25 bg-emerald-300/10 p-3 text-emerald-200"><MessageCircle className="h-6 w-6" aria-hidden="true" /></div><div><h2 className="text-xl font-semibold text-white">Three quick steps</h2><p className="mt-1 text-sm leading-6 text-zinc-400">You do not need to create, copy, or paste an API key for the normal connection.</p></div></div>
        <ol className="mt-6 grid gap-3 sm:grid-cols-3">
          {[["1", "Open Instinct", "Open Instinct and say: “Connect my PropAI workspace.”"], ["2", "Open its link", "Instinct will send a secure PropAI connection link."], ["3", "Approve access", "Sign in to PropAI, check the code, and tap Approve."]].map(([number, title, copy]) => <li key={number} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-center gap-3"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-300 text-sm font-bold text-black">{number}</span><span className="font-semibold text-white">{title}</span></div><p className="mt-3 text-sm leading-6 text-zinc-400">{copy}</p></li>)}
        </ol>
        <a href="https://app.instinct.com" target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-2 rounded-lg bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-black hover:bg-emerald-200">Open Instinct <ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><div className="flex items-center gap-2 text-sm font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" aria-hidden="true" /> Instinct can help with</div><p className="mt-3 text-sm leading-6 text-zinc-400">Searching listings, reading captured messages from your selected groups, finding matches, and working with your PropAI workspace data.</p></div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><div className="flex items-center gap-2 text-sm font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" aria-hidden="true" /> Your data stays scoped</div><p className="mt-3 text-sm leading-6 text-zinc-400">Instinct uses this workspace and its selected WhatsApp groups. Private WhatsApp chats are not captured or exposed.</p></div>
      </div>
      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5"><h2 className="text-base font-semibold text-white">Try this after connecting</h2><p className="mt-2 rounded-lg border border-white/10 bg-black/20 px-4 py-3 text-sm text-emerald-200">“Find me a 2 BHK for rent in Bandra West from my WhatsApp groups.”</p></div>
      <details className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5"><summary className="flex cursor-pointer list-none items-center gap-3 text-sm font-semibold text-zinc-300"><KeyRound className="h-4 w-4 text-zinc-500" aria-hidden="true" /> Advanced/manual connection settings</summary><div className="mt-4 border-t border-white/10 pt-4 text-sm leading-6 text-zinc-400"><p>Manual API-key setup is only for technical integrations or troubleshooting. It is not required for the normal Instinct approval flow.</p><Link href="/workspace/mcp" className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/[0.06]">Open advanced integrations <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link></div></details>
    </section>
  );
}
