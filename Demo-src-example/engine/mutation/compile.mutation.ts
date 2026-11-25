import type { ContributingObject } from '../../models/concept.model';
import type { Comparison } from '../execution/query.execution';
import type { MutationManifest, SetValue } from './resolve.mutation';

/**
 * Mutations §3 — a change in the user's words, compiled to a manifest.
 *
 * ── Compiled the same way a question is ────────────────────────────────────
 *
 * The model is told names — concepts, the fields this person may change, the
 * fields and operators each concept can be filtered by — and returns structure.
 * It never sees a record, a value from a record, or a table. What it returns is
 * validated here and rejected rather than repaired: a repaired change is a
 * change nobody asked for, previewed as though they had.
 *
 * ── The vocabulary is the permission ───────────────────────────────────────
 *
 * A concept the person cannot reach, is not cleared for, or cannot write to any
 * part of is not in it. A field hidden from them by policy is not in it. So a
 * manifest cannot name either, because the model was never told they exist —
 * and anything it names that is not in the vocabulary is rejected here, not
 * trusted.
 */

export type ChangeVocabulary = {
  conceptId: string;
  name: string;
  /** Fields this person may set: visible, and mapped in a system they can write to. */
  writable: string[];
  /** Fields a change may be scoped by: visible and mapped in every system the concept spans. */
  filterable: string[];
  /** Operators every system the concept spans can apply. */
  filters: Comparison[];
};

