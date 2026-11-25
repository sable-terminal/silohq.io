// Data access for platform.fleet_event_copies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_report; written by no service.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import { fleetEventCopyTable, type FleetEventCopy } from '../../models/platform/fleetEventCopy.model.ts';

export const fleetEventCopyRepo = {
  findBySeq(db: Queryable, seq: FleetEventCopy['seq']): Promise<FleetEventCopy | undefined> {
    return findRow(db, fleetEventCopyTable, { seq });
  },
};
