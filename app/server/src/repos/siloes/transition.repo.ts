// Data access for siloes.transitions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  transitionTable,
  type NewTransition,
  type Transition,
  type TransitionPrimaryKey,
} from '../../models/siloes/transition.model.ts';

export interface HistoryFilter {
  siloId: string;
  objectTypeId: string;
  property: string;
  objectRefs?: string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export const transitionRepo = {
  insert(db: Queryable, row: NewTransition): Promise<Transition> {
    return insertRow(db, transitionTable, row);
  },

  findByKey(db: Queryable, key: TransitionPrimaryKey): Promise<Transition | undefined> {
    return findRow(db, transitionTable, key);
  },

  /** An organisation's Capture partitions, created on its first Capture Silo (idempotent). */
  async ensurePartitions(db: Queryable, organisationId: string): Promise<void> {
    await db.query('select siloes.create_capture_partitions($1)', [organisationId]);
  },

  /** A batch of transitions in one statement. */
  async insertMany(db: Queryable, rows: NewTransition[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { rowCount } = await db.query(
      `insert into siloes.transitions (organisation_id, silo_id, object_type_id, object_ref, property, previous_value, new_value, observed_at, connection_id)
       select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::bytea[], $7::bytea[], $8::timestamptz[], $9::uuid[])`,
      [rows.map((r) => r.organisationId), rows.map((r) => r.siloId), rows.map((r) => r.objectTypeId), rows.map((r) => r.objectRef),
        rows.map((r) => r.property), rows.map((r) => r.previousValue), rows.map((r) => r.newValue), rows.map((r) => r.observedAt),
        rows.map((r) => r.connectionId)]);
    return rowCount ?? 0;
  },

  /** How many transitions of a property a Silo holds in the window, and when its capture began. */
  async stats(db: Queryable, f: HistoryFilter): Promise<{ count: number; first: string | null }> {
    const { rows } = await db.query(
      `select count(*)::int as count, min(observed_at) as first from siloes.transitions
       where silo_id = $1 and object_type_id = $2 and property = $3 and ($4::text[] is null or object_ref = any($4))
         and ($5::timestamptz is null or observed_at >= $5) and ($6::timestamptz is null or observed_at < $6)`,
      [f.siloId, f.objectTypeId, f.property, f.objectRefs ?? null, f.from ?? null, f.to ?? null]);
    const row = rows[0] as { count: number; first: Date | string | null };
    return { count: row.count, first: row.first === null ? null : new Date(row.first).toISOString() };
  },

  async list(db: Queryable, f: HistoryFilter, limit: number): Promise<Transition[]> {
    const { rows } = await db.query(
      `select ${transitionTable.select} from siloes.transitions
       where silo_id = $1 and object_type_id = $2 and property = $3 and ($4::text[] is null or object_ref = any($4))
         and ($5::timestamptz is null or observed_at >= $5) and ($6::timestamptz is null or observed_at < $6)
       order by observed_at, id limit $7`,
      [f.siloId, f.objectTypeId, f.property, f.objectRefs ?? null, f.from ?? null, f.to ?? null, limit]);
    return rows as Transition[];
  },

  /** One object's transitions of these properties in these Siloes, newest first, before a time (34.4). */
  async listForObject(db: Queryable, f: { siloIds: readonly string[]; objectTypeId: string; objectRef: string; properties: readonly string[]; before?: string | undefined },
    limit: number): Promise<Transition[]> {
    if (f.siloIds.length === 0 || f.properties.length === 0) return [];
    const { rows } = await db.query(
      `select ${transitionTable.select} from siloes.transitions
       where silo_id = any($1::uuid[]) and object_type_id = $2 and object_ref = $3 and property = any($4::text[])
         and ($5::timestamptz is null or observed_at < $5)
       order by observed_at desc, id desc limit $6`,
      [f.siloIds, f.objectTypeId, f.objectRef, f.properties, f.before ?? null, limit]);
    return rows as Transition[];
  },

  /** When captured history of a type's properties begins in these Siloes (34.4). */
  async firstObserved(db: Queryable, siloIds: readonly string[], objectTypeId: string, properties: readonly string[]): Promise<string | null> {
    if (siloIds.length === 0 || properties.length === 0) return null;
    const { rows } = await db.query(
      `select min(observed_at) as first from siloes.transitions
       where silo_id = any($1::uuid[]) and object_type_id = $2 and property = any($3::text[])`, [siloIds, objectTypeId, properties]);
    const first = (rows[0] as { first: Date | string | null }).first;
    return first === null ? null : new Date(first).toISOString();
  },

  /** Per object, the last transition of a property at or before a time (30.8). */
  async lastAtOrBefore(db: Queryable, f: { siloId: string; objectTypeId: string; property: string; objectRefs: readonly string[]; at: string }): Promise<Transition[]> {
    const { rows } = await db.query(
      `select distinct on (object_ref) ${transitionTable.select} from siloes.transitions
       where silo_id = $1 and object_type_id = $2 and property = $3 and object_ref = any($4) and observed_at <= $5
       order by object_ref, observed_at desc, id desc`, [f.siloId, f.objectTypeId, f.property, f.objectRefs, f.at]);
    return rows as Transition[];
  },

  /** Per object, the first transition of a property after a time: its previous value is the value at the time (30.8). */
  async firstAfter(db: Queryable, f: { siloId: string; objectTypeId: string; property: string; objectRefs: readonly string[]; at: string }): Promise<Transition[]> {
    const { rows } = await db.query(
      `select distinct on (object_ref) ${transitionTable.select} from siloes.transitions
       where silo_id = $1 and object_type_id = $2 and property = $3 and object_ref = any($4) and observed_at > $5
       order by object_ref, observed_at, id`, [f.siloId, f.objectTypeId, f.property, f.objectRefs, f.at]);
    return rows as Transition[];
  },

  /** Purge entity, concept or Silo (spec 70.2): counts of what went. */
  async purge(db: Queryable, organisationId: string, siloId: string, objectTypeId: string | null, objectRef: string | null)
    : Promise<{ transitions: number; baselines: number; ledger: number }> {
    const { rows } = await db.query('select transitions, baselines, ledger from siloes.purge_capture($1, $2, $3, $4)',
      [organisationId, siloId, objectTypeId, objectRef]);
    const r = rows[0] as { transitions: string; baselines: string; ledger: string };
    return { transitions: Number(r.transitions), baselines: Number(r.baselines), ledger: Number(r.ledger) };
  },

  /** The retention sweep (70.1): counts of what went. */
  async sweep(db: Queryable, organisationId: string, siloId: string, before: string): Promise<{ transitions: number; baselines: number; ledger: number }> {
    const { rows } = await db.query('select transitions, baselines, ledger from siloes.sweep_capture($1, $2, $3)', [organisationId, siloId, before]);
    const r = rows[0] as { transitions: string; baselines: string; ledger: string };
    return { transitions: Number(r.transitions), baselines: Number(r.baselines), ledger: Number(r.ledger) };
  },

  async captureBytes(db: Queryable, organisationId: string, siloId: string): Promise<string> {
    const { rows } = await db.query('select siloes.capture_bytes($1, $2)::text as bytes', [organisationId, siloId]);
    return (rows[0] as { bytes: string }).bytes;
  },
};
