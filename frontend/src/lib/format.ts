function compactNumber(value: number, maximumFractionDigits = 2) {
  return value.toLocaleString("en-IN", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  });
}

export function formatBrokerPrice(value?: number | null) {
  if (value == null || Number.isNaN(value)) return "";
  const amount = Number(value);
  if (amount >= 10000000) return `${compactNumber(amount / 10000000)} Cr`;
  if (amount >= 100000) return `${compactNumber(amount / 100000)} Lac`;
  if (amount >= 1000) return `${compactNumber(amount / 1000)} K`;
  return compactNumber(amount);
}

const LISTING_VALUE_LABELS: Record<string, string> = {
  semi_furnished: "Semi-furnished",
  fully_furnished: "Fully furnished",
  brand_new_building: "Brand new building",
  brand_new: "Brand new",
  ready_to_move: "Ready to move",
  bare_shell: "Bare shell",
  warm_shell: "Warm shell",
  under_construction: "Under construction",
};

export function formatListingValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map(formatListingValue).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  const raw = String(value).trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase().replace(/\s+/g, "_");
  return LISTING_VALUE_LABELS[normalized] || raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
