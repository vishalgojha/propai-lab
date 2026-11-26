// Shared connection-status model for the WhatsApp connections page. The page
// header and every per-phone card MUST derive their state from these two
// functions so they can never contradict each other.
//
// Data semantics (grounded in routers/dashboard.py /api/dashboard/whatsapp-status
// and routers/whatsapp_sync.py /api/phones):
// - The probe (whatsapp-status) reports the ingestor's LIVE view. state "open"/
//   "connected" is fresh live confirmation; "stopped"/"close"/"disconnected" is
//   a definitive offline report from a reachable ingestor; "connecting"/
//   "reconnecting"/"qr" is pairing in progress; "unavailable"/"unknown" means
//   the ingestor could not be reached; status_stale marks a cached snapshot
//   (bounded to the backend's ~45-90s grace).
// - The stored phone row (GET /api/phones?include_live=false) is LAST-KNOWN
//   state written by ingestor lifecycle events. It can lag reality, so it must
//   never be shown as fresh "Connected": only as "Last known connected".

export type ProbeReading =
  | "unchecked" // probe has not completed yet
  | "failed" // probe request itself failed
  | "unknown" // probe answered but the ingestor is unreachable
  | "live" // fresh live connected session
  | "stale" // cached live snapshot within the backend grace window
  | "pairing" // connecting/reconnecting/qr in progress
  | "offline"; // definitive not-connected report from a reachable ingestor

type ProbeStatusLike = {
  connected?: boolean | null;
  state?: string | null;
  connection_state?: string | null;
  status_stale?: boolean | null;
};

export function probeReading(
  status: ProbeStatusLike | null,
  checked: boolean,
  error: boolean,
): ProbeReading {
  if (!checked) return "unchecked";
  if (error || !status) return "failed";
  if (status.status_stale) return "stale";
  if (status.connected || status.state === "open" || status.state === "connected") return "live";
  const state = String(status.state || status.connection_state || "").toLowerCase();
  if (state === "connecting" || state === "reconnecting" || state === "qr") return "pairing";
  if (state === "" || state === "unavailable" || state === "unknown") return "unknown";
  return "offline";
}

export type PhoneConnectionView =
  | "checking"
  | "connected" // fresh live confirmation for this phone
  | "pairing" // pairing/reconnecting in progress
  | "last-known" // stored row says connected, live truth unavailable: NOT fresh
  | "disconnected" // definitively not connected (probe reachable)
  | "unavailable" // no live truth and no stored connection
  | "unpaired"; // placeholder record, never paired

export function phoneConnectionView({
  storedConnected,
  placeholder,
  matchesProbe,
  status,
  checked,
  error,
}: {
  storedConnected: boolean; // isConnectedPhone(stored row): last-known only
  placeholder: boolean; // isPlaceholderPhone(phone_number)
  matchesProbe: boolean; // matchesLiveStatus(phone, status)
  status: ProbeStatusLike | null;
  checked: boolean;
  error: boolean;
}): PhoneConnectionView {
  const reading = probeReading(status, checked, error);
  if (reading === "unchecked") return "checking";
  if (reading === "live") return matchesProbe ? "connected" : (storedConnected ? "last-known" : placeholder ? "unpaired" : "disconnected");
  if (reading === "pairing") return "pairing";
  if (reading === "offline") return placeholder ? "unpaired" : "disconnected";
  if (reading === "stale") {
    // Grace-bounded cached snapshot: never fresh truth. A stored row or a
    // matched cached session is last-known; without either, live truth is
    // simply unavailable, and a stale cache must not read as definitive offline.
    if (storedConnected || (matchesProbe && status?.connected)) return "last-known";
    return placeholder ? "unpaired" : "unavailable";
  }
  // unknown / failed: live truth unavailable, stored row is last-known only.
  if (storedConnected) return "last-known";
  return placeholder ? "unpaired" : "unavailable";
}

export function connectionHealth({
  phonesLoading,
  liveStatusChecked,
  phonesError,
  liveStatusError,
  views,
}: {
  phonesLoading: boolean;
  liveStatusChecked: boolean;
  phonesError: unknown;
  liveStatusError: boolean;
  views: PhoneConnectionView[];
}) {
  if (phonesLoading || !liveStatusChecked) return { status: "checking" as const, detail: "Checking connection…", pending: true, unknown: false };
  const count = (view: PhoneConnectionView) => views.filter((v) => v === view).length;
  const connected = count("connected");
  // Only fresh live-confirmed sessions make the header healthy.
  if (connected > 0) return { status: "healthy" as const, detail: `${connected} connected`, pending: false, unknown: false };
  // A stored connection without live truth is last-known, never healthy.
  if (count("last-known") > 0) return { status: "warning" as const, detail: "Last known connected · live status unavailable", pending: false, unknown: true };
  if (phonesError || liveStatusError || count("unavailable") > 0) return { status: "warning" as const, detail: "Connection status unavailable", pending: false, unknown: true };
  if (count("pairing") > 0) return { status: "warning" as const, detail: "Reconnecting…", pending: false, unknown: false };
  return { status: "error" as const, detail: "0 connected", pending: false, unknown: false };
}

export function connectionMetric(value: number, live: boolean, loading: boolean) {
  if (live) return value.toLocaleString();
  if (value > 0) return `${value.toLocaleString()} (last known)`;
  return loading ? "Loading…" : "—";
}
