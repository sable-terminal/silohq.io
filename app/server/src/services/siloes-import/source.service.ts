// An Import Silo as a source (spec 66.5, 68.5): the manifest its published definition stands
// for, so the federated engine plans and reads it like any connector's objects, and
// derivation maps its objects to object types exactly as it does any other (68.5).
//
// One SQL object per definition object, over its table in the Silo's dataset (obj__<name>,
// see import-loader). Its fields are the declared ones, typed, plus the row's reference
// (the identifier where the definition names none: a row's position in its file) and when
// it was received. Every read filters the partition column, as the table requires. The
// store is the Silo's own (transport store silo): read in the cell, never through an agent,
// never written. Every filter, sort and aggregate is pushed to the store.

import { AGGREGATE_FUNCTIONS, FILTER_OPS, type FieldType } from '../../contracts/connect/manifest.contract.ts';
import { importTableOf } from '../../contracts/import-loader/load.contract.ts';
import type { DefinitionDocument } from '../../contracts/siloes/import.contract.ts';

/** Import field types as manifest field types. */
const FIELD_TYPE: Readonly<Record<DefinitionDocument['objects'][number]['fields'][number]['type'], FieldType>> = {
  string: 'string', integer: 'integer', decimal: 'number', boolean: 'boolean', date: 'date', timestamp: 'date-time', json: 'json',
};

/** The grammar the Silo store speaks: the SQL engine's name for it. */
const STORE_DIALECT = 'bigquery';

/** A definition object's name as a manifest object name: lower snake case, as its table is named. */
export const siloObjectNameOf = (name: string): string => importTableOf(name).replace(/^obj__/, '');

export function siloManifestOf(silo: { id: string; name: string; storeRef: string }, document: DefinitionDocument): Record<string, unknown> {
  return {
    schemaVersion: '1',
    identity: { name: `${silo.name} (Silo)`.slice(0, 200), provider: 'Silo', version: '1.0.0' },
    transport: { viaAgent: false, store: { kind: 'silo', siloId: silo.id } },
    protocol: { kind: 'sql', dialect: STORE_DIALECT },
    auth: { strategy: 'none', fields: [] },
    objects: document.objects.map((o) => {
      const fields = [
        { name: 'row_ref', type: 'string', nullable: false, column: '_row_ref' },
        { name: 'received_at', type: 'date-time', nullable: false, column: '_received_at' },
        ...o.fields.filter((f) => f.name !== 'row_ref' && f.name !== 'received_at')
          .map((f) => ({ name: f.name, type: FIELD_TYPE[f.type], nullable: f.name !== o.identifier })),
      ];
      const scalar = fields.filter((f) => f.type !== 'json');
      return {
        name: siloObjectNameOf(o.name),
        label: o.name,
        identifier: [o.identifier ?? 'row_ref'],
        fields,
        source: { kind: 'sql', schema: silo.storeRef, table: importTableOf(o.name), partitionColumn: '_received_at' },
        pushdown: {
          filters: scalar.map((f) => ({ field: f.name, ops: f.type === 'string' ? [...FILTER_OPS] : FILTER_OPS.filter((op) => op !== 'contains' && op !== 'starts_with') })),
          sort: scalar.map((f) => ({ field: f.name })),
          aggregates: { functions: [...AGGREGATE_FUNCTIONS], groupBy: true },
        },
      };
    }),
  };
}
