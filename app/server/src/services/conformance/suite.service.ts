// The conformance suite (spec 17.2), as tests over reads. It knows no provider and no
// protocol: it reads through a function the service gives it (connect-runtime's readObject),
// and compares what the source returns with what the manifest declares and with the same
// operation done in memory.
//
// Per object:
// - read: list (a bounded sample), field selection, observed types, identifier unique,
//   get by identifier (where an equality filter on it is declared);
// - pagination: the whole object read (bounded), three pages traversed, no duplicates,
//   continuation ends within max_pages, no gap against a source count (where the source
//   counts natively);
// - filter pushdown: each declared filter, sort and aggregate against the same operation
//   in memory over the whole read;
// - error: a wrong credential classified as auth (once per connection); an unknown
//   identifier as not_found. Rate limits and oversized responses are never provoked.
// Record values are held in memory for the comparison only. Results carry codes and counts.

import type { ConformanceTest, RunnableClass } from '../../contracts/conformance/conformance.contract.ts';
import type { FilterOp, Manifest, ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import type { PlanStep, StepFilter } from '../../contracts/connect/step.contract.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { aggregateRows, applyResidual, sortRows, type ReadStats, type Row } from '../connect-runtime/engine.service.ts';

export interface SuiteRead { rows: Row[]; stats: ReadStats }
export type Reader = (step: PlanStep, options?: { invalidCredentials?: true }) => Promise<SuiteRead>;

/** Rows in the read class's sample. */
export const SAMPLE_ROWS = 50;
const MAX_VALUE_LENGTH = 4_096;

const codeOf = (error: unknown): string => (isAppError(error) ? error.code : 'error.unexpected');
const step = (object: string, extra: Partial<PlanStep> = {}): PlanStep => ({ object, filters: [], sort: [], ...extra });
const keyOf = (object: ManifestObject, row: Row): string => JSON.stringify(object.identifier.map((f) => row[f] ?? null));

function duplicates(object: ManifestObject, rows: readonly Row[]): number {
  const seen = new Set<string>();
  let dups = 0;
  for (const row of rows) {
    const key = keyOf(object, row);
    if (seen.has(key)) dups += 1;
    seen.add(key);
  }
  return dups;
}

function sameKeys(object: ManifestObject, a: readonly Row[], b: readonly Row[]): boolean {
  if (a.length !== b.length) return false;
  const count = new Map<string, number>();
  for (const row of a) count.set(keyOf(object, row), (count.get(keyOf(object, row)) ?? 0) + 1);
  for (const row of b) {
    const key = keyOf(object, row);
    const n = count.get(key) ?? 0;
    if (n === 0) return false;
    count.set(key, n - 1);
  }
  return true;
}

const scalar = (v: unknown): v is string | number | boolean =>
  (typeof v === 'string' && v.length <= MAX_VALUE_LENGTH) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

/** A value from the whole read to test an operator with; undefined when the read has none. */
function probeValue(op: FilterOp, rows: readonly Row[], field: string): StepFilter['value'] | null | undefined {
  if (op === 'is_null' || op === 'is_not_null') return null;
  const v = rows.map((r) => r[field]).find((x) => x !== null && x !== undefined);
  if (!scalar(v)) return undefined;
  if (op === 'in') return [v];
  if (op === 'contains') return typeof v === 'string' && v.length > 0 ? (v.length >= 4 ? v.slice(1, 4) : v) : undefined;
  if (op === 'starts_with') return typeof v === 'string' && v.length > 0 ? v.slice(0, Math.min(3, v.length)) : undefined;
  return v;
}

const close = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

/** An identifier no source holds, in the identifier field's type. */
function unknownIdentifier(object: ManifestObject): string | number | undefined {
  const field = object.fields.find((f) => f.name === object.identifier[0]);
  if (field?.type === 'string') return 'silo-conformance-no-such-record-7f3a9c';
  if (field?.type === 'integer') return -987_654_321;
  if (field?.type === 'number') return -987_654_321.5;
  return undefined;
}

export async function runSuite(manifest: Manifest, classes: readonly RunnableClass[], read: Reader, signal: AbortSignal): Promise<ConformanceTest[]> {
  const tests: ConformanceTest[] = [];
  const on = new Set(classes);
  async function test(id: string, cls: RunnableClass, object: string | null, operator: ConformanceTest['operator'],
    body: () => Promise<{ outcome: ConformanceTest['outcome']; reason?: string }>): Promise<void> {
    if (signal.aborted) return;
    const started = performance.now();
    let outcome: ConformanceTest['outcome'];
    let reason: string | null = null;
    try {
      const result = await body();
      outcome = result.outcome;
      reason = result.reason ?? null;
    } catch (error) {
      outcome = 'failed';
      reason = `error:${codeOf(error)}`.slice(0, 200);
    }
    tests.push({ id, class: cls, object, outcome, durationMs: Math.round(performance.now() - started), reason, operator });
  }
  const na = (reason: string) => ({ outcome: 'not_applicable' as const, reason });

  // Once per connection: the source refuses a wrong credential as auth.
  if (on.has('error')) {
    await test('error.invalid_credential', 'error', null, null, async () => {
      if (manifest.auth.strategy === 'none') return na('no_credentials');
      if (manifest.transport.viaAgent) return na('agent_custody');
      try {
        await read(step(manifest.objects[0]!.name, { limit: 1 }), { invalidCredentials: true });
        return { outcome: 'failed', reason: 'wrong_credentials_accepted' };
      } catch (error) {
        return codeOf(error) === 'source.auth' ? { outcome: 'passed' } : { outcome: 'failed', reason: `classified:${codeOf(error)}` };
      }
    });
  }

  for (const object of manifest.objects) {
    const name = object.name;
    const at = (cls: string, what: string, ...rest: string[]) => [cls, what, name, ...rest].join('.');

    // The sample: the read class's list, and its rows for the tests that need one.
    let sample: SuiteRead | undefined;
    let sampleError: string | undefined;
    try {
      sample = await read(step(name, { limit: SAMPLE_ROWS }));
    } catch (error) {
      sampleError = codeOf(error);
    }
    // The whole object, bounded by the runtime: pagination and pushdown compare against it.
    let whole: SuiteRead | undefined;
    let wholeError: string | undefined;
    if (on.has('pagination') || on.has('filter_pushdown')) {
      try {
        whole = await read(step(name));
      } catch (error) {
        wholeError = codeOf(error);
      }
    }
    const tooLarge = wholeError === 'connect.rows_per_source_step' || wholeError === 'connect.wall_time';

    if (on.has('read')) {
      await test(at('read', 'list'), 'read', name, null, async () =>
        sample !== undefined ? { outcome: 'passed', reason: `rows:${sample.rows.length}` } : { outcome: 'failed', reason: `error:${sampleError}` });
      await test(at('read', 'field_selection'), 'read', name, null, async () => {
        const field = object.identifier[0]!;
        const out = await read(step(name, { fields: [field], limit: 5 }));
        return out.rows.every((r) => Object.keys(r).length === 1 && field in r) ? { outcome: 'passed' } : { outcome: 'failed', reason: 'extra_fields' };
      });
      await test(at('read', 'types'), 'read', name, null, async () => {
        const basis = whole ?? sample;
        if (basis === undefined) return { outcome: 'failed', reason: `error:${sampleError}` };
        return basis.stats.typeMismatches === 0 ? { outcome: 'passed' } : { outcome: 'failed', reason: `type_mismatches:${basis.stats.typeMismatches}` };
      });
      await test(at('read', 'identifier_unique'), 'read', name, null, async () => {
        if (sample === undefined) return { outcome: 'failed', reason: `error:${sampleError}` };
        const dups = duplicates(object, sample.rows);
        return dups === 0 ? { outcome: 'passed' } : { outcome: 'failed', reason: `duplicates:${dups}` };
      });
      await test(at('read', 'get'), 'read', name, null, async () => {
        const id = object.identifier[0]!;
        if (object.identifier.length !== 1 || !object.pushdown.filters.some((f) => f.field === id && f.ops.includes('eq'))) return na('no_identifier_filter');
        const first = sample?.rows.find((r) => scalar(r[id]));
        if (first === undefined) return na(sample === undefined ? `error:${sampleError}` : 'empty_sample');
        const out = await read(step(name, { filters: [{ field: id, op: 'eq', value: first[id] as string | number | boolean }] }));
        return out.rows.length >= 1 && out.rows.every((r) => keyOf(object, r) === keyOf(object, first))
          ? { outcome: 'passed' } : { outcome: 'failed', reason: `rows:${out.rows.length}` };
      });
    }

    if (on.has('pagination')) {
      const paged = object.source.kind === 'rest' && object.source.paging !== undefined;
      await test(at('pagination', 'terminates'), 'pagination', name, null, async () => {
        if (!paged) return na('no_paging');
        if (whole !== undefined) return { outcome: 'passed', reason: `pages:${whole.stats.pages}` };
        if (wholeError === 'connect.max_pages') return { outcome: 'failed', reason: 'max_pages' };
        return tooLarge ? na('source_larger_than_one_read') : { outcome: 'failed', reason: `error:${wholeError}` };
      });
      await test(at('pagination', 'traverse'), 'pagination', name, null, async () => {
        if (!paged) return na('no_paging');
        if (whole === undefined) return tooLarge ? na('source_larger_than_one_read') : { outcome: 'failed', reason: `error:${wholeError}` };
        return whole.stats.pages >= 3 ? { outcome: 'passed', reason: `pages:${whole.stats.pages}` } : na(`pages:${whole.stats.pages}`);
      });
      await test(at('pagination', 'no_duplicates'), 'pagination', name, null, async () => {
        if (!paged) return na('no_paging');
        if (whole === undefined) return tooLarge ? na('source_larger_than_one_read') : { outcome: 'failed', reason: `error:${wholeError}` };
        if (whole.stats.pages < 2) return na(`pages:${whole.stats.pages}`);
        const dups = duplicates(object, whole.rows);
        return dups === 0 ? { outcome: 'passed' } : { outcome: 'failed', reason: `duplicates:${dups}` };
      });
      await test(at('pagination', 'no_gap'), 'pagination', name, null, async () => {
        const counts = object.pushdown.aggregates?.functions.includes('count') === true;
        if (!counts) return na('no_source_count');
        if (whole === undefined) return tooLarge ? na('source_larger_than_one_read') : { outcome: 'failed', reason: `error:${wholeError}` };
        const out = await read(step(name, { aggregate: { groupBy: [], measures: [{ fn: 'count', as: 'n' }] } }));
        const n = Number(out.rows[0]?.['n']);
        return n === whole.rows.length ? { outcome: 'passed' } : { outcome: 'failed', reason: `count:${n}/rows:${whole.rows.length}` };
      });
    }

    if (on.has('filter_pushdown')) {
      const unavailable = () => (whole === undefined ? (tooLarge ? na('source_larger_than_one_read') : { outcome: 'failed' as const, reason: `error:${wholeError}` }) : undefined);
      for (const declared of object.pushdown.filters) {
        for (const op of declared.ops) {
          await test(at('filter_pushdown', 'filter', declared.field, op), 'filter_pushdown', name, { field: declared.field, op }, async () => {
            const blocked = unavailable();
            if (blocked !== undefined) return blocked;
            const value = probeValue(op, whole!.rows, declared.field);
            if (value === undefined) return na('no_value_to_test');
            const filter = (value === null ? { field: declared.field, op } : { field: declared.field, op, value }) as StepFilter;
            const native = await read(step(name, { filters: [filter] }));
            const expected = applyResidual(whole!.rows, { filters: [filter], aggregate: null, sort: [], limit: null });
            return sameKeys(object, native.rows, expected) ? { outcome: 'passed' }
              : { outcome: 'failed', reason: `rows:${native.rows.length}/expected:${expected.length}` };
          });
        }
      }
      for (const declared of object.pushdown.sort) {
        await test(at('filter_pushdown', 'sort', declared.field), 'filter_pushdown', name, { field: declared.field, op: 'sort' }, async () => {
          const blocked = unavailable();
          if (blocked !== undefined) return blocked;
          const sort = [{ field: declared.field, direction: 'asc' as const }];
          const native = await read(step(name, { sort }));
          const expected = sortRows([...whole!.rows], sort);
          const same = native.rows.length === expected.length && native.rows.every((r, i) => close(r[declared.field], expected[i]![declared.field]));
          return same ? { outcome: 'passed' } : { outcome: 'failed', reason: `order_differs:rows:${native.rows.length}/expected:${expected.length}` };
        });
      }
      const aggregates = object.pushdown.aggregates;
      if (aggregates !== undefined) {
        const numeric = object.fields.find((f) => f.type === 'integer' || f.type === 'number');
        for (const fn of aggregates.functions) {
          await test(at('filter_pushdown', 'aggregate', fn), 'filter_pushdown', name, { field: fn === 'count' ? '*' : numeric?.name ?? '*', op: fn }, async () => {
            const blocked = unavailable();
            if (blocked !== undefined) return blocked;
            if (fn !== 'count' && numeric === undefined) return na('no_numeric_field');
            const measure = fn === 'count' ? { fn, as: 'v' } : { fn, field: numeric!.name, as: 'v' };
            const aggregate = { groupBy: [], measures: [measure] };
            const native = await read(step(name, { aggregate }));
            const expected = aggregateRows([...whole!.rows], aggregate);
            return close(Number(native.rows[0]?.['v']), Number(expected[0]?.['v'])) ? { outcome: 'passed' } : { outcome: 'failed', reason: 'value_differs' };
          });
        }
      }
    }

    if (on.has('error')) {
      await test(at('error', 'not_found'), 'error', name, null, async () => {
        const id = object.identifier[0]!;
        const value = unknownIdentifier(object);
        if (object.identifier.length !== 1 || value === undefined || !object.pushdown.filters.some((f) => f.field === id && f.ops.includes('eq'))) {
          return na('no_identifier_filter');
        }
        try {
          const out = await read(step(name, { filters: [{ field: id, op: 'eq', value }] }));
          return out.rows.length === 0 ? { outcome: 'passed', reason: 'empty' } : { outcome: 'failed', reason: `rows:${out.rows.length}` };
        } catch (error) {
          return codeOf(error) === 'source.not_found' ? { outcome: 'passed' } : { outcome: 'failed', reason: `classified:${codeOf(error)}` };
        }
      });
      await test(at('error', 'rate_limit'), 'error', name, null, async () => na('not_provoked'));
    }
  }
  return tests;
}
