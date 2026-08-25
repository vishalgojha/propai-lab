import { redirect } from "next/navigation";

// Preserve the legacy/live-inventory URL used by older homepage builds and
// bookmarks. Public search is the canonical listings destination.
export default function MarketListingsRedirect() {
  redirect("/search");
}
