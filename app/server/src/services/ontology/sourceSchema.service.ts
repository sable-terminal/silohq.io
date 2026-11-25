// The source layer as the ontology sees it (spec 21.4): a connection's declared objects,
// fields, identifiers and foreign keys, from the connector manifest version the connection
// runs. Structure only, never a record (spec 22.1).
//
// Read straight from Connect's tables (read-only, under the request's row-level security)
// until connect-registry's read contracts list ontology among their callers; then this is
// the one place to change.

import { manifestSchema, type FieldType } from '../../contracts/connect/manifest.contract.ts';
import type { DataType } from '../../contracts/ontology/manifest.contract.ts';
import type { Queryable } from '../../infra/postgres.infra.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface SourceField { name: string; type: FieldType; nullable: boolean }
export interface SourceRelationship { field: string; targetObject: string; targetField: string; kind: 'foreign_key' | 'reference' | 'parent' }
export interface SourceObject {
  name: string;
  label: string | undefined;
  identifier: string[];
  /** Other field sets the source declares unique: match key candidates (spec 19.4, 23). */
  uniqueKeys?: string[][] | undefined;
  fields: SourceField[];
  relationships: SourceRelationship[];
}
export interface SourceSchema {
  connectionId: string;
  connectionName: string;
  /** The connector version the connection runs: recorded on each contributing object. */
  connectorVersion: string;
  objects: SourceObject[];
}

/** The property type a declared source type proposes (spec 21.6). */
export const PROPOSED_TYPE: Record<FieldType, DataType> = {
  string: 'string', integer: 'integer', number: 'decimal', boolean: 'boolean', date: 'date', 'date-time': 'timestamp', json: 'struct',
};

export function createSourceSchemas(db: Queryable) {
  const known = new Map<string, SourceSchema>();
  return {
    async of(connectionId: string): Promise<SourceSchema> {
      const cached = known.get(connectionId);
      if (cached) return cached;
      const connection = await connectionRepo.findById(db, connectionId);
      if (!connection || connection.status === 'revoked') {
        throw new AppError('not_found', 'no such connection', { code: 'ontology.connection_not_found' });
      }
      const row = await connectorManifestRepo.findById(db, connection.manifestId);
      const parsed = manifestSchema.safeParse(row?.document);
      if (!parsed.success) {
        throw new AppError('integrity', 'the connection runs a manifest that does not read', { code: 'ontology.manifest_unreadable' });
      }
      const schema: SourceSchema = {
        connectionId, connectionName: connection.name, connectorVersion: parsed.data.identity.version,
        objects: parsed.data.objects.map((o) => ({
          name: o.name, label: o.label, identifier: o.identifier, uniqueKeys: o.uniqueKeys ?? [],
          fields: o.fields.map((f) => ({ name: f.name, type: f.type, nullable: f.nullable })),
          relationships: o.relationships,
        })),
      };
      known.set(connectionId, schema);
      return schema;
    },

    async object(connectionId: string, sourceObject: string): Promise<SourceObject & { connectorVersion: string }> {
      const schema = await this.of(connectionId);
      const found = schema.objects.find((o) => o.name === sourceObject);
      if (!found) {
        throw new AppError('validation', `the connection declares no object ${sourceObject}`, {
          code: 'ontology.source_object_unknown', details: { sourceObject },
        });
      }
      return { ...found, connectorVersion: schema.connectorVersion };
    },

    async field(connectionId: string, sourceObject: string, fieldPath: string): Promise<SourceField> {
      const object = await this.object(connectionId, sourceObject);
      const found = object.fields.find((f) => f.name === fieldPath);
      if (!found) {
        throw new AppError('validation', `${sourceObject} declares no field ${fieldPath}`, {
          code: 'ontology.source_field_unknown', details: { sourceObject, fieldPath },
        });
      }
      return found;
    },
  };
}
export type SourceSchemas = ReturnType<typeof createSourceSchemas>;
