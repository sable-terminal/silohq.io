// connect-registry (catalogue): connectors, immutable manifest versions and connections.
//
// A manifest version is saved only when it passes, in order: the manifest schema, the
// expression evaluator (every expression compiled for its block, spec 14.2) and the
// protocol engine's own checks (strategies it runs, its grammar). Anything failing is
// refused with the paths at fault, never repaired. A saved version is canonicalised and
// hashed, becomes the connector's current version, and never changes once used.
//
// Decisions are the policy service's (spec 14.9): connector.build and connector.edit for
// connectors; connection.create at the owning scope; connection.manage for the owner or
// at the owning scope; connector.verify (authorising) to confirm and activate;
// connection.credential.rotate for new secrets after creation.
//
// Connection parameters are public data on the connection row, checked against the
// manifest (services/connect-registry/parameters.service.ts); probing needs every required
// one. Confirming needs a conformance run on the connection's version that passed the
// required classes (spec 17.1, 17.2).

import { planGates, requireBuilder, requireConnectionRoom, requireListed } from '../billing/planGates.service.ts';
import { createOutboundWebhookSecret } from '../../contracts/credential/outboundWebhookSecret.contract.ts';
import type { OutboundWebhookView } from '../../contracts/connect-registry/outboundWebhook.contract.ts';
import type { WebhookEndpoint } from '../../models/connect/webhookEndpoint.model.ts';
import { webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import { z } from 'zod';
import type { ConnectionView, CONNECTION_MOVES } from '../../contracts/connect-registry/connection.contract.ts';
import type { ConnectorSetupView, ConnectorView, ManifestVersionView } from '../../contracts/connect-registry/connector.contract.ts';
import { gateOf } from '../../contracts/conformance/conformance.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf, type ConnectionParameters } from '../../contracts/connect/parameters.contract.ts';
import { revokeConnectionCredentials, storeConnectionCredentials } from '../../contracts/credential/connectionCredential.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import type { Connector } from '../../models/connect/connector.model.ts';
import type { ConnectorManifest } from '../../models/connect/connectorManifest.model.ts';
import { conformanceRunRepo, connectionCredentialRepo, connectionRepo, connectorManifestRepo, connectorRepo } from '../../repos/connect/index.repo.ts';
import { membershipRepo, roleAssignmentRepo, servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, ContractViolation, fromDatabaseError, isAppError, type Issue } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { protocolIssues } from '../connect-runtime/protocols/checks.protocol.ts';
import { checkManifestExpressions } from '../expression-evaluator/evaluator.service.ts';
import { recordConnectEvent } from './connectEvents.service.ts';
import { checkParameters, missingParameters, parameterIssues } from './parameters.service.ts';

export interface RegistryDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

const actor = (ctx: Context) => {
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined) {
    throw new AppError('forbidden', 'connectors and connections are managed by a member', { code: 'connect.member_required' });
  }
  return { organisationId: ctx.request.organisationId!, membershipId };
};

/**
 * Who builds: a member, or an AI FDE's Integration principal drafting and probing a connector
 * (51.4), under the permissions policy gives it (its role's tools within its engaging
 * administrator's, now). What the principal creates is recorded as the principal's; the
 * connections it creates are owned by its owner, the engaging administrator, who gives their
 * credentials and answers for them.
 */
export interface Builder { organisationId: string; membershipId: string | undefined; servicePrincipalId: string | undefined; owner: string }

export async function builderOf(deps: RegistryDeps, ctx: Context): Promise<Builder> {
  const organisationId = ctx.request.organisationId!;
  if (ctx.request.membershipId !== undefined) {
    return { organisationId, membershipId: ctx.request.membershipId, servicePrincipalId: undefined, owner: ctx.request.membershipId };
  }
  const servicePrincipalId = ctx.request.servicePrincipalId;
  const principal = servicePrincipalId === undefined ? undefined
    : await inTransaction(deps.databases.pool('control'), ctx.request, (db) => servicePrincipalRepo.findById(db, servicePrincipalId), { readOnly: true });
  if (principal === undefined || principal.kind !== 'fde') {
    throw new AppError('forbidden', 'connectors and connections are managed by a member', { code: 'connect.member_required' });
  }
  return { organisationId, membershipId: undefined, servicePrincipalId, owner: principal.ownerMembershipId };
}

