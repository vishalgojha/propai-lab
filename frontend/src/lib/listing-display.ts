export function formatBuildingName(value?: string | null): string {
  const text = value?.trim() || "";
  // A parser occasionally puts the price-only header into building_name
  // (for example "3lacs"). It is not a property title and must not be
  // presented as one. Price is rendered separately by ListingCard.
  if (/^(?:₹\s*)?\d+(?:[.,]\d+)?\s*(?:k|lac(?:s)?|lakh(?:s)?|cr(?:ore)?(?:s)?)\s*(?:negotiable)?$/i.test(text)) {
    return "On Request";
  }
  return text || "On Request";
}
