// Lenses (spec 38.9): a member's private working layers. References, counts and
// dispositions only. A personal disposition needs no permission beyond seeing the finding,
// and never counts toward thresholds.
//
// Sharing (decision 2026-11-14): with a member, a scope or the organisation, under the
// owner's sharing policy, with access view, use or copy. A shared Lens resolves under the
// opener's own clearances, role, field policies, markings and purposes on every open: a
// finding the opener may not see, or objects of a type they may not see, are dropped, with a
// statement that part of it is not visible. Sharing never grants access. Saved object sets
// are kept by reference: running one applies the runner's own access, as always. Coverage
// at share is the proportion each recipient can see, worked out as that recipient (for a
// scope or the organisation, over at most COVERAGE_RECIPIENTS of them); the share records the
// lowest and the audit event the lowest and highest.

import type { LensView } from '../../contracts/recognition/lens.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Lens } from '../../models/recognition/lens.model.ts';
import { findingRepo, lensDispositionRepo, lensRepo, lensShareRepo } from '../../repos/recognition/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { access, member, readManifest, recordEvent, type Context, type RecognitionDeps } from './deps.service.ts';
import { assemble, getFinding, visibleTo } from './findings.service.ts';
import { accessToLens, granteeOfLensShare, type LensAccess } from './lensAccess.service.ts';
import { effectivePolicy, permitted } from '../workspace/sharing.service.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import type { LensShare } from '../../models/recognition/lensShare.model.ts';

const lensNotFound = (): AppError => new AppError('not_found', 'no such Lens', { code: 'recognition.lens_not_found' });

async function views(db: Queryable, lenses: readonly Lens[]): Promise<LensView[]> {
  const counts = await lensDispositionRepo.counts(db, lenses.map((l) => l.id));
  return lenses.map((l) => {
    const of = (d: 'confirmed' | 'dismissed' | 'deferred') => counts.find((c) => c.lensId === l.id && c.disposition === d)?.n ?? 0;
    return {
      id: l.id, name: l.name, workingSets: l.workingSets as LensView['workingSets'],
      dispositions: { confirmed: of('confirmed'), dismissed: of('dismissed'), deferred: of('deferred') }, version: l.version, createdAt: l.createdAt,
    };
  });
}

const nameTaken = (error: unknown): never => {
  if (fromDatabaseError(error).category === 'conflict') {
    throw new AppError('conflict', 'you already have a Lens with that name', { code: 'recognition.lens_name_taken' });
  }
  throw error;
};

export async function createLens(deps: RecognitionDeps, ctx: Context, input: { name: string; workingSets: LensView['workingSets'] }): Promise<LensView> {
  const who = member(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const lens = await lensRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, membershipId: who.membershipId, name: input.name, workingSets: input.workingSets,
    }).catch(nameTaken);
    await recordEvent(db, who, ctx.correlationId, { event: 'lens_created', resource: { type: 'lens', id: lens.id }, detail: { working_sets: input.workingSets.length } });
    return (await views(db, [lens]))[0]!;
  });
}

export const COVERAGE_RECIPIENTS = 100;

interface Resolved { workingSets: LensView['workingSets']; total: number; hidden: number }

/** A Lens's references as one reader may see them (see the header): the caller, or a recipient who is not present. */
async function resolveFor(deps: RecognitionDeps, reader: Context, lens: Lens, asMembershipId?: string): Promise<Resolved> {
  const sets = lens.workingSets as LensView['workingSets'];
  const findingIds = [...new Set(sets.flatMap((s) => (s.kind === 'findings' ? s.findingIds : [])))];
  const typeIds = [...new Set(sets.flatMap((s) => (s.kind === 'objects' ? [s.objectTypeId] : [])))];
  let visibleFindings = new Set<string>();
  if (findingIds.length > 0) {
    const manifest = await readManifest(deps, reader);
    const assembled = await inTransaction(deps.databases.pool('control'), reader.request, async (db) =>
      assemble(db, await findingRepo.list(db, { ids: findingIds, includeSuperseded: true, limit: findingIds.length }), manifest, undefined), { readOnly: true });
    visibleFindings = new Set((await visibleTo(deps, reader, assembled, asMembershipId)).visible.map((a) => a.finding.id));
  }
  const types = typeIds.length === 0 ? undefined : await access(deps, reader, { objectTypes: typeIds }, asMembershipId);
  let total = 0;
  let hidden = 0;
  const workingSets: LensView['workingSets'] = [];
  for (const set of sets) {
    if (set.kind === 'findings') {
      const kept = set.findingIds.filter((id) => visibleFindings.has(id));
      total += set.findingIds.length;
      hidden += set.findingIds.length - kept.length;
      workingSets.push({ ...set, findingIds: kept });
    } else if (set.kind === 'objects') {
      total += set.objectIds.length;
      if (types !== undefined && types.allowed && types.typeVisible(set.objectTypeId)) workingSets.push(set);
      else hidden += set.objectIds.length;
    } else {
      total += 1;
      workingSets.push(set);
    }
  }
  return { workingSets, total, hidden };
}