async function allowed(deps: RegistryDeps, ctx: Context, permission: string, scopeId?: string, connectionId?: string): Promise<boolean> {
  const decision = await deps.services.call(authorise, {
    body: {
      permission, ...(scopeId === undefined ? {} : { scopeId }),
      ...(connectionId === undefined ? {} : { resource: { type: 'connection' as const, id: connectionId } }),
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  return decision.decision === 'allow';
}

export async function demand(deps: RegistryDeps, ctx: Context, permission: string, scopeId?: string, connectionId?: string): Promise<void> {
  if (!await allowed(deps, ctx, permission, scopeId, connectionId)) {
    throw new AppError('forbidden', `you do not hold ${permission} here`, { code: 'connect.not_permitted', details: { permission } });
  }
}

// ----------------------------------------------------------------------------- views

const connectorView = (c: Connector, current: ConnectorManifest | undefined): ConnectorView => ({
  id: c.id, organisationId: c.organisationId, kind: c.kind, slug: c.slug, name: c.name, provider: c.provider,
  description: c.description, trustTier: c.trustTier, sourceRoute: c.sourceRoute, status: c.status, createdAt: c.createdAt,
  version: c.version, currentManifestId: current?.id ?? null,
});

export const manifestView = (m: ConnectorManifest): ManifestVersionView => ({
  id: m.id, connectorId: m.connectorId, version: m.version, schemaVersion: m.schemaVersion, documentHash: m.documentHash.toString('hex'),
  sourceRoute: m.sourceRoute, parentVersionId: m.parentVersionId, firstUsedAt: m.firstUsedAt, createdAt: m.createdAt,
  supersededAt: m.supersededAt,
});

export const connectionView = (c: Connection): ConnectionView => ({
  id: c.id, connectorId: c.connectorId, manifestId: c.manifestId, name: c.name, provider: c.provider, trustTier: c.trustTier,
  owningScopeId: c.owningScopeId, owningMembershipId: c.owningMembershipId, policyAuthority: c.policyAuthority, status: c.status,
  writesEnabled: c.writesEnabled, agentPoolId: c.agentPoolId, credentialCustody: c.credentialCustody, createdAt: c.createdAt, lastHealthyAt: c.lastHealthyAt,
  haltedReason: c.haltedReason, haltedAt: c.haltedAt, revokedAt: c.revokedAt, version: c.version,
  parameters: parametersOf(c.parameters),
});

// ----------------------------------------------------------------------------- connectors

export async function createConnector(deps: RegistryDeps, ctx: Context, input: {
  slug: string; name: string; provider: string; description?: string | undefined; sourceRoute: 'ai' | 'visual';
}): Promise<ConnectorView> {
  const { organisationId, membershipId, servicePrincipalId } = await builderOf(deps, ctx);
  await demand(deps, ctx, 'connector.build');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    // Both build routes are Enterprise capabilities (D76).
    requireBuilder(await planGates(db, organisationId), input.sourceRoute);
    let row: Connector;
    try {
      row = await connectorRepo.insert(db, {
        id: uuidv7(), organisationId, kind: 'private', slug: input.slug, name: input.name, provider: input.provider,
        description: input.description ?? null, trustTier: 'private', sourceRoute: input.sourceRoute, status: 'draft',
        authorOrganisationId: organisationId, createdByMembershipId: membershipId ?? null, createdByServicePrincipalId: servicePrincipalId ?? null,
      });
    } catch (error) {
      const mapped = fromDatabaseError(error);
      if (mapped.category === 'conflict') throw new AppError('conflict', 'a connector with that slug exists', { code: 'connector.slug_taken' });
      throw mapped;
    }
    await recordConnectEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'connector_created', membershipId, servicePrincipalId, resourceType: 'connector',
      resourceId: row.id, detail: { source_route: input.sourceRoute },
    });
    return connectorView(row, undefined);
  });
}

export async function getConnector(deps: RegistryDeps, ctx: Context, connectorId: string): Promise<ConnectorView> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = await connectorRepo.findById(db, connectorId);
    if (!row) throw new AppError('not_found', 'no such connector', { code: 'connector.not_found' });
    return connectorView(row, await connectorManifestRepo.current(db, connectorId));
  }, { readOnly: true });
}

export async function listConnectors(deps: RegistryDeps, ctx: Context, limit: number): Promise<ConnectorView[]> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const rows = await connectorRepo.listVisible(db, limit);
    return Promise.all(rows.map(async (row) => connectorView(row, await connectorManifestRepo.current(db, row.id))));
  }, { readOnly: true });
}

// ----------------------------------------------------------------------------- manifests

const zodIssues = (error: z.ZodError): Issue[] => error.issues.slice(0, 50).map((issue) => ({
  path: ['document', ...issue.path.map(String)].join('.'), code: issue.code, message: issue.message,
}));

/** The schema, the expressions and the protocol's own checks; the parsed manifest, or a refusal naming every path at fault. */
export function validateManifest(document: unknown): { manifest: Manifest; expressionIssues: Issue[] } {
  const parsed = manifestSchema.safeParse(document);
  if (!parsed.success) throw new ContractViolation('the manifest does not match the manifest schema', 'manifest.invalid', zodIssues(parsed.error));
  const expressionIssues = checkManifestExpressions(parsed.data).map((i) => ({
    path: `document.${i.path}`, code: i.code, message: `the ${i.block} expression is refused: ${i.reason}`,
  }));
  const patterns = parameterIssues(parsed.data);
  if (patterns.length > 0) throw new ContractViolation('a parameter pattern is refused', 'manifest.pattern_unsafe', patterns);
  return { manifest: parsed.data, expressionIssues };
}

