/**
 * Per-session record of options actually shown to the model, so a reveal can only name an option
 * that a prior result returned (no guessing ids), plus a cap on reveals per session (no harvesting).
 * This narrows the attack surface; it does not prove a human broker asked. That stays an attestation.
 */
// Off by default (0). Proposed, unapproved product limit, enabled only via env; it limits bulk harvesting, it does not verify a human.
export const MAX_REVEALS_PER_SESSION = Number(process.env.MCP_MAX_REVEALS_PER_SESSION || 0);
type State = { rawIds: Set<number>; listingIds: Set<string>; reveals: number };
const sessions = new WeakMap<object, State>();
const state = (ctx: object): State => {
  let s = sessions.get(ctx);
  if (!s) sessions.set(ctx, (s = { rawIds: new Set(), listingIds: new Set(), reveals: 0 }));
  return s;
};

/** Only trusted result shapes count: raw search/semantic/context `items[].id` and listing `source_message_id`/`id` fields at result level. Nothing nested inside raw_payload or message text. */
export function noteShown(ctx: object, result: unknown) {
  const s = state(ctx);
  const sc = (result as { structuredContent?: Record<string, any> })?.structuredContent;
  if (!sc || typeof sc !== "object") return;
  const addListing = (v: any) => {
    for (const k of ["source_message_id", "id"]) {
      const m = typeof v?.[k] === "string" ? /^(\d+):(\d+)$/.exec(v[k]) : null;
      if (m) s.listingIds.add(v[k]);
    }
  };
  if (typeof sc.id === "number" && Number.isInteger(sc.id) && typeof sc.message === "string") s.rawIds.add(sc.id);
  const one = sc.message;
  if (one && typeof one === "object" && Number.isInteger(one.id) && typeof one.message === "string") s.rawIds.add(one.id);
  for (const it of Array.isArray(sc.items) ? sc.items : []) {
    if (typeof it?.id === "number" && Number.isInteger(it.id) && typeof it.message === "string") s.rawIds.add(it.id);
  }
  for (const key of ["results", "listings", "requirements"]) for (const it of Array.isArray(sc[key]) ? sc[key] : []) addListing(it);
  addListing(sc);
  if (sc.listing) addListing(sc.listing);
}
export const wasShown = (ctx: object, rawId: number) => state(ctx).rawIds.has(rawId);
export const wasListingShown = (ctx: object, listingId: string) => state(ctx).listingIds.has(listingId);
export const revealAllowed = (ctx: object) => (MAX_REVEALS_PER_SESSION <= 0 || state(ctx).reveals < MAX_REVEALS_PER_SESSION);
export const recordReveal = (ctx: object) => { state(ctx).reveals++; };
