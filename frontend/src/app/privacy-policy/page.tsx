export const metadata = {
  title: "Privacy Policy — PropAI",
  description: "How PropAI handles information across its property and broker tools.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-black px-5 py-12 text-zinc-300 sm:px-8 lg:px-12">
      <article className="mx-auto max-w-3xl space-y-8 text-[15px] leading-7">
        <header>
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-green-300">PropAI</p>
          <h1 className="text-2xl font-bold leading-tight text-white sm:text-4xl">Privacy Policy</h1>
          <p className="mt-3 text-sm text-zinc-500">Last updated: 16 August 2026</p>
        </header>
        <section><h2 className="mb-2 text-xl font-semibold text-white">About this policy</h2><p>PropAI helps people discover fresh property listings shared by real estate brokers and helps brokers manage enquiries and advertising workflows. This policy explains what information we collect, why we use it, and your choices when using PropAI.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Information we collect</h2><p>We may collect account and workspace details, broker messages and listing media from connected WhatsApp networks, information from services you choose to connect such as Meta, and technical and security information needed to operate the service.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">How we use information</h2><p>We use information to provide search, listing, broker, workspace, and advertising features; structure property facts; keep listings fresh; prevent abuse; secure accounts; and provide reports or recommendations requested by a broker. We do not sell personal information.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">WhatsApp and integrations</h2><p>PropAI processes content from connected broker networks to organise searchable inventory and support broker workflows. Connected service credentials are stored server-side with access controls and encryption. Third-party services have their own terms and privacy policies.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Your choices</h2><p>You may ask us to access, correct, export, or delete personal information associated with your account, subject to records we must retain for legal, security, or operational reasons. You can also revoke connected services through their settings.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Contact</h2><p>For privacy questions or requests, email <a className="text-green-300 hover:text-green-200" href="mailto:hello@propai.live">hello@propai.live</a>. Do not send passwords, access tokens, or other secrets.</p></section>
      </article>
    </main>
  );
}
