// The SOAP engine's writes (spec 14.4, 42.5, 45.2, 45.3): each operation calls the SOAP
// operation its manifest declares, with the parameters built by the manifest's JSONata from
// the values and identifier (or the values themselves); only declared parameters are sent,
// each as escaped element text in the declared order. Sent through the credential service
// (which places WS-Security's UsernameToken where the manifest names it). A Fault is a
// failure, classified by its code like any other.
//
// As for REST: not atomic, each operation reporting its own outcome; an update, upsert or
// delete is retried under the manifest's attempts, a create never blindly; an auth failure
// stops the plan. A create reads the written record's identifier from the response Body by
// the manifest's result expression.

import type { WriteResult } from '../../../../contracts/connect-runtime/write.contract.ts';
import type { ManifestObject } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError, isAppError } from '../../../../utils/errors.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import { SourceError, withRetries, type ReadContext } from '../../engine.service.ts';
import { expandPath } from '../graphql/graphql.protocol.ts';
import type { RestWrite } from '../rest/write.protocol.ts';
import { buildEnvelope } from './envelope.protocol.ts';
import { sendOnce } from './soap.protocol.ts';

const MANIFEST_OP = { create: 'create', update_full: 'updateFull', update_partial: 'update', delete: 'delete', upsert: 'upsert' } as const;

const failure = (error: unknown): WriteResult['error'] => {
  if (error instanceof SourceError) return { meaning: error.meaning, code: error.code };
  if (isAppError(error)) return { meaning: error.category === 'bounds' ? 'bounds' : 'upstream', code: error.code };
  return { meaning: 'upstream', code: 'write.failed' };
};

export async function soapWrite(ctx: ReadContext, object: ManifestObject, writes: readonly RestWrite[]): Promise<WriteResult[]> {
  if (object.source.kind !== 'soap' || ctx.manifest.protocol.kind !== 'soap') {
    throw new AppError('integrity', 'a SOAP object has a SOAP source', { code: 'manifest.source_kind' });
  }
  const version = ctx.manifest.protocol.version;
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
      const operation = declared?.soap;
      if (declared === undefined || operation === undefined) {
        throw new AppError('validation', `the manifest declares no ${write.operation} operation on ${object.name}`, { code: 'write.operation_undeclared' });
      }
      const built = declared.body === undefined ? { ...write.values }
        : await compileExpression('write.body', 'jsonata', declared.body.jsonata)
          .evaluate({ input: write.values, identifier: write.identifier ?? null, params: ctx.params }, ctx.now);
      if (built === null || typeof built !== 'object' || Array.isArray(built)) {
        throw new AppError('integrity', 'a SOAP write\'s body gives its parameters as an object', { code: 'soap.parameters_not_object' });
      }
      const allowed = new Set(operation.parameters.map((p) => p.name));
      const unknown = Object.keys(built).find((name) => !allowed.has(name));
      if (unknown !== undefined) {
        throw new AppError('integrity', 'a write sets a parameter the operation does not declare', { code: 'soap.parameter_undeclared', details: { parameter: unknown } });
      }
      const envelope = buildEnvelope(version, operation, built as Record<string, unknown>);
      const send = () => sendOnce(ctx, version, operation, path, envelope);
      const response = write.operation === 'create' ? await send() : await withRetries(ctx, send);
      let identifier = write.identifier ?? null;
      if ((write.operation === 'create' || write.operation === 'upsert') && declared.result !== undefined) {
        const found = await compileExpression('write.result', 'jsonata', declared.result.jsonata).evaluate({ input: response.body, headers: response.headers }, ctx.now);
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
