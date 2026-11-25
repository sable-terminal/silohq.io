// Data access for audit.audit_events, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_audit_writer, silo_report; written by silo_audit_writer.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  auditEventTable,
  type AuditEvent,
  type AuditEventPrimaryKey,
  type NewAuditEvent,
} from '../../models/audit/auditEvent.model.ts';

/** The last link of an organisation's chain. */
export interface ChainLink {
  chainSeq: string;
  rowHash: Buffer;
}

export interface AuditEventFilter {
  organisationId: string;
  from?: string | undefined;
  to?: string | undefined;
  event?: string | undefined;
  membershipId?: string | undefined;
  resource?: { type: string; id: string } | undefined;
  /** Only events about this scope or a scope beneath it (spec 63.5: admins read their subtree). */
  withinScopeId?: string | undefined;
  /** Keyset: events strictly before this (occurred_at, id). */
  before?: { occurredAt: string; id: string } | undefined;
  limit: number;
}

const SELECT = auditEventTable.select;

export const auditEventRepo = {
  insert(db: Queryable, row: NewAuditEvent): Promise<AuditEvent> {
    return insertRow(db, auditEventTable, row);
  },

  findByKey(db: Queryable, key: AuditEventPrimaryKey): Promise<AuditEvent | undefined> {
    return findRow(db, auditEventTable, key);
  },

  findByChainSeqAndRetentionClassAndOccurredAt(
    db: Queryable,
    key: Pick<AuditEvent, 'organisationId' | 'chainSeq' | 'retentionClass' | 'occurredAt'>,
  ): Promise<AuditEvent | undefined> {
    return findRow(db, auditEventTable, key);
  },

  findBySourceEventIdAndRetentionClassAndOccurredAt(
    db: Queryable,
    key: Pick<AuditEvent, 'organisationId' | 'sourceEventId' | 'retentionClass' | 'occurredAt'>,
  ): Promise<AuditEvent | undefined> {
    return findRow(db, auditEventTable, key);
  },

  // The chain (design: audit.audit_events). One writer per organisation at a time: the
  // writer takes this lock, reads the tip, and inserts the next link in one transaction.
  /** A Fleet event into every customer organisation's audit log, once by its sequence (definer function; D199). How many logs it went to. */
  async copyFleetEvent(db: Queryable, input: { seq: number; event: string; schemaVersion: number; topic: string; payload: unknown; correlationId: string }): Promise<number> {
    const { rows } = await db.query('select platform.copy_fleet_event($1, $2, $3, $4, $5, $6) as n',
      [input.seq, input.event, input.schemaVersion, input.topic, JSON.stringify(input.payload), input.correlationId]);
    return (rows[0] as { n: number }).n;
  },

  /** A status incident's declaration or resolution into every customer organisation's audit log, once (definer function; D209). */
  async copyIncidentEvent(db: Queryable, input: { noticeId: string; event: string; schemaVersion: number; topic: string; payload: unknown; correlationId: string }): Promise<number> {
    const { rows } = await db.query('select platform.copy_incident_event($1, $2, $3, $4, $5, $6) as n',
      [input.noticeId, input.event, input.schemaVersion, input.topic, JSON.stringify(input.payload), input.correlationId]);
    return (rows[0] as { n: number }).n;
  },

  async lockChain(db: Queryable, organisationId: string): Promise<void> {
    await db.query(`select pg_advisory_xact_lock(hashtextextended('audit.chain:' || $1::text, 0))`, [organisationId]);
  },

  async chainTip(db: Queryable, organisationId: string): Promise<ChainLink | undefined> {
    const { rows } = await db.query(
      `select chain_seq as "chainSeq", row_hash as "rowHash" from audit.audit_events
       where organisation_id = $1 order by chain_seq desc limit 1`, [organisationId]);
    return rows[0] as ChainLink | undefined;
  },

  /**
   * Inserts the next link. recorded_at is the clock after the chain lock was taken, not the
   * transaction's start, so it rises with chain_seq and a day's events are a contiguous run.
   */
  async insertChained(db: Queryable, row: NewAuditEvent): Promise<AuditEvent> {
    const { rows } = await db.query(
      `insert into audit.audit_events (occurred_at, retention_class, source_event_id, organisation_id, event, membership_id,
         service_principal_id, operator_id, system_service, subject_membership_id, scope_id, resource_type, resource_id,
         purpose_session_id, operator_access_session_id, correlation_id, detail, ip_hash, chain_seq, prev_hash, row_hash, recorded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, clock_timestamp())
       returning ${SELECT}`,
      [row.occurredAt, row.retentionClass ?? 'standard', row.sourceEventId, row.organisationId, row.event, row.membershipId ?? null,
        row.servicePrincipalId ?? null, row.operatorId ?? null, row.systemService ?? null, row.subjectMembershipId ?? null,
        row.scopeId ?? null, row.resourceType ?? null, row.resourceId ?? null, row.purposeSessionId ?? null,
        row.operatorAccessSessionId ?? null, row.correlationId, JSON.stringify(row.detail ?? {}), row.ipHash ?? null,
        row.chainSeq, row.prevHash, row.rowHash]);
    return rows[0] as AuditEvent;
  },

  /** The last link recorded before an instant: the head of the day that ends there. */
  async tipRecordedBefore(db: Queryable, organisationId: string, before: string): Promise<ChainLink | undefined> {
    const { rows } = await db.query(
      `select chain_seq as "chainSeq", row_hash as "rowHash" from audit.audit_events
       where organisation_id = $1 and recorded_at < $2 order by chain_seq desc limit 1`, [organisationId, before]);
    return rows[0] as ChainLink | undefined;
  },

  async countRecorded(db: Queryable, organisationId: string, from: string, to: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::bigint as n from audit.audit_events where organisation_id = $1 and recorded_at >= $2 and recorded_at < $3`,
      [organisationId, from, to]);
    return Number((rows[0] as { n: string }).n);
  },

  async firstRecordedAt(db: Queryable, organisationId: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `select recorded_at as "recordedAt" from audit.audit_events where organisation_id = $1 order by chain_seq limit 1`, [organisationId]);
    return (rows[0] as { recordedAt: string } | undefined)?.recordedAt;
  },

  /** The first of these events at or after a time, for a metric that cites it (spec 54.3). */
  async firstOf(db: Queryable, organisationId: string, events: readonly string[], since: string): Promise<{ id: string; occurredAt: string } | undefined> {
    const { rows } = await db.query(
      `select id::text as id, occurred_at as "occurredAt" from audit.audit_events
        where organisation_id = $1 and event = any($2::text[]) and occurred_at >= $3 order by occurred_at, id limit 1`, [organisationId, events, since]);
    return rows[0] as { id: string; occurredAt: string } | undefined;
  },

  /** How many of each of these events occurred in [from, to). */
  async countsOf(db: Queryable, organisationId: string, events: readonly string[], from: string, to: string): Promise<Record<string, number>> {
    const { rows } = await db.query(
      `select event, count(*)::int as n from audit.audit_events
        where organisation_id = $1 and event = any($2::text[]) and occurred_at >= $3 and occurred_at < $4 group by event`, [organisationId, events, from, to]);
    return Object.fromEntries((rows as { event: string; n: number }[]).map((r) => [r.event, r.n]));
  },

  /** One event's details since a time, oldest first, bounded. References and counts only, as every event's detail is. */
  async detailsOf(db: Queryable, organisationId: string, event: string, since: string, limit: number)
    : Promise<{ occurredAt: string; detail: Record<string, unknown> }[]> {
    const { rows } = await db.query(
      `select occurred_at as "occurredAt", detail from audit.audit_events
        where organisation_id = $1 and event = $2 and occurred_at >= $3 order by occurred_at, id limit $4`, [organisationId, event, since, limit]);
    return rows as { occurredAt: string; detail: Record<string, unknown> }[];
  },

  /**
   * Events of these names on any of these resources in [from, to), oldest first, bounded: an
   * artefact's later history (54.1's post-handover reversal rate). References and counts only.
   */
  async onResources(db: Queryable, organisationId: string, events: readonly string[], resourceIds: readonly string[], from: string, to: string, limit: number)
    : Promise<{ id: string; event: string; occurredAt: string; resourceId: string; membershipId: string | null; detail: Record<string, unknown> }[]> {
    if (resourceIds.length === 0 || events.length === 0) return [];
    const { rows } = await db.query(
      `select id::text as id, event, occurred_at as "occurredAt", resource_id as "resourceId", membership_id as "membershipId", detail
         from audit.audit_events
        where organisation_id = $1 and event = any($2::text[]) and resource_id = any($3::uuid[]) and occurred_at >= $4 and occurred_at < $5
        order by occurred_at, id limit $6`, [organisationId, events, resourceIds, from, to, limit]);
    return rows as never;
  },

  /** Each resource's first event of this name since a time: when each connection's first mapping was confirmed, say. */
  async firstPerResource(db: Queryable, organisationId: string, event: string, since: string): Promise<{ resourceId: string; occurredAt: string }[]> {
    const { rows } = await db.query(
      `select resource_id as "resourceId", min(occurred_at) as "occurredAt" from audit.audit_events
        where organisation_id = $1 and event = $2 and occurred_at >= $3 and resource_id is not null group by resource_id`, [organisationId, event, since]);
    return rows as { resourceId: string; occurredAt: string }[];
  },

  /** The first open of a published version of this app, since a time, by a person other than the one named (54.1's time to first app). */
  async firstOpenByAnother(db: Queryable, organisationId: string, appId: string, since: string, notMembershipId: string)
    : Promise<{ id: string; occurredAt: string } | undefined> {
    const { rows } = await db.query(
      `select id::text as id, occurred_at as "occurredAt" from audit.audit_events
        where organisation_id = $1 and event = 'app_opened' and resource_type = 'app' and resource_id = $2 and occurred_at >= $3
          and membership_id is not null and membership_id <> $4 and detail ->> 'published' = 'true'
        order by occurred_at, id limit 1`, [organisationId, appId, since, notMembershipId]);
    return rows[0] as { id: string; occurredAt: string } | undefined;
  },

  /** The first live subscription with objects on this connection, at or after a time (54.1's time to first live clone). */
  async firstLiveSubscription(db: Queryable, organisationId: string, connectionId: string, since: string): Promise<{ id: string; occurredAt: string } | undefined> {
    const { rows } = await db.query(
      `select id::text as id, occurred_at as "occurredAt" from audit.audit_events
        where organisation_id = $1 and event = 'subscription_opened' and occurred_at >= $3
          and detail ->> 'connection_id' = $2 and detail ->> 'mode' = 'live' and (detail ->> 'objects')::int > 0
        order by occurred_at, id limit 1`, [organisationId, connectionId, since]);
    return rows[0] as { id: string; occurredAt: string } | undefined;
  },

  /** Newest first, filtered; for the audit view. */
  async list(db: Queryable, filter: AuditEventFilter): Promise<AuditEvent[]> {
    const params: unknown[] = [filter.organisationId];
    const terms = ['e.organisation_id = $1'];
    const add = (term: (n: string) => string, value: unknown): void => {
      params.push(value);
      terms.push(term(`$${params.length}`));
    };
    if (filter.from !== undefined) add((n) => `e.occurred_at >= ${n}`, filter.from);
    if (filter.to !== undefined) add((n) => `e.occurred_at < ${n}`, filter.to);
    if (filter.event !== undefined) add((n) => `e.event = ${n}`, filter.event);
    if (filter.membershipId !== undefined) add((n) => `e.membership_id = ${n}`, filter.membershipId);
    if (filter.resource !== undefined) {
      add((n) => `e.resource_type = ${n}`, filter.resource.type);
      add((n) => `e.resource_id = ${n}`, filter.resource.id);
    }
    if (filter.withinScopeId !== undefined) {
      add((n) => `exists (select 1 from iam.scopes s, iam.scopes root
                          where s.organisation_id = e.organisation_id and s.id = e.scope_id
                            and root.organisation_id = e.organisation_id and root.id = ${n} and s.path <@ root.path)`, filter.withinScopeId);
    }
    if (filter.before !== undefined) {
      params.push(filter.before.occurredAt, filter.before.id);
      terms.push(`(e.occurred_at, e.id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(filter.limit);
    const { rows } = await db.query(
      `select ${SELECT} from audit.audit_events e
       where ${terms.join(' and ')} order by e.occurred_at desc, e.id desc limit $${params.length}`, params);
    return rows as AuditEvent[];
  },

  /** A run of the chain in order, after a given link (0 for the start), and the link it follows. */
  async chainRun(db: Queryable, organisationId: string, afterChainSeq: string, limit: number)
    : Promise<{ anchor: ChainLink | undefined; rows: AuditEvent[] }> {
    const { rows } = await db.query(
      `select ${SELECT} from audit.audit_events where organisation_id = $1 and chain_seq > $2 order by chain_seq limit $3`,
      [organisationId, afterChainSeq, limit]);
    const anchorRows = afterChainSeq === '0' ? [] : (await db.query(
      `select chain_seq as "chainSeq", row_hash as "rowHash" from audit.audit_events where organisation_id = $1 and chain_seq = $2`,
      [organisationId, afterChainSeq])).rows;
    return { anchor: anchorRows[0] as ChainLink | undefined, rows: rows as AuditEvent[] };
  },

  /**
   * How many distinct memberships have an event on any of these resources, since a time:
   * lineage's access overlay (spec 59.4). A count, never who.
   */
  async distinctMembershipsOn(db: Queryable, organisationId: string, resourceIds: readonly string[], since: string | null): Promise<number> {
    if (resourceIds.length === 0) return 0;
    const { rows } = await db.query(
      `select count(distinct membership_id)::int as n from audit.audit_events
       where organisation_id = $1 and resource_id = any($2::uuid[]) and membership_id is not null
         and ($3::timestamptz is null or occurred_at >= $3::timestamptz)`,
      [organisationId, resourceIds, since]);
    return (rows[0] as { n: number }).n;
  },
};
