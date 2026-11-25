// Resolving rows into objects (spec 23.3 to 23.6), for the executor's answering path and for
// resolution runs: key each row, hash identifiers and keys under the organisation key,
// write the entity graph in one transaction per batch, and, on the answering path, merge each
// object's values under field authority with coverage.

import type { ObjectTypeView } from '../../contracts/ontology/manifest.contract.ts';
import type { resolveRecords as resolveRecordsContract } from '../../contracts/resolution/resolve.contract.ts';
import type { CallOutput, ParsedInput } from '../../contracts/endpoint.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { fieldAuthorityRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import {
  acting, hashAll, manifestAt, planFor, recordEvent, typeIn, type Acting, type Context, type ResolutionDeps,
} from './deps.service.ts';
import { resolveIntoGraph, type GraphOutcome, type GraphStats } from './graph.service.ts';
import { compositeKey, identifierText, normalisedComponents, sourceIdentifierHash, sourceKey, type KeyPlan } from './identity.service.ts';
import { merge, type Authority } from './merge.service.ts';

export interface BatchRow {
  connectionId: string;
  sourceObject: string;
  identifier: string;
  values: Readonly<Record<string, unknown>>;
}

export interface BatchOutcome extends GraphOutcome {
  /** Per row, its normalised key components, or undefined when it could not be keyed. */
  components: (string[] | undefined)[];
  unkeyed: number;
}

/** Keys, hashes and resolves one batch of rows into the graph. */
export async function resolveBatch(
  deps: ResolutionDeps, ctx: Context, actor: Acting, type: ObjectTypeView, plan: KeyPlan, rows: readonly BatchRow[],
  options: { touch: 'always' | 'hourly'; proposalId?: string | undefined },
): Promise<BatchOutcome> {
  const resolvable = type.resolutionClass === 'resolvable';
  const components = rows.map((r) => (resolvable ? normalisedComponents(plan, r.values) : undefined));
  const keyTexts = rows.map((r, i) => {
    const c = components[i];
    return c === undefined ? sourceKey(r.connectionId, r.sourceObject, r.identifier) : compositeKey(c);
  });
  const ids = await hashAll(deps, ctx, 'source_identifier', rows.map((r) => r.identifier));
  const keys = await hashAll(deps, ctx, 'match_key', keyTexts);
  if (ids.keyVersionId !== keys.keyVersionId) {
    throw new AppError('unavailable', 'the organisation key changed during the batch; try again', { code: 'resolution.key_rotated', retryable: true });
  }
  const outcome = await inTransaction(deps.databases.pool('control'), { organisationId: actor.organisationId }, async (db) => {
    const result = await resolveIntoGraph(db, {
      organisationId: actor.organisationId, objectTypeId: type.id, keyVersionId: ids.keyVersionId, proposalId: options.proposalId,
      touch: options.touch,
    }, rows.map((r, i) => ({
      connectionId: r.connectionId, sourceObject: r.sourceObject, identifierHash: ids.hashes[i]!, keyHash: keys.hashes[i]!,
      // Keyed by its source identifier: the id is the one every service derives (spec 24.7).
      ...(components[i] === undefined ? { idSeed: sourceIdentifierHash(r.connectionId, r.sourceObject, r.identifier) } : {}),
    })));
    await recordGraphEvents(db, actor, ctx.correlationId, type.id, result.stats);
    return result;
  });
  return { ...outcome, components, unkeyed: resolvable ? components.filter((c) => c === undefined).length : 0 };
}

async function recordGraphEvents(db: Parameters<typeof recordEvent>[0], actor: Acting, correlationId: string, typeId: string, stats: GraphStats) {
  if (stats.remapped > 0) {
    await recordEvent(db, actor, correlationId, { event: 'match_key_remapped', resource: { type: 'object_type', id: typeId }, detail: { entries: stats.remapped } });
  }
  if (stats.merged > 0) {
    await recordEvent(db, actor, correlationId, { event: 'object_merged_redirect', resource: { type: 'object_type', id: typeId }, detail: { objects: stats.merged } });
  }
}

/** The live declarations of a type, conditions compiled; conditional first, then newest first. */
export async function authoritiesOf(deps: ResolutionDeps, organisationId: string, typeId: string): Promise<Authority[]> {
  const rows = await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => fieldAuthorityRepo.liveForType(db, typeId), { readOnly: true });
  const out: Authority[] = [];
  for (const row of rows) {
    let condition = null;
    if (row.condition !== null) {
      try {
        condition = compileCel(row.condition, { object: 'map' });
      } catch {
        deps.logger.warn('a field authority condition does not compile; it is skipped', { event: 'resolution.authority_unusable', resourceId: row.id });
        continue;
      }
    }
    out.push({ id: row.id, propertyIdentityId: row.propertyIdentityId, winningConnectionId: row.winningConnectionId, condition });
  }
  return [...out.filter((a) => a.condition !== null), ...out.filter((a) => a.condition === null)];
}

