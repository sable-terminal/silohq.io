// Data access for connect.discovery_settings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  discoverySettingTable,
  type DiscoverySetting,
  type DiscoverySettingChanges,
  type NewDiscoverySetting,
} from '../../models/connect/discoverySetting.model.ts';

export const discoverySettingRepo = {
  insert(db: Queryable, row: NewDiscoverySetting): Promise<DiscoverySetting> {
    return insertRow(db, discoverySettingTable, row);
  },

  findByOrganisationId(
    db: Queryable,
    organisationId: DiscoverySetting['organisationId'],
  ): Promise<DiscoverySetting | undefined> {
    return findRow(db, discoverySettingTable, { organisationId });
  },

  update(
    db: Queryable,
    organisationId: DiscoverySetting['organisationId'],
    changes: DiscoverySettingChanges,
  ): Promise<DiscoverySetting | undefined> {
    return updateRow(db, discoverySettingTable, { organisationId }, changes);
  },
};