export async function createManifestVersion(deps: RegistryDeps, ctx: Context, connectorId: string, input: {
  document: Record<string, unknown>; parentVersionId?: string | undefined;
}): Promise<ManifestVersionView> {
  const { organisationId, membershipId, servicePrincipalId } = await builderOf(deps, ctx);
  const control = deps.databases.pool('control');
  const connector = await inTransaction(control, ctx.request, (db) => connectorRepo.findById(db, connectorId), { readOnly: true });
  if (!connector) throw new AppError('not_found', 'no such connector', { code: 'connector.not_found' });
  if (connector.organisationId === null) {
    throw new AppError('forbidden', 'catalogue connectors change by catalogue release; fork a private copy to repair one', {
      code: 'connector.catalogue_immutable',
    });
  }
  const current = await inTransaction(control, ctx.request, (db) => connectorManifestRepo.current(db, connectorId), { readOnly: true });
  // Spec 16.6: connector.edit is held by the connector's author and by admins, so the author
  // versions their own connector (the build routes save a version per draft) under connector.build.
  const author = membershipId !== undefined ? connector.createdByMembershipId === membershipId : connector.createdByServicePrincipalId === servicePrincipalId;
  // An Integration principal versions only the connectors it drafted.
  if (servicePrincipalId !== undefined && !author) {
    throw new AppError('forbidden', 'an AI FDE principal versions only the connectors it drafted', { code: 'connect.not_permitted', details: { permission: 'connector.edit' } });
  }
  await demand(deps, ctx, current === undefined || author ? 'connector.build' : 'connector.edit');

  const { manifest, expressionIssues } = validateManifest(input.document);
  if (expressionIssues.length > 0) {
    // Spec 14.10: a rejected expression is an audit event, recorded though nothing is saved.
    await inTransaction(control, ctx.request, (db) => recordConnectEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'manifest_expression_rejected', membershipId, servicePrincipalId, resourceType: 'connector',
      resourceId: connectorId, detail: { expressions: expressionIssues.length, first_path: expressionIssues[0]!.path.slice(0, 200) },
    }));
    throw new ContractViolation('an expression in the manifest is refused', 'manifest.expression_invalid', expressionIssues);
  }
  const protocol = protocolIssues(manifest).map((i) => ({ ...i, path: `document.${i.path}` }));
  if (protocol.length > 0) throw new ContractViolation('the protocol engine refuses the manifest', 'manifest.protocol_invalid', protocol);

  const document = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const documentHash = sha256(canonicalJsonBytes(document));
  return inTransaction(control, ctx.request, async (db) => {
    if (await connectorManifestRepo.findByConnectorIdAndVersion(db, { connectorId, version: manifest.identity.version })) {
      throw new AppError('conflict', 'that version exists; versions never change', { code: 'manifest.version_exists' });
    }
    await connectorManifestRepo.supersedeCurrent(db, connectorId);
    const row = await connectorManifestRepo.insert(db, {
      id: uuidv7(), organisationId, connectorId, version: manifest.identity.version, document: document as never, documentHash,
      schemaVersion: manifest.schemaVersion, sourceRoute: connector.sourceRoute, parentVersionId: input.parentVersionId ?? current?.id ?? null,
      createdByMembershipId: membershipId ?? null, createdByServicePrincipalId: servicePrincipalId ?? null,
    });
    if (connector.status === 'draft') await connectorRepo.update(db, connectorId, { status: 'active' });
    await recordConnectEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'connector_manifest_versioned', membershipId, servicePrincipalId, resourceType: 'manifest',
      resourceId: row.id, detail: { connector_id: connectorId, version: row.version, protocol: manifest.protocol.kind },
    });
    return manifestView(row);
  });
}

export async function listManifestVersions(deps: RegistryDeps, ctx: Context, connectorId: string): Promise<ManifestVersionView[]> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (!await connectorRepo.findById(db, connectorId)) throw new AppError('not_found', 'no such connector', { code: 'connector.not_found' });
    return (await connectorManifestRepo.listForConnector(db, connectorId, 200)).map(manifestView);
  }, { readOnly: true });
}

export async function getManifestVersion(deps: RegistryDeps, ctx: Context, connectorId: string, versionId: string)
  : Promise<ManifestVersionView & { document: Record<string, never> }> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = await connectorManifestRepo.findById(db, versionId);
    if (!row || row.connectorId !== connectorId) throw new AppError('not_found', 'no such manifest version', { code: 'manifest.not_found' });
    return { ...manifestView(row), document: row.document as Record<string, never> };
  }, { readOnly: true });
}

