// The GraphQL engine's writes (spec 14.4, 42.5, 45.2, 45.3): each operation calls the mutation
// its manifest declares. The document is printed from the manifest (the field, its typed
// variables, what it selects back), so it holds no value; the values travel as variables,
// built by the manifest's JSONata from the values and identifier, or the values themselves.
// Only variables the mutation declares are sent. Sent through the credential service, which
// places the secret; a 200 carrying errors is a failure, classified like any other (the
// manifest's rules, HTTP's meaning, the error's extensions code).
//
// As for REST: not atomic, each operation reporting its own outcome; an update, upsert or
// delete is retried under the manifest's attempts, a create never blindly; an auth failure
// stops the plan. A mutation answering null for an update or delete found no record.

import type { WriteResult } from '../../../../contracts/connect-runtime/write.contract.ts';
import type { ManifestObject } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError, isAppError } from '../../../../utils/errors.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import { getPath, SourceError, withRetries, type ReadContext } from '../../engine.service.ts';
import type { RestWrite } from '../rest/write.protocol.ts';
import { expandPath, sendOnce } from './graphql.protocol.ts';
import { buildMutation } from './query.protocol.ts';

const MANIFEST_OP = { create: 'create', update_full: 'updateFull', update_partial: 'update', delete: 'delete', upsert: 'upsert' } as const;

const failure = (error: unknown): WriteResult['error'] => {
  if (error instanceof SourceError) return { meaning: error.meaning, code: error.code };
  if (isAppError(error)) return { meaning: error.category === 'bounds' ? 'bounds' : 'upstream', code: error.code };
  return { meaning: 'upstream', code: 'write.failed' };
};

export async function graphqlWrite(ctx: ReadContext, object: ManifestObject, writes: readonly RestWrite[]): Promise<WriteResult[]> {
  if (object.source.kind !== 'graphql') throw new AppError('integrity', 'a GraphQL object has a GraphQL source', { code: 'manifest.source_kind' });
  const path = expandPath(object.source.path, ctx.params);
  const results: WriteResult[] = [];
  let stopped = false;
  for (const write of writes) {
    if (stopped) {
      results.push({ key: write.key, outcome: 'not_attempted', identifier: write.identifier ?? null, error: null });
      continue;
    }
    try {
      if (write.operation === 'custom') throw new AppError('validation', 'custom actions are REST endpoints', { code: 'write.operation_undeclared' });
      const declared = object.writes?.[MANIFEST_OP[write.operation]];
      const mutation = declared?.mutation;
      if (declared === undefined || mutation === undefined) {
        throw new AppError('validation', `the manifest declares no ${write.operation} mutation on ${object.name}`, { code: 'write.operation_undeclared' });
      }
      const built = declared.body === undefined ? { ...write.values }
        : await compileExpression('write.body', 'jsonata', declared.body.jsonata)
          .evaluate({ input: write.values, identifier: write.identifier ?? null, params: ctx.params }, ctx.now);
      if (built === null || typeof built !== 'object' || Array.isArray(built)) {
        throw new AppError('integrity', 'a GraphQL write\'s body gives its variables as an object', { code: 'graphql.variables_not_object' });
      }
      const allowed = new Set(mutation.variables.map((v) => v.name));
      const unknown = Object.keys(built).find((name) => !allowed.has(name));
      if (unknown !== undefined) {
        throw new AppError('integrity', 'a write sets a variable the mutation does not declare', { code: 'graphql.variable_undeclared', details: { variable: unknown } });
      }
      const document = buildMutation(mutation);
      const send = () => sendOnce(ctx, path, document, built as Record<string, unknown>);
      const response = write.operation === 'create' ? await send() : await withRetries(ctx, send);
      const data = (response.body as { data?: Record<string, unknown> | null } | null)?.data?.[mutation.field];
      if ((data === null || data === undefined) && (write.operation === 'update_partial' || write.operation === 'update_full' || write.operation === 'delete')) {
        throw new SourceError('not_found', { reason: 'mutation_returned_null' });
      }
      let identifier = write.identifier ?? null;
      if (write.operation === 'create' || write.operation === 'upsert') {
        const found = declared.result !== undefined
          ? await compileExpression('write.result', 'jsonata', declared.result.jsonata).evaluate({ input: data, headers: response.headers }, ctx.now)
          : getPath(data, object.fields.find((f) => f.name === object.identifier[0])?.path ?? object.identifier[0]!);
        identifier = found === null || found === undefined ? identifier : String(found);
      }
      results.push({ key: write.key, outcome: 'applied', identifier, error: null });
    } catch (error) {
      results.push({ key: write.key, outcome: 'failed', identifier: write.identifier ?? null, error: failure(error) });
      if (error instanceof SourceError && error.meaning === 'auth') stopped = true;
    }
  }
  return results;
}