type ResolveInput = ParsedInput<typeof resolveRecordsContract>;
type ResolveOutput = CallOutput<typeof resolveRecordsContract>;

/** The executor's call (contracts/resolution/resolve.contract.ts). */
export async function resolveRecords(deps: ResolutionDeps, ctx: Context, input: ResolveInput['body']): Promise<ResolveOutput> {
  const organisationId = ctx.request.organisationId!;
  const actor: Acting = ctx.request.membershipId !== undefined || ctx.request.servicePrincipalId !== undefined
    ? acting(ctx) : { organisationId, membershipId: undefined, servicePrincipalId: undefined };
  const manifest = await manifestAt(deps, ctx, input.ontologyVersionId);
  const type = typeIn(manifest, input.objectTypeId);
  input.sources.forEach((s, i) => {
    if (!type.contributingObjects.some((co) => co.connectionId === s.connectionId && co.sourceObject === s.sourceObject)) {
      throw new AppError('validation', 'a source is not a contributing object of the type', {
        code: 'resolution.not_contributing', details: { source: i },
      });
    }
  });
  const total = input.sources.reduce((n, s) => n + s.rows.length, 0);
  if (total > 20_000) {
    throw new AppError('bounds', 'too many rows in one call; resolve in batches', { code: 'resolution.too_many_rows', details: { rows: total, max: 20_000 } });
  }
  const { plan } = await planFor(deps, organisationId, type);
  const flat: (BatchRow & { source: number; row: number })[] = [];
  input.sources.forEach((s, si) => s.rows.forEach((r, ri) => flat.push({
    connectionId: s.connectionId, sourceObject: s.sourceObject, identifier: identifierText(r.identifier), values: r.values, source: si, row: ri,
  })));

  const outcome = flat.length === 0
    ? { objects: [] as string[], redirectedFrom: [] as (string | undefined)[], unkeyed: 0 }
    : await resolveBatch(deps, ctx, actor, type, plan, flat, { touch: 'hourly' });

  // Objects in first-seen order, with the rows of this request.
  const order: string[] = [];
  const objects = new Map<string, { rows: { source: number; row: number }[]; redirectedFrom: Set<string> }>();
  flat.forEach((r, i) => {
    const id = outcome.objects[i]!;
    let o = objects.get(id);
    if (!o) {
      o = { rows: [], redirectedFrom: new Set() };
      objects.set(id, o);
      order.push(id);
    }
    o.rows.push({ source: r.source, row: r.row });
    const via = outcome.redirectedFrom[i];
    if (via !== undefined) o.redirectedFrom.add(via);
  });

  const properties = input.properties ?? [...new Set(input.sources.flatMap((s) => s.rows.flatMap((r) => Object.keys(r.values))))];
  const known = new Set(type.properties.map((p) => p.identityId));
  const merged = merge({
    type,
    sources: input.sources,
    objects: order.map((id) => ({ rows: objects.get(id)!.rows })),
    properties: properties.filter((p) => known.has(p)),
    authorities: await authoritiesOf(deps, organisationId, type.id),
  });

  const result: ResolveOutput = {
    objects: order.map((id, i) => {
      const o = objects.get(id)!;
      const present = new Set(o.rows.map((r) => `${input.sources[r.source]!.connectionId}\u0000${input.sources[r.source]!.sourceObject}`));
      return {
        siloObjectId: id,
        redirectedFrom: [...o.redirectedFrom],
        rows: o.rows,
        absentFrom: type.contributingObjects.filter((co) => !present.has(`${co.connectionId}\u0000${co.sourceObject}`))
          .map((co) => ({ connectionId: co.connectionId, sourceObject: co.sourceObject })),
        properties: merged.properties[i]!,
      };
    }),
    coverage: merged.coverage,
    unkeyed: outcome.unkeyed,
  };

  // Spec 23.5: a source that could not be asked again is stated, never treated as settled.
  if (merged.coverage.unchecked > 0) {
    await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => recordEvent(db, actor, ctx.correlationId, {
      event: 'dispute_recheck_unavailable', resource: { type: 'object_type', id: type.id },
      detail: { objects: merged.coverage.unchecked, sources: input.sources.filter((s) => s.unchecked).length },
    }));
  }
  return result;
}
