import type { BulkTier } from './preview.mutation';

/**
 * Mutations §9 — who must agree to a change.
 *
 * ── Pure, so it can be read ────────────────────────────────────────────────
 *
 * Which policy applies, whether a floor overrides it, what several connections
 * add up to, and whether a set of decisions satisfies the result are the rules
 * a reviewer asks about. They are arithmetic over rows the service hands in,
 * with nothing to read and nothing to decide by accident.
 */

/** The terms a policy, a floor and a chain are all expressed in. */
export type PolicyTerms = {
  /** Distinct people. */
  approvalsRequired: number;
  /** At least one approver must hold this role. */
  requiredRoleId: string | null;
  /** Off by default (§9). Where on, a proposer's approval counts and is recorded as what it is. */
  allowSelfApproval: boolean;
  /** §14 — somebody holding `mutation.execute` runs it, rather than the last approval. */
  separateExecution: boolean;
  /** How long after the preview was read the chain stays open. */
  expiresAfterHours: number;
};

export type StoredPolicy = PolicyTerms & {
  id: string;
  connectionId: string | null;
  scopeId: string | null;
  /** The scope's materialised path, for policies set at connection plus scope. */
  scopePath: string | null;
};

export type Level = 'scope' | 'connection' | 'organisation' | 'implicit';

/**
 * §9 — "A connection with no policy requires one approver holding
 * mutation.approve on it." The window is the preview's own.
 */
const IMPLICIT_POLICY: PolicyTerms = {
  approvalsRequired: 1,
  requiredRoleId: null,
  allowSelfApproval: false,
  separateExecution: false,
  expiresAfterHours: 24,
};

/** The terms on which `policy` is weaker than `floor`, by name. Empty when it is not. */
export function weakerTerms(policy: PolicyTerms, floor: PolicyTerms): Array<keyof PolicyTerms> {
  const weaker: Array<keyof PolicyTerms> = [];
  if (policy.approvalsRequired < floor.approvalsRequired) weaker.push('approvalsRequired');
  if (floor.requiredRoleId !== null && policy.requiredRoleId !== floor.requiredRoleId) weaker.push('requiredRoleId');
  if (policy.allowSelfApproval && !floor.allowSelfApproval) weaker.push('allowSelfApproval');
  if (!policy.separateExecution && floor.separateExecution) weaker.push('separateExecution');
  if (policy.expiresAfterHours > floor.expiresAfterHours) weaker.push('expiresAfterHours');
  return weaker;
}

/** Each term at whichever of the two is stricter. */
function atLeast(policy: PolicyTerms, floor: PolicyTerms): PolicyTerms {
  return {
    approvalsRequired: Math.max(policy.approvalsRequired, floor.approvalsRequired),
    requiredRoleId: floor.requiredRoleId ?? policy.requiredRoleId,
    allowSelfApproval: policy.allowSelfApproval && floor.allowSelfApproval,
    separateExecution: policy.separateExecution || floor.separateExecution,
    expiresAfterHours: Math.min(policy.expiresAfterHours, floor.expiresAfterHours),
  };
}

const terms = (policy: PolicyTerms): PolicyTerms => ({
  approvalsRequired: policy.approvalsRequired,
  requiredRoleId: policy.requiredRoleId,
  allowSelfApproval: policy.allowSelfApproval,
  separateExecution: policy.separateExecution,
  expiresAfterHours: policy.expiresAfterHours,
});

export type Resolved = {
  connectionId: string;
  level: Level;
  policyIds: string[];
  /** What was configured, before any floor. */
  configured: PolicyTerms;
  /** What applies. */
  applied: PolicyTerms;
  /** Set when a floor raised a term, which is audited. */
  floorApplied: boolean;
};

/**
 * The policy for one connection, for one proposer.
 *
 * MOST SPECIFIC FIRST, AND THE FIRST LEVEL WITH ANYTHING WINS. A scope policy
 * applies to proposers in that scope or beneath it; among several, the deepest
 * scope is the most specific, and scopes equally deep are all applied, because a
 * person in two branches is held to both rather than to whichever was read first.
 *
 * A FLOOR IS APPLIED LAST, whatever level produced the policy — including the
 * implicit one, so a floor on a connection nobody configured still holds.
 */