/** A version's document, only of the organisation's own private connector (D262). */
export async function getOwnManifestDocument(deps: RegistryDeps, ctx: Context, connectorId: string, versionId: string)
  : Promise<ManifestVersionView & { document: Record<string, never> }> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const connector = await connectorRepo.findById(db, connectorId);
    if (!connector) throw new AppError('not_found', 'no such connector', { code: 'connector.not_found' });
    if (connector.kind !== 'private' || connector.organisationId !== ctx.request.organisationId) {
      throw new AppError('forbidden', 'only your organisation\'s own connectors are opened in the builder', { code: 'connector.not_own' });
    }
    const row = await connectorManifestRepo.findById(db, versionId);
    if (!row || row.connectorId !== connectorId) throw new AppError('not_found', 'no such manifest version', { code: 'manifest.not_found' });
    return { ...manifestView(row), document: row.document as Record<string, never> };
  }, { readOnly: true });
}

/** The version's setup form (W7): declared parameters, auth fields and objects; never a value, never the manifest. */
export async function getConnectorSetup(deps: RegistryDeps, ctx: Context, connectorId: string, manifestId: string | undefined): Promise<ConnectorSetupView> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const connector = await connectorRepo.findById(db, connectorId);
    if (!connector) throw new AppError('not_found', 'no such connector', { code: 'connector.not_found' });
    const row = manifestId === undefined ? await connectorManifestRepo.current(db, connectorId) : await connectorManifestRepo.findById(db, manifestId);
    if (!row || row.connectorId !== connectorId) throw new AppError('not_found', 'the connector has no such version', { code: 'connector.no_version' });
    const m = manifestSchema.parse(row.document);
    return {
      connectorId, manifestId: row.id, version: row.version, protocol: m.protocol.kind, viaAgent: m.transport.viaAgent,
      params: m.params.map((p) => ({ name: p.name, label: p.label, required: p.required, pattern: p.pattern ?? null })),
      auth: { strategy: m.auth.strategy, fields: m.auth.fields.map((f) => ({ name: f.name, kind: f.kind, label: f.label, role: f.role })) },
      objects: m.objects.map((o) => ({ name: o.name, label: o.label ?? null })),
    };
  }, { readOnly: true });
}

// ----------------------------------------------------------------------------- connections

export async function loadConnection(deps: RegistryDeps, ctx: Context, connectionId: string): Promise<Connection> {
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => connectionRepo.findById(db, connectionId), { readOnly: true });
  if (!row) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
  return row;
}

/** The owner manages their connection; anyone else needs the permission at its owning scope (spec 14.9). */
async function requireOwnerOr(deps: RegistryDeps, ctx: Context, connection: Connection, permission: string): Promise<void> {
  if (connection.owningMembershipId === ctx.request.membershipId) return;
  await demand(deps, ctx, permission, connection.owningScopeId, connection.id);
}

export async function createConnection(deps: RegistryDeps, ctx: Context, input: {
  connectorId: string; manifestId?: string | undefined; name: string; owningScopeId: string; agentPoolId?: string | undefined;
  parameters?: ConnectionParameters | undefined; credentialCustody?: 'cell' | 'agent' | undefined;
}): Promise<ConnectionView> {
  const { organisationId, membershipId, servicePrincipalId, owner } = await builderOf(deps, ctx);
  await demand(deps, ctx, 'connection.create', input.owningScopeId);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const connector = await connectorRepo.findById(db, input.connectorId);
    if (!connector) throw new AppError('not_found', 'no such connector', { code: 'connector.not_found' });
    if (connector.status === 'withdrawn' || connector.status === 'deprecated') {
      throw new AppError('conflict', `the connector is ${connector.status}; new connections are refused`, { code: 'connector.unavailable' });
    }
    // The plan's limit and listing (D76): counted under a lock, so the last place is taken once.
    const gates = await planGates(db, organisationId);
    if (gates.connectionsLimit !== null) {
      await connectionRepo.lockForLimit(db, organisationId);
      requireConnectionRoom(gates, await connectionRepo.countTowardLimit(db));
    }
    requireListed(gates, connector);
    const manifest = input.manifestId === undefined ? await connectorManifestRepo.current(db, connector.id)
      : await connectorManifestRepo.findById(db, input.manifestId);
    if (!manifest || manifest.connectorId !== connector.id) {
      throw new AppError('conflict', 'the connector has no such version', { code: 'connector.no_version' });
    }
    const document = manifestSchema.parse(manifest.document);
    if (document.transport.viaAgent && input.agentPoolId === undefined) {
      throw new AppError('validation', 'this connector runs through the Silo Agent: name an agent pool', { code: 'connection.agent_pool_required' });
    }
    // Only a login the agent uses can be kept on the agent's host (spec 10.7).
    const custody = document.transport.viaAgent ? input.credentialCustody ?? 'cell' : 'cell';
    if (!document.transport.viaAgent && input.credentialCustody === 'agent') {
      throw new AppError('validation', 'only a connection through the Silo Agent keeps its login on the agent\'s host', { code: 'connection.custody_not_agent' });
    }
    const parameters = checkParameters(document, input.parameters ?? {});
    let row: Connection;
    try {
      row = await connectionRepo.insert(db, {
        id: uuidv7(), organisationId, connectorId: connector.id, manifestId: manifest.id, name: input.name, provider: connector.provider,
        trustTier: connector.trustTier, owningScopeId: input.owningScopeId, owningMembershipId: owner,
        agentPoolId: document.transport.viaAgent ? input.agentPoolId! : null, credentialCustody: custody, createdBy: membershipId ?? null,
        createdByServicePrincipalId: servicePrincipalId ?? null, parameters,
      });
    } catch (error) {
      const mapped = isAppError(error) ? error : fromDatabaseError(error);
      if (mapped.details['sqlstate'] === '23503') throw new AppError('validation', 'the owning scope or agent pool does not exist', { code: 'connection.reference_invalid' });
      throw mapped;
    }
    await recordConnectEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'connection_created', membershipId, servicePrincipalId, resourceType: 'connection',
      resourceId: row.id, detail: { connector_id: connector.id, manifest_id: manifest.id, owning_scope_id: input.owningScopeId, credential_custody: custody },
    });
    return connectionView(row);
  });
}

