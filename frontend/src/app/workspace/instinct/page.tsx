import Link from "next/link";

export default function InstinctWorkspacePage() {
  return <section className="mx-auto max-w-2xl px-4 pb-12 pt-8 lg:px-6">
    <p className="mb-3 text-sm text-zinc-400">Your assistant</p>
    <h1 className="text-3xl font-semibold text-white">Connect my assistant</h1>
    <p className="mt-4 text-base leading-7 text-zinc-300">Let Instinct read the PropAI information you allow, so you can ask for help in your chat.</p>
    <div className="mt-7 rounded-2xl border border-white/10 bg-zinc-950 p-6">
      <h2 className="text-lg font-semibold text-white">Connection setup is not available yet</h2>
      <p className="mt-3 text-sm leading-6 text-zinc-300">We are checking the complete sign-in and connection flow before opening setup. You do not need to copy credentials or change anything now.</p>
      <button type="button" disabled className="mt-5 inline-flex min-h-12 items-center justify-center rounded-lg border border-white/20 px-5 py-3 font-semibold text-zinc-400 disabled:cursor-not-allowed">Connect my assistant, coming soon</button>
      <p className="mt-3 text-xs leading-5 text-zinc-400">Existing connections are not changed. You can review or remove their access in Advanced settings below.</p>
    </div>
    <p className="mt-6 text-sm leading-6 text-zinc-400">This does not share your groups, add other brokers' data, include private direct messages or allow changes to your records. Those choices stay separate.</p>
    <details className="mt-7 rounded-xl border border-white/10 p-4 text-sm text-zinc-400">
      <summary className="min-h-11 cursor-pointer py-3 font-semibold text-zinc-200">Advanced connection settings</summary>
      <p className="mt-2 leading-6">Existing connections keep working. Use these settings to review or remove access, or for technical setup with another assistant.</p>
      <Link href="/workspace/mcp" className="mt-3 inline-block min-h-11 py-3 text-emerald-300">Manage existing connections</Link>
    </details>
  </section>;
}
