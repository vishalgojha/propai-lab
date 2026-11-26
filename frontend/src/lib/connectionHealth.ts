export function connectionHealth({ phonesLoading, liveStatusChecked, phonesError, liveStatusError, connectedCount }: {
  phonesLoading: boolean; liveStatusChecked: boolean; phonesError: unknown;
  liveStatusError: boolean; connectedCount: number;
}) {
  if (phonesLoading || !liveStatusChecked) return { status: "checking" as const, detail: "Checking connection…", pending: true, unknown: false };
  // A failed live probe does not contradict phone records that still confirm
  // a linked session: the per-phone cards show Connected from the same data,
  // so the header must not simultaneously warn "status unavailable".
  if (connectedCount > 0) return { status: "healthy" as const, detail: `${connectedCount} connected`, pending: false, unknown: false };
  if (phonesError || liveStatusError) return { status: "warning" as const, detail: "Connection status unavailable", pending: false, unknown: true };
  return { status: "error" as const, detail: "0 connected", pending: false, unknown: false };
}

export function connectionMetric(value: number, live: boolean, loading: boolean) {
  if (live) return value.toLocaleString();
  if (value > 0) return `${value.toLocaleString()} (last known)`;
  return loading ? "Loading…" : "—";
}
