// Data access for connect.cdc_slots, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.
//
// The reader lease is the fence (spec 10.3): a slot is read by the one agent holding an
// unexpired lease, and only that agent's acknowledgements are recorded. A lapsed lease is
// another agent's to take, which resumes from the acknowledged position.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  cdcSlotTable,
  type CdcSlot,
  type CdcSlotChanges,
  type NewCdcSlot,
} from '../../models/connect/cdcSlot.model.ts';

const leaseFree = '(leased_by_agent_id is null or lease_expires_at < now() or leased_by_agent_id = $2)';

export const cdcSlotRepo = {
  insert(db: Queryable, row: NewCdcSlot): Promise<CdcSlot> {
    return insertRow(db, cdcSlotTable, row);
  },

  findById(db: Queryable, id: CdcSlot['id']): Promise<CdcSlot | undefined> {
    return findRow(db, cdcSlotTable, { id });
  },

  update(db: Queryable, id: CdcSlot['id'], changes: CdcSlotChanges): Promise<CdcSlot | undefined> {
    return updateRow(db, cdcSlotTable, { id }, changes);
  },

  /** The connection's capture not yet dropped: the live one, else the latest lost or being dropped. */
  async currentFor(db: Queryable, connectionId: string): Promise<CdcSlot | undefined> {
    const { rows } = await db.query(
      `select ${cdcSlotTable.select} from connect.cdc_slots where connection_id = $1 and status <> 'dropped'
        order by (status = 'active') desc, created_at desc, id desc limit 1`, [connectionId]);
    return rows[0] as CdcSlot | undefined;
  },

  /**
   * Slots of the pool an agent may take now, oldest first: live ones to read, and ones being
   * dropped, unleased or with a lapsed lease, on connections still active.
   */
  async takeable(db: Queryable, poolId: string, agentId: string, status: 'active' | 'dropping', limit: number): Promise<CdcSlot[]> {
    const { rows } = await db.query(
      `select ${cdcSlotTable.select} from connect.cdc_slots s
        where s.agent_pool_id = $1 and s.status = $3
          and (s.leased_by_agent_id is null or s.lease_expires_at < now() or s.leased_by_agent_id = $2)
          and (s.status = 'dropping' or exists (select 1 from connect.connections c where c.id = s.connection_id and c.status = 'active'))
        order by s.created_at, s.id limit $4`, [poolId, agentId, status, limit]);
    return rows as CdcSlot[];
  },

  /** Takes a slot's lease for an agent of its pool, unless another agent holds it unexpired. */
  async claim(db: Queryable, slotId: string, agentId: string, poolId: string, leaseSeconds: number): Promise<CdcSlot | undefined> {
    const { rows } = await db.query(
      `update connect.cdc_slots set leased_by_agent_id = $2, lease_expires_at = now() + make_interval(secs => $4)
        where id = $1 and agent_pool_id = $3 and status in ('active', 'dropping') and ${leaseFree}
        returning ${cdcSlotTable.select}`, [slotId, agentId, poolId, leaseSeconds]);
    return rows[0] as CdcSlot | undefined;
  },

  /**
   * Renews the agent's leases on these slots: those it still holds, still live or being
   * dropped, on connections still active. The ids renewed; the agent stops the rest.
   */
  async renew(db: Queryable, agentId: string, slotIds: readonly string[], leaseSeconds: number): Promise<string[]> {
    if (slotIds.length === 0) return [];
    const { rows } = await db.query(
      `update connect.cdc_slots s set lease_expires_at = now() + make_interval(secs => $3)
        where s.id = any($2::uuid[]) and s.leased_by_agent_id = $1 and s.lease_expires_at >= now()
          and (s.status = 'dropping' or (s.status = 'active'
            and exists (select 1 from connect.connections c where c.id = s.connection_id and c.status = 'active')))
        returning s.id`, [agentId, slotIds, leaseSeconds]);
    return rows.map((r) => (r as { id: string }).id);
  },

  /** Gives up the agent's lease on a slot, or on all it holds. */
  async release(db: Queryable, agentId: string, slotId?: string): Promise<number> {
    const { rowCount } = await db.query(
      `update connect.cdc_slots set leased_by_agent_id = null, lease_expires_at = null
        where leased_by_agent_id = $1 and ($2::uuid is null or id = $2)`, [agentId, slotId ?? null]);
    return rowCount ?? 0;
  },

  /**
   * Records a position the holding agent read up to, never moving it back (an agent's spool may
   * send what lies behind it): later says whether one position follows another for the slot's
   * method. False when the agent's lease has lapsed or moved.
   */
  async acknowledge(db: Queryable, slotId: string, agentId: string, position: string,
    later: (method: CdcSlot['method'], current: string, next: string) => boolean): Promise<boolean> {
    const { rows } = await db.query(
      `select method, acknowledged_position as "acknowledgedPosition" from connect.cdc_slots
        where id = $1 and leased_by_agent_id = $2 and lease_expires_at >= now() and status = 'active' for update`, [slotId, agentId]);
    const row = rows[0] as Pick<CdcSlot, 'method' | 'acknowledgedPosition'> | undefined;
    if (row === undefined) return false;
    if (row.acknowledgedPosition === null || later(row.method, row.acknowledgedPosition, position)) {
      await db.query('update connect.cdc_slots set acknowledged_position = $2, acknowledged_at = now() where id = $1', [slotId, position]);
    }
    return true;
  },

  /**
   * Gives the slot to the agent that reads it, or holds a spool of what only it has, whoever
   * else held the lease (spec 10.6): the replication slot serves one reader, and that is it.
   */
  async takeOver(db: Queryable, slotId: string, agentId: string, poolId: string, leaseSeconds: number): Promise<CdcSlot | undefined> {
    const { rows } = await db.query(
      `update connect.cdc_slots set leased_by_agent_id = $2, lease_expires_at = now() + make_interval(secs => $4)
        where id = $1 and agent_pool_id = $3 and status in ('active', 'dropping')
        returning ${cdcSlotTable.select}`, [slotId, agentId, poolId, leaseSeconds]);
    return rows[0] as CdcSlot | undefined;
  },

  /** The holding agent found the slot gone or invalidated; the lease goes with it. */
  async markLost(db: Queryable, slotId: string, agentId: string): Promise<CdcSlot | undefined> {
    const { rows } = await db.query(
      `update connect.cdc_slots set status = 'lost', lost_at = now(), leased_by_agent_id = null, lease_expires_at = null
        where id = $1 and leased_by_agent_id = $2 and status = 'active' returning ${cdcSlotTable.select}`, [slotId, agentId]);
    return rows[0] as CdcSlot | undefined;
  },

  /** The holding agent dropped the slot on the customer's database. */
  async markDropped(db: Queryable, slotId: string, agentId: string): Promise<CdcSlot | undefined> {
    const { rows } = await db.query(
      `update connect.cdc_slots set status = 'dropped', dropped_at = now(), leased_by_agent_id = null, lease_expires_at = null
        where id = $1 and leased_by_agent_id = $2 and status = 'dropping' returning ${cdcSlotTable.select}`, [slotId, agentId]);
    return rows[0] as CdcSlot | undefined;
  },
};
