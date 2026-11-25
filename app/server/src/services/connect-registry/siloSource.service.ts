// A Silo as a source (spec 66.5): the connector, manifest version and connection an Import
// Silo answers through. Called by siloes-import when a person publishes the Silo's
// definition, under that person's request; see contracts/connect-registry/siloSource.contract.ts.

import { inTransaction } from '../../infra/postgres.infra.ts';
import { connectionRepo, connectorManifestRepo, connectorRepo } from '../../repos/connect/index.repo.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { scopeRepo } from '../../repos/iam/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { protocolIssues } from '../connect-runtime/protocols/checks.protocol.ts';
import { recordConnectEvent } from './connectEvents.service.ts';
import { validateManifest, type RegistryDeps } from './registry.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

/** The connector's slug: one per Silo, never a catalogue name. */
export const siloConnectorSlug = (siloId: string): string => `silo-${siloId}`;

export async function registerSiloSource(deps: RegistryDeps, ctx: Context, siloId: string, input: {
  name: string; document: Record<string, unknown>; markingIds: string[];
}): Promise<{ connectorId: string; connectionId: string; manifestId: string; version: string; changed: boolean }> {
  const organisationId = ctx.request.organisationId!;
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined) throw new AppError('forbidden', 'a Silo source is registered for the person who published it', { code: 'connect.member_required' });
  const { manifest, expressionIssues } = validateManifest(input.document);
  const store = manifest.transport.store;
  if (store?.kind !== 'silo' || store.siloId !== siloId) {
    throw new AppError('validation', 'a Silo source\'s manifest names that Silo as its store', { code: 'manifest.silo_store_mismatch' });
  }
  if (expressionIssues.length > 0 || protocolIssues(manifest).length > 0) {
    throw new AppError('integrity', 'the generated Silo manifest does not validate', { code: 'manifest.silo_invalid' });
  }
  const document = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const documentHash = sha256(canonicalJsonBytes(document));

  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    let connector = await connectorRepo.findPrivateBySlug(db, siloConnectorSlug(siloId));
    if (connector === undefined) {
      connector = await connectorRepo.insert(db, {
        id: uuidv7(), organisationId, kind: 'private', slug: siloConnectorSlug(siloId), name: input.name, provider: 'Silo', trustTier: 'private',
        sourceRoute: 'silo', status: 'active', authorOrganisationId: organisationId, createdByMembershipId: membershipId,
      });
      await recordConnectEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'connector_created', membershipId, resourceType: 'connector', resourceId: connector.id,
        detail: { source_route: 'silo', silo_id: siloId },
      });
    }
    const current = await connectorManifestRepo.current(db, connector.id);
    let version = current;
    if (current?.documentHash !== documentHash) {
      const count = (await connectorManifestRepo.listForConnector(db, connector.id, 1000)).length;
      await connectorManifestRepo.supersedeCurrent(db, connector.id);
      version = await connectorManifestRepo.insert(db, {
        id: uuidv7(), organisationId, connectorId: connector.id, version: `1.0.${count}`, document: { ...document, identity: {
          ...(document['identity'] as Record<string, unknown>), version: `1.0.${count}` } } as never,
        documentHash, schemaVersion: manifest.schemaVersion, sourceRoute: 'silo', parentVersionId: current?.id ?? null, createdByMembershipId: membershipId,
      });
      await recordConnectEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'connector_manifest_versioned', membershipId, resourceType: 'manifest', resourceId: version.id,
        detail: { connector_id: connector.id, version: version.version, protocol: manifest.protocol.kind },
      });
    }
    let connection = await connectionRepo.firstForConnector(db, connector.id);
    if (connection === undefined) {
      const root = await scopeRepo.root(db);
      if (root === undefined) throw new AppError('integrity', 'the organisation has no root scope', { code: 'connect.root_scope_missing' });
      connection = await connectionRepo.insert(db, {
        id: uuidv7(), organisationId, connectorId: connector.id, manifestId: version!.id, name: input.name, provider: 'silo', trustTier: 'private',
        owningScopeId: root.id, owningMembershipId: membershipId, status: 'active', createdBy: membershipId,
      });
      await recordConnectEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'connection_created', membershipId, resourceType: 'connection', resourceId: connection.id,
        detail: { connector_id: connector.id, manifest_id: version!.id, owning_scope_id: root.id, silo_id: siloId },
      });
    } else if (connection.manifestId !== version!.id) {
      connection = (await connectionRepo.update(db, connection.id, { manifestId: version!.id, version: connection.version + 1 }))!;
    }
    // A copy carries its source's markings (58.4): the Silo's markings are its connection's.
    const held = new Set((await resourceMarkingRepo.markingsFor(db, 'connection', [connection.id])).map((m) => m.markingId));
    for (const markingId of input.markingIds.filter((m) => !held.has(m))) {
      await resourceMarkingRepo.insert(db, {
        id: uuidv7(), organisationId, connectionId: connection.id, propertyMappingId: null, propertyId: null, linkTypeId: null, actionTypeId: null,
        siloId: null, viewId: null, appId: null, functionId: null, interfaceId: null, markingId, appliedBy: membershipId,
      });
    }
    return { connectorId: connector.id, connectionId: connection.id, manifestId: version!.id, version: version!.version, changed: current?.id !== version!.id };
  });
}

/** A whole-Silo wipe: halted while it runs, so nothing reads what is being removed; revoked when the Silo is disabled. */
export async function retireSiloSource(deps: RegistryDeps, ctx: Context, siloId: string, move: 'halt' | 'revoke')
  : Promise<{ connectionId: string | null; status: string | null }> {
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const connector = await connectorRepo.findPrivateBySlug(db, siloConnectorSlug(siloId));
    const connection = connector === undefined ? undefined : await connectionRepo.firstForConnector(db, connector.id);
    if (connection === undefined) return { connectionId: null, status: null };
    if (connection.status === 'revoked' || (move === 'halt' && connection.status === 'halted')) return { connectionId: connection.id, status: connection.status };
    const at = new Date().toISOString();
    const updated = (await connectionRepo.update(db, connection.id, move === 'halt'
      ? { status: 'halted', haltedAt: at, haltedReason: 'silo_purging', version: connection.version + 1 }
      : { status: 'revoked', revokedAt: at, writesEnabled: false, version: connection.version + 1 }))!;
    await recordConnectEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: move === 'halt' ? 'connection_halted' : 'connection_revoked',
      membershipId: ctx.request.membershipId, resourceType: 'connection', resourceId: connection.id, detail: { reason: 'silo_purge', silo_id: siloId },
    });
    return { connectionId: updated.id, status: updated.status };
  });
}
