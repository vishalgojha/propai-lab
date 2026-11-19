// Concurrency gate for periodic refreshers.
//
// The Connections dashboard polls on fixed timers and also refreshes on user
// actions and status events. Without a gate those triggers overlap: a slow
// request (cold storage pool, busy worker) stacks duplicate /phones and
// /stats calls behind each other, which queues on the shared API storage
// pool and makes the whole page feel stuck. The gate guarantees at most one
// run of an async task at a time; a trigger that arrives mid-run is dropped,
// because the in-flight run already returns fresher data than a queued copy.

export type InFlightGate = <T>(task: () => Promise<T>) => Promise<T | undefined>;

export function createInFlightGate(): InFlightGate {
  let inFlight = false;
  return async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await task();
    } finally {
      inFlight = false;
    }
  };
}

// Self-scheduling poll delay: base plus small positive jitter so many open
// tabs do not synchronise into the same request burst, and so the next poll
// is always scheduled after the previous one finished (never overlapping).
export function nextPollDelay(
  baseMs: number,
  jitterMs: number,
  random: () => number = Math.random,
): number {
  const jitter = jitterMs > 0 ? Math.floor(random() * (jitterMs + 1)) : 0;
  return baseMs + jitter;
}
