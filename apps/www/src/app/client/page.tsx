import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ClientSignupForm from "./ClientSignupForm";

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
          A client login lets you connect Instinct or another MCP-compatible assistant to PropAI&apos;s public
          property search under your own account. It gives access to the public shared-market search only. It does
          not open any broker workspace or private broker data, and broker phone numbers are not shown. To reach a
          broker, use the contact button on a listing.
        </p>
        <ClientSignupForm />
        <div className="mt-10 text-zinc-400 leading-relaxed">
          <h2 className="text-lg font-semibold text-white mb-2">Connect your assistant</h2>
          <p className="mb-2">After you confirm your email, add this connector URL to your assistant and sign in when it asks:</p>
          <code className="block font-mono text-sm text-green-300 break-all select-all">https://mcp.propai.live/mcp</code>
          <p className="mt-3">Your name and number are saved with your login so PropAI can follow up on your search.</p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