export function changeVocabularyOf(input: {
  concepts: ReadonlyArray<{ id: string; name: string; objects: readonly ContributingObject[] }>;
  /** Connections this person can write to now. */
  writable: ReadonlySet<string>;
  filters: ReadonlyMap<string, readonly Comparison[]>;
}): ChangeVocabulary[] {
  return input.concepts
    .map((concept) => {
      const writable = new Set<string>();
      for (const object of concept.objects) {
        if (!input.writable.has(object.connectionId)) continue;
        for (const field of Object.keys(object.fieldMap)) writable.add(field);
      }

      const [first, ...rest] = concept.objects;
      const filterable = first
        ? Object.keys(first.fieldMap).filter((field) => rest.every((object) => field in object.fieldMap))
        : [];

      const declared = concept.objects.map((object) => input.filters.get(object.connectionId) ?? []);
      const filters = declared.length === 0 ? [] : [...declared[0]!].filter((op) => declared.every((one) => one.includes(op)));

      return {
        conceptId: concept.id,
        name: concept.name,
        writable: [...writable].sort(),
        filterable: filterable.sort(),
        filters: [...filters].sort(),
      };
    })
    .filter((concept) => concept.writable.length > 0 && concept.filterable.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function describeChangeVocabulary(vocabulary: readonly ChangeVocabulary[]): string {
  return vocabulary
    .map((concept) =>
      [
        `concept ${concept.conceptId} "${concept.name}"`,
        `  fields that can be changed: ${concept.writable.join(', ')}`,
        `  fields that say which records: ${concept.filterable.join(', ')}`,
        `  operators: ${concept.filters.join(', ') || '(none)'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

/** What the model is asked to produce. A shape, never an example with values in it. */
export function changeShape(): string {
  return [
    'You turn a request to change records into exactly one JSON object, and nothing else.',
    '',
    'A change:',
    '{"conceptId": "<id from the list>", "operation": "update|delete", ' +
      '"where": [{"field": "<field that says which records>", "op": "<operator>", "value": <json>}], ' +
      '"set": {"<field that can be changed>": <string, number, boolean or null>}}',
    '',
    'A refusal, when the request cannot be expressed with the concepts and fields listed:',
    '{"refusal": "<why, in one sentence>"}',
    '',
    'A clarification, when two or more concepts could be meant:',
    '{"ambiguous": {"question": "<what to ask>", "options": ["<conceptId>", "<conceptId>"]}}',
    '',
    '`where` is required and must say which records: a change to every record is refused.',
    '`set` is required for an update and must be omitted for a delete.',
    'Use only concept ids, field names and operators from the list below. Never invent one: refuse instead.',
    'Take values from the request itself. Never guess a value the request does not state.',
  ].join('\n');
}

export type CompiledChange =
  | { outcome: 'change'; manifest: MutationManifest }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'ambiguous'; question: string; options: Array<{ conceptId: string; name: string }> }
  | { outcome: 'rejected'; reason: string; detail?: Record<string, unknown> };

const COMPARISONS: readonly Comparison[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null'];

const reject = (reason: string, detail?: Record<string, unknown>): CompiledChange => ({
  outcome: 'rejected',
  reason,
  ...(detail ? { detail } : {}),
});

function parse(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const scalar = (value: unknown): value is SetValue =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/**
 * Validate what the model returned against what this person may change.
 *
 * STRICT, ALWAYS. §7: "Partial requires it to be chosen per mutation, never per
 * organisation" — and never by a model on somebody's behalf. A compiled change
 * that resolves imperfectly is refused, and the person can ask again saying so.
 */
export function validateChange(raw: unknown, vocabulary: readonly ChangeVocabulary[]): CompiledChange {
  const body = parse(raw);
  if (!body) return reject('The model did not return a change.');

  if (typeof body.refusal === 'string' && body.refusal.trim() !== '') {
    return { outcome: 'refused', reason: body.refusal.trim() };
  }

  if (body.ambiguous !== undefined) {
    const ambiguous = parse(body.ambiguous);
    const options = Array.isArray(ambiguous?.options) ? ambiguous!.options : [];
    const known = options
      .map((id) => vocabulary.find((concept) => concept.conceptId === id))
      .filter((concept): concept is ChangeVocabulary => concept !== undefined);

    if (typeof ambiguous?.question !== 'string' || known.length < 2 || known.length !== options.length) {
      return reject('The model asked for a clarification it did not make answerable.');
    }
    return {
      outcome: 'ambiguous',
      question: ambiguous.question,
      options: known.map((concept) => ({ conceptId: concept.conceptId, name: concept.name })),
    };
  }

  const unexpected = Object.keys(body).filter((key) => !['conceptId', 'operation', 'where', 'set'].includes(key));
  if (unexpected.length > 0) return reject('The change carried something a change cannot.', { keys: unexpected });

  const concept = vocabulary.find((one) => one.conceptId === body.conceptId);
  if (!concept) return reject('The change named a concept that is not available to change.');

  if (body.operation !== 'update' && body.operation !== 'delete') {
    return reject('The change did not say whether to update or delete.');
  }

  if (!Array.isArray(body.where) || body.where.length === 0 || body.where.length > 50) {
    return reject('The change did not say which records it applies to.');
  }

  const where: MutationManifest['where'] = [];
  for (const entry of body.where) {
    const filter = parse(entry);
    if (!filter) return reject('A condition in the change was not a condition.');

    const extra = Object.keys(filter).filter((key) => !['field', 'op', 'value'].includes(key));
    if (extra.length > 0) return reject('A condition carried something a condition cannot.', { keys: extra });

    if (typeof filter.field !== 'string' || !concept.filterable.includes(filter.field)) {
      return reject('The change filtered on a field that cannot say which records.', { field: filter.field });
    }
    if (typeof filter.op !== 'string' || !COMPARISONS.includes(filter.op as Comparison) || !concept.filters.includes(filter.op as Comparison)) {
      return reject('The change used an operator this concept cannot apply.', { op: filter.op });
    }

    where.push({ field: filter.field, op: filter.op as Comparison, ...('value' in filter ? { value: filter.value } : {}) });
  }

  const set = body.set === undefined ? {} : parse(body.set);
  if (set === null) return reject('The values to set were not a set of values.');

  const entries = Object.entries(set);
  if (body.operation === 'update' && (entries.length === 0 || entries.length > 100)) {
    return reject('An update has to say which fields change, and to what.');
  }
  if (body.operation === 'delete' && entries.length > 0) {
    return reject('A delete sets no fields.');
  }

  for (const [field, value] of entries) {
    if (!concept.writable.includes(field)) return reject('The change set a field that cannot be changed.', { field });
    if (!scalar(value)) return reject('The change set a value that is not a single value.', { field });
  }

  return {
    outcome: 'change',
    manifest: {
      conceptId: concept.conceptId,
      operation: body.operation,
      where,
      set: Object.fromEntries(entries) as Record<string, SetValue>,
      resolution: 'strict',
    },
  };
}
