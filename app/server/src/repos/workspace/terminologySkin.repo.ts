// Data access for workspace.terminology_skins, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  terminologySkinTable,
  type NewTerminologySkin,
  type TerminologySkin,
  type TerminologySkinChanges,
} from '../../models/workspace/terminologySkin.model.ts';

export const terminologySkinRepo = {
  insert(db: Queryable, row: NewTerminologySkin): Promise<TerminologySkin> {
    return insertRow(db, terminologySkinTable, row);
  },

  findById(db: Queryable, id: TerminologySkin['id']): Promise<TerminologySkin | undefined> {
    return findRow(db, terminologySkinTable, { id });
  },

  update(
    db: Queryable,
    id: TerminologySkin['id'],
    changes: TerminologySkinChanges,
  ): Promise<TerminologySkin | undefined> {
    return updateRow(db, terminologySkinTable, { id }, changes);
  },

  async listLive(db: Queryable): Promise<TerminologySkin[]> {
    const { rows } = await db.query(
      `select ${terminologySkinTable.select} from workspace.terminology_skins where superseded_at is null order by set_at, id`);
    return rows as TerminologySkin[];
  },

  /** The live label for an element, locked: setting a new one supersedes it. */
  async findLiveFor(db: Queryable, target: { objectTypeId?: string; stateValue?: string; linkTypeId?: string; actionTypeId?: string })
    : Promise<TerminologySkin | undefined> {
    const { rows } = await db.query(
      `select ${terminologySkinTable.select} from workspace.terminology_skins
       where superseded_at is null
         and (($1::uuid is not null and object_type_id = $1 and state_value is not distinct from $2::text)
              or ($3::uuid is not null and link_type_id = $3) or ($4::uuid is not null and action_type_id = $4))
       for update`,
      [target.objectTypeId ?? null, target.stateValue ?? null, target.linkTypeId ?? null, target.actionTypeId ?? null]);
    return rows[0] as TerminologySkin | undefined;
  },
};
