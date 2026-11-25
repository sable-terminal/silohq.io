// Merge (spec 27.6, 23): rows from each contributing system become objects, and each
// property gets a decided value or an explicit dispute, never an average.
//
// - A resolvable type is resolved by the entity graph: the executor sends the rows it read
//   to resolution's resolveRecords (contracts/resolution/resolve.contract.ts) and takes its
//   objects, Silo object ids and value states (declared under field authority, agreed, only,
//   disputed, empty, unchecked). There is no local fallback: when resolution cannot be
//   reached the plan is refused, never answered with objects the graph would not recognise.
//   Values are taken from the row of the system resolution names (declared, only), or any
//   holder (agreed), and typed here by the property, as every value the engine compares.
// - A single-source type is keyed by its source identifier; its id is the one every service
//   derives (utils/siloObjectId.util.ts), with no lookup (spec 24.7).
//
// resolveRecords takes at most MAX_RESOLVE_ROWS rows per system and 16 MiB per call. A larger
// read is split by the hash of each row's declared-normalised match key, so rows that are
// one object under the declared normalisation go together; an object a confirmed rule joins
// across two partitions comes back under one id from both, and its two halves are combined
// conservatively (any difference is a dispute; field authority is not re-applied).

import { createHash } from 'node:crypto';
import { MAX_RESOLVE_ROWS, type resolveRecords, type ValueState } from '../../contracts/resolution/resolve.contract.ts';
import type { CallInput, CallOutput } from '../../contracts/endpoint.contract.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { identifierText, singleSourceObjectId } from '../../utils/siloObjectId.util.ts';
import { compileCel, type CompiledCel } from '../expression-evaluator/cel.service.ts';
import type { ContributingObjectView } from '../planner/access.service.ts';
import type { NodeProgram } from '../planner/decompose.service.ts';
import { sameValue, typed, type Json } from './values.service.ts';

export { organisationNamespace, uuidv5 } from '../../utils/siloObjectId.util.ts';

/** A source row: values by the system's field names. Record values. */
export type Row = Record<string, Json>;

export type AuthorityState = ValueState;

export interface Decided {
  value: Json | null;
  state: AuthorityState;
  /** The connection the value came from, where resolution names one (declared or only). */
  from?: string | undefined;
  /** The field authority that decided a declared value (23.4). */
  authorityId?: string | undefined;
}

export interface SourceRecord {
  source: ContributingObjectView;
  row: Row;
}

export interface MergedObject {
  id: string;
  typeId: string;
  records: SourceRecord[];
  /** By property identity id: every property the node reads. */
  values: Map<string, Decided>;
  unmatched: boolean;
}

export interface SourceRows {
  source: ContributingObjectView;
  rows: Row[];
}

/** No value to show or compare: the state carries why. */
export const undecided = (state: AuthorityState): boolean => state === 'disputed' || state === 'empty' || state === 'unchecked';

const normalisers = new Map<string, CompiledCel>();
const NORMALISE_BOUNDS = { steps: 1_000, timeMs: 5 };

