// The audit hash chain (spec 13.4, 63.1; design: audit.audit_events, audit.chain_heads,
// audit.partition_seals). The spec says a removed row must be detectable and a daily
// head is published to the customer; the construction is defined here.
//
// Row hash, per organisation, in chain_seq order starting at 1:
//   row_hash = SHA-256( "silo.audit_events.v1" 0x00 prev_hash canonical_json(fields) )
// where prev_hash is the previous row's row_hash (for chain_seq 1, SHA-256 of the
// organisation id's 16 bytes, so one organisation's chain cannot pass as another's) and
// fields are every column except id, row_hash and recorded_at, with timestamps in
// canonicalTimestamp form, bytea as lowercase hex and chain_seq as a decimal string.
// Changing, removing or reordering any row breaks every later hash.
//
// Partition seal: a running hash over the digests of a closed partition's rows in id
// order, starting from SHA-256("silo.partition_seal.v1"), so a dropped row changes the
// seal even across organisations. audit_events rows contribute their row_hash; ledgers
// without a chain contribute rowDigest(row).

import { canonicalJsonBytes } from './canonicalJson.util.ts';
import { constantTimeEqual, sha256 } from './crypto.util.ts';
import { isUuid } from './id.util.ts';
import { canonicalTimestamp } from './time.util.ts';

// The prev_hash of an organisation's first event (design: audit.audit_events.prev_hash).
export function auditGenesisHash(organisationId: string): Buffer {
  if (!isUuid(organisationId)) throw new TypeError('organisation id must be a UUID');
  return sha256(Buffer.from(organisationId.replaceAll('-', ''), 'hex'));
}
const ROW_DOMAIN = Buffer.from('silo.audit_events.v1\u0000', 'utf8');
const SEAL_DOMAIN = 'silo.partition_seal.v1';

export interface ChainedAuditEvent {
  organisationId: string;
  chainSeq: string | number | bigint;
  sourceEventId: string;
  occurredAt: string;
  retentionClass: 'standard' | 'high_volume';
  event: string;
  membershipId: string | null;
  servicePrincipalId: string | null;
  operatorId: string | null;
  systemService: string | null;
  subjectMembershipId: string | null;
  scopeId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  purposeSessionId: string | null;
  operatorAccessSessionId: string | null;
  correlationId: string;
  detail: unknown;
  ipHash: Buffer | null;
}

function chainFields(event: ChainedAuditEvent): Record<string, unknown> {
  return {
    organisation_id: event.organisationId,
    chain_seq: String(event.chainSeq),
    source_event_id: event.sourceEventId,
    occurred_at: canonicalTimestamp(event.occurredAt),
    retention_class: event.retentionClass,
    event: event.event,
    membership_id: event.membershipId,
    service_principal_id: event.servicePrincipalId,
    operator_id: event.operatorId,
    system_service: event.systemService,
    subject_membership_id: event.subjectMembershipId,
    scope_id: event.scopeId,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    purpose_session_id: event.purposeSessionId,
    operator_access_session_id: event.operatorAccessSessionId,
    correlation_id: event.correlationId,
    detail: event.detail,
    ip_hash: event.ipHash === null ? null : event.ipHash.toString('hex'),
  };
}

export function auditRowHash(prevHash: Buffer, event: ChainedAuditEvent): Buffer {
  if (prevHash.length !== 32) throw new TypeError('prev_hash must be 32 bytes');
  return sha256(Buffer.concat([ROW_DOMAIN, prevHash, canonicalJsonBytes(chainFields(event))]));
}

export type ChainVerdict = { ok: true; lastHash: Buffer; count: number }
  | { ok: false; chainSeq: string; reason: 'organisation' | 'gap' | 'prev_hash' | 'row_hash' };

// Checks one organisation's rows in chain_seq order, from its first event or, given the
// previous row's hash and sequence, from the middle.
export function verifyAuditChain(
  organisationId: string,
  rows: Iterable<ChainedAuditEvent & { prevHash: Buffer; rowHash: Buffer }>,
  from: { prevHash: Buffer; chainSeq: bigint } = { prevHash: auditGenesisHash(organisationId), chainSeq: 0n },
): ChainVerdict {
  let prev = from.prevHash;
  let seq = from.chainSeq;
  let count = 0;
  for (const row of rows) {
    if (row.organisationId !== organisationId) return { ok: false, chainSeq: String(row.chainSeq), reason: 'organisation' };
    const rowSeq = BigInt(row.chainSeq);
    if (rowSeq !== seq + 1n) return { ok: false, chainSeq: String(row.chainSeq), reason: 'gap' };
    if (!constantTimeEqual(row.prevHash, prev)) return { ok: false, chainSeq: String(row.chainSeq), reason: 'prev_hash' };
    if (!constantTimeEqual(row.rowHash, auditRowHash(prev, row))) {
      return { ok: false, chainSeq: String(row.chainSeq), reason: 'row_hash' };
    }
    prev = row.rowHash;
    seq = rowSeq;
    count += 1;
  }
  return { ok: true, lastHash: prev, count };
}

// A digest of any ledger row, for seals of ledgers without a chain. Buffers become hex
// and timestamp strings are left as given: pass the row as the database returned it.
export function rowDigest(row: Record<string, unknown>): Buffer {
  const plain = (value: unknown): unknown => {
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return String(value);
    if (Array.isArray(value)) return value.map(plain);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    }
    return value;
  };
  return sha256(canonicalJsonBytes(plain(row)));
}

export class PartitionSeal {
  private running: Buffer = sha256(SEAL_DOMAIN);
  private rows = 0;

  add(rowDigestOrHash: Buffer): void {
    this.running = sha256(Buffer.concat([this.running, rowDigestOrHash]));
    this.rows += 1;
  }

  get runningHash(): Buffer {
    return this.running;
  }

  get rowCount(): number {
    return this.rows;
  }
}
