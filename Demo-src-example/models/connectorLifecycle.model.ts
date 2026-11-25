/**
 * What happens to a connector after somebody has drafted one: the repairs a
 * re-check proposes, the runs that test it, the manifest versions it gains and
 * the ladder its connection climbs.
 *
 * THE LADDER IS HERE AND NOT IN A TABLE. 014 spells the four tiers out as a
 * CHECK because their ORDER carries behaviour — `nextTier` is the same fact read
 * forwards, and a service that wrote `['private', 'community', ...]` of its own
 * would be a second copy of an ordering the database already enforces.
 */

/* ── Repair proposals ───────────────────────────────────────────────────── */

/**
 * 018 permits `auto_applied` for `rename` and nothing else, and permits it only
 * once the sandbox has passed. The kinds are spelled out here so a service
 * naming one that does not exist fails at compile time rather than at the CHECK.
 */
export type HealChangeKind = 'rename' | 'semantic' | 'new_field' | 'object_removed';

export type SandboxStatus = 'passed' | 'failed';

export type HealDecision = 'accepted' | 'rejected';

export interface HealProposal {
  id: string;
  connectionId: string;
  /**
   * The manifest version this was noticed against. A proposal outlives the
   * document it describes, and without this the diff is applied to something
   * else.
   */
  manifestId: string;
  changeKind: HealChangeKind;
  subject: string;
  proposedDiff: Record<string, unknown>;
  /** Null means untested, which is not the same as having failed. */
  sandboxStatus: SandboxStatus | null;
  sandboxResult: Record<string, unknown> | null;
  autoApplied: boolean;
  appliedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  decision: HealDecision | null;
  createdAt: Date;
}

/**
 * Nobody has dealt with this yet.
 *
 * DERIVED, NEVER STORED. A `state` column beside `auto_applied` and `decision`
 * would be a third thing to keep in step with two others, and 018's index over
 * `reviewed_at IS NULL AND auto_applied = false` is this same predicate in the
 * database — one of them would eventually stop matching the other.
 */
export function isAwaitingReview(proposal: HealProposal): boolean {
  return !proposal.autoApplied && proposal.decision === null;
}

/* ── Probe and verification runs ────────────────────────────────────────── */

/** 017's stages. One table serves the read-only probe and the write cycle. */
export type RunStage =
  | 'parse'
  | 'probe'
  | 'reconcile'
  | 'propose_mapping'
  | 'confirm'
  | 'verify';

export type RunStatus = 'running' | 'passed' | 'failed';

export interface ProbeRun {
  id: string;
  connectionId: string;
  stage: RunStage;
  status: RunStatus;
  /** The SHAPE a run saw. Never the rows — 017 has no column for those. */
  findings: Record<string, unknown>;
  errors: unknown[];
  readOnly: boolean;
  startedAt: Date;
  completedAt: Date | null;
}

/* ── Connection lifecycle state ─────────────────────────────────────────── */

export type TrustTier = 'private' | 'community' | 'verified' | 'certified';

/** 014's ladder, in 014's order. */
export const TRUST_TIERS: readonly TrustTier[] = [
  'private',
  'community',
  'verified',
  'certified',
] as const;

/** The rung above this one, or null at the top. */
export function nextTier(tier: string): TrustTier | null {
  const index = TRUST_TIERS.indexOf(tier as TrustTier);
  return index === -1 ? null : (TRUST_TIERS[index + 1] ?? null);
}

/**
 * What promotion has to look at: how far up the ladder a connection is, whether
 * it may write, and whether anybody has confirmed it yet.
 */
export interface ConnectionTrustState {
  trustTier: string;
  writesEnabled: boolean;
  status: string;
}

