// The deprecation lifecycle and rollback (spec 25.7, 25.8).
//
//   active -> deprecated (still usable; its replacement named; a retirement date at least 30
//   days ahead) -> retired (absent from the vocabulary of the new version; dependants fail
//   with the reason)
//
// Deprecation and retirement are ontology.manage, by a person, each a new main version: the
// element's entry in it says where it stands, so earlier versions, which lineage references,
// keep it as it was. Nothing is deleted.
//
// A rollback is a proposal like any other (origin rollback): a working branch on main's head
// whose one commit makes its content equal a named prior main version, so impact analysis,
// approvals and the merge are the ordinary ones. The merge is a new main version of kind
// rollback naming the version it restores; elements created since are retired, elements
// retired since come back, and nothing in the entity graph or the authorities is deleted.

import type { ElementKind, ProposalView } from '../../contracts/ontology/proposal.contract.ts';
import type { VersionView } from '../../contracts/ontology/manifest.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { ontologyBranchRepo, ontologyDependencyRepo, ontologyVersionRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { diff, entriesOf, findById, type AnyEntry, type Content } from './content.service.ts';
import { demand, person, recordEvent, type Context, type OntologyDeps } from './deps.service.ts';
import { commit, readContent, versionToView, type Write } from './store.service.ts';
import { dropReminder, elementRefs, keepReminder, tellOwners } from './retirementNotices.service.ts';
import { openProposal, proposalView } from './versioning.service.ts';

/** Deprecation names a retirement date at least this far ahead (spec 25.7). */
export const MIN_NOTICE_DAYS = 30;

const KINDS: readonly ElementKind[] = ['object_type', 'link_type', 'shared_property', 'interface', 'function'];

const clock = (deps: OntologyDeps): Date => (deps.now ?? (() => new Date()))();
const today = (deps: OntologyDeps): string => clock(deps).toISOString().slice(0, 10);
const daysAhead = (deps: OntologyDeps, n: number): string => new Date(clock(deps).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** How many dependants name the element (an object type's include those naming its properties). */
async function dependantsOf(db: Queryable, kind: ElementKind, entry: AnyEntry): Promise<number> {
  return new Set((await ontologyDependencyRepo.liveForElements(db, elementRefs(kind, entry))).map((r) => r.dependantRef)).size;
}

async function lockedMain(db: Queryable) {
  const found = await ontologyBranchRepo.findMain(db);
  if (!found) throw new AppError('not_found', 'the organisation has no ontology yet', { code: 'ontology.none_yet' });
  return (await ontologyBranchRepo.lock(db, found.id))!;
}

function elementOn(content: Content, kind: ElementKind, id: string): AnyEntry {
  const entry = findById(content, kind, id);
  if (!entry) throw new AppError('not_found', `no such ${kind.replace('_', ' ')} on main`, { code: 'ontology.element_not_found' });
  return entry;
}

export async function deprecateElement(deps: OntologyDeps, ctx: Context, kind: ElementKind, id: string,
  input: { replacedById?: string | undefined; retireAfter: string; note?: string | undefined }): Promise<VersionView> {
  const actor = person(ctx, 'deprecating');
  await demand(deps, ctx, 'ontology.manage');
  if (input.retireAfter < daysAhead(deps, MIN_NOTICE_DAYS)) {
    throw new AppError('validation', `retirement is at least ${MIN_NOTICE_DAYS} days after deprecation`, {
      code: 'ontology.retirement_too_soon', details: { earliest: daysAhead(deps, MIN_NOTICE_DAYS) },
    });
  }
  const done = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const main = await lockedMain(db);
    const content = await readContent(db, actor.organisationId, main.headVersionId!);
    const entry = elementOn(content, kind, id);
    if (entry.status !== 'active') throw new AppError('conflict', `the element is ${entry.status}`, { code: 'ontology.not_active' });
    if (input.replacedById !== undefined) {
      const replacement = findById(content, kind, input.replacedById);
      if (!replacement || replacement.id === id || replacement.status !== 'active') {
        throw new AppError('validation', `the replacement is an active ${kind.replace('_', ' ')} on main, not this one`, {
          code: 'ontology.replacement_invalid',
        });
      }
    }
    const write: Write = {
      kind, operation: 'deprecate', changeClass: 'compatible', lifecycle: 'deprecated',
      entry: { ...entry, replacedById: input.replacedById ?? null, retireAfter: input.retireAfter } as AnyEntry,
    };
    const { version } = await commit(db, {
      organisationId: actor.organisationId, branch: main, parentVersionId: main.headVersionId!, parentContent: content, kind: 'change', actor,
      writes: [write],
    });
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'element_deprecated', resource: { type: kind, id },
      detail: {
        version_id: version.id, retire_after: input.retireAfter, dependants: await dependantsOf(db, kind, entry),
        ...(input.replacedById === undefined ? {} : { replaced_by: input.replacedById }),
      },
    });
    await keepReminder(db, actor.organisationId, kind, id, input.retireAfter);
    return { view: versionToView(version, main), refs: elementRefs(kind, entry) };
  });
  // Owners of the dependants are told after the commit; the deprecation stands if they cannot be (spec 25.7).
  await tellOwners(deps, actor.organisationId, ctx.correlationId, 'element_deprecated', id, done.refs);
  return done.view;
}

