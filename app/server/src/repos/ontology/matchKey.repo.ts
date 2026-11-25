// Data access for ontology.match_keys, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  matchKeyTable,
  type MatchKey,
  type MatchKeyChanges,
  type MatchKeyPrimaryKey,
  type NewMatchKey,
} from '../../models/ontology/matchKey.model.ts';

export const matchKeyRepo = {
  insert(db: Queryable, row: NewMatchKey): Promise<MatchKey> {
    return insertRow(db, matchKeyTable, row);
  },

  findByKey(db: Queryable, key: MatchKeyPrimaryKey): Promise<MatchKey | undefined> {
    return findRow(db, matchKeyTable, key);
  },

  update(db: Queryable, key: MatchKeyPrimaryKey, changes: MatchKeyChanges): Promise<MatchKey | undefined> {
    return updateRow(db, matchKeyTable, key, changes);
  },

  /** Serialises writes to one type's entity graph for the rest of the transaction. */
  async lockType(db: Queryable, objectTypeId: string): Promise<void> {
    await db.query(`select pg_advisory_xact_lock(hashtextextended('ontology.match_keys:' || $1::text, 0))`, [objectTypeId]);
  },

  /** The live entries of these source records (match_keys_live_source). */
  async liveBySourceRecords(db: Queryable, objectTypeId: string, connectionId: string, sourceObject: string, identifierHashes: readonly Buffer[])
    : Promise<MatchKey[]> {
    if (identifierHashes.length === 0) return [];
    const { rows } = await db.query(
      `select ${matchKeyTable.select} from ontology.match_keys
       where object_type_id = $1 and connection_id = $2 and source_object = $3 and source_identifier_hash = any($4::bytea[])
         and superseded_at is null`, [objectTypeId, connectionId, sourceObject, identifierHashes]);
    return rows as MatchKey[];
  },

  /** The live entries holding these match keys (match_keys_merge_lookup). */
  async liveByKeys(db: Queryable, objectTypeId: string, keyHashes: readonly Buffer[]): Promise<MatchKey[]> {
    if (keyHashes.length === 0) return [];
    const { rows } = await db.query(
      `select ${matchKeyTable.select} from ontology.match_keys
       where object_type_id = $1 and match_key_hash = any($2::bytea[]) and superseded_at is null`, [objectTypeId, keyHashes]);
    return rows as MatchKey[];
  },

  /** The live entries of these objects (match_keys_by_object). */
  async liveByObjects(db: Queryable, objectTypeId: string, siloObjectIds: readonly string[]): Promise<MatchKey[]> {
    if (siloObjectIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${matchKeyTable.select} from ontology.match_keys
       where silo_object_id = any($2::uuid[]) and object_type_id = $1 and superseded_at is null`, [objectTypeId, siloObjectIds]);
    return rows as MatchKey[];
  },

  /** These rows by id, live or superseded. */
  /** Whether any object of the type is bound to live records in two contributing objects (27.7). */
  async overlapsSources(db: Queryable, objectTypeId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (
         select 1 from ontology.match_keys a
         join ontology.match_keys b on b.organisation_id = a.organisation_id and b.silo_object_id = a.silo_object_id
          and b.object_type_id = a.object_type_id and b.superseded_at is null
          and (b.connection_id, b.source_object) <> (a.connection_id, a.source_object)
         where a.object_type_id = $1 and a.superseded_at is null
       ) as overlapping`, [objectTypeId]);
    return (rows[0] as { overlapping: boolean }).overlapping;
  },

  async findMany(db: Queryable, ids: readonly string[]): Promise<MatchKey[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(`select ${matchKeyTable.select} from ontology.match_keys where id = any($1::uuid[])`, [ids]);
    return rows as MatchKey[];
  },

  /** Every match key an object has ever held, live or superseded. */
  async historyOf(db: Queryable, objectTypeId: string, siloObjectId: string): Promise<Buffer[]> {
    const { rows } = await db.query(
      'select distinct match_key_hash as h from ontology.match_keys where silo_object_id = $2 and object_type_id = $1', [objectTypeId, siloObjectId]);
    return rows.map((r: { h: Buffer }) => r.h);
  },

  /** Which of these Silo object ids any row has ever named: an id is never given to a second object. */
  async idsEverUsed(db: Queryable, objectTypeId: string, siloObjectIds: readonly string[]): Promise<Set<string>> {
    if (siloObjectIds.length === 0) return new Set();
    const { rows } = await db.query(
      `select distinct silo_object_id as id from ontology.match_keys where silo_object_id = any($2::uuid[]) and object_type_id = $1`,
      [objectTypeId, siloObjectIds]);
    return new Set(rows.map((r: { id: string }) => r.id));
  },

  /** Inserts entries in one statement. */
  async insertMany(db: Queryable, rows: readonly NewMatchKey[]): Promise<void> {
    if (rows.length === 0) return;
    const column = <K extends keyof NewMatchKey>(key: K) => rows.map((r) => r[key] ?? null);
    await db.query(
      `insert into ontology.match_keys (id, organisation_id, object_type_id, silo_object_id, connection_id, source_object,
         source_identifier_hash, match_key_hash, hmac_key_version_id, origin, resolution_proposal_id)
       select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::bytea[], $8::bytea[], $9::uuid[],
         $10::text[], $11::uuid[])`,
      [column('id'), column('organisationId'), column('objectTypeId'), column('siloObjectId'), column('connectionId'), column('sourceObject'),
        column('sourceIdentifierHash'), column('matchKeyHash'), column('hmacKeyVersionId'), column('origin'), column('resolutionProposalId')]);
  },

  /** Supersedes live entries (remapping, merging, retiring). Returns how many changed. */
  async supersede(db: Queryable, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await db.query(
      'update ontology.match_keys set superseded_at = now() where id = any($1::uuid[]) and superseded_at is null', [ids]);
    return rowCount ?? 0;
  },

  /**
   * Marks entries seen. On the answering path at most once an hour per row (force false),
   * to keep write load down; a full run marks every row it read (force true).
   */
  async touch(db: Queryable, ids: readonly string[], force: boolean): Promise<void> {
    if (ids.length === 0) return;
    await db.query(
      `update ontology.match_keys set last_seen_at = now()
       where id = any($1::uuid[]) and superseded_at is null and ($2 or last_seen_at < now() - interval '1 hour')`, [ids, force]);
  },

  /** After a complete read of a contributing object: live entries it no longer returned are superseded. */
  async retireUnseen(db: Queryable, objectTypeId: string, connectionId: string, sourceObject: string, seenSince: string)
    : Promise<{ id: string; siloObjectId: string }[]> {
    const { rows } = await db.query(
      `update ontology.match_keys set superseded_at = now()
       where object_type_id = $1 and connection_id = $2 and source_object = $3 and superseded_at is null and last_seen_at < $4
       returning id, silo_object_id as "siloObjectId"`, [objectTypeId, connectionId, sourceObject, seenSince]);
    return rows as { id: string; siloObjectId: string }[];
  },
};
