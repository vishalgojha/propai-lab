import type { RawMessage } from "./api";

export type FormatIssueReason =
  | "Too compressed"
  | "Mixed listing + requirement"
  | "Only external link"
  | "Missing price"
  | "Missing location"
  | "No property details";

export type FormatIssue = {
  reason: FormatIssueReason;
  detail: string;
  severity: "high" | "medium" | "low";
  missing: string[];
};

const URL_RE = /\b(?:https?:\/\/|www\.|instagram\.com|fb\.com|facebook\.com|youtu\.be|youtube\.com|t\.me|wa\.me|chat\.whatsapp\.com)\b/i;
const PROPERTY_RE = /\b(?:bhk|rk|flat|apartment|villa|office|shop|godown|warehouse|carpet|sq\.?\s*ft|sqft|sft|rent|sale|lease|budget|deposit|price|cr|crore|lac|lakh)\b/i;
const PRICE_RE = /\b(?:rent|budget|deposit|price|asking|quote|sale\s*price|₹|rs\.?|cr|crore|lac|lakh|k)\b/i;
const LOCATION_RE = /\b(?:location|road|rd|lane|marg|nagar|west|east|juhu|bandra|andheri|khar|santacruz|bkc|worli|parel|malad|goregaon|thane|chembur|powai|lower parel|dadar)\b/i;
const REQUIREMENT_RE = /\b(?:requirement|required|wanted|looking|need|buyer|tenant|client)\b/i;
const LISTING_RE = /\b(?:available|sale|rent|lease|distress|exclusive|mandate|inventory|possession)\b/i;

function meaningfulLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[\-_*=\s]+$/.test(line));
}

function propertySignalCount(text: string) {
  const checks = [
    /\b\d+(?:\.\d+)?\s*(?:bhk|rk)\b/i,
    /\b(?:carpet|sq\.?\s*ft|sqft|sft)\b/i,
    PRICE_RE,
    LOCATION_RE,
    /\b(?:furnished|unfurnished|semi|parking|possession|floor|building)\b/i,
  ];
  return checks.reduce((count, re) => count + (re.test(text) ? 1 : 0), 0);
}

export function classifyFormatIssue(message: Pick<RawMessage, "message">): FormatIssue | null {
  const text = (message.message || "").trim();
  if (!text) {
    return {
      reason: "No property details",
      detail: "Empty message body.",
      severity: "low",
      missing: ["Property type", "Location", "Price", "Listing or requirement"],
    };
  }

  const lines = meaningfulLines(text);
  const compactText = text.replace(/\s+/g, " ").trim();
  const hasPropertySignal = PROPERTY_RE.test(compactText);
  const hasUrl = URL_RE.test(compactText);

  if (hasUrl && propertySignalCount(compactText) < 2) {
    return {
      reason: "Only external link",
      detail: "External links are not enough for PropAI to create a clean market opportunity.",
      severity: "high",
      missing: ["Property details", "Location", "Price"],
    };
  }

  if (!hasPropertySignal) {
    if (lines.length <= 1 || compactText.length < 30) {
      return {
        reason: "No property details",
        detail: "No clear property, listing, or requirement signal was found.",
        severity: "low",
        missing: ["Property type", "Location", "Price", "Listing or requirement"],
      };
    }
    return null;
  }

  const hasRequirement = REQUIREMENT_RE.test(compactText);
  const hasListing = LISTING_RE.test(compactText);
  if (hasRequirement && hasListing && lines.length <= 3) {
    return {
      reason: "Mixed listing + requirement",
      detail: "Listing and requirement language appears in the same compressed post.",
      severity: "high",
      missing: ["Separate listing and requirement"],
    };
  }

  if (lines.length <= 2 && propertySignalCount(compactText) >= 3) {
    return {
      reason: "Too compressed",
      detail: "The post has property signals but not enough line breaks or boundaries to split safely.",
      severity: "high",
      missing: ["Add line breaks", "Separate each property"],
    };
  }

  const missing: string[] = [];
  if (!PRICE_RE.test(compactText)) missing.push("Price");
  if (!LOCATION_RE.test(compactText)) missing.push("Location");
  if (!hasRequirement && !hasListing) missing.push("Listing or requirement");

  if (missing.length > 0) {
    return {
      reason: missing.includes("Price") ? "Missing price" : "Missing location",
      detail: `Add ${missing.join(", ").toLowerCase()} to improve matching.`,
      severity: "low",
      missing,
    };
  }

  return null;
}
