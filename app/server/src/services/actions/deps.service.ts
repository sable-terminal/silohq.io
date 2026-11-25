// What the write-back services share: their dependencies, who is acting, decisions through
// the policy service, record values sealed and opened through the credential service, and
// the ontology and connection reads every stage needs.

import { openRecordValues, sealRecordValues, type ValueBinding } from '../../contracts/credential/recordValue.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import { getVersionManifest, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { authorise, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { AppError } from '../../utils/errors.util.ts';

import type { GrantSigner } from './grants.service.ts';

export interface WriteBackDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  /** The canary (43.9, 45.4): at `rows` or more a `sample` is written and verified first. Default 10,000 and 100. */
  canary?: { rows: number; sample: number } | undefined;
  /** Signs the execution grant a write through the Silo Agent runs on (spec 5.6, 10.4). */
  grants?: GrantSigner | undefined;
}

/** The canary of the spec: not a policy setting, and never removed (43.9). */
export const CANARY = { rows: 10_000, sample: 100 } as const;

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export const callOptions = (ctx: Context) => ({ request: ctx.request, correlationId: ctx.correlationId });

/** The acting member. Service principals propose through Crons (spec 43.11), which are not built yet. */
export function memberOf(ctx: Context, what: string): { organisationId: string; membershipId: string } {
  const organisationId = ctx.request.organisationId;
  const membershipId = ctx.request.membershipId;
  if (organisationId === undefined || membershipId === undefined) {
    throw new AppError('forbidden', `${what} is done by a member`, { code: 'action.member_required' });
  }
  return { organisationId, membershipId };
}

export async function permitted(deps: WriteBackDeps, ctx: Context, permission: string, scopeId?: string): Promise<boolean> {
  const decision = await deps.services.call(authorise, { body: { permission, ...(scopeId === undefined ? {} : { scopeId }) } }, callOptions(ctx));
  return decision.decision === 'allow';
}

export async function demand(deps: WriteBackDeps, ctx: Context, permission: string, scopeId: string | undefined, code: string): Promise<void> {
  if (!await permitted(deps, ctx, permission, scopeId)) {
    throw new AppError('forbidden', `you need ${permission} for this`, { code, details: { permission } });
  }
}

export interface Access {
  connections: Map<string, 'none' | 'read' | 'write'>;
  objectTypeVisible: (id: string) => boolean;
  propertyVisible: (identityId: string) => boolean;
  fieldEffect: (connectionId: string, path: string) => 'allow' | 'mask' | 'redact' | 'deny';
}

/** Steps 3 to 5 of spec 57.6 for what a mutation touches: connections, the type, its properties and fields. */
export async function accessOf(deps: WriteBackDeps, ctx: Context, input: {
  connections: string[]; objectTypes: string[]; properties: string[]; fields: { connectionId: string; path: string }[];
}): Promise<Access> {
  const out = await deps.services.call(resolveAccess, {
    body: { connections: input.connections, objectTypes: input.objectTypes, properties: input.properties, fields: input.fields },
  }, callOptions(ctx));
  if (out.decision === 'deny') {
    throw new AppError('forbidden', 'you may not act in this organisation now', { code: 'action.not_permitted', details: { reason: out.reason } });
  }
  const connections = new Map(out.connections.map((c) => [c.id, c.access]));
  const types = new Map(out.objectTypes.map((t) => [t.id, t.visible]));
  const properties = new Map(out.properties.map((p) => [p.id, p.visible && p.effect === 'allow']));
  const fields = new Map(out.fields.map((f) => [`${f.connectionId}\u0000${f.path}`, f.effect]));
  return {
    connections,
    objectTypeVisible: (id) => types.get(id) === true,
    propertyVisible: (id) => properties.get(id) === true,
    fieldEffect: (connectionId, path) => fields.get(`${connectionId}\u0000${path}`) ?? 'allow',
  };
}

/** Whether the actor is cleared for every one of these markings: clearance, or a purpose session of this request (58.5). */
export async function clearedFor(deps: WriteBackDeps, ctx: Context, markingIds: readonly string[]): Promise<boolean> {
  if (markingIds.length === 0) return true;
  const out = await deps.services.call(resolveAccess, { body: { markings: [...markingIds] } }, callOptions(ctx));
  return out.decision === 'allow' && markingIds.every((id) => out.markings.some((m) => m.id === id && m.satisfied));
}

// ----------------------------------------------------------------------------- record values

/** Seals record values for their rows (contracts/credential/recordValue.contract.ts). */
export async function sealValues(deps: WriteBackDeps, ctx: Context, items: readonly { binding: ValueBinding; value: unknown }[]): Promise<Buffer[]> {
  if (items.length === 0) return [];
  const out = await deps.services.call(sealRecordValues, {
    body: { items: items.map((i) => ({ binding: i.binding, value: canonicalJsonBytes({ v: i.value ?? null }).toString('base64') })) },
  }, callOptions(ctx));
  return out.items.map((b) => Buffer.from(b, 'base64'));
}

/** Opens record values sealed by sealValues. */
export async function openValues(deps: WriteBackDeps, ctx: Context, items: readonly { binding: ValueBinding; sealed: Buffer }[]): Promise<unknown[]> {
  if (items.length === 0) return [];
  const out = await deps.services.call(openRecordValues, {
    body: { items: items.map((i) => ({ binding: i.binding, sealed: i.sealed.toString('base64') })) },
  }, callOptions(ctx));
  return out.items.map((b) => (JSON.parse(Buffer.from(b, 'base64').toString('utf8')) as { v: unknown }).v);
}

// ----------------------------------------------------------------------------- reads

export async function ontologyAt(deps: WriteBackDeps, ctx: Context, versionId: string): Promise<OntologyManifest> {
  return deps.services.call(getVersionManifest, { params: { versionId } }, callOptions(ctx));
}

export interface ConnectionWithManifest {
  connection: Connection;
  manifest: Manifest;
  manifestId: string;
  connectorVersion: string;
}

/**
 * A connection and the manifest it runs, read from Connect's tables under the request's
 * row-level security (structure only, never a record), as the ontology service reads a
 * source schema. The runtime re-reads both when it writes.
 */
export async function connectionWithManifest(db: Queryable, connectionId: string): Promise<ConnectionWithManifest> {
  const connection = await connectionRepo.findById(db, connectionId);
  if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found', details: { connectionId } });
  const row = await connectorManifestRepo.findById(db, connection.manifestId);
  const parsed = manifestSchema.safeParse(row?.document);
  if (!row || !parsed.success) throw new AppError('integrity', 'the connection runs a manifest that does not read', { code: 'connection.manifest_unreadable' });
  return { connection, manifest: parsed.data, manifestId: row.id, connectorVersion: parsed.data.identity.version };
}

export async function readConnections(deps: WriteBackDeps, request: RequestContext, ids: readonly string[]): Promise<Map<string, ConnectionWithManifest>> {
  return inTransaction(deps.databases.pool('control'), request, async (db) => {
    const out = new Map<string, ConnectionWithManifest>();
    for (const id of new Set(ids)) out.set(id, await connectionWithManifest(db, id));
    return out;
  }, { readOnly: true });
}