export async function getConnection(deps: RegistryDeps, ctx: Context, connectionId: string): Promise<ConnectionView> {
  return connectionView(await loadConnection(deps, ctx, connectionId));
}

export async function listConnections(deps: RegistryDeps, ctx: Context, limit: number): Promise<ConnectionView[]> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => (await connectionRepo.list(db, limit)).map(connectionView),
    { readOnly: true });
}

const stale = () => new AppError('conflict', 'the connection changed since you read it; read it again', { code: 'connection.version_stale' });

export async function renameConnection(deps: RegistryDeps, ctx: Context, connectionId: string, input: { name: string; version: number })
  : Promise<ConnectionView> {
  const { organisationId, membershipId } = actor(ctx);
  const connection = await loadConnection(deps, ctx, connectionId);
  await requireOwnerOr(deps, ctx, connection, 'connection.manage');
  if (connection.name === input.name) return connectionView(connection);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = await connectionRepo.updateAtVersion(db, connectionId, input.version, { name: input.name });
    if (!row) throw stale();
    await recordConnectEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'connection_renamed', membershipId, resourceType: 'connection', resourceId: row.id,
    });
    return connectionView(row);
  });
}

/** The connection's manifest, parsed. */
async function manifestOf(deps: RegistryDeps, ctx: Context, connection: Connection): Promise<Manifest> {
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => connectorManifestRepo.findById(db, connection.manifestId),
    { readOnly: true });
  if (!row) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
  return manifestSchema.parse(row.document);
}

const sameParameters = (a: ConnectionParameters, b: ConnectionParameters): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/**
 * Replaces the parameter set, at the version read. A change moves where data comes from, so
 * it is the owner's or needs connection.manage at the owning scope, and is audited by name,
 * never by value.
 */
export async function setConnectionParameters(deps: RegistryDeps, ctx: Context, connectionId: string, input: {
  parameters: ConnectionParameters; version: number;
}): Promise<ConnectionView> {
  const { organisationId, membershipId } = actor(ctx);
  const connection = await loadConnection(deps, ctx, connectionId);
  await requireOwnerOr(deps, ctx, connection, 'connection.manage');
  if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection takes no changes', { code: 'connection.revoked' });
  const parameters = checkParameters(await manifestOf(deps, ctx, connection), input.parameters);
  const before = parametersOf(connection.parameters);
  if (sameParameters(before, parameters)) return connectionView(connection);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = await connectionRepo.updateAtVersion(db, connectionId, input.version, { parameters });
    if (!row) throw stale();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(parameters)])].filter((k) => before[k] !== parameters[k]).sort();
    await recordConnectEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'connection_parameters_changed', membershipId, resourceType: 'connection',
      resourceId: connectionId, detail: { changed: changed.length, names: changed.join(',').slice(0, 200) },
    });
    return connectionView(row);
  });
}

type Move = (typeof CONNECTION_MOVES)[number];

const MOVES: Readonly<Record<Move, {
  from: readonly Connection['status'][]; to: Connection['status']; permission: string; ownerMay: boolean;
  event: 'connection_probing' | 'connection_verified' | 'connection_activated' | 'connection_halted' | 'connection_resumed' | 'connection_revoked';
}>> = {
  probe: { from: ['draft'], to: 'probing', permission: 'connection.manage', ownerMay: true, event: 'connection_probing' },
  confirm: { from: ['probing'], to: 'verified', permission: 'connector.verify', ownerMay: false, event: 'connection_verified' },
  activate: { from: ['verified'], to: 'active', permission: 'connector.verify', ownerMay: false, event: 'connection_activated' },
  halt: { from: ['active'], to: 'halted', permission: 'connection.manage', ownerMay: true, event: 'connection_halted' },
  resume: { from: ['halted'], to: 'active', permission: 'connection.manage', ownerMay: true, event: 'connection_resumed' },
  revoke: { from: ['draft', 'probing', 'verified', 'active', 'halted'], to: 'revoked', permission: 'connection.manage', ownerMay: true, event: 'connection_revoked' },
};

