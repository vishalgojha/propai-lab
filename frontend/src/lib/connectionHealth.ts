export function connectionHealth({ phonesLoading, liveStatusChecked, phonesError, liveStatusError, connectedCount }: {
  phonesLoading: boolean; liveStatusChecked: boolean; phonesError: unknown;
  liveStatusError: boolean; connectedCount: number;
}) {
  if (phonesLoading || !liveStatusChecked) return { status: "checking" as const, detail: "Checking connection…", pending: true, unknown: false };
  if (phonesError || liveStatusError) return { status: "warning" as const, detail: "Connection status unavailable", pending: false, unknown: true };
  return { status: connectedCount > 0 ? "healthy" as const : "error" as const, detail: `${connectedCount} connected`, pending: false, unknown: false };
}

export function connectionMetric(value: number, live: boolean, loading: boolean) {
  if (live) return value.toLocaleString();
  if (value > 0) return `${value.toLocaleString()} (last known)`;
  return loading ? "Loading…" : "—";
}
