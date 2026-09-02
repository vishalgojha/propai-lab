/* Design direction: Mumbai Editorial Utility — detail pages surface provenance, fit, and next action with the same light editorial hierarchy as the marketplace homepage. */

export type ListingKind = "Residential" | "Commercial";
export type ListingTransaction = "Rent" | "Sale";

export type ListingDetail = {
  id: string;
  slug: string;
  kind: ListingKind;
  transaction: ListingTransaction;
  city: string;
  locality: string;
  title: string;
  price: string;
  priceNote: string;
  freshness: string;
  source: string;
  summary: string;
  overview: Array<{ label: string; value: string }>;
  highlights: string[];
  brokerNote: string;
  related: string[];
};

export const listingDetails: ListingDetail[] = [
  {
    id: "30627",
    slug: "3-bhk-for-sale",
    kind: "Residential",
    transaction: "Sale",
    city: "Mumbai",
    locality: "Mumbai",
    title: "3 BHK for sale",
    price: "Price on request",
    priceNote: "Share your brief for current pricing and availability.",
    freshness: "Updated 21h ago",
    source: "Verified Mumbai broker network",
    summary: "A live residential sale brief shared through an active broker conversation. Ask for the current carpet area, photos, and viewing windows directly on WhatsApp.",
    overview: [
      { label: "Configuration", value: "3 BHK" },
      { label: "Carpet area", value: "On enquiry" },
      { label: "Furnishing", value: "On enquiry" },
      { label: "Possession / OC", value: "Ask broker" },
    ],
    highlights: ["Fresh broker conversation", "Current photos shared on WhatsApp", "Carpet area and OC details on enquiry"],
    brokerNote: "This listing is intentionally photo-light. The broker can share current photos, videos, and the latest availability after your enquiry.",
    related: ["Bandra West", "Khar West", "Santacruz West"],
  },
  {
    id: "9501",
    slug: "1-bhk-for-rent-kamal-pushpa-near-lilavati-hospital-reclamation-bandra-west-fully-furnished",
    kind: "Residential",
    transaction: "Rent",
    city: "Mumbai",
    locality: "Reclamation, Bandra West",
    title: "Fully furnished 1 BHK near Lilavati Hospital",
    price: "₹80,000 / month",
    priceNote: "Furnished rental brief; confirm deposit and move-in timing with the broker.",
    freshness: "Updated 21h ago",
    source: "Verified Mumbai broker network",
    summary: "A fully furnished 1 BHK at Kamal Pushpa near Lilavati Hospital, shared through an active rental conversation in Reclamation, Bandra West.",
    overview: [
      { label: "Configuration", value: "1 BHK" },
      { label: "Furnishing", value: "Fully furnished" },
      { label: "Carpet area", value: "On enquiry" },
      { label: "Jodi", value: "Ask broker" },
    ],
    highlights: ["Near Lilavati Hospital", "Fully furnished", "Direct broker WhatsApp handoff"],
    brokerNote: "Ask the broker for current photos, building rules, deposit details, and whether the adjoining unit can be paired as a Jodi.",
    related: ["Bandra West", "Khar West", "Santacruz West"],
  },
  {
    id: "4101",
    slug: "office-space-for-sale-bkc",
    kind: "Commercial",
    transaction: "Sale",
    city: "Mumbai",
    locality: "BKC, Mumbai",
    title: "Office space for sale in BKC",
    price: "₹12.80 Cr",
    priceNote: "Fitted office with current commercial availability to confirm.",
    freshness: "Updated 2h ago",
    source: "Verified Mumbai broker network",
    summary: "A fitted office space in BKC for an owner-occupier or investment brief. Connect with the broker for the floor plan, frontage, parking, and current OC status.",
    overview: [
      { label: "Asset type", value: "Office" },
      { label: "Area", value: "2,140 sqft" },
      { label: "Fit-out", value: "Fitted" },
      { label: "OC", value: "Available on enquiry" },
    ],
    highlights: ["BKC commercial location", "Fitted office condition", "Parking and floor plan via broker"],
    brokerNote: "Commercial details can shift quickly. Ask for the current floor plan, frontage, parking allocation, CAM, and OC documentation on WhatsApp.",
    related: ["BKC", "Andheri West", "Powai"],
  },
  {
    id: "6202",
    slug: "retail-rent-baner",
    kind: "Commercial",
    transaction: "Rent",
    city: "Pune",
    locality: "Baner, Pune",
    title: "Retail space for rent in Baner",
    price: "₹1.45L / month",
    priceNote: "Street-facing retail brief; confirm deposit, frontage, and permitted use.",
    freshness: "Updated 4h ago",
    source: "Verified Pune broker network",
    summary: "A street-facing retail space in Baner with a practical footprint for a growing local business. Ask the broker about frontage, permitted use, parking, and handover timing.",
    overview: [
      { label: "Asset type", value: "Retail" },
      { label: "Area", value: "980 sqft" },
      { label: "Frontage", value: "Street-facing" },
      { label: "Fit-out / OC", value: "Ask broker" },
    ],
    highlights: ["Baner, Pune", "Street-facing retail frontage", "Jodi and permitted use on enquiry"],
    brokerNote: "For commercial rent, confirm permitted use, signage rules, loading access, deposit, and whether adjoining space is available as a Jodi.",
    related: ["Baner", "Kalyani Nagar", "Koregaon Park"],
  },
];

export const listingById = Object.fromEntries(listingDetails.map((listing) => [listing.id, listing])) as Record<string, ListingDetail>;
