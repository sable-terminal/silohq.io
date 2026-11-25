// Data access for workspace.push_devices, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  pushDeviceTable,
  type NewPushDevice,
  type PushDevice,
  type PushDeviceChanges,
} from '../../models/workspace/pushDevice.model.ts';

export const pushDeviceRepo = {
  insert(db: Queryable, row: NewPushDevice): Promise<PushDevice> {
    return insertRow(db, pushDeviceTable, row);
  },

  findById(db: Queryable, id: PushDevice['id']): Promise<PushDevice | undefined> {
    return findRow(db, pushDeviceTable, { id });
  },

  update(db: Queryable, id: PushDevice['id'], changes: PushDeviceChanges): Promise<PushDevice | undefined> {
    return updateRow(db, pushDeviceTable, { id }, changes);
  },

  /** A member's live devices on a platform. */
  async liveFor(db: Queryable, membershipId: string, platform: string): Promise<PushDevice[]> {
    const { rows } = await db.query(
      `select ${pushDeviceTable.select} from workspace.push_devices where membership_id = $1 and platform = $2 and revoked_at is null
        order by registered_at, id`, [membershipId, platform]);
    return rows as PushDevice[];
  },

  async listLive(db: Queryable, membershipId: string): Promise<PushDevice[]> {
    const { rows } = await db.query(
      `select ${pushDeviceTable.select} from workspace.push_devices where membership_id = $1 and revoked_at is null order by registered_at, id`, [membershipId]);
    return rows as PushDevice[];
  },

  /** The live device with this token, if any (re-registering returns it). */
  async findLive(db: Queryable, platform: string, token: string): Promise<PushDevice | undefined> {
    const { rows } = await db.query(
      `select ${pushDeviceTable.select} from workspace.push_devices where platform = $1 and token = $2 and revoked_at is null`, [platform, token]);
    return rows[0] as PushDevice | undefined;
  },

  async revoke(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query('update workspace.push_devices set revoked_at = now() where id = $1 and revoked_at is null', [id]);
    return rowCount === 1;
  },

  async markSent(db: Queryable, id: string): Promise<void> {
    await db.query('update workspace.push_devices set last_sent_at = now() where id = $1', [id]);
  },
};
