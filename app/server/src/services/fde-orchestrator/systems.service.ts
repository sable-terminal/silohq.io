// The organisation's list of systems for an engagement (spec 51.2 to 51.4): each with the
// documentation its connector is drafted from, in descending fidelity a specification (OpenAPI,
// WSDL, GraphQL, OData $metadata) or documentation written for the schema. A person holding
// fde.engage lists a system, which puts it in the engagement's scope; in stage 2 the
// Integration principal drafts its connector from that documentation and probes it once the
// connection's owner (the engaging administrator) has given its credential: the AI FDE never
// holds a secret (52.1). Withdrawing a system takes it out of scope; a connection already
// drafted stays a draft its owner can revoke.
//
// Email samples are never listed here: they hold record values, which no store keeps and no
// model sees (62.5); a person drafts an email connector in the builder.

import type { SystemView } from '../../contracts/fde-orchestrator/engagement.contract.ts';
import type { Documentation } from '../../contracts/connector-builder/build.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { FdeEngagementSystem } from '../../models/fde/index.model.ts';
import { connectionCredentialRepo, connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { fdeEngagementSystemRepo } from '../../repos/fde/index.repo.ts';
import { scopeRepo } from '../../repos/iam/index.repo.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { nowOf, recordEvent, type Context, type FdeDeps } from './deps.service.ts';
import { loadEngagement } from './engagements.service.ts';

export type SystemDocumentation = Exclude<Documentation, { kind: 'email' | 'base_url' }>;

/** The documentation as the builder takes it. */
export function documentationOf(s: FdeEngagementSystem): SystemDocumentation {
  if (s.documentationKind === 'text') return { kind: 'text', title: s.documentationTitle!, text: s.documentation };
  if (s.documentationKind === 'url') return { kind: 'url', url: s.documentation };
  return { kind: s.documentationKind, text: s.documentation };
}

/**
 * Whether a drafted connection still waits for the credential its owner gives: none is live
 * and its manifest's strategy needs one. Counted through the safe view; no secret is read.
 */
export async function awaitingCredential(db: Queryable, connectionId: string): Promise<boolean> {
  if (await connectionCredentialRepo.countLive(db, connectionId) > 0) return false;
  const connection = await connectionRepo.findById(db, connectionId);
  const manifest = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
  const parsed = manifest === undefined ? undefined : manifestSchema.safeParse(manifest.document);
  return parsed?.success === true && parsed.data.auth.strategy !== 'none';
}

const view = async (db: Queryable, s: FdeEngagementSystem): Promise<SystemView> => ({
  id: s.id, engagementId: s.engagementId, name: s.name, provider: s.provider, slug: s.slug, documentationKind: s.documentationKind,
  baseUrl: s.baseUrl, owningScopeId: s.owningScopeId, status: s.status, connectionId: s.connectionId,
  awaitingCredential: s.status === 'drafted' && s.connectionId !== null && await awaitingCredential(db, s.connectionId),
  listedBy: s.listedBy, listedAt: s.listedAt, draftedAt: s.draftedAt,
});

export function createSystems(deps: FdeDeps) {
  const pool = deps.databases.pool('control');

  return {
    async add(ctx: Context, engagementId: string, input: {
      name: string; provider: string; slug: string; documentation: SystemDocumentation; baseUrl?: string | undefined;
      owningScopeId: string; parameters?: Record<string, string> | undefined;
    }): Promise<SystemView> {
      const membershipId = ctx.request.membershipId!;
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active' && e.status !== 'paused') {
          throw new AppError('conflict', `a ${e.status} engagement takes no new system`, { code: 'fde.engagement_not_active' });
        }
        if (await scopeRepo.findById(db, input.owningScopeId) === undefined) throw new AppError('validation', 'no such scope', { code: 'fde.scope_unknown' });
        let row: FdeEngagementSystem;
        try {
          row = await fdeEngagementSystemRepo.insert(db, {
            id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, name: input.name, provider: input.provider, slug: input.slug,
            documentationKind: input.documentation.kind, documentationTitle: input.documentation.kind === 'text' ? input.documentation.title : null,
            documentation: input.documentation.kind === 'url' ? input.documentation.url : input.documentation.text, baseUrl: input.baseUrl ?? null, owningScopeId: input.owningScopeId,
            parameters: (input.parameters ?? {}) as never, listedBy: membershipId, listedAt: nowOf(deps).toISOString(),
          });
        } catch (error) {
          const mapped = isAppError(error) ? error : fromDatabaseError(error);
          if (mapped.category === 'conflict') throw new AppError('conflict', 'this engagement lists a system with that slug', { code: 'fde.system_slug_taken' });
          throw mapped;
        }
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_system_listed', engagementId: e.id,
          actor: { membershipId }, resource: { type: 'fde_engagement_system', id: row.id },
          detail: { documentation: row.documentationKind, owning_scope_id: row.owningScopeId } });
        return view(db, row);
      });
    },

    async list(ctx: Context, engagementId: string): Promise<{ systems: SystemView[] }> {
      return inTransaction(pool, ctx.request, async (db) => {
        await loadEngagement(db, engagementId);
        const systems: SystemView[] = [];
        for (const s of await fdeEngagementSystemRepo.listForEngagement(db, engagementId)) systems.push(await view(db, s));
        return { systems };
      }, { readOnly: true });
    },

    async withdraw(ctx: Context, engagementId: string, systemId: string): Promise<SystemView> {
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        const s = await fdeEngagementSystemRepo.findById(db, systemId);
        if (s === undefined || s.engagementId !== e.id) throw new AppError('not_found', 'no such system', { code: 'fde.system_not_found' });
        if (s.status === 'withdrawn') return view(db, s);
        const updated = (await fdeEngagementSystemRepo.update(db, s.id, { status: 'withdrawn', withdrawnAt: nowOf(deps).toISOString() }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_system_withdrawn', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! }, resource: { type: 'fde_engagement_system', id: s.id },
          detail: { drafted: s.connectionId !== null } });
        return view(db, updated);
      });
    },
  };
}

export type Systems = ReturnType<typeof createSystems>;
