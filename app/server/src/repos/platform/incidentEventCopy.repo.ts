// Data access for platform.incident_event_copies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_report; written by no service.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import {
  incidentEventCopyTable,
  type IncidentEventCopy,
  type IncidentEventCopyPrimaryKey,
} from '../../models/platform/incidentEventCopy.model.ts';

export const incidentEventCopyRepo = {
  findByKey(db: Queryable, key: IncidentEventCopyPrimaryKey): Promise<IncidentEventCopy | undefined> {
    return findRow(db, incidentEventCopyTable, key);
  },
};
