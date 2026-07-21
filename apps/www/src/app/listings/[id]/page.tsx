import { notFound, redirect } from "next/navigation";
import { getListingById } from "@/lib/localities";
import { buildListingSlug } from "@/lib/listing-card";

// Back-compat: old bare-numeric URLs like /listings/12345 301 to the canonical
// /listings/{slug}/12345 form. The canonical route handles the actual render;
// this file is purely a redirector so external sites that linked to bare ids
// don't 404.
export const dynamic = "force-dynamic";

export default async function LegacyListingRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) notFound();

  let listing;
  try {
    listing = await getListingById(numericId);
  } catch {
    notFound();
  }
  if (!listing) notFound();

  const slug = buildListingSlug({
    id: listing.id,
    bhk: listing.bhk,
    micro_market: listing.micro_market,
    building_name: listing.building_name,
    property_type: listing.property_type,
  });
  // 308 preserves the HTTP method on POST (safer than 301 for redirects that
  // might receive form submissions in the future). 301 is fine here — the page
  // is read-only — but 308 is the conventional modern choice for permanent
  // route changes.
  redirect(`/listings/${slug ?? numericId}/${numericId}`, "replace");
}
