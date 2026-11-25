// Explains a step against a connection: the split, and the native form the source receives.
// The REST form is the manifest's patches; the SQL form is the generated statement, without
// its values; the GraphQL and SOAP forms name the query or operation and the variables or
// parameters set, never their values.

import { filterOf, propertyOf } from '../connect-runtime/protocols/odata/odata.protocol.ts';
import type { PlanStep, PushdownSplit } from '../../contracts/connect/step.contract.ts';
import { manifestSchema, type RequestPatch } from '../../contracts/connect/manifest.contract.ts';
import { gateOf } from '../../contracts/conformance/conformance.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import type { ExecutorBounds } from '../../config/limits.config.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { conformanceRunRepo, connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { isDialect } from '../connect-runtime/protocols/sql/checks.protocol.ts';
import { buildQuery } from '../connect-runtime/protocols/graphql/query.protocol.ts';
import { selectStatement } from '../connect-runtime/protocols/sql/query.protocol.ts';
import { objectOf, restPatches, splitPushdown, withoutFailing } from './compile.service.ts';

export interface ExplainDeps {
  databases: Databases;
  services: ServiceClient;
  bounds: Pick<ExecutorBounds, 'maxRowsPerSourceStep'>;
}

export type NativeForm =
  | { protocol: 'rest'; patches: RequestPatch[] }
  | { protocol: 'sql'; dialect: string; statement: string; parameters: number }
  | { protocol: 'graphql'; query: string; variables: string[] }
  | { protocol: 'soap'; operation: string; parameters: string[] }
  | { protocol: 'odata'; entitySet: string; query: Record<string, string> };

export async function explainPushdown(deps: ExplainDeps, ctx: Pick<HandlerContext, 'request' | 'correlationId'>, input: { connectionId: string; step: PlanStep })
  : Promise<{ split: PushdownSplit; native: NativeForm }> {
  const { row, params, conformed } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const connection = await connectionRepo.findById(db, input.connectionId);
    if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    return {
      row: await connectorManifestRepo.findById(db, connection.manifestId), params: parametersOf(connection.parameters),
      conformed: await conformanceRunRepo.latestCompleted(db, connection.id, connection.manifestId),
    };
  }, { readOnly: true });
  if (!row) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
  const declared = manifestSchema.parse(row.document);
  const manifest = conformed === undefined ? declared : withoutFailing(declared, gateOf(conformed).failingOperators);
  const object = objectOf(manifest, input.step.object);
  const split = splitPushdown(manifest, object, input.step);
  if (manifest.protocol.kind === 'graphql' && object.source.kind === 'graphql') {
    const patches = await restPatches(object, split.native, params, new Date());
    const variables = [...new Set([...Object.keys(object.source.constants), ...patches.flatMap((p) => Object.keys(p.variables ?? {}))])].sort();
    return { split, native: { protocol: 'graphql', query: buildQuery(object.source, object.fields), variables } };
  }
  if (manifest.protocol.kind === 'soap' && object.source.kind === 'soap') {
    const patches = await restPatches(object, split.native, params, new Date());
    const parameters = [...new Set([...Object.keys(object.source.constants), ...patches.flatMap((p) => Object.keys(p.variables ?? {}))])].sort();
    return { split, native: { protocol: 'soap', operation: object.source.operation, parameters } };
  }
  if (manifest.protocol.kind === 'odata' && object.source.kind === 'odata') {
    // The query the engine writes, its values as typed literals.
    const query: Record<string, string> = {};
    const filter = filterOf(manifest.protocol.version, object, object.source, split.native.filters);
    if (filter !== undefined) query['$filter'] = filter;
    if (split.native.sort.length > 0) query['$orderby'] = split.native.sort.map((s) => `${propertyOf(object, s.field)} ${s.direction}`).join(',');
    if (split.native.limit !== null) query['$top'] = String(split.native.limit);
    return { split, native: { protocol: 'odata', entitySet: object.source.entitySet, query } };
  }
  if (manifest.protocol.kind === 'rest') {
    return { split, native: { protocol: 'rest', patches: await restPatches(object, split.native, params, new Date()) } };
  }
  if (manifest.protocol.kind !== 'sql') throw new AppError('integrity', 'no native form for this protocol', { code: 'manifest.protocol_unknown' });
  const dialect = manifest.protocol.dialect;
  if (!isDialect(dialect)) throw new AppError('integrity', 'the manifest names no grammar of the SQL engine', { code: 'manifest.dialect_unknown' });
  const statement = selectStatement(dialect, object, split.native, object.fields, split.native.limit ?? deps.bounds.maxRowsPerSourceStep + 1);
  return { split, native: { protocol: 'sql', dialect, statement: statement.text, parameters: statement.values.length } };
}