const coverageOf = (r: Resolved): number => (r.total === 0 ? 1 : Math.round(((r.total - r.hidden) / r.total) * 10_000) / 10_000);

async function loadLens(db: Queryable, lensId: string): Promise<Lens> {
  const lens = await lensRepo.findById(db, lensId);
  if (!lens || lens.archivedAt !== null) throw lensNotFound();
  return lens;
}

const shareView = (s: LensShare) => ({
  id: s.id, lensId: s.lensId, grantee: granteeOfLensShare(s), access: s.access as LensAccess, coverageAtShare: Number(s.coverageAtShare),
  sharedBy: s.sharedBy, createdAt: s.createdAt, revokedAt: s.revokedAt,
});

/** Shares a Lens its owner holds (lens.share), under their sharing policy, with each recipient's coverage worked out as them. */
export async function shareLens(deps: RecognitionDeps, ctx: Context, lensId: string, input: { grantee: ShareGrantee; access: LensAccess }) {
  const who = member(ctx);
  const pool = deps.databases.pool('control');
  const { lens, recipients } = await inTransaction(pool, who.request, async (db) => {
    const found = await loadLens(db, lensId);
    if (found.membershipId !== who.membershipId) throw lensNotFound();
    const policy = await effectivePolicy(db, found.organisationId, found.membershipId);
    if (!await permitted(db, found.membershipId, input.grantee, policy)) {
      throw new AppError('forbidden', 'your sharing policy does not allow sharing with them', { code: 'recognition.lens_share_forbidden' });
    }
    const reached = input.grantee.kind === 'membership' ? [input.grantee.membershipId]
      : input.grantee.kind === 'scope' ? await lensShareRepo.membersWithin(db, input.grantee.scopeId, COVERAGE_RECIPIENTS + 1)
        : await lensShareRepo.activeMembers(db, COVERAGE_RECIPIENTS + 1);
    return { lens: found, recipients: reached.filter((m) => m !== found.membershipId).slice(0, COVERAGE_RECIPIENTS) };
  }, { readOnly: true });
  const coverages: number[] = [];
  for (const recipient of recipients) coverages.push(coverageOf(await resolveFor(deps, ctx, lens, recipient)));
  const lowest = coverages.length === 0 ? 1 : Math.min(...coverages);
  const highest = coverages.length === 0 ? 1 : Math.max(...coverages);
  return inTransaction(pool, who.request, async (db) => {
    const row = await lensShareRepo.insert(db, {
      id: uuidv7(), organisationId: lens.organisationId, lensId: lens.id,
      granteeMembershipId: input.grantee.kind === 'membership' ? input.grantee.membershipId : null,
      granteeScopeId: input.grantee.kind === 'scope' ? input.grantee.scopeId : null,
      granteeWholeOrganisation: input.grantee.kind === 'organisation' ? true : null,
      access: input.access, coverageAtShare: String(lowest), sharedBy: who.membershipId!,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'lens_shared', resource: { type: 'lens', id: lens.id },
      detail: { share_id: row.id, grantee: input.grantee.kind, access: input.access, recipients: recipients.length, coverage_lowest: lowest, coverage_highest: highest },
    });
    return { share: shareView(row), coverage: { recipients: recipients.length, lowest, highest } };
  });
}

/** The owner's shares of a Lens. */
export async function listLensShares(deps: RecognitionDeps, ctx: Context, lensId: string) {
  const who = member(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const lens = await loadLens(db, lensId);
    if (lens.membershipId !== who.membershipId) throw lensNotFound();
    return { shares: (await lensShareRepo.listForLens(db, lensId)).map(shareView) };
  }, { readOnly: true });
}

/** Revoked by the Lens's owner or whoever shared it. */
export async function revokeLensShare(deps: RecognitionDeps, ctx: Context, shareId: string): Promise<void> {
  const who = member(ctx);
  await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const share = await lensShareRepo.findById(db, shareId);
    const lens = share === undefined ? undefined : await lensRepo.findById(db, share.lensId);
    if (!share || !lens || (lens.membershipId !== who.membershipId && share.sharedBy !== who.membershipId)) {
      throw new AppError('not_found', 'no such share', { code: 'recognition.lens_share_not_found' });
    }
    if (await lensShareRepo.revoke(db, shareId, who.membershipId!)) {
      await recordEvent(db, who, ctx.correlationId, { event: 'lens_share_revoked', resource: { type: 'lens', id: lens.id }, detail: { share_id: shareId } });
    }
  });
}

