// Data access for connect.agents, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  agentTable,
  type Agent,
  type AgentChanges,
  type NewAgent,
} from '../../models/connect/agent.model.ts';

export const agentRepo = {
  insert(db: Queryable, row: NewAgent): Promise<Agent> {
    return insertRow(db, agentTable, row);
  },

  findById(db: Queryable, id: Agent['id']): Promise<Agent | undefined> {
    return findRow(db, agentTable, { id });
  },

  findByCertificateFingerprint(
    db: Queryable,
    certificateFingerprint: Agent['certificateFingerprint'],
  ): Promise<Agent | undefined> {
    return findRow(db, agentTable, { certificateFingerprint });
  },

  findByServicePrincipalId(
    db: Queryable,
    key: Pick<Agent, 'organisationId' | 'servicePrincipalId'>,
  ): Promise<Agent | undefined> {
    return findRow(db, agentTable, key);
  },

  update(db: Queryable, id: Agent['id'], changes: AgentChanges): Promise<Agent | undefined> {
    return updateRow(db, agentTable, { id }, changes);
  },

  /** The organisation's agents not revoked, for the Estate map: metadata only. */
  async listForEstate(db: Queryable, limit: number): Promise<Agent[]> {
    const { rows } = await db.query(
      `select ${agentTable.select} from connect.agents where revoked_at is null order by enrolled_at, id limit $1`, [limit]);
    return rows as Agent[];
  },

  /** The agents of these pools, revoked ones included, oldest first. */
  async forPools(db: Queryable, poolIds: readonly string[]): Promise<Agent[]> {
    if (poolIds.length === 0) return [];
    const { rows } = await db.query(`select ${agentTable.select} from connect.agents where pool_id = any($1::uuid[]) order by enrolled_at, id`, [poolIds]);
    return rows as Agent[];
  },

  /** The pool's agents with a tunnel open somewhere, as last written: where to look for one to give work to. */
  async withTunnels(db: Queryable, poolId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select id from connect.agents where pool_id = $1 and status in ('healthy', 'unhealthy') and tunnel_connected_at is not null order by id`, [poolId]);
    return rows.map((r) => (r as { id: string }).id);
  },

  /** The agent holding a certificate, before any organisation is known (connect.resolve_agent). */
  async resolve(db: Queryable, fingerprint: Buffer): Promise<ResolvedAgent | undefined> {
    const { rows } = await db.query(
      `select organisation_id as "organisationId", id, pool_id as "poolId", status, version, version_state as "versionState"
       from connect.resolve_agent($1)`, [fingerprint]);
    return rows[0] as ResolvedAgent | undefined;
  },

  /**
   * The agent reports a version other than the one recorded: it updated, or went back. The
   * version before is kept, the work counts start again (the old ones kept as prior), the update
   * in hand is done, and its age is judged afresh (a version still outdated starts its own 90
   * days). Nothing changes if the recorded version is no longer from.
   */
  async changeVersion(db: Queryable, id: string, from: string, to: string, at: string): Promise<Agent | undefined> {
    const { rows } = await db.query(
      `update connect.agents
          set version = $3, previous_version = $2, version_since = $4,
              prior_work_done = work_done, prior_work_failed = work_failed, work_done = 0, work_failed = 0,
              updating_to = null, update_started_at = null, version_state = 'current', version_outdated_at = null
        where id = $1 and version = $2
       returning ${agentTable.select}`, [id, from, to, at]);
    return rows[0] as Agent | undefined;
  },

  /** Work given to the agent since the last flush, and the part it failed itself. */
  async addWork(db: Queryable, id: string, done: number, failed: number): Promise<void> {
    await db.query('update connect.agents set work_done = work_done + $2, work_failed = work_failed + $3 where id = $1', [id, done, failed]);
  },

  /** Another agent of the pool taking an update it began after since: the pool updates one at a time. */
  async updatingInPool(db: Queryable, poolId: string, exceptId: string, since: Date): Promise<boolean> {
    const { rows } = await db.query(
      `select 1 from connect.agents
        where pool_id = $1 and id <> $2 and status <> 'revoked' and updating_to is not null and update_started_at > $3
        limit 1`, [poolId, exceptId, since]);
    return rows.length > 0;
  },

  /** Which wave of the cell's agent rollouts the agent is in (connect.agent_update_wave). */
  async wave(db: Queryable, organisationId: string, id: string, firstOrganisations: readonly string[]): Promise<number> {
    const { rows } = await db.query('select connect.agent_update_wave($1, $2, $3::uuid[]) as wave', [organisationId, id, firstOrganisations]);
    return (rows[0] as { wave: number }).wave;
  },

  /**
   * Every organisation's agents judged against the floor of the last three minor releases
   * (connect.flag_outdated_agents): outdated below it, refused after refuseAfterDays, current
   * again at or above it. The agents whose state changed.
   */
  async flagOutdated(db: Queryable, floor: { major: number; minor: number }, at: string, refuseAfterDays: number)
    : Promise<{ organisationId: string; agentId: string; version: string; versionState: Agent['versionState'] }[]> {
    const { rows } = await db.query(
      `select organisation_id as "organisationId", agent_id as "agentId", version, version_state as "versionState"
       from connect.flag_outdated_agents($1, $2, $3, make_interval(days => $4))`, [floor.major, floor.minor, at, refuseAfterDays]);
    return rows as { organisationId: string; agentId: string; version: string; versionState: Agent['versionState'] }[];
  },
};

export interface ResolvedAgent {
  organisationId: string;
  id: string;
  poolId: string;
  status: Agent['status'];
  version: string;
  versionState: Agent['versionState'];
}
