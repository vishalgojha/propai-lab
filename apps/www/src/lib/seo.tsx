import type { Metadata } from "next";

// Generic, XSS-safe JSON-LD injector. Renders a <script type="application/ld+json">
// with the supplied object serialized to JSON. Used for GEO/AEO structured data
// so Google AI Mode and LLMs (ChatGPT, Perplexity) can cite PropAI's listings.
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // JSON.stringify output is safe inside a script tag for our structured objects.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function getSiteUrl(): string {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_SITE_URL) {
    try {
      return new URL(process.env.NEXT_PUBLIC_SITE_URL).origin;
    } catch {
      /* fall through */
    }
  }
  return "https://www.propai.live";
}

type OrgInput = {
  url: string;
  name?: string;
  description?: string;
};

export function buildOrganization({ url, name = "PropAI", description }: OrgInput) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name,
    url,
    description:
      description ||
      "PropAI reads live WhatsApp broker group conversations to build verified, fresh property listings and routes every enquiry directly to the posting broker.",
    logo: `${url}/pwa-512x512.png`,
    sameAs: ["https://app.propai.live"],
  };
}

export function buildWebSite(url: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "PropAI",
    url,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${url}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export function buildBreadcrumb(url: string, trail: Array<{ name: string; url: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: t.name,
      item: t.url.startsWith("http") ? t.url : `${url}${t.url}`,
    })),
  };
}

type ListingSchemaInput = {
  url: string;
  id: number | string;
  title: string;
  description: string;
  price: number | null;
  priceCurrency: string;
  dealType: "For rent" | "For sale";
  bedrooms?: string | null;
  areaSqft?: number | null;
  address?: string | null;
  locality?: string | null;
  brokerName?: string | null;
  datePosted?: string | null;
};

export function buildRealEstateListing(input: ListingSchemaInput) {
  const offer: Record<string, unknown> = {
    "@type": "Offer",
    priceCurrency: input.priceCurrency,
    availability: "https://schema.org/InStock",
  };
  if (input.price != null) offer.price = input.price;
  if (input.dealType === "For rent") offer.leaseLength = "P1M";

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    name: input.title,
    description: input.description,
    url: input.url,
    datePosted: input.datePosted || undefined,
    offer,
  };
  if (input.bedrooms) schema.numberOfRooms = input.bedrooms;
  if (input.areaSqft != null) schema.floorSize = { "@type": "QuantitativeValue", value: input.areaSqft, unitCode: "SQF" };
  if (input.address || input.locality) {
    schema.address = {
      "@type": "PostalAddress",
      addressLocality: input.locality || undefined,
      streetAddress: input.address || undefined,
      addressCountry: "IN",
    };
  }
  if (input.brokerName) {
    schema.broker = {
      "@type": "RealEstateAgent",
      name: input.brokerName,
    };
  }
  return schema;
}

type LocalitySchemaInput = {
  url: string;
  name: string;
  description: string;
  listingCount: number;
};

export function buildLocalBusiness(input: LocalitySchemaInput) {
  return {
    "@context": "https://schema.org",
    "@type": "RealEstateAgent",
    name: `PropAI — ${input.name}`,
    url: input.url,
    description: input.description,
    areaServed: input.name,
    knowsAbout: "Residential and commercial property listings sourced from live broker WhatsApp networks",
    aggregateRating: undefined,
    ...(input.listingCount > 0
      ? { potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${input.url}?q=${encodeURIComponent(input.name)}` }, "query-input": "required name=search_term_string" } }
      : {}),
  };
}

export function buildFaqPage(items: Array<{ question: string; answer: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((q) => ({
      "@type": "Question",
      name: q.question,
      acceptedAnswer: { "@type": "Answer", text: q.answer },
    })),
  };
}

export const NOINDEX: Metadata["robots"] = {
  index: false,
  follow: true,
};