/**
 * Sets a connection's policy authority (14.7, 44.4), a super admin's decision taken
 * organisation-wide. policy_authority_changed records each change, from and to;
 * policy_authority_delegated names the admin given it, policy_authority_revoked the one it was
 * taken from (policies they wrote stand).
 */
export async function setPolicyAuthority(deps: RegistryDeps, ctx: Context, connectionId: string, input: {
  mode: 'owner_set' | 'delegated' | 'locked'; delegateMembershipId?: string | undefined; version: number;
}): Promise<ConnectionView> {
  const { organisationId, membershipId } = actor(ctx);
  const decision = await deps.services.call(authorise, { body: { permission: 'connection.policy_authority', organisationWide: true } },
    { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', 'a connection\'s policy authority is a super admin\'s to set', { code: 'connect.not_permitted', details: { permission: 'connection.policy_authority' } });
  }
  if ((input.mode === 'delegated') !== (input.delegateMembershipId !== undefined)) {
    throw new AppError('validation', 'a delegation names one admin, and only a delegation does', { code: 'connection.delegate_required' });
  }
  const connection = await loadConnection(deps, ctx, connectionId);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (input.delegateMembershipId !== undefined) {
      const delegate = await membershipRepo.findById(db, input.delegateMembershipId);
      if (delegate === undefined || delegate.status !== 'active') throw new AppError('validation', 'the delegate is not an active member', { code: 'connection.delegate_unknown' });
    }
    const updated = await connectionRepo.updateAtVersion(db, connectionId, input.version, {
      policyAuthority: input.mode, policyAuthorityGrantedTo: input.delegateMembershipId ?? null, policyAuthoritySetBy: membershipId,
      policyAuthoritySetAt: new Date().toISOString(),
    });
    if (!updated) throw stale();
    const record = (event: 'policy_authority_changed' | 'policy_authority_delegated' | 'policy_authority_revoked', detail: Record<string, string>) =>
      recordConnectEvent(db, { organisationId, correlationId: ctx.correlationId, event, membershipId, resourceType: 'connection', resourceId: connectionId, detail });
    await record('policy_authority_changed', { from: connection.policyAuthority, to: input.mode });
    const before = connection.policyAuthorityGrantedTo;
    if (before !== null && before !== input.delegateMembershipId) await record('policy_authority_revoked', { delegate_membership_id: before });
    if (input.delegateMembershipId !== undefined && before !== input.delegateMembershipId) {
      await record('policy_authority_delegated', { delegate_membership_id: input.delegateMembershipId });
    }
    return connectionView(updated);
  });
}

