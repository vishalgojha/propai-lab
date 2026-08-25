import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export const metadata = {
  title: "Terms of Service — PropAI",
  description:
    "Terms governing use of PropAI property discovery, broker workspace, and advertising tools.",
};

export default function TermsOfServicePage() {
  return (
    <div className="www-shell min-h-screen text-white">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-10 lg:px-6 lg:py-16">
        <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-green-300">
          PropAI
        </p>
        <h1 className="mb-4 text-[32px] font-bold leading-tight lg:text-[44px]">
          Terms of Service
        </h1>
        <p className="mb-10 text-sm text-zinc-500">Last updated: 16 August 2026</p>

        <div className="space-y-9 text-[15px] leading-7 text-zinc-400 lg:text-[16px]">
          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">1. Using PropAI</h2>
            <p>
              These Terms govern your use of propai.live, app.propai.live, and
              related PropAI services. By using PropAI, you agree to these Terms
              and our Privacy Policy. If you use PropAI for a business or
              brokerage, you confirm that you have authority to accept these Terms
              for that organisation.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">2. Accounts and security</h2>
            <p>
              Keep your account details accurate and protect your login credentials.
              You are responsible for activity under your account and workspace.
              Tell us promptly if you believe your account or a connected
              integration has been accessed without permission.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">3. Listings and broker content</h2>
            <p>
              PropAI structures property information shared by brokers and their
              connected WhatsApp networks. Brokers are responsible for having the
              rights and permissions needed to share their content and for the
              accuracy, legality, availability, pricing, and representation of
              their listings. Buyers and tenants should independently verify
              property details directly with the broker.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">4. Advertising tools</h2>
            <p>
              PropAI may help authorised users draft, review, report on, and manage
              advertising campaigns through connected third-party platforms.
              Campaign actions that can spend money, publish content, change
              budgets, or change delivery require explicit user approval where
              supported. You remain responsible for campaign instructions,
              destination details, creative rights, compliance, and advertising
              spend charged by the connected platform.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">5. Acceptable use</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>Do not use PropAI for unlawful, fraudulent, abusive, or deceptive activity.</li>
              <li>Do not upload content that you do not have permission to use.</li>
              <li>Do not attempt to bypass access controls, rate limits, or workspace boundaries.</li>
              <li>Do not use automated access in a way that harms the service or other users.</li>
              <li>Do not represent PropAI, a broker, or a listing inaccurately.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">6. Third-party services</h2>
            <p>
              PropAI can connect to services such as WhatsApp infrastructure,
              Meta, hosting, storage, and authentication providers. Those services
              have separate terms and may control whether a connection is
              available. We are not responsible for outages, policy decisions, or
              changes made by a third-party platform.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">7. Availability and changes</h2>
            <p>
              We work to keep PropAI reliable, but the service may change,
              experience interruptions, or contain errors. We may update features
              and these Terms as the product evolves. Continued use after an
              update means you accept the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">8. Contact</h2>
            <p>
              Questions about these Terms can be sent to{" "}
              <a className="text-green-300 hover:text-green-200" href="mailto:hello@propai.live">
                hello@propai.live
              </a>
              . Do not send passwords, access tokens, or other secrets by email.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
