// Probe manifests: what the build routes declare so a probe sees a source's own structure
// (spec 14.6, 16.3). They are ordinary manifests, validated and versioned like any other,
// so a probe runs through the same engine, credential path and bounds as a query.
//
// - A raw object captures each whole record, or the whole response when the records path
//   is not yet known, in one json field (RAW_FIELD), so inference sees every key.
// - A catalogue declares the ANSI information_schema views as objects
//   (CATALOGUE_OBJECTS), filtered at the source by schema, so inference reads tables,
//   columns, keys and foreign keys. Values read are names and types, never records.

import type { ManifestInput, ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import { CATALOGUE_OBJECTS } from '../../contracts/schema-inference/inference.contract.ts';

export const RAW_FIELD = 'record';

type ObjectInput = ManifestInput['objects'][number];
type Request = Extract<ObjectInput['source'], { kind: 'rest' }>['request'];

/** An object that returns each record (or the whole body) whole. */
export function rawObject(name: string, request: Request, recordsPath = '$'): ObjectInput {
  return {
    name,
    identifier: [RAW_FIELD],
    fields: [{ name: RAW_FIELD, type: 'json', nullable: false, value: { jsonata: '$' }, provenance: 'observed' }],
    source: { kind: 'rest', request, records: { jsonata: recordsPath } },
  };
}

/** Whether an object is a raw capture: one json field holding the record itself. */
export function isRawCapture(object: ManifestObject): boolean {
  return object.fields.length === 1 && object.fields[0]!.name === RAW_FIELD && object.fields[0]!.type === 'json'
    && object.fields[0]!.value?.jsonata.trim() === '$';
}

const text = (name: string) => ({ name, type: 'string' as const, nullable: true });
const integer = (name: string) => ({ name, type: 'integer' as const, nullable: true });
const bySchema = { filters: [{ field: 'table_schema', ops: ['eq' as const, 'in' as const, 'ne' as const] }], sort: [] };

/** The information_schema views as objects of a SQL manifest. */
export function catalogueObjects(): ObjectInput[] {
  return [
    {
      name: CATALOGUE_OBJECTS.columns, identifier: ['table_schema', 'table_name', 'column_name'],
      fields: [text('table_schema'), text('table_name'), text('column_name'), integer('ordinal_position'), text('is_nullable'), text('data_type')],
      source: { kind: 'sql', schema: 'information_schema', table: 'columns' }, pushdown: bySchema,
    },
    {
      name: CATALOGUE_OBJECTS.constraints, identifier: ['constraint_schema', 'constraint_name'],
      fields: [text('constraint_schema'), text('constraint_name'), text('table_schema'), text('table_name'), text('constraint_type')],
      source: { kind: 'sql', schema: 'information_schema', table: 'table_constraints' }, pushdown: bySchema,
    },
    {
      name: CATALOGUE_OBJECTS.keys, identifier: ['constraint_schema', 'constraint_name', 'column_name'],
      fields: [text('constraint_schema'), text('constraint_name'), text('table_schema'), text('table_name'), text('column_name'), integer('ordinal_position')],
      source: { kind: 'sql', schema: 'information_schema', table: 'key_column_usage' }, pushdown: bySchema,
    },
    {
      name: CATALOGUE_OBJECTS.references, identifier: ['constraint_schema', 'constraint_name'],
      fields: [text('constraint_schema'), text('constraint_name'), text('unique_constraint_schema'), text('unique_constraint_name')],
      source: { kind: 'sql', schema: 'information_schema', table: 'referential_constraints' },
      pushdown: { filters: [{ field: 'constraint_schema', ops: ['eq', 'in', 'ne'] }], sort: [] },
    },
  ];
}
