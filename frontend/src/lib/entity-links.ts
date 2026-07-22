export type EntityLinkLike = {
  type: string;
  text: string;
  id?: string | number;
  phone?: string;
  exists?: boolean;
};

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function slugifyEntitySegment(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanizeLabel(value: string) {
  const clean = normalizeText(value).replace(/-/g, " ");
  return clean
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (word.length <= 4 && /^[a-z0-9]+$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function entityTooltip(entity: Pick<EntityLinkLike, "type" | "exists">) {
  if (entity.exists === false) {
    return "Click to create profile";
  }
  switch (entity.type) {
    case "phone":
      return "Click to view broker profile";
    case "locality":
      return "Click to explore market";
    case "building":
      return "Click to view building profile";
    case "society":
      return "Click to view society profile";
    case "landmark":
      return "Click to view landmark profile";
    case "developer":
      return "Click to view developer profile";
    case "firm":
      return "Click to view firm profile";
    case "client":
      return "Click to view client profile";
    case "broker":
      return "Click to view broker profile";
    default:
      return "Click to view profile";
  }
}

export function entityProfileHref(entity: EntityLinkLike) {
  const text = normalizeText(entity.text);
  const encodedText = encodeURIComponent(text);
  const slug = slugifyEntitySegment(text);

  if (!text) return "/search";
  if (entity.type === "broker" && entity.id) return `/brokers/${encodeURIComponent(String(entity.id))}`;
  if ((entity.type === "broker" || entity.type === "phone") && entity.phone) {
    return `/broker/${encodeURIComponent(entity.phone)}`;
  }
  if (entity.type === "broker") return `/brokers?search=${encodedText}`;
  if (entity.type === "firm") return `/firms/${slug || encodedText}`;
  if (entity.type === "building" && entity.id) return `/buildings/${encodeURIComponent(String(entity.id))}`;
  if (entity.type === "building") return `/buildings/${encodedText}`;
  if (entity.type === "locality") return `/localities/${slug || encodedText}`;
  if (entity.type === "society") return `/societies/${slug || encodedText}`;
  if (entity.type === "landmark") return `/landmarks/${slug || encodedText}`;
  if (entity.type === "developer") return `/developers/${slug || encodedText}`;
  if (entity.type === "listing" && entity.id) return `/market/listings?listing=${encodeURIComponent(String(entity.id))}`;
  if (entity.type === "requirement") return `/search?q=${encodedText}`;
  if (entity.type === "client" && entity.id) return `/clients/${encodeURIComponent(String(entity.id))}`;
  return `/search?q=${encodedText}`;
}

export function entityCreateHref(entity: EntityLinkLike) {
  const params = new URLSearchParams({
    term: entity.text,
    type: entity.type,
  });
  return `/trainer?${params.toString()}`;
}

export function labelFromSlug(slug: string) {
  return humanizeLabel(decodeURIComponent(slug));
}
