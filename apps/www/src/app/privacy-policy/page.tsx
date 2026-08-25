import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export const metadata = {
  title: "Privacy Policy — PropAI",
  description:
    "How PropAI collects, uses, stores, and protects information across its property discovery and broker tools.",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="www-shell min-h-screen text-white">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-10 lg:px-6 lg:py-16">
        <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-green-300">
          PropAI
        </p>
        <h1 className="mb-4 text-[32px] font-bold leading-tight lg:text-[44px]">
          Privacy Policy
        </h1>
        <p className="mb-10 text-sm text-zinc-500">Last updated: 16 August 2026</p>

        <div className="space-y-9 text-[15px] leading-7 text-zinc-400 lg:text-[16px]">
          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">1. About this policy</h2>
            <p>
              PropAI (“PropAI”, “we”, “us”, or “our”) helps people discover fresh
              property listings shared by real estate brokers and helps brokers
              manage enquiries and advertising workflows. This policy explains
              what information we collect, why we use it, and the choices available
              to you when you use propai.live, app.propai.live, or our related tools.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">2. Information we collect</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="text-zinc-200">Account information:</span> name,
                email address, workspace details, and authentication records when
                you create or use a broker account.
              </li>
              <li>
                <span className="text-zinc-200">Broker network content:</span>{" "}
                messages, listing details, media, and metadata shared through
                connected WhatsApp broker groups and submitted through our tools.
              </li>
              <li>
                <span className="text-zinc-200">Connected services:</span> when you
                choose to connect Meta or another service, we receive only the
                permissions and account data authorised through that service.
              </li>
              <li>
                <span className="text-zinc-200">Technical information:</span> device,
                browser, log, security, and approximate usage information needed to
                operate and protect the service.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">3. How we use information</h2>
            <p>We use information to:</p>
            <ul className="mt-2 list-disc space-y-2 pl-5">
              <li>provide search, listing, broker, workspace, and advertising features;</li>
              <li>extract and organise property facts from broker messages;</li>
              <li>keep listings fresh, prevent abuse, and secure accounts;</li>
              <li>create reports and recommendations requested by a broker; and</li>
              <li>communicate about service, security, or account changes.</li>
            </ul>
            <p className="mt-3">
              We do not sell personal information. PropAI is a discovery layer and
              does not insert itself into a buyer’s direct WhatsApp relationship
              with a broker.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">4. WhatsApp and broker data</h2>
            <p>
              PropAI processes messages and media from connected broker networks to
              structure searchable inventory and support broker workflows. We limit
              access by workspace, retain operational records only as needed for
              the service, and do not publish private message content as a public
              listing. Public listings are derived from broker activity and may be
              hidden when they become stale.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">5. Meta and other integrations</h2>
            <p>
              If you connect Meta Ads or another third-party service, that service’s
              own terms and privacy policy also apply. PropAI stores connection
              credentials server-side using access controls and encryption, uses
              them only for the workspace features you authorise, and does not
              display access tokens in the browser. You can disconnect an
              integration from the relevant workspace or contact us for help.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">6. Sharing and service providers</h2>
            <p>
              We share information only with providers that help us host, secure,
              authenticate, store, analyse, or deliver the service, and with
              connected platforms when you authorise an integration. Providers are
              expected to protect information and process it for the agreed
              purpose. We may also disclose information when required by law or to
              protect users, the service, or our rights.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">7. Your choices</h2>
            <p>
              You may ask us to access, correct, export, or delete personal
              information associated with your account, subject to records we must
              keep for legal, security, or operational reasons. You can also revoke
              a connected service’s access through that service’s settings.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">8. Contact us</h2>
            <p>
              For privacy questions or requests, email{" "}
              <a className="text-green-300 hover:text-green-200" href="mailto:hello@propai.live">
                hello@propai.live
              </a>
              . Please include enough information for us to identify your account,
              but do not send passwords, access tokens, or other secrets.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