/** A Lens as its opener may see it: whole for its owner, resolved under a recipient's own access. */
export async function openLens(deps: RecognitionDeps, ctx: Context, lensId: string) {
  const who = member(ctx);
  const { lens, held } = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const found = await loadLens(db, lensId);
    return { lens: found, held: await accessToLens(db, found, who.membershipId!) };
  }, { readOnly: true });
  if (held === undefined) throw lensNotFound();
  const [view] = await inTransaction(deps.databases.pool('control'), who.request, (db) => views(db, [lens]), { readOnly: true });
  if (held === 'owner') return { ...view!, access: held, hidden: 0, statement: null };
  const resolved = await resolveFor(deps, ctx, lens);
  return {
    ...view!, workingSets: resolved.workingSets, access: held, hidden: resolved.hidden,
    statement: resolved.hidden === 0 ? null : `Part of this Lens is not visible to you: ${resolved.hidden} of ${resolved.total} references are hidden by your access.`,
  };
}

/** Lenses shared with the member, each opened as them. */
export async function listSharedLenses(deps: RecognitionDeps, ctx: Context) {
  const who = member(ctx);
  const ids = await inTransaction(deps.databases.pool('control'), who.request, (db) => lensShareRepo.lensesReaching(db, who.membershipId!, 200), { readOnly: true });
  const lenses = [];
  for (const id of ids) {
    try {
      const opened = await openLens(deps, ctx, id);
      if (opened.access !== 'owner') lenses.push(opened);
    } catch (error) {
      if (!(error instanceof AppError && error.category === 'not_found')) throw error;
    }
  }
  return { lenses };
}

/** A copy (copy access) as the member's own Lens, of only what they may see. */
export async function copyLens(deps: RecognitionDeps, ctx: Context, lensId: string, input: { name: string }): Promise<LensView> {
  const opened = await openLens(deps, ctx, lensId);
  if (opened.access !== 'owner' && opened.access !== 'copy') {
    throw new AppError('forbidden', 'this Lens is shared with you to view or use, not to copy', { code: 'recognition.lens_copy_not_shared' });
  }
  return createLens(deps, ctx, { name: input.name, workingSets: opened.workingSets });
}

export async function listLenses(deps: RecognitionDeps, ctx: Context): Promise<LensView[]> {
  const who = member(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => views(db, await lensRepo.listForMember(db, who.membershipId)),
    { readOnly: true });
}

export async function updateLens(deps: RecognitionDeps, ctx: Context, lensId: string,
  input: { name?: string | undefined; workingSets?: LensView['workingSets'] | undefined; archive?: true | undefined; version: number }): Promise<LensView> {
  const who = member(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const lens = await lensRepo.findById(db, lensId);
    if (!lens || lens.membershipId !== who.membershipId || lens.archivedAt !== null) throw lensNotFound();
    const updated = await lensRepo.updateAtVersion(db, lensId, input.version, {
      ...(input.name === undefined ? {} : { name: input.name }), ...(input.workingSets === undefined ? {} : { workingSets: input.workingSets }),
      ...(input.archive === true ? { archivedAt: new Date().toISOString() } : {}),
    }).catch(nameTaken);
    if (updated === undefined) throw new AppError('conflict', 'the Lens changed since you read it', { code: 'recognition.lens_stale' });
    return (await views(db, [updated]))[0]!;
  });
}

export async function recordLensDisposition(deps: RecognitionDeps, ctx: Context, lensId: string, findingId: string,
  disposition: 'confirmed' | 'dismissed' | 'deferred'): Promise<{ lensId: string; findingId: string; disposition: typeof disposition; recordedAt: string }> {
  const who = member(ctx);
  // The finding must be one the member can see (38.11); a hidden one is not found.
  await getFinding(deps, ctx, findingId, undefined);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const lens = await lensRepo.findById(db, lensId);
    if (!lens || lens.membershipId !== who.membershipId || lens.archivedAt !== null) throw lensNotFound();
    const row = await lensDispositionRepo.upsert(db, {
      organisationId: who.organisationId, lensId, findingId, disposition, recordedAt: new Date().toISOString(),
    });
    return { lensId, findingId, disposition: row.disposition, recordedAt: row.recordedAt };
  });
}
