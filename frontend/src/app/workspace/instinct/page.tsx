import Link from "next/link";
import { KeyRound } from "lucide-react";

export default function InstinctWorkspacePage() {
  return (
    <section className="mx-auto max-w-4xl px-4 pb-12 pt-8 lg:px-6">
      <h1 className="mb-1 text-2xl font-semibold text-white">Instinct</h1>
      <p className="mb-6 text-sm text-zinc-500">Connect Instinct to this workspace through the tenant-scoped REST API.</p>

      <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-amber-200"><KeyRound className="h-5 w-5" aria-hidden="true" /></div>
          <div><h2 className="text-lg font-semibold text-white">Connect Instinct</h2><p className="mt-1 text-sm leading-6 text-zinc-400">To connect Instinct, ask your assistant to connect to PropAI. Open the connection link it sends, sign in with your usual PropAI email and password, check the code and tap Approve. That&apos;s the whole setup: no API key to create or copy, and no token ever appears in chat. Access is read-only by default; private CRM writes require separate approval.</p></div>
        </div>
        <p className="mt-4 text-sm leading-6 text-zinc-400">Private DMs need both workspace consent and DM permission on the key. A new connection doesn&apos;t automatically include DM access.</p>
        <p className="mt-4 text-sm leading-6 text-zinc-400">Manual setup remains available as a fallback: it uses a separate API key created on the Integrations page, not your PropAI password. Your PropAI email and password alone are not an API connection, and saving them in a vault does not connect anything. Save the one-time key securely, never in chat. Existing connections keep working.</p>
        <h3 className="mt-5 text-sm font-semibold text-white">Manual setup</h3>
        <div className="mt-3 grid gap-3 text-sm text-zinc-300 sm:grid-cols-3"><div><div className="font-semibold text-white">Base URL</div><code className="mt-1 block text-xs text-amber-200">https://api.propai.live</code></div><div><div className="font-semibold text-white">Inventory</div><code className="mt-1 block text-xs text-zinc-400">/api/external/v1/listings/search</code></div><div><div className="font-semibold text-white">Matches</div><code className="mt-1 block text-xs text-zinc-400">/api/external/v1/matches</code></div></div>
        <p className="mt-4 text-xs leading-5 text-zinc-400">Manual setup: save the one-time token in Instinct Vault as a password/secret named <code className="text-amber-200">PROPAI_API_KEY</code>. Use endpoint <code className="text-amber-200">https://api.propai.live/api/external/v1</code> and send it as <code className="text-amber-200">X-API-Key</code> or <code className="text-amber-200">Authorization: Bearer</code>.</p>
        <Link href="/workspace/mcp" className="mt-5 inline-flex items-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-300/10">Create a token manually on the Integrations page</Link>
      </div>

      <div className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-6">
        <h2 className="text-lg font-semibold text-white">Watch the connection walkthrough</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-400">68 seconds: save your PropAI login in Instinct Vault, ask Instinct to connect, then approve access. Private account details are hidden.</p>
        <div className="mx-auto mt-4 max-w-xs overflow-hidden rounded-xl border border-amber-300/20">
          <video controls preload="metadata" playsInline className="block w-full" aria-label="PropAI Instinct connection walkthrough">
            <source src="/videos/propai-connect-v2.mp4" type="video/mp4" />
            Your browser does not support the Instinct connection walkthrough video.
          </video>
        </div>
      </div>
    </section>
  );
}
