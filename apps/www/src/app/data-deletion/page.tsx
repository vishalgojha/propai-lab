export const metadata = {
  title: "Data Deletion Instructions — PropAI",
  description: "How to request deletion of your PropAI account and personal data.",
};

export default function DataDeletionPage() {
  return (
    <main className="min-h-screen bg-black px-5 py-12 text-zinc-300 sm:px-8 lg:px-12">
      <article className="mx-auto max-w-3xl space-y-8 text-[15px] leading-7">
        <header>
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-green-300">PropAI</p>
          <h1 className="text-4xl font-bold text-white">Data Deletion Instructions</h1>
          <p className="mt-3 text-sm text-zinc-500">Last updated: 16 August 2026</p>
        </header>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Request deletion</h2><p>To request deletion of your PropAI account and personal data, email <a className="ml-1 text-green-300 hover:text-green-200" href="mailto:hello@propai.live?subject=PropAI%20data%20deletion%20request">hello@propai.live</a>. Use the subject “PropAI data deletion request” and include the email address associated with your account.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">What happens next</h2><p>We will verify the request, remove or anonymise eligible account data, and confirm completion by email. We may retain limited information where required by law, for security, fraud prevention, billing, or dispute resolution.</p></section>
        <section><h2 className="mb-2 text-xl font-semibold text-white">Connected services</h2><p>Removing PropAI data does not automatically delete information held by Meta, WhatsApp, or another connected platform. Please use that platform’s own privacy and deletion controls for data it maintains independently.</p></section>
      </article>
    </main>
  );
}
