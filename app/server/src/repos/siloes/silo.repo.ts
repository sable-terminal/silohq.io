// Data access for siloes.siloes, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { siloTable, type NewSilo, type Silo, type SiloChanges } from '../../models/siloes/silo.model.ts';

export const siloRepo = {
  insert(db: Queryable, row: NewSilo): Promise<Silo> {
    return insertRow(db, siloTable, row);
  },

  findById(db: Queryable, id: Silo['id']): Promise<Silo | undefined> {
    return findRow(db, siloTable, { id });
  },

  update(db: Queryable, id: Silo['id'], changes: SiloChanges): Promise<Silo | undefined> {
    return updateRow(db, siloTable, { id }, changes);
  },

  /** This organisation's Siloes held in Silo's BigQuery (Import, Object Index, Warehouse), live. */
  async listInBigQuery(db: Queryable): Promise<Silo[]> {
    const { rows } = await db.query(
      `select ${siloTable.select} from siloes.siloes
       where kind in ('import', 'object_index', 'warehouse') and disabled_at is null and store_ref is not null order by created_at, id`);
    return rows as Silo[];
  },

  /** The organisations with Siloes in Silo's BigQuery, across the cell: identifiers only. */
  async organisationsInBigQuery(db: Queryable, limit: number): Promise<string[]> {
    const { rows } = await db.query('select distinct organisation_id as "organisationId" from siloes.bigquery_siloes($1)', [limit]);
    return (rows as { organisationId: string }[]).map((r) => r.organisationId);
  },

  /** When the Silo last took data in: a capture, a processed file, a completed index refresh or Warehouse sync (66.9). */
  async lastUpdatedOf(db: Queryable, siloId: string): Promise<string | null> {
    const { rows } = await db.query(
      `select greatest(
         (select max(observed_at) from siloes.transitions where silo_id = $1),
         (select max(processed_at) from siloes.silo_files where silo_id = $1),
         (select max(r.completed_at) from siloes.index_refreshes r join siloes.index_definitions d on d.id = r.index_definition_id
            where d.silo_id = $1 and r.status = 'completed'),
         (select max(r.completed_at) from siloes.warehouse_sync_runs r join siloes.warehouse_tables t on t.id = r.warehouse_table_id
            join siloes.warehouse_projects p on p.id = t.warehouse_project_id where p.silo_id = $1 and r.status = 'completed')
       ) as at`, [siloId]);
    const at = (rows[0] as { at: Date | string | null }).at;
    return at === null ? null : new Date(at).toISOString();
  },

  /** The live Import Silo a connection stands for (66.5); undefined where the connection is no Silo's. */
  async findImportBySourceConnection(db: Queryable, connectionId: string): Promise<Silo | undefined> {
    const { rows } = await db.query(
      `select ${siloTable.select} from siloes.siloes
       where kind = 'import' and source_connection_id = $1 and disabled_at is null order by created_at, id limit 1`, [connectionId]);
    return rows[0] as Silo | undefined;
  },

  /** The organisation's live Silo holding its Action ledger, where one does (48.2; D205): at most one. */
  async findLedgerHolder(db: Queryable): Promise<Silo | undefined> {
    const { rows } = await db.query(
      `select ${siloTable.select} from siloes.siloes where action_ledger_enabled_at is not null and disabled_at is null limit 1`);
    return rows[0] as Silo | undefined;
  },

  async list(db: Queryable, includeDisabled: boolean): Promise<Silo[]> {
    const { rows } = await db.query(
      `select ${siloTable.select} from siloes.siloes where ($1::boolean or disabled_at is null) order by created_at, id`, [includeDisabled]);
    return rows as Silo[];
  },

  /** Every live Silo, across the cell: identifiers only. */
  async liveAcrossCell(db: Queryable, limit: number): Promise<{ organisationId: string; id: string; kind: Silo['kind'] }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id, kind from siloes.live_siloes($1)', [limit]);
    return rows as { organisationId: string; id: string; kind: Silo['kind'] }[];
  },
};
