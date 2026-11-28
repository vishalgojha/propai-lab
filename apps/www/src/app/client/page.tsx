import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ClientSignupForm from "./ClientSignupForm";

const CLIENT_INSTINCT_MESSAGE =
  "I am a PropAI buyer or tenant, not a broker. Use PropAI's public REST API. First read https://api.propai.live/api/public/v1/docs, then search only the public shared-market listings. Never ask me for broker credentials, private WhatsApp data, source phone numbers, or workspace access. Open the public listing URL when I want to contact a broker.";

export const metadata = {
  title: "Client login | PropAI",
  description:
    "Create a client login to connect your own AI assistant to PropAI's public property search. Client logins have no access to broker workspaces or private broker data.",
};

export default function ClientPage() {
  return (
    <div className="www-shell min-h-screen text-white">
      <SiteHeader />
      <main className="www-page-main www-content-page max-w-2xl mx-auto px-4 lg:px-6 py-10 lg:py-16">
        <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold mb-4">
          Client <span className="text-green-400">login</span>
        </h1>
        <p className="text-zinc-400 mb-8 leading-relaxed">
          Buyers and tenants can connect their own assistant to PropAI&apos;s public property search. This is a
          client-only surface: it never opens a broker workspace, private WhatsApp data, or broker phone numbers.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          <section className="rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5">
            <h2 className="text-lg font-semibold text-white">Instinct</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              Send Instinct this instruction. It uses PropAI&apos;s account-free public REST search; no PropAI
              password or API key is needed.
            </p>
            <a
              href={`https://wa.me/16508702892?text=${encodeURIComponent(CLIENT_INSTINCT_MESSAGE)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex rounded-lg bg-green-400 px-4 py-2 text-sm font-semibold text-black"
            >
              Open Instinct
            </a>
            <p className="mt-3 break-words text-xs leading-5 text-zinc-500">
              API guide: https://api.propai.live/api/public/v1/docs
            </p>
          </section>
          <section className="rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5">
            <h2 className="text-lg font-semibold text-white">Any MCP client</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              Add this connector to Claude, ChatGPT, or another MCP-compatible assistant. It exposes only the
              buyer/tenant public market surface.
            </p>
            <code className="mt-4 block break-all rounded-lg border border-zinc-700 bg-black/30 p-3 text-sm text-green-300 select-all">
              https://mcp.propai.live/mcp
            </code>
          </section>
        </div>
        <div className="mt-6 rounded-xl border border-green-400/20 bg-green-400/5 p-4 text-sm leading-6 text-zinc-300">
          Your assistant can search fresh public listings and open a listing&apos;s WhatsApp contact route. It cannot
          read broker groups, private inventory, CRM records, raw messages, or other buyers&apos; requirements.
        </div>
        <ClientSignupForm />
        <div className="mt-10 text-zinc-400 leading-relaxed">
          <h2 className="text-lg font-semibold text-white mb-2">Connect your assistant</h2>
          <p className="mb-2">A client login is optional for public search. Create one if you want a client identity for future assistant features:</p>
          <code className="block font-mono text-sm text-green-300 break-all select-all">https://mcp.propai.live/mcp</code>
          <p className="mt-3">Your name and number are saved only for your own buyer/tenant follow-up request.</p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