function normalised(expression: string | null, value: Json | null): string | null {
  if (value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (expression === null) return text;
  let program = normalisers.get(expression);
  if (program === undefined) {
    program = compileCel(expression, { value: 'string' });
    normalisers.set(expression, program);
  }
  try {
    const out = program.evaluate({ value: text }, NORMALISE_BOUNDS);
    return out === null || out === undefined || out === '' ? null : String(out);
  } catch {
    return null;
  }
}

const mappingOf = (node: NodeProgram, identityId: string, source: ContributingObjectView) =>
  node.access.properties.get(identityId)?.property.mappings.find((m) => m.connectionId === source.connectionId && m.sourceObject === source.sourceObject);

/** The row's match key under the declared normalisations, or undefined when a component is missing. */
export function declaredKey(node: NodeProgram, source: ContributingObjectView, row: Row): string | undefined {
  const parts: string[] = [];
  for (const mk of node.access.type.matchKeys) {
    const property = node.access.properties.get(mk.propertyIdentityId);
    const mapping = mappingOf(node, mk.propertyIdentityId, source);
    if (property === undefined || mapping === undefined) return undefined;
    const value = normalised(mk.normalisation, typed(row[mapping.fieldPath], property.property.dataType, mapping));
    if (value === null) return undefined;
    parts.push(value);
  }
  return parts.length === 0 ? undefined : canonicalJson(parts);
}

/** A property's value on an object from its records, typed: the first holder of the named system, or any. */
function valueFrom(node: NodeProgram, identityId: string, records: readonly SourceRecord[], connectionId: string | undefined): Json | null {
  const property = node.access.properties.get(identityId);
  if (property === undefined) return null;
  for (const record of records) {
    if (connectionId !== undefined && record.source.connectionId !== connectionId) continue;
    const mapping = mappingOf(node, identityId, record.source);
    if (mapping === undefined) continue;
    const value = typed(record.row[mapping.fieldPath], property.property.dataType, mapping);
    if (value !== null) return value;
  }
  return null;
}

/** Values of one system's records for an object: one value is only, several differing is disputed. */
function decideWithin(node: NodeProgram, identityId: string, records: readonly SourceRecord[]): Decided {
  const property = node.access.properties.get(identityId);
  if (property === undefined) return { value: null, state: 'empty' };
  const held: Json[] = [];
  for (const record of records) {
    const mapping = mappingOf(node, identityId, record.source);
    if (mapping === undefined) continue;
    const value = typed(record.row[mapping.fieldPath], property.property.dataType, mapping);
    if (value !== null && !held.some((h) => sameValue(h, value))) held.push(value);
  }
  return held.length === 0 ? { value: null, state: 'empty' } : held.length > 1 ? { value: null, state: 'disputed' } : { value: held[0]!, state: 'only' };
}

/** A single-source type: one object per source identifier, with the id every service derives. */
export function mergeSingleSource(organisationId: string, node: NodeProgram, read: readonly SourceRows[]): MergedObject[] {
  const type = node.access.type;
  const objects = new Map<string, MergedObject>();
  for (const { source, rows } of read) {
    for (const row of rows) {
      const identifier = identifierText(row[source.identifierFieldPath])
        // No identifier: the row stands alone under the hash of its content (it cannot be addressed again).
        ?? `row:${createHash('sha256').update(canonicalJson(row)).digest('hex')}`;
      const id = singleSourceObjectId(organisationId, type.id, source.connectionId, source.sourceObject, identifier);
      let object = objects.get(id);
      if (object === undefined) {
        object = { id, typeId: type.id, records: [], values: new Map(), unmatched: false };
        objects.set(id, object);
      }
      object.records.push({ source, row });
    }
  }
  for (const object of objects.values()) {
    for (const id of node.reads) object.values.set(id, decideWithin(node, id, object.records));
  }
  return [...objects.values()];
}

// ----------------------------------------------------------------------------- resolvable

type ResolveBody = CallInput<typeof resolveRecords>['body'];
export type ResolveReply = CallOutput<typeof resolveRecords>;
export type Resolve = (body: ResolveBody) => Promise<ResolveReply>;

/** Rows sent per system per call: under the contract's bound, with room to spare. */
const ROWS_PER_CALL = Math.floor(MAX_RESOLVE_ROWS * 0.8);
/** Bytes sent per call: half the contract's 16 MiB. */
const BYTES_PER_CALL = 8 * 1024 * 1024;
const MAX_PARTITIONS = 256;

interface Sent { readIndex: number; row: Row; identifier: string | number }

/** Thrown when even the most partitions cannot keep one call within the contract's bound. */
export class ResolveBound extends Error {
  readonly rows: number;
  constructor(rows: number) {
    super('resolve.bound');
    this.rows = rows;
  }
}

function bucketOf(text: string, partitions: number): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0) % partitions;
}

/** Splits the read into calls, each within the contract's bounds per system and in bytes. */
function partition(node: NodeProgram, read: readonly SourceRows[]): { sent: Sent[]; readIndex: number }[][] {
  const keyed = read.map(({ source, rows }) => rows.map((row) => {
    const identifier = row[source.identifierFieldPath];
    return { row, identifier, key: declaredKey(node, source, row) ?? `\u0000${String(identifier)}`, bytes: Buffer.byteLength(JSON.stringify(row)) };
  }));
  const maxRows = Math.max(1, ...keyed.map((rows) => rows.length));
  const totalBytes = keyed.reduce((n, rows) => n + rows.reduce((m, r) => m + r.bytes, 0), 0);
  let partitions = Math.max(1, Math.ceil(maxRows / ROWS_PER_CALL), Math.ceil(totalBytes / BYTES_PER_CALL));
  for (;;) {
    const calls: { sent: Sent[]; readIndex: number }[][] = Array.from({ length: partitions }, () => read.map((_, readIndex) => ({ sent: [], readIndex })));
    keyed.forEach((rows, readIndex) => rows.forEach((r) => {
      if (identifierText(r.identifier) === undefined) return;
      calls[bucketOf(r.key, partitions)]![readIndex]!.sent.push({ readIndex, row: r.row, identifier: r.identifier as string | number });
    }));
    const largest = Math.max(...calls.flatMap((call) => call.map((s) => s.sent.length)));
    if (largest <= MAX_RESOLVE_ROWS) return calls;
    if (partitions >= MAX_PARTITIONS) throw new ResolveBound(largest);
    partitions = Math.min(MAX_PARTITIONS, partitions * 2);
  }
}

