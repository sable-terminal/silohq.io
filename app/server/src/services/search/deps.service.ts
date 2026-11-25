// What the search service runs on, and what its parts share: who is searching, the ontology
// manifest of the active version (cached by version id, since a version never changes), the
// person's vocabulary from policy, and the audit event of an Explorer search.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { getActiveVersion, getVersionManifest, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface SearchDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  manifests: ManifestCache;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller'>;

/** Manifests by version id, newest kept: a version is immutable, so a cached one is never stale. */
export class ManifestCache {
  private readonly entries = new Map<string, OntologyManifest>();
  private readonly max: number;

  constructor(max = 16) {
    this.max = max;
  }

  get(versionId: string): OntologyManifest | undefined {
    const found = this.entries.get(versionId);
    if (found !== undefined) {
      this.entries.delete(versionId);
      this.entries.set(versionId, found);
    }
    return found;
  }

  set(manifest: OntologyManifest): void {
    this.entries.set(manifest.version.id, manifest);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

export function actor(ctx: Context): { organisationId: string; membershipId?: string; servicePrincipalId?: string } {
  const { organisationId, membershipId, servicePrincipalId } = ctx.request;
  if (membershipId === undefined && servicePrincipalId === undefined) {
    throw new AppError('forbidden', 'search is for a member or a service principal', { code: 'search.actor_required' });
  }
  return { organisationId: organisationId!, ...(membershipId ? { membershipId } : {}), ...(servicePrincipalId ? { servicePrincipalId } : {}) };
}

/** Searching the ontology needs ontology.view, as reading it does. */
export async function demandView(deps: SearchDeps, ctx: Context): Promise<void> {
  const decision = await deps.services.call(authorise, { body: { permission: 'ontology.view' } },
    { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', 'you do not hold ontology.view', { code: 'search.not_permitted', details: { permission: 'ontology.view' } });
  }
}

/** The active version's manifest. */
export async function activeManifest(deps: SearchDeps, ctx: Context): Promise<OntologyManifest> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const head = await deps.services.call(getActiveVersion, { query: {} }, options);
  const cached = deps.manifests.get(head.id);
  if (cached !== undefined) return cached;
  const manifest = await deps.services.call(getVersionManifest, { params: { versionId: head.id } }, options);
  deps.manifests.set(manifest);
  return manifest;
}

/** The ontology.properties row of each property identity in each object type version: what markings and field policies name. */
/** explorer_search_run (spec 34.6): counts only, never the text. */
export async function recordExplorerSearch(deps: SearchDeps, ctx: Context, detail: Record<string, string | number>): Promise<void> {
  const a = actor(ctx);
  const who: AuditActor = a.membershipId !== undefined ? { kind: 'membership', membershipId: a.membershipId }
    : { kind: 'service_principal', servicePrincipalId: a.servicePrincipalId! };
  const payload = auditEventMessage.schema.parse({
    event: 'explorer_search_run', actor: who, subjectMembershipId: null, scopeId: null, resource: null, purposeSessionId: null,
    operatorAccessSessionId: null, ipHash: null, detail,
  });
  await inTransaction(deps.databases.pool('control'), ctx.request, (db) => outboxRepo.insert(db, {
    id: uuidv7(), organisationId: a.organisationId, topic: auditEventMessage.topic, orderingKey: a.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: ctx.correlationId,
  }));
}
