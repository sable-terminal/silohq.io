import type { Comparison } from '../execution/query.execution';
import type { ManifestV2, ObjectV2, OperationV2, PipelineV2 } from '../../schemas/manifest.schema';
import { isPipeline, isVariants, WRITE_ROLES } from '../../schemas/manifest.schema';
import { columnOf, ROW_STORE_OPERATORS } from './pushdown.read';

/**
 * What the rest of the product may assume a connector can do, read off the
 * document (MANIFEST-V2 §1.4).
 *
 * THE COMPILER, THE CONCEPT PLANNER AND THE MUTATION PREVIEW ask these
 * questions; they never read `pushdown` or `write` themselves, so the document
 * can grow without every caller learning its shape. For SQL everything is
 * derived from which fields are columns; for everything else it is what the
 * operation declares.
 */

export interface ObjectCapabilities {
  /** Operators pushed for at least one field. */
  filters: Comparison[];
  /** The precise version: operators per field. */
  filtersByField: Record<string, Comparison[]>;
  sort: boolean;
  fieldSelection: boolean;
  aggregates: Array<'count' | 'sum' | 'group_by'>;
  maxFilterValues: number;
}

export interface ObjectWrites {
  create: boolean;
  updateFull: boolean;
  updatePartial: boolean;
  delete: boolean;
  upsert: boolean;
  batch: boolean;
  customActions: string[];
  /** Verify-writes can reverse a test record: a delete, or a declared undo. */
  undoable: boolean;
}

const ALL: Comparison[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null'];

const NONE: ObjectCapabilities = { filters: [], filtersByField: {}, sort: false, fieldSelection: false, aggregates: [], maxFilterValues: 0 };

function readsOf(object: ObjectV2): Array<OperationV2 | PipelineV2> {
  return isVariants(object.read) ? (object.read as Array<OperationV2 | PipelineV2>) : [object.read];
}

export function capabilitiesOf(manifest: ManifestV2, objectName: string): ObjectCapabilities {
  const object = manifest.objects.find((o) => o.name === objectName);
  if (!object) return NONE;
  const byField: Record<string, Set<Comparison>> = {};
  const add = (field: string, op: Comparison) => (byField[field] ??= new Set()).add(op);
  let sort = false;
  let fieldSelection = false;
  const aggregates = new Set<'count' | 'sum' | 'group_by'>();
  let maxFilterValues = 0;

  for (const read of readsOf(object)) {
    if ((manifest.transport.kind === 'sql' || manifest.transport.kind === 'silo_import') && !isPipeline(read)) {
      const declared = read.pushdown?.filters;
      for (const field of object.fields) {
        if (declared && Object.keys(declared).length > 0) {
          for (const op of Object.keys(declared[field.name] ?? {}) as Comparison[]) add(field.name, op);
        } else if (columnOf(read, field.name) !== null) {
          for (const op of ALL) if (manifest.transport.kind === 'sql' || ROW_STORE_OPERATORS.has(op)) add(field.name, op);
        }
      }
      sort = true;
      fieldSelection = true;
      if (manifest.transport.kind === 'sql') aggregates.add('count').add('sum').add('group_by');
      maxFilterValues = Math.max(maxFilterValues, read.pushdown?.maxFilterValues ?? 0);
      continue;
    }
    const operations = isPipeline(read) ? read.steps.map((s) => s.operation) : [read];
    for (const op of operations) {
      const pd = op.pushdown ?? manifest.defaults.pushdown;
      if (!pd) continue;
      for (const [field, ops] of Object.entries(pd.filters)) for (const op2 of Object.keys(ops ?? {}) as Comparison[]) add(field, op2);
      if (!isPipeline(read)) {
        sort ||= Boolean(pd.sort);
        fieldSelection ||= Boolean(pd.fields);
        for (const kind of Object.keys(pd.aggregates ?? {}) as Array<'count' | 'sum' | 'group_by'>) aggregates.add(kind);
      }
      maxFilterValues = Math.max(maxFilterValues, pd.maxFilterValues);
    }
  }

  const filtersByField = Object.fromEntries(Object.entries(byField).map(([field, ops]) => [field, [...ops]]));
  return {
    filters: ALL.filter((op) => Object.values(byField).some((ops) => ops.has(op))),
    filtersByField,
    sort,
    fieldSelection,
    aggregates: [...aggregates],
    maxFilterValues,
  };
}

export function writesOf(manifest: ManifestV2, objectName: string): ObjectWrites {
  const object = manifest.objects.find((o) => o.name === objectName);
  const ops = object?.write?.operations ?? {};
  const has = (name: string) => name in ops;
  return {
    create: has('create'),
    updateFull: has('update_full') || has('update'),
    updatePartial: has('update_partial') || has('update'),
    delete: has('delete'),
    upsert: has('upsert'),
    batch: Boolean(object?.write?.batch),
    customActions: Object.keys(ops).filter((name) => !(WRITE_ROLES as readonly string[]).includes(name)),
    undoable: has('delete') || Boolean(object?.write?.verify.undo),
  };
}

/** Whether any object on this connector can be written to at all. */
export const writable = (manifest: ManifestV2): boolean =>
  manifest.objects.some((o) => Object.keys(o.write?.operations ?? {}).length > 0);

/** The table a SQL object is read from, when it is one — what a foreign key in the catalogue names. */
export function tableOf(object: ObjectV2): string | null {
  for (const read of readsOf(object)) {
    if (!isPipeline(read) && read.request.table) return read.request.table;
  }
  return null;
}

/**
 * What a connection can do, over all of its available objects: every operator
 * any object takes, every total any computes, and the SMALLEST declared `in`
 * list, so a batch sized by this fits every object. Zero means no cap.
 */
export function connectionCapabilities(manifest: ManifestV2): ObjectCapabilities {
  const all = manifest.objects.filter((o) => o.available).map((o) => capabilitiesOf(manifest, o.name));
  const caps = all.map((c) => c.maxFilterValues).filter((n) => n > 0);
  const byField: Record<string, Comparison[]> = {};
  for (const c of all) for (const [field, ops] of Object.entries(c.filtersByField)) byField[field] = [...new Set([...(byField[field] ?? []), ...ops])];
  return {
    filters: ALL.filter((op) => all.some((c) => c.filters.includes(op))),
    filtersByField: byField,
    sort: all.some((c) => c.sort),
    fieldSelection: all.some((c) => c.fieldSelection),
    aggregates: [...new Set(all.flatMap((c) => c.aggregates))],
    maxFilterValues: caps.length > 0 ? Math.min(...caps) : 0,
  };
}
