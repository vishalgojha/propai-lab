import { supabase } from "./supabase.ts";

type Severity = "HIGH" | "MEDIUM" | "LOW";

type Anomaly = {
  severity: Severity;
  signature: string;
  query: string;
  listingId: string;
  failedFields: string[];
  likelyCause: string;
  timestamp: string;
};

type Batch = {
  firstSeen: number;
  lastSeen: number;
  count: number;
  samples: Anomaly[];
  timer?: ReturnType<typeof setTimeout>;
  lastAlertAt: number;
  lastAlertCount: number;
};

const batches = new Map<string, Batch>();
const WINDOW_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 60 * 60 * 1000;
const ALERT_TO = process.env.MCP_DATA_QUALITY_ALERT_TO || "vishal@chaoscraftlabs.com";

function compact(value: unknown, max = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function placeholder(value: unknown) {
  return new Set(["[document]", "[image]", "[video]", "[voice message]", "[sticker]"]).has(
    compact(value).toLowerCase(),
  );
}

function classify(row: Record<string, unknown>, query: string, index: number): Anomaly | null {
  const listingId = compact(row.source_message_id || row.id || `result-${index}`);
  const failedFields: string[] = [];
  if (row.bhk == null && !/\b(?:commercial|office|shop|showroom|warehouse)\b/i.test(JSON.stringify(row))) failedFields.push("bhk");
  if (row.price == null) failedFields.push("price");
  if (row.area_sqft == null) failedFields.push("area_sqft");
  const titlePlaceholder = placeholder(row.building_name) || placeholder(row.title);
  if (titlePlaceholder) failedFields.push("building_name");
  if (!failedFields.length) return null;

  const source = compact(row.raw_message || row.cleaned_message || row.description);
  const mediaOnly = placeholder(source);
  const allCriticalMissing = failedFields.includes("price") && failedFields.includes("area_sqft") &&
    (failedFields.includes("bhk") || /\b(?:residential|flat|apartment|bhk)\b/i.test(JSON.stringify(row)));
  const severity: Severity = allCriticalMissing || mediaOnly ? "HIGH" : failedFields.some((field) => ["bhk", "price", "area_sqft"].includes(field)) ? "MEDIUM" : "LOW";
  const cause = mediaOnly
    ? "The source is a media/document placeholder with no OCR text."
    : titlePlaceholder
      ? "A media placeholder leaked into the building field."
      : "The parsed row is missing one or more source-grounded core fields.";
  const signature = `${mediaOnly ? "media_only" : "missing_fields"}:${failedFields.sort().join(",")}`;
  return {
    severity,
    signature,
    query: compact(query, 500),
    listingId,
    failedFields,
    likelyCause: cause,
    timestamp: new Date().toISOString(),
  };
}

async function sendEmail(batch: Batch, anomaly: Anomaly) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.MCP_DATA_QUALITY_ALERT_FROM || "PropAI Data Quality <alerts@propai.live>";
  if (!apiKey) {
    console.warn(JSON.stringify({ event: "mcp_data_quality_email_skipped", reason: "RESEND_API_KEY_missing", signature: anomaly.signature }));
    return;
  }
  const samples = batch.samples.slice(0, 5).map((item) =>
    `- ${item.listingId}: ${item.failedFields.join(", ")} | query: ${item.query} | cause: ${item.likelyCause}`,
  ).join("\n");
  const subject = `[PropAI ${anomaly.severity}] MCP parser data-quality issue (${batch.count} occurrence${batch.count === 1 ? "" : "s"})`;
  const text = [
    `PropAI MCP detected ${batch.count} ${anomaly.signature} issue(s) in the last five minutes.`,
    `Severity: ${anomaly.severity}`,
    `Likely cause: ${anomaly.likelyCause}`,
    "",
    "Sample failures:",
    samples,
    "",
    "This alert was batched and throttled. The MCP query response was not blocked.",
  ].join("\n");
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [ALERT_TO], subject, text }),
    });
    if (!response.ok) console.warn(`[mcp/data-quality] email failed HTTP ${response.status}: ${compact(await response.text())}`);
  } catch (error) {
    console.warn("[mcp/data-quality] email delivery failed:", error instanceof Error ? error.message : error);
  }
}

function flush(signature: string, batch: Batch) {
  const anomaly = batch.samples[0];
  if (!anomaly || anomaly.severity === "LOW") return;
  const now = Date.now();
  const withinCooldown = batch.lastAlertAt > 0 && now - batch.lastAlertAt < COOLDOWN_MS;
  const spike = batch.lastAlertCount > 0 && batch.count >= Math.max(3, batch.lastAlertCount * 3);
  if (withinCooldown && !spike) {
    // The timer has fired; clear this window so later events can schedule a
    // fresh five-minute batch without losing the cooldown state.
    batches.set(signature, { ...batch, count: 0, samples: [], firstSeen: now, lastSeen: now, timer: undefined });
    return;
  }
  batch.lastAlertAt = now;
  batch.lastAlertCount = batch.count;
  void sendEmail(batch, anomaly);
  batches.set(signature, { ...batch, count: 0, samples: [], firstSeen: now, lastSeen: now, timer: undefined });
}

function record(anomaly: Anomaly) {
  console.warn(JSON.stringify({ event: "mcp_data_quality_anomaly", ...anomaly }));
  void (async () => {
    try {
      const { error } = await supabase.from("mcp_data_quality_events").insert({
        severity: anomaly.severity,
        signature: anomaly.signature,
        query: anomaly.query,
        listing_id: anomaly.listingId,
        failed_fields: anomaly.failedFields,
        likely_cause: anomaly.likelyCause,
        occurred_at: anomaly.timestamp,
      });
      if (error) console.warn("[mcp/data-quality] event persistence failed:", error.message);
    } catch (error) {
      console.warn("[mcp/data-quality] event persistence failed:", error);
    }
  })();

  if (anomaly.severity === "LOW") return;
  const now = Date.now();
  const current = batches.get(anomaly.signature) || {
    firstSeen: now,
    lastSeen: now,
    count: 0,
    samples: [],
    lastAlertAt: 0,
    lastAlertCount: 0,
  };
  current.lastSeen = now;
  current.count += 1;
  if (current.samples.length < 10) current.samples.push(anomaly);
  if (!current.timer) current.timer = setTimeout(() => flush(anomaly.signature, current), WINDOW_MS);
  batches.set(anomaly.signature, current);
}

export function reportMarketResultAnomalies(query: string, rows: unknown[]) {
  for (const [index, row] of rows.entries()) {
    if (row && typeof row === "object") {
      const anomaly = classify(row as Record<string, unknown>, query, index);
      if (anomaly) record(anomaly);
    }
  }
}

export function reportMcpParserError(query: string, error: unknown) {
  record({
    severity: "HIGH",
    signature: "parser_exception",
    query: compact(query, 500),
    listingId: "unknown",
    failedFields: ["parser"],
    likelyCause: compact(error),
    timestamp: new Date().toISOString(),
  });
}