export async function changeConnectionStatus(deps: RegistryDeps, ctx: Context, connectionId: string, input: {
  move: Move; version: number; reason?: string | undefined;
}): Promise<ConnectionView> {
  const rule = MOVES[input.move];
  // An AI FDE's Integration principal probes a draft it built (51.4), under connector.build; every other move is a member's.
  const { organisationId, membershipId, servicePrincipalId } = input.move === 'probe' ? await builderOf(deps, ctx) : { ...actor(ctx), servicePrincipalId: undefined };
  const connection = await loadConnection(deps, ctx, connectionId);
  if (servicePrincipalId !== undefined) {
    if (connection.createdByServicePrincipalId !== servicePrincipalId) {
      throw new AppError('forbidden', 'an AI FDE principal probes only the connections it drafted', { code: 'connect.not_permitted', details: { permission: rule.permission } });
    }
    await demand(deps, ctx, 'connector.build', connection.owningScopeId, connection.id);
  } else if (rule.ownerMay) await requireOwnerOr(deps, ctx, connection, rule.permission);
  else await demand(deps, ctx, rule.permission, connection.owningScopeId, connection.id);

  let row: Connection;
  if (input.move === 'revoke' && connection.status === 'revoked') {
    row = connection; // Revoking again only makes sure the credentials are gone (below).
  } else {
    if (!rule.from.includes(connection.status)) {
      throw new AppError('conflict', `a ${connection.status} connection cannot ${input.move}`, {
        code: 'connection.status_move', details: { from: connection.status, move: input.move },
      });
    }
    if (input.move === 'halt' && input.reason === undefined) {
      throw new AppError('validation', 'a halt says why', { code: 'connection.halt_reason_required' });
    }
    // An email connection reads nothing (spec 14.4): its notifications are checked rule by rule as
    // they arrive, so the suite's read, pagination and error classes do not apply to it.
    if (input.move === 'confirm' && (await manifestOf(deps, ctx, connection)).protocol.kind !== 'email') {
      // Spec 17.1, 17.2: confirmation follows a conformance run on this version that passed
      // the read, pagination and error classes.
      const run = await inTransaction(deps.databases.pool('control'), ctx.request,
        (db) => conformanceRunRepo.latestCompleted(db, connection.id, connection.manifestId), { readOnly: true });
      const gate = run === undefined ? undefined : gateOf(run);
      if (gate === undefined || !gate.verified) {
        throw new AppError('conflict', 'run the conformance suite and pass its read, pagination and error classes first', {
          code: 'connection.conformance_required',
          details: { ...(run === undefined ? { run: 'none' } : { runId: run.id, failedClasses: gate!.failedClasses.join(',') }) },
        });
      }
    }
    if (input.move === 'probe') {
      const missing = missingParameters(await manifestOf(deps, ctx, connection), parametersOf(connection.parameters));
      if (missing.length > 0) {
        throw new AppError('validation', 'set every required parameter before probing', {
          code: 'connection.parameter_missing', details: { parameter: missing[0]!, missing: missing.length },
        });
      }
    }
    const now = new Date().toISOString();
    row = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
      // Spec 14.7: revoking a connection revokes its credentials in the same transaction.
      // The trigger connect.connections_revoke_credentials does it, since only the credential
      // service writes that table; the count is taken first for the audit event.
      const live = input.move === 'revoke' ? await connectionCredentialRepo.countLive(db, connectionId) : 0;
      const updated = await connectionRepo.updateAtVersion(db, connectionId, input.version, {
        status: rule.to,
        ...(input.move === 'halt' ? { haltedReason: input.reason!, haltedAt: now } : {}),
        ...(input.move === 'resume' ? { haltedReason: null, haltedAt: null } : {}),
        ...(input.move === 'revoke' ? { revokedAt: now, writesEnabled: false } : {}),
        ...(input.move === 'activate' ? { lastHealthyAt: now } : {}),
      });
      if (!updated) throw stale();
      await recordConnectEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: rule.event, membershipId, servicePrincipalId, resourceType: 'connection', resourceId: connectionId,
        detail: { from: connection.status, to: rule.to },
      });
      if (live > 0) {
        await recordConnectEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'credential_revoked', membershipId, resourceType: 'connection',
          resourceId: connectionId, detail: { credentials: live },
        });
      }
      return updated;
    });
  }
  if (input.move === 'revoke' && row === connection) {
    // Revoking again: make sure nothing live is left, through the credential service.
    await deps.services.call(revokeConnectionCredentials, { body: { connectionId } }, { request: ctx.request, correlationId: ctx.correlationId });
  }
  return connectionView(row);
}

export async function setConnectionSecrets(deps: RegistryDeps, ctx: Context, connectionId: string, values: Record<string, string>) {
  const connection = await loadConnection(deps, ctx, connectionId);
  if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection takes no new secrets', { code: 'connection.revoked' });
  // The person creating a connection supplies its first secrets; after that, a new secret is a rotation.
  if (!(connection.status === 'draft' && connection.createdBy === ctx.request.membershipId)) {
    await requireOwnerOr(deps, ctx, connection, 'connection.credential.rotate');
  }
  return deps.services.call(storeConnectionCredentials, { body: { connectionId, values } },
    { request: ctx.request, correlationId: ctx.correlationId });
}

/** The connector a version belongs to, for replaying a keyed version creation. */
export async function getManifestConnector(deps: RegistryDeps, ctx: Context, versionId: string): Promise<string> {
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => connectorManifestRepo.findById(db, versionId), { readOnly: true });
  if (!row) throw new AppError('not_found', 'no such manifest version', { code: 'manifest.not_found' });
  return row.connectorId;
}

// ----------------------------------------------------------------------------- outbound webhook targets (spec 20.4)

/** A target as its manager sees it: never its secret. */
const outboundView = (e: WebhookEndpoint, viaAgent: boolean): OutboundWebhookView => ({
  id: e.id, connectionId: e.connectionId, targetUrl: e.targetUrl!, statusUrl: e.statusUrl, sentFrom: viaAgent ? 'agent' : 'cell',
  riskClass: e.riskClass as OutboundWebhookView['riskClass'], actionName: e.actionName, status: e.status, lastDeliveryAt: e.lastDeliveryAt, createdAt: e.createdAt, revokedAt: e.revokedAt,
});

/** webhook.outbound.manage at the connection's owning scope: a target and its signing secret, shown once. */
/**
 * A physical connection is enabled only once someone holds actuation.approve through the
 * organisation's physical-operations role (47.8; decision 2026-11-18), so the two-person
 * physical approval (47.2) can always be met.
 */
