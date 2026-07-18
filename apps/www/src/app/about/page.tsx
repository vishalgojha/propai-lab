import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export const metadata = {
  title: "About PropAI — Real Listings from Mumbai's Broker WhatsApp Groups",
  description:
    "Most listings online are old. PropAI reads the WhatsApp groups where Mumbai's brokers actually work, shows how many groups corroborate each listing, and auto-hides anything untouched for 30 days. No stale photos — message the broker for current ones.",
};

export default async function AboutPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="max-w-3xl mx-auto px-4 lg:px-6 py-10 lg:py-16">
        <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-6">
          About <span className="text-green-400">PropAI</span>
        </h1>

        <div className="space-y-8 text-[15px] lg:text-[17px] text-zinc-400 leading-relaxed">
          <p>
            Most property listings you find online are old. A broker posts a flat
            in a WhatsApp group, it gets forwarded twenty times, and three weeks
            later it&apos;s still floating around the internet — except it&apos;s
            already been rented out.
          </p>
          <p>
            PropAI reads the WhatsApp groups where Mumbai&apos;s brokers actually
            work. Every listing you see here came from a real broker, in a real
            conversation, usually within the last few days. We show you how many
            separate broker groups have mentioned it and when it was last seen —
            so instead of trusting one listing, you&apos;re seeing what&apos;s
            actually corroborated across the market right now. Anything untouched
            for 30 days gets auto-hidden. What you see is what&apos;s live today,
            not what was live sometime this month.
          </p>
          <div>
            <h2 className="text-lg lg:text-xl font-semibold text-white mb-3">
              Why there are no photos.
            </h2>
            <p>
              This inventory turns over daily. A photo shot when a flat was first
              listed is often wrong by the time you&apos;d see it — wrong
              furnishing, wrong price, sometimes a different flat entirely. Instead
              of stale photos, every listing routes straight to the broker who&apos;s
              actually holding it — message them on WhatsApp and they&apos;ll send
              you real, current photos, video walkthroughs, and tell you what&apos;s
              actually still available.
            </p>
          </div>
          <p>
            <span className="text-white font-medium">Direct to broker, no middleman chatbot.</span>{" "}
            Your enquiry goes straight to a real person who calls you back. No forms
            that go nowhere, no chatbot standing between you and the person who has
            the keys.
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
