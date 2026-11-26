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
    parts.push("Sharing unchanged: the groups covered were already shared.");
  }
  parts.push(
    `Shared: ${activeSelected} of your ${confirmedJids.length} selected group${confirmedJids.length === 1 ? "" : "s"}.`
  );
  const unshared = confirmedJids.filter((jid) => !afterActive.has(jid));
  if (unshared.length > 0) {
    const paused = unshared.filter((jid) => afterRevoked.has(jid)).length;
    const neverShared = unshared.length - paused;
    const notProperty = unshared.filter((jid) => afterShareClassByJid[jid] === "non_property").length;
    const split: string[] = [];
    if (paused > 0) split.push(`${paused} paused`);
    if (neverShared > 0) split.push(`${neverShared} never shared`);
    parts.push(`${unshared.length} not shared: ${split.join(", ")}.`);
    if (notProperty > 0) {
      parts.push(
        notProperty === 1
          ? "1 of these is not a property group and can never be shared."
          : `${notProperty} of these are not property groups and can never be shared.`
      );
    }
  } else if (confirmedJids.length > 0) {
    parts.push("Every selected group is now shared.");
  }
  return parts.join(" ");
}

/** PropAI/Propi product or broadcast groups: never pre-ticked, never bulk-ticked. */
export const PROPAI_INTERNAL_GROUP_PATTERN = /^prop\s?(ai|i)\b/i;

export type RestorePlanInput = {
  /** Groups currently selected for capture. */
  selectedJids: Iterable<string>;
  /** Sharing-revoked (paused) jids from the server state. */
  revokedJids: Set<string>;
  /** Share class per jid from the server state. */
  shareClassByJid: Record<string, SharingClass | undefined>;
  /** Display name per jid for the product-group check. */
  nameByJid: Map<string, string>;
};

export type RestorePlan = {
  /** Paused previously-consented groups the review lists (never non-property). */
  restorable: string[];
  /** Pre-ticked: property-named, non-product only. Unclear groups are never pre-ticked. */
  preTicked: string[];
  /** Covered by the bulk "tick all" control: restorable minus product groups. */
  bulkJids: string[];
  /** Product groups in the list: explicit tick only. */
  internalCount: number;
};

/**
 * Restore-review plan. Non-property groups are never listed. Product groups
 * are listed but start unticked and stay out of the bulk control, so the
 * bulk choice can never silently share them.
 */
export function buildRestorePlan(input: RestorePlanInput): RestorePlan {
  const { selectedJids, revokedJids, shareClassByJid, nameByJid } = input;
  const isInternal = (jid: string) => PROPAI_INTERNAL_GROUP_PATTERN.test(nameByJid.get(jid) ?? "");
  const restorable = Array.from(selectedJids).filter(
    (jid) => revokedJids.has(jid) && shareClassByJid[jid] !== "non_property"
  );
  const preTicked = restorable.filter((jid) => shareClassByJid[jid] === "property" && !isInternal(jid));
  const bulkJids = restorable.filter((jid) => !isInternal(jid));
  return { restorable, preTicked, bulkJids, internalCount: restorable.length - bulkJids.length };
}

export type RestorePayload = {
  groupJids: string[];
  /** Exact per-group opt-in the API requires for any ticked unclear group. */
  allowUnclear: string[];
};

/**
 * Payload for the confirm tap: every ticked unclear-class group must be
 * named in allowUnclear or the API holds it back. Non-property groups can
 * never appear here because the plan never lists them.
 */
export function buildRestorePayload(tickedJids: string[], shareClassByJid: Record<string, SharingClass | undefined>): RestorePayload {
  const groupJids = Array.from(tickedJids);
  return {
    groupJids,
    allowUnclear: groupJids.filter((jid) => shareClassByJid[jid] !== "property"),
  };
}
