"use client";

import { useParams } from "next/navigation";
import GenericEntityProfile from "@/components/GenericEntityProfile";
import { labelFromSlug } from "@/lib/entity-links";

export default function SocietyProfilePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug || "";
  const title = labelFromSlug(slug);

  return (
    <GenericEntityProfile
      entityType="Society"
      title={title}
      query={title}
      subtitle="Society profile created on demand from captured WhatsApp conversations."
      backHref="/search?q=society"
      emptyHint="No canonical society profile exists yet. This route still gives the entity a stable home."
    />
  );
}
