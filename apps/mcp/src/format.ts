import type { IgrTransaction, LocalityStats, PublicListing } from "./types.js";

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const relativeFormatter = new Intl.RelativeTimeFormat("en-IN", { numeric: "auto" });

export function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatCurrencyCr(value: number | null | undefined) {
  if (value == null) return "price not shared";
  const abs = Math.abs(value);
  if (abs >= 10000000) {
    return `₹${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  }
  if (abs >= 100000) {
    return `₹${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lakh`;
  }
  if (abs >= 1000) {
    return `₹${Math.round(value / 1000).toLocaleString("en-IN")}k`;
  }
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

export function formatBudgetRange(min?: number, max?: number) {
  if (min != null && max != null) return `${formatCurrencyCr(min)}-${formatCurrencyCr(max)}`;
  if (max != null) return `up to ${formatCurrencyCr(max)}`;
  if (min != null) return `from ${formatCurrencyCr(min)}`;
  return "any budget";
}

export function formatSqft(value: number | null | undefined) {
  return value != null ? `${Math.round(value).toLocaleString("en-IN")} sqft` : "area not shared";
}

export function formatPerSqft(value: number | null | undefined) {
  return value != null ? `₹${Math.round(value).toLocaleString("en-IN")}/sqft` : "N/A";
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "date not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.format(date);
}

export function formatAge(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = date.getTime() - Date.now();
  const diffHours = Math.round(diffMs / 3600000);
  if (Math.abs(diffHours) < 24) return relativeFormatter.format(diffHours, "hour");
  return relativeFormatter.format(Math.round(diffHours / 24), "day");
}

export function listingLabel(row: PublicListing) {
  const parts = [
    row.bhk ? `${row.bhk}BHK` : null,
    row.property_type,
    row.sub_area || row.area || row.location,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : row.title || "Property";
}

export function listingLine(row: PublicListing, index: number) {
  const timestamp = row.message_timestamp || row.created_at;
  const age = formatAge(timestamp);
  const place = row.title || listingLabel(row);
  const size = row.size_sqft ? `, ${formatSqft(row.size_sqft)}` : "";
  const suffix = age ? ` (${age})` : "";
  return `${index + 1}. ${listingLabel(row)}, ${formatCurrencyCr(row.price)} - ${place}${size}${suffix}`;
}

export function igrSummary(
  transaction: IgrTransaction | null,
  stats: LocalityStats | null,
  requestedBuilding?: string,
  requestedLocality?: string,
) {
  if (!transaction && !stats) {
    return "No Maharashtra IGR transaction data found for this building or locality.";
  }

  if (!transaction && stats) {
    return `No exact building match found. Area average (${stats.months} months) in ${stats.locality}: ${formatPerSqft(stats.avg_price_per_sqft)} across ${stats.transaction_count} transactions.`;
  }

  const dealRate = transaction?.price_per_sqft ?? null;
  const marketRate = stats?.avg_price_per_sqft ?? null;
  let comparison = "";
  if (dealRate != null && marketRate != null && marketRate > 0) {
    comparison = dealRate >= marketRate ? "above market" : "below market";
  }

  const building = transaction?.building_name || requestedBuilding || "Building";
  const locality = transaction?.locality || requestedLocality || "locality not available";
  const avgLine = stats
    ? `Area average (${stats.months} months): ${formatPerSqft(stats.avg_price_per_sqft)}${comparison ? ` - ${comparison}` : ""}`
    : "Area average (6 months): N/A";

  return `Last registered: ${building}, ${locality} - ${formatCurrencyCr(transaction?.consideration)} on ${formatDate(transaction?.reg_date)} (${formatSqft(transaction?.area_sqft)}, ${formatPerSqft(transaction?.price_per_sqft)})\n${avgLine}`;
}
