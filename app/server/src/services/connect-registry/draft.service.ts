// A connection still being built follows its draft (spec 16.3, 16.4): the build routes
// write a new manifest version for each draft they probe, and the sandbox connection moves
// to it. Draft or probing connections only, within their own connector; the owner moves
// theirs, anyone else needs connection.manage at the owning scope (spec 14.9). The
// connection's parameters must still fit the version it moves to.

import type { ConnectionView } from '../../contracts/connect-registry/connection.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { recordConnectEvent } from './connectEvents.service.ts';
import { checkParameters } from './parameters.service.ts';
import { builderOf, connectionView, type RegistryDeps } from './registry.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

const MOVABLE = new Set(['draft', 'probing']);

export async function setDraftConnectionVersion(deps: RegistryDeps, ctx: Context, connectionId: string, input: {
  manifestId: string; version: number;
}): Promise<ConnectionView> {
  // A member, or the AI FDE principal that drafted this connection (51.4).
  const { organisationId, membershipId, servicePrincipalId } = await builderOf(deps, ctx);
  const control = deps.databases.pool('control');
  const { connection, manifest } = await inTransaction(control, ctx.request, async (db) => {
    const connection = await connectionRepo.findById(db, connectionId);
    if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    return { connection, manifest: await connectorManifestRepo.findById(db, input.manifestId) };
  }, { readOnly: true });

  if (servicePrincipalId !== undefined && connection.createdByServicePrincipalId !== servicePrincipalId) {
    throw new AppError('forbidden', 'an AI FDE principal moves only the connections it drafted', { code: 'connect.not_permitted', details: { permission: 'connector.build' } });
  }
  if (membershipId === undefined || connection.owningMembershipId !== membershipId) {
    const permission = servicePrincipalId !== undefined ? 'connector.build' : 'connection.manage';
    const decision = await deps.services.call(authorise, {
      body: { permission, scopeId: connection.owningScopeId, resource: { type: 'connection', id: connection.id } },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    if (decision.decision !== 'allow') {
      throw new AppError('forbidden', 'you do not hold connection.manage here', { code: 'connect.not_permitted', details: { permission: 'connection.manage' } });
    }
  }
  if (!MOVABLE.has(connection.status)) {
    throw new AppError('conflict', `a ${connection.status} connection changes version through a reviewed repair, not a build`, {
      code: 'connection.not_building', details: { status: connection.status },
    });
  }
  if (!manifest || manifest.connectorId !== connection.connectorId) {
    throw new AppError('conflict', 'the connector has no such version', { code: 'connector.no_version' });
  }
  if (manifest.id === connection.manifestId) return connectionView(connection);
  checkParameters(manifestSchema.parse(manifest.document), parametersOf(connection.parameters));

  return inTransaction(control, ctx.request, async (db) => {
    const row = await connectionRepo.updateAtVersion(db, connectionId, input.version, { manifestId: manifest.id });
    if (!row) throw new AppError('conflict', 'the connection changed since you read it; read it again', { code: 'connection.version_stale' });
    await recordConnectEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'connection_version_changed', membershipId, resourceType: 'connection',
      resourceId: connectionId, detail: { from_manifest_id: connection.manifestId, to_manifest_id: manifest.id, status: connection.status },
    });
    return connectionView(row);
  });
}
