import { redirect } from "next/navigation";

/**
 * Keep old bookmarks working while extraction activity remains the single
 * workspace-scoped view for backlog progress and extraction review.
 */
export default function AdminExtractionProgressRedirect() {
  redirect("/extractions");
}