export async function retireElement(deps: OntologyDeps, ctx: Context, kind: ElementKind, id: string): Promise<VersionView> {
  const actor = person(ctx, 'retiring');
  await demand(deps, ctx, 'ontology.manage');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const main = await lockedMain(db);
    const content = await readContent(db, actor.organisationId, main.headVersionId!);
    const entry = elementOn(content, kind, id) as AnyEntry & { retireAfter?: string };
    if (entry.status !== 'deprecated') {
      throw new AppError('conflict', 'an element is deprecated before it is retired', { code: 'ontology.not_deprecated' });
    }
    if (entry.retireAfter !== undefined && entry.retireAfter > today(deps)) {
      throw new AppError('conflict', `the element may be retired from ${entry.retireAfter}`, {
        code: 'ontology.retirement_not_due', details: { retireAfter: entry.retireAfter },
      });
    }
    const { version } = await commit(db, {
      organisationId: actor.organisationId, branch: main, parentVersionId: main.headVersionId!, parentContent: content, kind: 'change', actor,
      writes: [{ kind, entry, operation: 'retire', changeClass: 'breaking', lifecycle: 'retired' }],
    });
    await dropReminder(db, id);
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'element_retired', resource: { type: kind, id },
      detail: { version_id: version.id, dependants: await dependantsOf(db, kind, entry) },
    });
    return versionToView(version, main);
  });
}

/** Opens a rollback proposal: a branch whose content equals the named prior main version (spec 25.8). */
export async function openRollback(deps: OntologyDeps, ctx: Context, input: { targetVersionId: string; title: string; description?: string | undefined })
  : Promise<ProposalView> {
  const actor = person(ctx, 'proposing a rollback');
  await demand(deps, ctx, 'ontology.propose');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const main = await lockedMain(db);
    const target = await ontologyVersionRepo.findById(db, input.targetVersionId);
    if (!target || target.branchId !== main.id) {
      throw new AppError('validation', 'a rollback restores a version of main', { code: 'ontology.rollback_target_invalid' });
    }
    if (target.id === main.headVersionId) throw new AppError('conflict', 'that version is main\'s head', { code: 'ontology.rollback_to_head' });
    const [head, restored] = await Promise.all([
      readContent(db, actor.organisationId, main.headVersionId!), readContent(db, actor.organisationId, target.id),
    ]);
    const changes = diff(head, restored);
    if (changes.length === 0) throw new AppError('conflict', 'main already has that content', { code: 'ontology.rollback_no_change' });
    const writes: Write[] = changes.map((c) => c.operation === 'retire'
      ? { kind: c.kind, entry: findById(head, c.kind, c.id)!, operation: 'retire', changeClass: 'breaking', lifecycle: 'retired' }
      : {
        kind: c.kind, entry: findById(restored, c.kind, c.id)!, operation: c.operation, changeClass: c.changeClass,
        lifecycle: findById(restored, c.kind, c.id)!.status === 'deprecated' ? 'deprecated' : 'active',
      });
    const branchId = uuidv7();
    await ontologyBranchRepo.insert(db, {
      id: branchId, organisationId: actor.organisationId, name: `rollback ${target.sequence} ${branchId.slice(-8)}`.slice(0, 100), kind: 'working',
      baseVersionId: main.headVersionId, headVersionId: main.headVersionId, ownerMembershipId: actor.membershipId, status: 'open',
    });
    const branch = (await ontologyBranchRepo.findById(db, branchId))!;
    await commit(db, {
      organisationId: actor.organisationId, branch, parentVersionId: main.headVersionId!, parentContent: head, kind: 'change', actor, writes,
    });
    const proposal = await openProposal(db, actor, ctx.correlationId, (await ontologyBranchRepo.findById(db, branchId))!, {
      title: input.title, description: input.description ?? null, origin: 'rollback', rollbackTo: target.id,
    });
    return proposalView(db, proposal);
  });
}

/** Lists main's deprecated elements, with when each may be retired. */
export function deprecatedOn(content: Content): { kind: ElementKind; id: string; apiName: string; replacedById: string | null; retireAfter: string | null }[] {
  return KINDS.flatMap((kind) => entriesOf(content, kind).filter((e) => e.status === 'deprecated').map((e) => {
    const d = e as AnyEntry & { replacedById?: string | null; retireAfter?: string };
    return { kind, id: e.id, apiName: e.apiName, replacedById: d.replacedById ?? null, retireAfter: d.retireAfter ?? null };
  }));
}

