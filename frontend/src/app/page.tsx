import type { Metadata } from "next";
import BrokerLandingClient from "./BrokerLandingClient";

export const metadata: Metadata = {
  title: "Property Management Software for Brokers | PropAI",
  description:
    "PropAI helps Indian real-estate brokers turn WhatsApp conversations into searchable listings, client requirements, matches, and follow-ups in one workspace.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Property Management Software for Brokers | PropAI",
    description:
      "Organise your WhatsApp property network into a searchable broker workspace for listings, requirements, matches, and deals.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export default function BrokerLandingPage() {
  return <BrokerLandingClient />;
}
