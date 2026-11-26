export type SharingClass = "property" | "unclear" | "non_property";

export type SharingOutcomeInput = {
  /** Groups whose selection was (re)confirmed in this operation. */
  confirmedJids: string[];
  /** Sharing set actually sent to the API in this operation. */
  attemptedShared: string[];
  /** Sharing-active jids before this operation. */
  beforeActive: Set<string>;
  /** Sharing-active jids after this operation, verified from the server. */
  afterActive: Set<string>;
  /** Sharing-revoked (paused) jids from the refreshed server state. */
  afterRevoked: Set<string>;
  /** Share class per jid from the refreshed server state. */
  afterShareClassByJid: Record<string, SharingClass>;
};

/**
 * Truthful post-confirmation sharing summary. Every count is computed from
 * the server's refreshed state, never from the attempted set: confirming
 * already-shared groups is a no-op and must say so. Counts reconcile against
 * the confirmed selection (shared + unshared = selected) and paused groups
 * are told apart from groups that were never shared.
 */
export function buildSharingOutcomeMessage(input: SharingOutcomeInput): string {
  const { confirmedJids, attemptedShared, beforeActive, afterActive, afterRevoked, afterShareClassByJid } = input;
  const newlyShared = attemptedShared.filter((jid) => !beforeActive.has(jid) && afterActive.has(jid)).length;
  const activeSelected = confirmedJids.filter((jid) => afterActive.has(jid)).length;
  const parts: string[] = [];
  if (newlyShared > 0) {
    parts.push(
      `${newlyShared} group${newlyShared === 1 ? "" : "s"} newly shared with other authenticated PropAI brokers' assistants.`
    );
  } else {
    parts.push("Sharing unchanged: the groups this confirmation covers were already shared.");
  }
  parts.push(
    `Shared: ${activeSelected} of your ${confirmedJids.length} selected group${confirmedJids.length === 1 ? "" : "s"}.`
  );
  const unshared = confirmedJids.filter((jid) => !afterActive.has(jid));
  if (unshared.length > 0) {
    const paused = unshared.filter((jid) => afterRevoked.has(jid)).length;
    const neverShared = unshared.length - paused;
    const notProperty = unshared.filter((jid) => afterShareClassByJid[jid] === "non_property").length;
    const reviewable = unshared.length - notProperty;
    const split: string[] = [];
    if (paused > 0) split.push(`${paused} paused`);
    if (neverShared > 0) split.push(`${neverShared} never shared`);
    parts.push(`${unshared.length} stay${unshared.length === 1 ? "s" : ""} unshared (${split.join(", ")}).`);
    if (reviewable > 0) {
      parts.push(
        reviewable === 1
          ? "To share it, tick it individually in the confirmation dialog."
          : "To share one, tick it individually in the confirmation dialog."
      );
    }
    if (notProperty > 0) {
      parts.push(
        `${notProperty} ${notProperty === 1 ? "is" : "are"} not a property group and can never be shared.`
      );
    }
  } else if (confirmedJids.length > 0) {
    parts.push("Every selected group is now shared.");
  }
  return parts.join(" ");
}
