/**
 * A connected instance of a connector — "Acme's Salesforce", as against "how to
 * talk to Salesforce", which is the manifest.
 *
 * THE TYPES HERE ARE THE SHAPES THE REPOS RETURN, not a mirror of every column.
 * `connections` carries provenance, policy authority and verification columns
 * that nothing in this domain reads; inventing fields for them would be a
 * contract nothing fills, and the first caller to trust one would read
 * `undefined`.
 */

export type ConnectionStatus =
  | 'draft'
  | 'probing'
  | 'verified'
  | 'active'
  | 'halted'
  | 'revoked';

/** 028: how much the credential can reach at the source. `unknown` is a gap, not an assurance. */
export type CredentialRights = 'broad' | 'scoped' | 'unknown';

/**
 * Whether one credential may serve a group.
 *
 * THE MANIFEST DECLARES IT AND IT IS NOT NULLABLE HERE. It is read out of a
 * `jsonb` document where the field may be absent, and the repo's map settles
 * that once: anything that is not `per_user` is shareable. Leaving it null to
 * the callers means every one of them decides what a missing value means, and
 * the safe reading is not the one somebody reaches for at four in the afternoon.
 */
export type CredentialSharing = 'shareable' | 'per_user';

/* ── Connecting ─────────────────────────────────────────────────────────── */

/** The live manifest a new connection will be made against. */
export interface ConnectableManifest {
  id: string;
  provider: string;
  credentialSharing: CredentialSharing;
}

/* ── Reading the record ─────────────────────────────────────────────────── */

/** How far the live grants on a connection currently reach. */
export interface ConnectionReach {
  /** Scopes by name: "Engineering" answers the question, "1 scope" does not. */
  scopes: string[];
  people: number;
  principals: number;
}

/** A connection as the list screen reads it: the row, its credential hint and its reach. */
export interface ConnectionOverview {
  id: string;
  name: string;
  provider: string;
  status: ConnectionStatus;
  writesEnabled: boolean;
  haltedReason: string | null;
  lastHealthyAt: Date | null;
  credentialActsAs: string | null;
  credentialRights: CredentialRights;
  /** The last four characters of the secret. The only fragment of it a screen sees. */
  credentialLastFour: string | null;
  notes: string | null;
  /** Which instance of the system this is — host, tenant, region. Never secret; refused if it looks it. */
  parameters: Record<string, string>;
  /** The connector version this connection runs. */
  manifestId: string;
  manifestVersion: number | null;
  /** Where the credential may go, as confirmed (MANIFEST-V2 §9.2). Null before anything was pinned. */
  pinnedOrigins: string[] | null;
  /** When the credential itself stops working, where that can be read from it (125). */
  credentialExpiresAt: Date | null;
  credentialExpirySource: 'certificate' | 'token' | 'declared' | null;
  reach: ConnectionReach;
}

/** Enough of a connection to decide whether a halt can be cleared, and to say what it was. */
export interface ConnectionHalt {
  status: ConnectionStatus;
  haltedReason: string | null;
}

/** What the credential is at the source, and how far it reaches. 028. */
export interface CredentialProvenance {
  actsAs: string | null;
  rights: CredentialRights;
}

/** §7's record of a verification or maintenance run. */
export interface ProbeRun {
  id: string;
  stage: string;
  status: string;
  findings: Record<string, unknown>;
  errors: unknown[];
  /** §7 step 1 is read-only and step 4 is not; the difference has to survive. */
  readOnly: boolean;
  startedAt: Date;
  completedAt: Date | null;
}

/** One version in the lineage of the manifest a connection reads through. */
export interface ManifestVersion {
  id: string;
  version: number;
  sourceRoute: string;
  createdAt: Date;
  supersededAt: Date | null;
}

/* ── What is available, before it is usable ─────────────────────────────── */

export type AvailabilityStatus = 'ready' | 'needs_your_credential' | 'needs_setup';

/** An approved connector, and what this person's own access to it amounts to. */
export interface AvailableConnector {
  manifestId: string;
  connectorKey: string;
  name: string;
  provider: string;
  version: number | null;
  credentialSharing: CredentialSharing;
  /** A connection through this manifest that the asker can already read. */
  connectionId: string | null;
  /**
   * EVERY LIVE CONNECTION THROUGH THIS MANIFEST, THE ASKER'S INCLUDED. The
   * screen wants the count of OTHER people, and subtracting at the call site is
   * how one screen says eleven and another twelve; `othersConnected` below does
   * it once.
   */
  connectionsInUse: number;
}

/**
 * NOBODY HAS SET IT UP AT ALL versus IT IS SET UP AND WAITING FOR YOU. The first
 * needs an admin and the second needs you, and telling somebody the wrong one
 * sends them to the wrong place.
 *
 * DERIVED, NEVER STORED, for the reason `seat.model` gives about seat state: a
 * status column beside the connection and the count would be a third source of
 * truth, wrong the first time a colleague connects.
 */
export function availabilityOf(
  connector: Pick<AvailableConnector, 'connectionId' | 'credentialSharing' | 'connectionsInUse'>,
): AvailabilityStatus {
  if (connector.connectionId) return 'ready';
  return connector.connectionsInUse > 0 && connector.credentialSharing === 'per_user'
    ? 'needs_your_credential'
    : 'needs_setup';
}

/**
 * How many colleagues have connected. A COUNT AND NEVER A LIST — that eleven
 * colleagues have connected their Jira says the thing works and you are the one
 * who has not; WHICH colleagues is not that screen's business.
 */
export function othersConnected(
  connector: Pick<AvailableConnector, 'connectionId' | 'connectionsInUse'>,
): number {
  return connector.connectionId
    ? Math.max(connector.connectionsInUse - 1, 0)
    : connector.connectionsInUse;
}

/* ── Grants ─────────────────────────────────────────────────────────────── */

export type GranteeType = 'organisation' | 'scope' | 'membership' | 'principal';

/**
 * Who a grant names.
 *
 * FOUR COLUMNS AND EXACTLY ONE OF THEM IS SET, which 016's `one_grantee` check
 * enforces. The kind is therefore a fact about the row rather than a fifth
 * column, and `granteeTypeOf` is the single place that reads it — two copies of
 * this ladder disagree the first time a grantee kind is added, and the one that
 * is wrong labels a machine identity as a person in an access review.
 */
export interface GrantTarget {
  organisationWide: boolean;
  scopeId: string | null;
  membershipId: string | null;
  principalId: string | null;
}

export function granteeTypeOf(target: GrantTarget): GranteeType {
  if (target.organisationWide) return 'organisation';
  if (target.scopeId) return 'scope';
  if (target.membershipId) return 'membership';
  return 'principal';
}

/** Null for the organisation, which is the one grantee that is not a row somewhere else. */
export function granteeIdOf(target: GrantTarget): string | null {
  return target.scopeId ?? target.membershipId ?? target.principalId;
}

export interface ConnectionGrant extends GrantTarget {
  id: string;
  canRead: boolean;
  canWrite: boolean;
  includeDescendants: boolean;
  grantedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** What a revocation hands back: the connection it was on, and who it had named. */
export interface RevokedGrant extends GrantTarget {
  connectionId: string;
}

/**
 * One person who can currently reach a connection, and the route that got them
 * there — which is not always the grant somebody remembers making.
 */
export interface ReachEntry {
  membershipId: string;
  firstName: string;
  lastName: string;
  email: string;
  canWrite: boolean;
  via: 'organisation' | 'scope' | 'membership';
  viaName: string | null;
}
