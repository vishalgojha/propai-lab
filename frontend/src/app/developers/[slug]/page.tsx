"use client";

import { useParams } from "next/navigation";
import GenericEntityProfile from "@/components/GenericEntityProfile";
import { labelFromSlug } from "@/lib/entity-links";

export default function DeveloperProfilePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug || "";
  const title = labelFromSlug(slug);

  return (
    <GenericEntityProfile
      entityType="Developer"
      title={title}
      query={title}
      subtitle="Developer profile created from mentions, listings, and raw messages."
      backHref="/search?q=developer"
      emptyHint="No canonical developer page exists yet. This on-demand profile still opens from the chip."
    />
  );
}
