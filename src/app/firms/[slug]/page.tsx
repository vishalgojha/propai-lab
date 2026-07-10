"use client";

import { useParams } from "next/navigation";
import GenericEntityProfile from "@/components/GenericEntityProfile";
import { labelFromSlug } from "@/lib/entity-links";

export default function FirmProfilePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug || "";
  const title = labelFromSlug(slug);

  return (
    <GenericEntityProfile
      entityType="Firm"
      title={title}
      query={title}
      subtitle="Firm profile created from captured broker and listing mentions."
      backHref="/search?q=firm"
      emptyHint="No canonical firm profile exists yet. This route still gives firms a stable landing page."
    />
  );
}
