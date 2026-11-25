// Data access for recognition.detector_configurations, in plain SQL; no ORM.
// Read and written by silo_app. Row-level security applies: call it inside inTransaction
// with the request context.
//
// What a detector examines on an object type (spec 38.2, 38.11 recognition.configure): the
// properties named by identity, the time field, and whether it is enabled.

import type { Queryable } from '../base.repo.ts';
import { detectorConfigurationTable, type DetectorConfiguration } from '../../models/recognition/index.model.ts';

export type { DetectorConfiguration };

const SELECT = detectorConfigurationTable.select;

export const detectorConfigurationRepo = {
  async listForType(db: Queryable, objectTypeId: string): Promise<DetectorConfiguration[]> {
    const { rows } = await db.query(
      `select ${SELECT} from recognition.detector_configurations where object_type_id = $1 order by detector_id`, [objectTypeId]);
    return rows as DetectorConfiguration[];
  },

  async find(db: Queryable, detectorId: string, objectTypeId: string): Promise<DetectorConfiguration | undefined> {
    const { rows } = await db.query(
      `select ${SELECT} from recognition.detector_configurations where detector_id = $1 and object_type_id = $2`, [detectorId, objectTypeId]);
    return rows[0] as DetectorConfiguration | undefined;
  },

  async insert(db: Queryable, row: Omit<DetectorConfiguration, 'version' | 'createdAt' | 'updatedAt'>): Promise<DetectorConfiguration> {
    const { rows } = await db.query(
      `insert into recognition.detector_configurations
         (id, organisation_id, detector_id, object_type_id, property_identity_ids, time_field_identity_id, enabled, configured_by)
       values ($1, $2, $3, $4, $5::uuid[], $6, $7, $8) returning ${SELECT}`,
      [row.id, row.organisationId, row.detectorId, row.objectTypeId, row.propertyIdentityIds, row.timeFieldIdentityId, row.enabled, row.configuredBy]);
    return rows[0] as DetectorConfiguration;
  },

  /** Optimistic: undefined when the version moved. */
  async updateAtVersion(db: Queryable, id: string, version: number,
    changes: Pick<DetectorConfiguration, 'propertyIdentityIds' | 'timeFieldIdentityId' | 'enabled' | 'configuredBy'>)
    : Promise<DetectorConfiguration | undefined> {
    const { rows } = await db.query(
      `update recognition.detector_configurations
          set property_identity_ids = $3::uuid[], time_field_identity_id = $4, enabled = $5, configured_by = $6, version = version + 1
        where id = $1 and version = $2 returning ${SELECT}`,
      [id, version, changes.propertyIdentityIds, changes.timeFieldIdentityId, changes.enabled, changes.configuredBy]);
    return rows[0] as DetectorConfiguration | undefined;
  },
};