/** Two readings of one object from two calls: equal values agree, different ones dispute. */
function combine(a: Decided, b: Decided): Decided {
  if (a.state === 'disputed' || b.state === 'disputed') return { value: null, state: 'disputed' };
  if (a.value === null && b.value === null) return { value: null, state: a.state === 'unchecked' || b.state === 'unchecked' ? 'unchecked' : 'empty' };
  if (a.value === null) return b;
  if (b.value === null) return a;
  return sameValue(a.value, b.value) ? { value: a.value, state: 'agreed' } : { value: null, state: 'disputed' };
}

/** A resolvable type's rows, resolved by the entity graph. */
export async function mergeResolvable(resolve: Resolve, organisationId: string, ontologyVersionId: string, node: NodeProgram, read: readonly SourceRows[])
  : Promise<MergedObject[]> {
  const type = node.access.type;
  const wanted = [...new Set([...node.reads, ...type.matchKeys.map((k) => k.propertyIdentityId)])];
  const merge = [...node.reads].slice(0, 500);
  const objects = new Map<string, MergedObject>();
  const keyable = new Set<Row>();
  for (const { source, rows } of read) for (const row of rows) if (declaredKey(node, source, row) !== undefined) keyable.add(row);

  for (const call of partition(node, read)) {
    if (call.every((s) => s.sent.length === 0)) continue;
    const sources = call.map(({ sent, readIndex }) => {
      const source = read[readIndex]!.source;
      return {
        connectionId: source.connectionId, sourceObject: source.sourceObject, unchecked: false,
        rows: sent.map(({ row, identifier }) => {
          const values: Record<string, Json> = {};
          for (const id of wanted) {
            const mapping = mappingOf(node, id, source);
            const raw = mapping === undefined ? undefined : row[mapping.fieldPath];
            if (raw !== undefined) values[id] = raw;
          }
          return { identifier, values };
        }),
      };
    });
    const reply = await resolve({ objectTypeId: type.id, ontologyVersionId, sources, properties: merge });
    for (const resolved of reply.objects) {
      const records: SourceRecord[] = resolved.rows.map(({ source, row }) => ({
        source: read[call[source]!.readIndex]!.source, row: call[source]!.sent[row]!.row,
      }));
      const values = new Map<string, Decided>();
      for (const id of node.reads) {
        const merged = resolved.properties[id];
        if (merged === undefined) {
          values.set(id, { value: null, state: 'empty' });
          continue;
        }
        const state = merged.state;
        values.set(id, undecided(state) ? { value: null, state }
          : {
            value: valueFrom(node, id, records, state === 'agreed' ? undefined : merged.from), state,
            ...(merged.from !== undefined && state !== 'agreed' ? { from: merged.from } : {}),
            ...(merged.authorityId !== undefined ? { authorityId: merged.authorityId } : {}),
          });
      }
      const seen = objects.get(resolved.siloObjectId);
      if (seen === undefined) {
        objects.set(resolved.siloObjectId, {
          id: resolved.siloObjectId, typeId: type.id, records, values,
          unmatched: records.length === 1 && !keyable.has(records[0]!.row),
        });
      } else {
        seen.records.push(...records);
        for (const [id, decided] of values) seen.values.set(id, combine(seen.values.get(id) ?? { value: null, state: 'empty' }, decided));
        seen.unmatched = false;
      }
    }
  }
  // Rows with no identifier cannot be sent: each stands alone, unmatched.
  for (const { source, rows } of read) {
    for (const row of rows) {
      if (identifierText(row[source.identifierFieldPath]) !== undefined) continue;
      const [alone] = mergeSingleSource(organisationId, node, [{ source, rows: [row] }]);
      objects.set(alone!.id, { ...alone!, unmatched: true });
    }
  }
  return [...objects.values()];
}
