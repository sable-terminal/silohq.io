/**
 * §9 — what an agent was permitted to contact, and what it reported back.
 *
 * THERE IS NO FIELD HERE FOR A VALUE READ OUT OF THE CUSTOMER'S DATA, and the
 * absence is the point rather than an oversight. 019 gives a finding a
 * `structure` column and deliberately nothing to put a row in, because §9.3
 * says discovery must not be the phase where the no-data-stored claim quietly
 * breaks. A model field for it would be the first half of a column for it.
 *
 * THE AGENT IS NOT MODELLED. It is a program on the customer's network, and
 * `agentId` is text on the authorisation for the same reason it is text in 019:
 * a uuid pointing at nothing looks like a uuid pointing at something.
 */

/**
 * How a thing was found, which is not the same as what was permitted.
 *
 * The authorisation carries the methods allowed; a finding carries the one
 * actually used. "Postgres, from the catalogue" is a schema and "Postgres, from
 * a port scan" is a guess from an open 5432 — an admin approving findings one at
 * a time is deciding about different things in the two cases.
 */
export type ScanMethod = 'port_scan' | 'read_host_config' | 'catalogue_introspect';

/**
 * The organisation-wide switch.
 *
 * ENABLING IT AUTHORISES NOTHING. §9.2 — a scan needs its own authorisation with
 * its own ranges and its own expiry; this row only says whether such an
 * authorisation may exist at all.
 */
export interface DiscoverySettings {
  organisationId: string;
  enabled: boolean;
  enabledBy: string | null;
  enabledAt: Date | null;
  disabledBy: string | null;
  disabledAt: Date | null;
}

/** A window, not standing permission: one scan, its ranges, and when it lapses. */
export interface ScanAuthorisation {
  id: string;
  organisationId: string;
  agentId: string;
  /** CIDR, always explicit — nothing is inferred from the agent's own address. */
  ranges: string[];
  methods: ScanMethod[];
  authorisedBy: string;
  authorisedAt: Date;
  /** §9.2 routes a scan through the approval chain. Null until approvals exist. */
  approvalId: string | null;
  expiresAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
}

export type AuthorisationState = 'live' | 'revoked' | 'expired';

/**
 * DERIVED FROM THE TWO TIMESTAMPS, NEVER STORED. A `state` column would be wrong
 * the moment `expires_at` passed, because nothing runs at that moment to update
 * it — expiry is the passage of time rather than an event anybody writes down.
 *
 * This is the same condition the trigger in 019 applies before it lets a run
 * start. The trigger remains the enforcement; this is for reading, and a caller
 * that used it to decide whether a scan may proceed would be checking a copy.
 */
export function stateOf(
  authorisation: ScanAuthorisation,
  now: Date = new Date(),
): AuthorisationState {
  if (authorisation.revokedAt) return 'revoked';
  if (authorisation.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'live';
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface DiscoveryRun {
  id: string;
  authorisationId: string;
  status: RunStatus;
  hostsContacted: number;
  startedAt: Date;
  completedAt: Date | null;
}

/**
 * A run with the two numbers a security review asks for first.
 *
 * The agent is on the authorisation rather than the run, so "which agent
 * contacted these hosts" cannot be answered from `discovery_runs` alone.
 */
export interface RunSummary extends DiscoveryRun {
  agentId: string;
  findings: number;
}

export type FindingDecision = 'accepted' | 'rejected' | 'ignored';

/** Something an agent saw. A proposal, never a configuration. */
export interface DiscoveryFinding {
  id: string;
  runId: string;
  host: string;
  port: number | null;
  method: ScanMethod;
  /** §9.3: schema, columns, types, foreign keys, row counts, endpoint shapes. */
  structure: Record<string, unknown>;
  /** What it appears to be, which is a guess until somebody confirms it. */
  proposedTransport: string | null;
  confidence: number | null;
  decision: FindingDecision | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  promotedConnectionId: string | null;
  foundAt: Date;
}

/**
 * DECIDED IS THE DECISION BEING PRESENT, NOT ITS VALUE. Rejecting and ignoring
 * close a finding as firmly as accepting does; a caller testing for `accepted`
 * to see whether the review has happened lets a rejected finding be reviewed a
 * second time by somebody who disagrees with the first answer.
 */
export function isDecided(finding: DiscoveryFinding): boolean {
  return finding.decision !== null;
}

/**
 * What a promoted finding is called in the builder.
 *
 * DERIVED, BECAUSE THE METHOD BELONGS IN THE NAME. The person opening the draft
 * is being asked to trust a shape somebody's network volunteered, and a host
 * alone does not say whether that shape came from a catalogue or from a guess at
 * an open port.
 */
export function proposedConnectorName(
  finding: Pick<DiscoveryFinding, 'host' | 'method'>,
): string {
  return `${finding.host} (found by ${finding.method.replace(/_/g, ' ')})`;
}
