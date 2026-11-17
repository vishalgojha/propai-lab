import { redirect } from "next/navigation";

// Retired broker UI. Keep old bookmarks safe without changing stored records.
export default function RetiredDealsPage() {
  redirect("/dashboard");
}
