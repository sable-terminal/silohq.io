// The OData engine's writes (spec 14.4, 42.5, 45.2, 45.3). The engine writes the request, as
// SQL's does; the manifest only declares which operations the entity set takes:
// - create: POST to the entity set; the written record's identifier is read from the entity
//   the service returns (its key properties), or from the manifest's result expression;
// - update (partial): PATCH to the entity's key (version 2.0: MERGE, tunnelled as POST with
//   X-HTTP-Method, as SAP Gateway expects); a full update: PUT;
// - delete: DELETE to the entity's key;
// - upsert: PATCH to the key, which an OData service creates when absent (4.0 only).
// The body is the values written, under their property names, or the manifest's JSONata
// over them. Keys are typed literals the engine formats, never text a value supplies.
//
// As for REST: not atomic, each operation reporting its own outcome; an update, upsert or
// delete is retried under the manifest's attempts, a create never blindly; an auth failure
// stops the plan.

import type { WriteResult } from '../../../../contracts/connect-runtime/write.contract.ts';
import type { ManifestObject } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError, isAppError } from '../../../../utils/errors.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import { getPath, SourceError, withRetries, type ReadContext } from '../../engine.service.ts';
import { sendOnce, type Request } from '../rest/rest.protocol.ts';
import type { RestWrite } from '../rest/write.protocol.ts';
import { entityPath, headersFor, keyPredicate, propertyOf } from './odata.protocol.ts';

const MANIFEST_OP = { create: 'create', update_full: 'updateFull', update_partial: 'update', delete: 'delete', upsert: 'upsert' } as const;

const failure = (error: unknown): WriteResult['error'] => {
  if (error instanceof SourceError) return { meaning: error.meaning, code: error.code };
  if (isAppError(error)) return { meaning: error.category === 'bounds' ? 'bounds' : 'upstream', code: error.code };
  return { meaning: 'upstream', code: 'write.failed' };
};

export async function odataWrite(ctx: ReadContext, object: ManifestObject, writes: readonly RestWrite[]): Promise<WriteResult[]> {
  if (object.source.kind !== 'odata' || ctx.manifest.protocol.kind !== 'odata') {
    throw new AppError('integrity', 'an OData object has an OData source', { code: 'manifest.source_kind' });
  }
  const source = object.source;
  const version = ctx.manifest.protocol.version;
  const collection = entityPath(source, ctx.params);
  /** The values under the service's property names. */
  const asProperties = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([field, value]) => [propertyOf(object, field), value]));
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
      if (declared === undefined) {
        throw new AppError('validation', `the manifest declares no ${write.operation} operation on ${object.name}`, { code: 'write.operation_undeclared' });
      }
      if (write.operation === 'upsert' && version === '2.0') {
        throw new AppError('validation', 'OData 2.0 has no upsert', { code: 'odata.upsert_unsupported' });
      }
      const body = write.operation === 'delete' ? undefined : declared.body === undefined ? asProperties(write.values)
        : await compileExpression('write.body', 'jsonata', declared.body.jsonata).evaluate({ input: write.values, identifier: write.identifier ?? null, params: ctx.params }, ctx.now);
      if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
        throw new AppError('integrity', "an OData write's body is an object of properties", { code: 'odata.body_not_object' });
      }
      const headers = { ...headersFor(version), 'content-type': 'application/json' };
      let request: Request;
      if (write.operation === 'create') {
        request = { method: 'POST', path: collection, query: {}, headers, body };
      } else {
        if (write.identifier === undefined || write.identifier === null) throw new AppError('validation', 'the write names no record', { code: 'write.identifier_missing' });
        const at = `${collection}${keyPredicate(version, object, source, write.identifier)}`;
        if (write.operation === 'delete') request = { method: 'DELETE', path: at, query: {}, headers, body: undefined };
        else if (write.operation === 'update_full') request = { method: 'PUT', path: at, query: {}, headers, body };
        else if (version === '2.0') request = { method: 'POST', path: at, query: {}, headers: { ...headers, 'x-http-method': 'MERGE' }, body };
        else request = { method: 'PATCH', path: at, query: {}, headers, body };
      }
      const send = () => sendOnce(ctx, request);
      const response = write.operation === 'create' ? await send() : await withRetries(ctx, send);
      let identifier = write.identifier ?? null;
      if (write.operation === 'create' || write.operation === 'upsert') {
        if (declared.result !== undefined) {
          const found = await compileExpression('write.result', 'jsonata', declared.result.jsonata).evaluate({ input: response.body, headers: response.headers }, ctx.now);
          identifier = found === null || found === undefined ? identifier : String(found);
        } else if (response.body !== null && typeof response.body === 'object') {
          // The created entity, as the service returned it (version 2.0 wraps it in d).
          const entity = (version === '2.0' ? (response.body as { d?: unknown }).d : response.body) as Record<string, unknown> | undefined;
          const parts = object.identifier.map((name) => getPath(entity, propertyOf(object, name)));
          if (parts.every((p) => p !== undefined && p !== null)) {
            identifier = parts.length === 1 ? String(parts[0]) : JSON.stringify(Object.fromEntries(object.identifier.map((name, i) => [name, parts[i]])));
          }
        }
      }
      results.push({ key: write.key, outcome: 'applied', identifier, error: null });
    } catch (error) {
      results.push({ key: write.key, outcome: 'failed', identifier: write.identifier ?? null, error: failure(error) });
      if (error instanceof SourceError && error.meaning === 'auth') stopped = true;
    }
  }
  return results;
}
