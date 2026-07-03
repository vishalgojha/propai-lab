"use client";

import { useParams } from "next/navigation";
import GenericEntityProfile from "@/components/GenericEntityProfile";
import { labelFromSlug } from "@/lib/entity-links";

export default function LandmarkProfilePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug || "";
  const title = labelFromSlug(slug);

  return (
    <GenericEntityProfile
      entityType="Landmark"
      title={title}
      query={title}
      subtitle="Landmark profile created from nearby messages and location references."
      backHref="/search?q=landmark"
      emptyHint="No canonical landmark profile exists yet. The chip still resolves to a useful page."
    />
  );
}