export function resolvePolicy(input: {
  connectionId: string;
  policies: readonly StoredPolicy[];
  proposerPaths: readonly string[];
  floor: PolicyTerms | null;
}): Resolved {
  const within = (path: string, scope: string) => path === scope || path.startsWith(`${scope}.`);

  const scoped = input.policies.filter(
    (policy) =>
      policy.connectionId === input.connectionId &&
      policy.scopePath !== null &&
      input.proposerPaths.some((path) => within(path, policy.scopePath!)),
  );

  let level: Level;
  let chosen: StoredPolicy[];

  if (scoped.length > 0) {
    const depth = (policy: StoredPolicy) => policy.scopePath!.split('.').length;
    const deepest = Math.max(...scoped.map(depth));
    level = 'scope';
    chosen = scoped.filter((policy) => depth(policy) === deepest);
  } else {
    const connection = input.policies.filter(
      (policy) => policy.connectionId === input.connectionId && policy.scopeId === null,
    );
    const organisation = input.policies.filter((policy) => policy.connectionId === null);

    if (connection.length > 0) {
      level = 'connection';
      chosen = connection;
    } else if (organisation.length > 0) {
      level = 'organisation';
      chosen = organisation;
    } else {
      level = 'implicit';
      chosen = [];
    }
  }

  const configured =
    chosen.length === 0
      ? IMPLICIT_POLICY
      : chosen.map(terms).reduce((held, next) => atLeast(held, next));

  const applied = input.floor ? atLeast(configured, input.floor) : configured;

  return {
    connectionId: input.connectionId,
    level,
    policyIds: chosen.map((policy) => policy.id).sort(),
    configured,
    applied,
    floorApplied: input.floor !== null && weakerTerms(configured, input.floor).length > 0,
  };
}

/** What a chain is held to: every connection's policy, satisfied together. */
export type ChainPolicy = {
  approvalsRequired: number;
  requiredRoleIds: string[];
  allowSelfApproval: boolean;
  separateExecution: boolean;
  expiresAfterHours: number;
  bulk: BulkTier;
  /** §8 — one more approver for a change of a hundred records or more. */
  bulkAdditional: number;
  connections: Resolved[];
};

/**
 * §9 — "Multi-connection mutations resolve every applicable policy and satisfy
 * the union, not the strictest. Two approvers required on one connection and an
 * admin required on another means two approvers of whom one is an admin."
 *
 * So the count is the largest any connection asks for, and every role any
 * connection names must be held by somebody among them. Taking the strictest
 * single policy would drop the admin; adding the counts would ask for three.
 */
export function unionOf(resolved: readonly Resolved[], bulk: BulkTier): ChainPolicy {
  const bulkAdditional = bulk === 'standard' ? 0 : 1;

  return {
    approvalsRequired: Math.max(1, ...resolved.map((one) => one.applied.approvalsRequired)) + bulkAdditional,
    requiredRoleIds: [
      ...new Set(resolved.map((one) => one.applied.requiredRoleId).filter((id): id is string => id !== null)),
    ].sort(),
    allowSelfApproval: resolved.every((one) => one.applied.allowSelfApproval),
    separateExecution: resolved.some((one) => one.applied.separateExecution),
    expiresAfterHours: Math.min(24, ...resolved.map((one) => one.applied.expiresAfterHours)),
    bulk,
    bulkAdditional,
    connections: [...resolved],
  };
}

/**
 * Whether the approvals so far satisfy the chain, and what is still missing.
 *
 * DISTINCT PEOPLE, NOT DECISIONS. The table enforces one row per person per
 * chain; counting people here as well means a caller handing in duplicates
 * cannot make two out of one.
 */
export function progressOf(
  policy: Pick<ChainPolicy, 'approvalsRequired' | 'requiredRoleIds'>,
  approvals: ReadonlyArray<{ approver: string; roleIds: readonly string[] }>,
): { satisfied: boolean; remaining: number; missingRoleIds: string[] } {
  const people = new Map(approvals.map((one) => [one.approver, new Set(one.roleIds)]));
  const held = new Set([...people.values()].flatMap((roles) => [...roles]));

  const remaining = Math.max(0, policy.approvalsRequired - people.size);
  const missingRoleIds = policy.requiredRoleIds.filter((roleId) => !held.has(roleId));

  return { satisfied: remaining === 0 && missingRoleIds.length === 0, remaining, missingRoleIds };
}
