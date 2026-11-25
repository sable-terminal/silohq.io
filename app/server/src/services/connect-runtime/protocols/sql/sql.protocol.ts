// The SQL protocol engine (spec 14.4, 14.5): customer databases, through the Silo Agent. One
// generated statement per step, the native part computed by the database. The agent holds
// the login and runs the statement; the engine sends it, reads rows keyed by field, and
// classifies a failure by its SQLSTATE, after the manifest's own rules. A manifest whose
// transport names a Silo store (66.5) is read the same way, the statement run in the cell's
// own store instead of through an agent.

import type { ErrorMeaning } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../../../utils/errors.util.ts';
import { SourceSqlError } from '../../agent.service.ts';
import { checkDeadline, classify, coerce, rowsBound, SourceError, withRetries, type ErrorInput, type ProtocolEngine, type Row } from '../../engine.service.ts';
import { isDialect } from './checks.protocol.ts';
import { selectStatement } from './query.protocol.ts';

/** SQLSTATE classes (ISO 9075 and the common extensions) as meanings. */
export function sqlStandard(input: ErrorInput): ErrorMeaning | undefined {
  const state = input.sqlstate;
  if (state === '') return undefined;
  if (state.startsWith('28') || state === '42501') return 'auth';
  if (state === '42P01' || state === '42S02' || state === '42704') return 'not_found';
  if (state.startsWith('23') || state.startsWith('40')) return state === '40001' || state === '40P01' ? 'upstream' : 'conflict';
  if (state.startsWith('22') || state.startsWith('42')) return 'validation';
  if (state === '54000' || state === '54001') return 'bounds';
  return 'upstream';
}

export const sqlEngine: ProtocolEngine = {
  async read(ctx, object, native, fields) {
    if (ctx.manifest.protocol.kind !== 'sql' || !isDialect(ctx.manifest.protocol.dialect)) {
      throw new AppError('integrity', 'the manifest names no grammar of the SQL engine', { code: 'manifest.dialect_unknown' });
    }
    const store = ctx.manifest.transport.store;
    if (store === undefined && ctx.connection.agentPoolId === null) {
      throw new AppError('integrity', 'an agent connection has no agent pool', { code: 'connection.agent_pool_missing' });
    }
    const dialect = ctx.manifest.protocol.dialect;
    const fetch = native.limit ?? ctx.maxRows + 1;
    const statement = selectStatement(dialect, object, native, fields, fetch);
    const { rows } = await withRetries(ctx, async () => {
      checkDeadline(ctx);
      if (store !== undefined) {
        const dataset = object.source.kind === 'sql' ? object.source.schema : undefined;
        if (dataset === undefined) throw new AppError('integrity', 'a Silo object names its dataset', { code: 'manifest.silo_dataset_missing' });
        return ctx.siloStore.query({
          organisationId: ctx.connection.organisationId, connectionId: ctx.connection.id, siloId: store.siloId, dataset, statement, maxRows: fetch,
          signal: ctx.signal,
        });
      }
      try {
        return await ctx.agent.query({
          organisationId: ctx.connection.organisationId, connectionId: ctx.connection.id, agentPoolId: ctx.connection.agentPoolId!,
          dialect, statement, maxRows: fetch, timeoutMs: Math.max(1, Math.floor(ctx.deadline - performance.now())), signal: ctx.signal,
        });
      } catch (error) {
        if (!(error instanceof SourceSqlError)) throw error;
        const meaning = await classify(ctx.manifest, { status: 0, headers: {}, body: null, sqlstate: error.sqlstate }, sqlStandard, ctx.now);
        throw new SourceError(meaning?.meaning ?? 'upstream', { sqlstate: error.sqlstate }, meaning?.retryAfterMs);
      }
    });
    ctx.stats.pages += 1;
    ctx.stats.sourceRows += rows.length;
    if (native.limit === null && rows.length > ctx.maxRows) throw rowsBound(ctx);

    const types = new Map(object.fields.map((f) => [f.name, f.type]));
    const columns = native.aggregate === null ? fields.map((f) => f.name)
      : [...native.aggregate.groupBy, ...native.aggregate.measures.map((m) => m.as)];
    // count is an integer, sum and avg numbers, min and max the type of their field.
    const measures = new Map((native.aggregate?.measures ?? []).map((m) => [m.as,
      m.fn === 'count' ? 'integer' as const : m.fn === 'sum' || m.fn === 'avg' ? 'number' as const : types.get(m.field!) ?? 'json']));
    return rows.map((source): Row => {
      const row: Row = {};
      for (const name of columns) {
        const value = source[name];
        // A database may return a count or sum as text (a numeric beyond a double); coerce reads it.
        row[name] = coerce(value, measures.get(name) ?? types.get(name) ?? 'json', ctx.stats);
      }
      return row;
    });
  },
};
