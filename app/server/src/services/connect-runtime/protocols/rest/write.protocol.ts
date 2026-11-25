// The REST engine's writes (spec 42.5, 45.2, 45.3): each operation is the request its
// manifest declares, {identifier} in the path standing for the record, the body built by the
// manifest's JSONata from the values (or the values themselves), sent through the credential
// service, which places the secret. Not atomic: each operation reports its own outcome.
//
// Retries follow the source's meaning: a rate-limited or failing update, upsert or delete is
// retried under the manifest's attempts (each names its record, so a repeat lands on it); a create is never retried blindly, since a source
// that does not honour an idempotency key could create the record twice (45.3), and neither is
// a custom action, whose effect a repeat might double. An auth failure stops the plan: the
// rest is not attempted.

import type { WriteOperation, WriteResult } from '../../../../contracts/connect-runtime/write.contract.ts';
import type { ManifestObject } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError, isAppError } from '../../../../utils/errors.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import { getPath, SourceError, withRetries, type ReadContext } from '../../engine.service.ts';
import { expandPath, sendOnce, type Request } from './rest.protocol.ts';

export interface RestWrite {
  key: string;
  operation: WriteOperation;
  identifier: string | undefined;
  values: Record<string, unknown>;
  customAction?: string | undefined;
}

const MANIFEST_OP = { create: 'create', update_full: 'updateFull', update_partial: 'update', delete: 'delete', upsert: 'upsert' } as const;

async function requestFor(ctx: ReadContext, object: ManifestObject, write: RestWrite): Promise<Request> {
  const declared = write.operation === 'custom'
    ? object.writes?.custom.find((c) => c.name === write.customAction)
    : object.writes?.[MANIFEST_OP[write.operation]];
  if (declared?.request === undefined) {
    throw new AppError('validation', `the manifest declares no ${write.operation} on ${object.name}`, { code: 'write.operation_undeclared' });
  }
  const template = declared.request;
  const withIdentifier = template.path.replace(/\{identifier\}/g, () => {
    if (write.identifier === undefined) {
      throw new AppError('validation', 'the request names the record, but the write has no identifier', { code: 'write.identifier_required' });
    }
    return encodeURIComponent(write.identifier);
  });
  let body: unknown = template.body;
  if (declared.body !== undefined) {
    body = await compileExpression('write.body', 'jsonata', declared.body.jsonata)
      .evaluate({ input: write.values, identifier: write.identifier ?? null, params: ctx.params }, ctx.now);
  } else if (write.operation !== 'delete' && body === undefined) {
    // A custom action with no body template sends its inputs.
    body = write.values;
  }
  return {
    method: template.method,
    path: expandPath(withIdentifier, ctx.params),
    query: Object.fromEntries(Object.entries(template.query).map(([k, v]) => [k, String(v)])),
    headers: Object.fromEntries(Object.entries(template.headers).map(([k, v]) => [k.toLowerCase(), v])),
    body,
  };
}

async function identifierOf(ctx: ReadContext, object: ManifestObject, write: RestWrite, response: { headers: Record<string, string>; body: unknown }): Promise<string | null> {
  if (write.operation !== 'create') return write.identifier ?? null;
  const result = object.writes?.create?.result;
  const idField = object.identifier[0]!;
  const found = result !== undefined
    ? await compileExpression('write.result', 'jsonata', result.jsonata).evaluate({ input: response.body, headers: response.headers }, ctx.now)
    : write.values[idField] ?? getPath(response.body, object.fields.find((f) => f.name === idField)?.path ?? idField);
  return found === null || found === undefined ? null : String(found);
}

const failure = (error: unknown): WriteResult['error'] => {
  if (error instanceof SourceError) return { meaning: error.meaning, code: error.code };
  if (isAppError(error)) return { meaning: error.category === 'bounds' ? 'bounds' : 'upstream', code: error.code };
  return { meaning: 'upstream', code: 'write.failed' };
};

export async function restWrite(ctx: ReadContext, object: ManifestObject, writes: readonly RestWrite[]): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  let stopped = false;
  for (const write of writes) {
    if (stopped) {
      results.push({ key: write.key, outcome: 'not_attempted', identifier: write.identifier ?? null, error: null });
      continue;
    }
    try {
      const request = await requestFor(ctx, object, write);
      const once = write.operation === 'create' || write.operation === 'custom';
      const response = once ? await sendOnce(ctx, request) : await withRetries(ctx, () => sendOnce(ctx, request));
      results.push({ key: write.key, outcome: 'applied', identifier: await identifierOf(ctx, object, write, response), error: null });
    } catch (error) {
      results.push({ key: write.key, outcome: 'failed', identifier: write.identifier ?? null, error: failure(error) });
      // An auth failure halts the connection's plan and marks it for repair (45.3).
      if (error instanceof SourceError && error.meaning === 'auth') stopped = true;
    }
  }
  return results;
}