export async function demandPhysicalOperations(databases: RegistryDeps['databases'], ctx: Pick<Context, 'request'>): Promise<void> {
  const holders = await inTransaction(databases.pool('control'), ctx.request, (db) => roleAssignmentRepo.holdersOf(db, 'actuation.approve', 1), { readOnly: true });
  if (holders.length === 0) {
    throw new AppError('conflict', 'nobody holds actuation.approve yet: assign the Physical operations role before enabling a physical connection', {
      code: 'connection.physical_operations_unstaffed', details: { role: 'Physical operations' },
    });
  }
}

export async function registerOutboundWebhook(deps: RegistryDeps, ctx: Context, connectionId: string,
  input: { targetUrl: string; statusUrl?: string | undefined; riskClass: 'external' | 'physical'; actionName?: string | undefined }) {
  const connection = await loadConnection(deps, ctx, connectionId);
  await demand(deps, ctx, 'webhook.outbound.manage', connection.owningScopeId, connection.id);
  if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection takes no webhook target', { code: 'connection.revoked' });
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined) throw new AppError('forbidden', 'a person registers a webhook target', { code: 'webhook.member_required' });
  if (input.riskClass === 'physical') await demandPhysicalOperations(deps.databases, ctx);
  const taken = () => new AppError('conflict', 'another live target of the connection has that action name', { code: 'webhook.action_taken' });
  if (input.actionName !== undefined && await inTransaction(deps.databases.pool('control'), ctx.request,
    (db) => webhookEndpointRepo.liveAction(db, connectionId, input.actionName!), { readOnly: true }) !== undefined) throw taken();
  const secret = await deps.services.call(createOutboundWebhookSecret, { body: { connectionId } }, { request: ctx.request, correlationId: ctx.correlationId });
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const inserted = await webhookEndpointRepo.insert(db, {
      id: uuidv7(), organisationId: connection.organisationId, connectionId, direction: 'outbound', targetUrl: input.targetUrl, riskClass: input.riskClass,
      actionName: input.actionName ?? null, statusUrl: input.statusUrl ?? null, secretCredentialId: secret.credentialId, createdBy: membershipId,
    }).catch((error: unknown) => {
      const mapped = fromDatabaseError(error);
      if (mapped.details['constraint'] === 'webhook_endpoints_action') throw taken();
      throw mapped;
    });
    // A physical target declares the connection's webhooks physical (47.7): its allow-list is kept from now on.
    if (input.riskClass === 'physical' && !connection.physicalWebhook) await connectionRepo.update(db, connectionId, { physicalWebhook: true });
    await recordConnectEvent(db, {
      organisationId: connection.organisationId, correlationId: ctx.correlationId, event: 'outbound_webhook_registered', membershipId,
      resourceType: 'connection', resourceId: connection.id,
      detail: { endpoint_id: inserted.id, risk_class: input.riskClass, status_endpoint: input.statusUrl !== undefined, sent_from: connection.agentPoolId === null ? 'cell' : 'agent' },
    });
    return inserted;
  });
  return { endpoint: outboundView(row, connection.agentPoolId !== null), secret: secret.secret };
}

export async function listOutboundWebhooks(deps: RegistryDeps, ctx: Context, connectionId: string): Promise<OutboundWebhookView[]> {
  const connection = await loadConnection(deps, ctx, connectionId);
  await demand(deps, ctx, 'webhook.outbound.manage', connection.owningScopeId, connection.id);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => (await webhookEndpointRepo.listOutbound(db, connectionId))
    .map((e) => outboundView(e, connection.agentPoolId !== null)), { readOnly: true });
}

/** Revoked, never deleted: notify fails its pending deliveries and sends it nothing more. */
export async function revokeOutboundWebhook(deps: RegistryDeps, ctx: Context, endpointId: string): Promise<OutboundWebhookView> {
  const found = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => webhookEndpointRepo.findById(db, endpointId), { readOnly: true });
  if (!found || found.direction !== 'outbound') throw new AppError('not_found', 'no such webhook target', { code: 'webhook.not_found' });
  const connection = await loadConnection(deps, ctx, found.connectionId);
  await demand(deps, ctx, 'webhook.outbound.manage', connection.owningScopeId, connection.id);
  if (found.status === 'revoked') return outboundView(found, connection.agentPoolId !== null);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = (await webhookEndpointRepo.update(db, endpointId, { status: 'revoked', revokedAt: new Date().toISOString() }))!;
    await recordConnectEvent(db, {
      organisationId: connection.organisationId, correlationId: ctx.correlationId, event: 'outbound_webhook_revoked', membershipId: ctx.request.membershipId ?? null,
      resourceType: 'connection', resourceId: connection.id, detail: { endpoint_id: endpointId },
    });
    return outboundView(row, connection.agentPoolId !== null);
  });
}
