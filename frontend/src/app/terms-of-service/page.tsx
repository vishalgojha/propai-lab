export const metadata = {
  title: "Terms of Service — PropAI",
  description: "Terms governing use of PropAI property, broker, and advertising tools.",
};

export default function TermsOfServicePage() {
  return (
    <main className="min-h-screen bg-black px-5 py-12 text-zinc-300 sm:px-8 lg:px-12">
      <article className="mx-auto max-w-3xl space-y-8 text-[15px] leading-7">
        <header>
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-green-300">PropAI</p>
          <h1 className="text-4xl font-bold text-white">Terms of Service</h1>
          <p className="mt-3 text-sm text-zinc-500">Last updated: 16 August 2026</p>
        </header>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Using PropAI</h2><p>These Terms govern use of PropAI property discovery, broker workspace, and related services. By using PropAI, you agree to these Terms and our Privacy Policy.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Accounts</h2><p>Keep account details accurate and protect your login credentials. You are responsible for activity under your account and workspace and should promptly report unauthorised access.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Listings and broker content</h2><p>Brokers are responsible for having the rights to share content and for the accuracy, legality, availability, pricing, and representation of their listings. Buyers and tenants should verify property details directly with the broker.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Advertising tools</h2><p>PropAI may help authorised users draft, report on, and manage campaigns through connected platforms. Users remain responsible for campaign instructions, creative rights, compliance, and advertising spend charged by those platforms.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Acceptable use</h2><p>Do not use PropAI for unlawful, fraudulent, abusive, or deceptive activity; upload content without permission; bypass access controls; or use automated access in a way that harms the service or other users.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Availability and contact</h2><p>Features may change and the service may experience interruptions. Questions about these Terms can be sent to <a className="text-green-300 hover:text-green-200" href="mailto:hello@propai.live">hello@propai.live</a>. Do not send passwords or access tokens by email.</p></section>
      </article>
    </main>
  );
}
