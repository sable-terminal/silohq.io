/**
 * §6 — the learned layer: a map, who it is shared with, and what is in it.
 *
 * `MapRecord`, NOT `Map`. The domain word is "map" and the global of that name
 * is a collection this codebase uses constantly — `reachOf` builds one three
 * lines from where a map is read. A model whose import shadows `Map` turns a
 * `new Map()` somewhere else in the file into a type error that reads as
 * nonsense, so the row is named for what it is.
 *
 * NOTHING HERE HOLDS A VALUE READ OUT OF A CUSTOMER'S RECORD. §6.1 — references,
 * counts and dispositions, which is the same guarantee migration 036 makes about
 * the tables: ids, names, counts, weights and timestamps, and nothing else. The
 * types below are the proof of it at the type level.
 */

export interface MapRecord {
  id: string;
  organisationId: string;
  /** §6.2 — a membership, not an organisation. That is the whole design. */
  ownerMembershipId: string;
  name: string;
  /** The one a session lands on when it has not chosen. One per owner. */
  active: boolean;
  forkedFrom: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

/**
 * Archived is not deleted, so "live" is a question every reader has to ask.
 *
 * DERIVED, NEVER STORED. A `live` column beside `archived_at` is a second source
 * of truth for one fact, and the first archive that updates one without the
 * other leaves the column everything reads as the wrong one.
 */
export function isLive(map: MapRecord): boolean {
  return map.archivedAt === null;
}

/** §6.2 — sharing, renaming and archiving are the owner's alone. */
export function isOwnedBy(map: MapRecord, membershipId: string): boolean {
  return map.ownerMembershipId === membershipId;
}

/**
 * What a map looks like to one person.
 *
 * `mine` IS RELATIVE TO THE READER, WHICH IS WHY IT IS COMPUTED HERE. It was
 * being recomputed at every call site as `row.owner_membership_id === actor
 * .membershipId`, and a comparison written out twice is a comparison that can
 * be written wrongly once.
 */
export interface MapSummary {
  id: string;
  name: string;
  active: boolean;
  mine: boolean;
  forkedFrom: string | null;
  createdAt: string;
}

export function summarise(map: MapRecord, readerMembershipId: string): MapSummary {
  return {
    id: map.id,
    name: map.name,
    active: map.active,
    mine: isOwnedBy(map, readerMembershipId),
    forkedFrom: map.forkedFrom,
    createdAt: map.createdAt.toISOString(),
  };
}

/* ── §6.3 and §6.4 Sharing ───────────────────────────────────────────────── */

/**
 * USE OR COPY, AND THE DIFFERENCE IS WHOSE LEARNING IT IS. `use` opens the
 * owner's map and teaches it nothing; `copy` forks it, after which the two
 * diverge. There is no `edit`, because a map somebody else's dismissals write
 * into is a map that averages two people — exactly what §6.2 refuses.
 */
export type MapAccess = 'use' | 'copy';

export interface MapShare {
  id: string;
  organisationId: string;
  mapId: string;
  /** Exactly one of these three is set; the table has a CHECK saying so. */
  membershipId: string | null;
  scopeId: string | null;
  organisationWide: boolean;
  access: MapAccess;
  sharedBy: string;
  sharedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * §6.4 — the policy governing views governs maps.
 *
 * IT LIVES ON THE ORGANISATION AND HAS ONE READER TODAY. Migration 036 named the
 * column for neither maps nor views deliberately: when saved views land they
 * read THIS setting rather than adding a second one, because two settings called
 * "sharing policy" that can disagree is how a customer ends up with a policy
 * they did not set.
 */
export const SHARING_POLICIES = ['open', 'scope_only', 'explicit_only', 'disabled'] as const;

export type SharingPolicy = (typeof SHARING_POLICIES)[number];

export function isSharingPolicy(value: string): value is SharingPolicy {
  return (SHARING_POLICIES as readonly string[]).includes(value);
}

/* ── §6.1 What a map holds ───────────────────────────────────────────────── */

/**
 * This concept relates to that concept.
 *
 * `conceptA` SORTS BEFORE `conceptB` AND THE TABLE ENFORCES IT. A pair stored
 * both ways round is two rows describing one relationship, which double-counts
 * in every aggregate that walks them.
 */
export interface MapLink {
  id: string;
  organisationId: string;
  mapId: string;
  conceptA: string;
  conceptB: string;
  strength: number;
  /** Times following this link led somewhere, not times it was drawn. */
  usefulnessCount: number;
  lastReinforcedAt: Date;
}

/**
 * This detector on this concept is usually signal, or usually noise.
 *
 * §6.6 — IT NEVER CHANGES WHAT A DETECTOR COMPUTES. The weight moves ranking and
 * connector selection; detection stays arithmetic. Both counts are kept because
 * a weight alone cannot say whether it came from two decisions or two hundred,
 * and a ranking layer that cannot tell those apart trusts a new map as much as a
 * seasoned one.
 */
export interface MapDetectorWeight {
  id: string;
  organisationId: string;
  mapId: string;
  conceptId: string;
  detector: string;
  /** One is neutral. Below one this map has learned to look at it less. */
  weight: number;
  signalCount: number;
  noiseCount: number;
  lastAdjustedAt: Date;
}

/**
 * §3.4 — a threshold, and where it came from.
 *
 * `origin` IS THE WHOLE POINT OF KEEPING IT. A threshold that has been through
 * the loop several times is used directly on the next run rather than
 * re-derived; one that has not is a first guess that should be re-derived when
 * the population changes. Without the column both look identical.
 */
export type ThresholdOrigin = 'derived' | 'tuned';

export interface Threshold {
  id: string;
  organisationId: string;
  mapId: string;
  conceptId: string;
  detector: string;
  value: number;
  origin: ThresholdOrigin;
  /** What makes §3.4's "several times" a condition rather than a word. */
  runCount: number;
  lastAdjustedAt: Date;
}
