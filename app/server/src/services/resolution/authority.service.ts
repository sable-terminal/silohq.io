// Field authorities (spec 23.4): declared and revoked by a person holding authority.declare
// on the type and read access to every connection that maps the property, with a reason.
// A declaration only makes sense for a property more than one contributing object maps, and
// its winning connection must map it (the database checks that too, at commit). The
// declaration records main's head as the version it was declared against; a declaration on
// a branch, to try its effect first, is the spec's open decision and is not offered.

import type { FieldAuthorityView } from '../../contracts/resolution/authority.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { FieldAuthority } from '../../models/ontology/fieldAuthority.model.ts';
import { fieldAuthorityRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { activeManifest, demand, demandReadAll, person, recordEvent, typeIn, type Context, type ResolutionDeps } from './deps.service.ts';

export const authorityView = (a: FieldAuthority): FieldAuthorityView => ({
  id: a.id, objectTypeId: a.objectTypeId, propertyIdentityId: a.propertyIdentityId, winningConnectionId: a.winningConnectionId,
  condition: a.condition, reason: a.reason, declaredBy: a.declaredBy, declaredAt: a.declaredAt, revokedBy: a.revokedBy, revokedAt: a.revokedAt,
  ontologyVersionId: a.ontologyVersionId,
});

export interface Authorities {
  declare(ctx: Context, input: { objectTypeId: string; propertyIdentityId: string; winningConnectionId: string; condition?: string | undefined; reason: string })
    : Promise<FieldAuthorityView>;
  revoke(ctx: Context, id: string): Promise<FieldAuthorityView>;
  get(ctx: Context, id: string): Promise<FieldAuthorityView>;
  list(ctx: Context, objectTypeId: string, includeRevoked: boolean): Promise<FieldAuthorityView[]>;
}

export function createAuthorities(deps: ResolutionDeps): Authorities {
  const pool = deps.databases.pool('control');

  return {
    async declare(ctx, input) {
      const actor = person(ctx, 'declaring a field authority');
      await demand(deps, ctx, 'authority.declare', input.objectTypeId);
      const manifest = await activeManifest(deps, ctx);
      const type = typeIn(manifest, input.objectTypeId);
      const property = type.properties.find((p) => p.identityId === input.propertyIdentityId);
      if (!property) throw new AppError('not_found', 'the type has no such property', { code: 'resolution.property_not_found' });
      const mappers = [...new Set(property.mappings.map((m) => m.connectionId))];
      if (property.mappings.length < 2) {
        throw new AppError('validation', 'only a property more than one system maps can have an authority', { code: 'resolution.authority_needless' });
      }
      if (!mappers.includes(input.winningConnectionId)) {
        throw new AppError('validation', 'the winning connection does not map the property', { code: 'resolution.winner_unmapped' });
      }
      await demandReadAll(deps, ctx, mappers);
      if (input.condition !== undefined) {
        try {
          compileCel(input.condition, { object: 'map' });
        } catch (error) {
          throw new AppError('validation', 'the condition is not a CEL predicate over object', { code: 'resolution.condition_invalid', cause: error });
        }
      }
      return inTransaction(pool, { organisationId: actor.organisationId }, async (db) => {
        const row = await fieldAuthorityRepo.insert(db, {
          id: uuidv7(), organisationId: actor.organisationId, objectTypeId: type.id, propertyIdentityId: property.identityId,
          winningConnectionId: input.winningConnectionId, condition: input.condition ?? null, declaredBy: actor.membershipId, reason: input.reason,
          ontologyVersionId: manifest.version.id,
        });
        await recordEvent(db, actor, ctx.correlationId, {
          event: 'authority_declared', resource: { type: 'field_authority', id: row.id },
          detail: { object_type_id: type.id, property_identity_id: property.identityId, winning_connection_id: input.winningConnectionId, conditional: input.condition !== undefined },
        });
        return authorityView(row);
      });
    },

    async revoke(ctx, id) {
      const actor = person(ctx, 'revoking a field authority');
      const found = await inTransaction(pool, { organisationId: actor.organisationId }, (db) => fieldAuthorityRepo.findById(db, id), { readOnly: true });
      if (!found) throw new AppError('not_found', 'no such field authority', { code: 'resolution.authority_not_found' });
      await demand(deps, ctx, 'authority.declare', found.objectTypeId);
      return inTransaction(pool, { organisationId: actor.organisationId }, async (db) => {
        const row = await fieldAuthorityRepo.revoke(db, id, actor.membershipId);
        if (!row) throw new AppError('conflict', 'the authority is already revoked', { code: 'resolution.authority_revoked' });
        await recordEvent(db, actor, ctx.correlationId, {
          event: 'authority_revoked', resource: { type: 'field_authority', id }, detail: { object_type_id: row.objectTypeId, property_identity_id: row.propertyIdentityId },
        });
        return authorityView(row);
      });
    },

    async get(ctx, id) {
      const found = await inTransaction(pool, { organisationId: ctx.request.organisationId! }, (db) => fieldAuthorityRepo.findById(db, id), { readOnly: true });
      if (!found) throw new AppError('not_found', 'no such field authority', { code: 'resolution.authority_not_found' });
      return authorityView(found);
    },

    async list(ctx, objectTypeId, includeRevoked) {
      const rows = await inTransaction(pool, { organisationId: ctx.request.organisationId! },
        (db) => fieldAuthorityRepo.listForType(db, objectTypeId, includeRevoked), { readOnly: true });
      return rows.map(authorityView);
    },
  };
}
