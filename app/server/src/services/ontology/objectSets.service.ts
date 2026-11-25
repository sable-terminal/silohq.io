// Saved object sets (spec 24.4): a definition checked against main's head, its owner, its
// visibility, and its dependencies in the index. Members are never stored (an explicit set
// keeps Silo object ids only); evaluation is the query engine's.

import type { ObjectSetView, SetDefinition } from '../../contracts/ontology/objectSet.contract.ts';
import { setDefinition } from '../../contracts/ontology/objectSet.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { ObjectSet } from '../../models/ontology/objectSet.model.ts';
import { servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import { objectSetRepo, ontologyDependencyRepo } from '../../repos/ontology/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { findValuePatterns } from '../../utils/redaction.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { findById, type Content } from './content.service.ts';
import { demand, demandView, mainBranch, person, recordEvent, type Context, type OntologyDeps } from './deps.service.ts';
import { readContent } from './store.service.ts';
import { writeLineage } from '../lineage/writer.service.ts';
import type { LineageWriteInput } from '../../contracts/lineage/lineage.contract.ts';

type LineageInput = LineageWriteInput['inputs'][number];

const refuse = (code: string, message: string): AppError => new AppError('validation', message, { code });

const view = (s: ObjectSet): ObjectSetView => ({
  id: s.id, name: s.name, description: s.description, kind: s.kind, baseTypeId: s.baseTypeId, baseInterfaceId: s.baseInterfaceId,
  definition: setDefinition.parse(s.definition), ontologyVersionId: s.ontologyVersionId, ownerMembershipId: s.ownerMembershipId,
  visibility: s.visibility, createdAt: s.createdAt, updatedAt: s.updatedAt,
});

function checkPredicate(content: Content, typeId: string, predicate: { cel: string; properties: string[] }): string[] {
  // A saved definition holds structure; a literal that looks like a record value is refused.
  if (findValuePatterns(predicate.cel).length > 0) throw refuse('object_set.value_in_definition', 'the predicate holds what looks like a record value');
  try {
    compileCel(predicate.cel, { object: 'map', now: 'timestamp' });
  } catch {
    throw refuse('object_set.predicate_invalid', 'the predicate does not type-check');
  }
  const type = findById(content, 'object_type', typeId)!;
  for (const id of predicate.properties) {
    if (!type.properties.some((p) => p.identityId === id)) throw refuse('object_set.property_unknown', 'the predicate reads a property the type does not have');
  }
  return predicate.properties;
}

interface Checked {
  kind: ObjectSet['kind'];
  baseTypeId: string | null;
  baseInterfaceId: string | null;
  explicitIds: string[] | null;
  elements: { kind: string; id: string }[];
}

/** Checks a definition against the content and gives its base and the elements it depends on. */
async function check(db: Queryable, content: Content, def: SetDefinition, owner: string): Promise<Checked> {
  const typeExists = (id: string) => {
    if (!findById(content, 'object_type', id) || findById(content, 'object_type', id)!.status !== 'active') {
      throw refuse('object_set.type_unknown', 'the set is over an object type that is not on main');
    }
  };
  if (def.kind === 'filter') {
    if ('objectTypeId' in def.base) {
      typeExists(def.base.objectTypeId);
      const props = checkPredicate(content, def.base.objectTypeId, def.predicate);
      return { kind: 'filter', baseTypeId: def.base.objectTypeId, baseInterfaceId: null, explicitIds: null,
        elements: [{ kind: 'object_type', id: def.base.objectTypeId }, ...props.map((id) => ({ kind: 'property_identity', id }))] };
    }
    if (!findById(content, 'interface', def.base.interfaceId)) throw refuse('object_set.interface_unknown', 'the set is over an interface that is not on main');
    if (def.predicate.properties.length > 0) throw refuse('object_set.property_unknown', 'a set over an interface reads shared properties through its implementations');
    compileCel(def.predicate.cel, { object: 'map', now: 'timestamp' });
    return { kind: 'filter', baseTypeId: null, baseInterfaceId: def.base.interfaceId, explicitIds: null, elements: [{ kind: 'interface', id: def.base.interfaceId }] };
  }
  if (def.kind === 'explicit') {
    typeExists(def.objectTypeId);
    return { kind: 'explicit', baseTypeId: def.objectTypeId, baseInterfaceId: null, explicitIds: [...new Set(def.ids)], elements: [{ kind: 'object_type', id: def.objectTypeId }] };
  }
  if (def.kind === 'traversal') {
    const elements: { kind: string; id: string }[] = [];
    let current: string;
    if ('objectTypeId' in def.start) {
      typeExists(def.start.objectTypeId);
      current = def.start.objectTypeId;
      elements.push({ kind: 'object_type', id: current });
      if (def.start.predicate) elements.push(...checkPredicate(content, current, def.start.predicate).map((id) => ({ kind: 'property_identity', id })));
    } else {
      const start = await visibleSet(db, def.start.objectSetId, owner);
      if (start.baseTypeId === null) throw refuse('object_set.start_interface', 'a traversal starts from a set of one object type');
      current = start.baseTypeId;
    }
    for (const hop of def.path) {
      const link = findById(content, 'link_type', hop.linkTypeId);
      if (!link || link.status !== 'active') throw refuse('object_set.link_unknown', 'a hop names a link type that is not on main');
      const [here, there] = hop.direction === 'forward' ? [link.fromTypeId, link.toTypeId] : [link.toTypeId, link.fromTypeId];
      if (here !== current) throw refuse('object_set.path_broken', 'each hop starts where the last one ended');
      if (hop.routeId !== undefined && !link.routes.some((r) => r.id === hop.routeId)) throw refuse('object_set.route_unknown', 'the hop names a route the link does not have');
      current = there;
      elements.push({ kind: 'link_type', id: link.id });
    }
    elements.push({ kind: 'object_type', id: current });
    return { kind: 'traversal', baseTypeId: current, baseInterfaceId: null, explicitIds: null, elements };
  }
  // Set operations combine sets of the same type or interface (spec 24.4).
  const operands = await Promise.all(def.operands.map((id) => visibleSet(db, id, owner)));
  const base = operands[0]!;
  if (operands.some((o) => o.baseTypeId !== base.baseTypeId || o.baseInterfaceId !== base.baseInterfaceId)) {
    throw refuse('object_set.operands_differ', 'set operations combine sets of one type or interface');
  }
  return {
    kind: 'composite', baseTypeId: base.baseTypeId, baseInterfaceId: base.baseInterfaceId, explicitIds: null,
    elements: base.baseTypeId !== null ? [{ kind: 'object_type', id: base.baseTypeId }] : [{ kind: 'interface', id: base.baseInterfaceId! }],
  };
}

async function visibleSet(db: Queryable, id: string, membershipId: string): Promise<ObjectSet> {
  const set = await objectSetRepo.findById(db, id);
  if (!set || set.archivedAt !== null || (set.ownerMembershipId !== membershipId && set.visibility !== 'shared')) {
    throw new AppError('not_found', 'no such object set', { code: 'object_set.not_found' });
  }
  return set;
}

export async function saveObjectSet(deps: OntologyDeps, ctx: Context, input: {
  name: string; description?: string | undefined; visibility: 'private' | 'shared'; definition: SetDefinition;
}): Promise<ObjectSetView> {
  const actor = person(ctx, 'saving an object set');
  await demand(deps, ctx, 'object_set.save');
  const main = await mainBranch(deps, actor);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const content = await readContent(db, actor.organisationId, main.headVersionId!);
    const checked = await check(db, content, input.definition, actor.membershipId);
    const id = uuidv7();
    let row: ObjectSet;
    try {
      row = await objectSetRepo.insert(db, {
        id, organisationId: actor.organisationId, name: input.name, description: input.description ?? null, kind: checked.kind,
        baseTypeId: checked.baseTypeId, baseInterfaceId: checked.baseInterfaceId, definition: input.definition as never,
        explicitIds: checked.explicitIds, ontologyVersionId: main.headVersionId!, ownerMembershipId: actor.membershipId, visibility: input.visibility,
      });
    } catch (error) {
      const mapped = fromDatabaseError(error);
      if (mapped.category === 'conflict') throw new AppError('conflict', 'you have a set with that name', { code: 'object_set.name_taken' });
      throw mapped;
    }
    await ontologyDependencyRepo.record(db, { kind: 'object_set', id }, main.headVersionId!, checked.elements);
    // An artefact cannot exist without its lineage (59.3): the types, properties and links it is over, and the sets it combines.
    const versionOfType = (typeId: string) => findById(content, 'object_type', typeId)?.typeVersionId;
    const typeOfProperty = (identity: string) => content.objectTypes.find((t) => t.properties.some((p) => p.identityId === identity))?.typeVersionId;
    const operands = input.definition.kind === 'composite'
      ? await Promise.all(input.definition.operands.map((o) => objectSetRepo.findById(db, o))) : [];
    await writeLineage(db, { organisationId: actor.organisationId, createdBy: { membershipId: actor.membershipId } }, {
      artefact: { kind: 'object_set', refId: id, version: main.headVersionId! },
      inputs: [
        ...checked.elements.flatMap((e): LineageInput[] => {
          if (e.kind === 'object_type') {
            const version = versionOfType(e.id);
            return version === undefined ? [] : [{ node: { kind: 'object_type_version' as const, refId: e.id, version }, relation: 'uses' as const }];
          }
          if (e.kind === 'property_identity') {
            const version = typeOfProperty(e.id);
            return version === undefined ? [] : [{ node: { kind: 'property' as const, refId: e.id, version }, relation: 'filters_on' as const }];
          }
          if (e.kind === 'link_type') return [{ node: { kind: 'link_type_version' as const, refId: e.id, version: main.headVersionId! }, relation: 'traverses' as const }];
          return [];
        }),
        ...operands.flatMap((o): LineageInput[] => (o === undefined ? [] : [{ node: { kind: 'object_set', refId: o.id, version: o.ontologyVersionId }, relation: 'derives' }])),
      ].filter((i: LineageInput, n, all: LineageInput[]) => all.findIndex((j) => j.node.kind === i.node.kind && j.node.refId === i.node.refId && j.node.version === i.node.version && j.relation === i.relation) === n),
    });
    const resource = { type: 'object_set', id };
    await recordEvent(db, actor, ctx.correlationId, { event: 'object_set_saved', resource, detail: { kind: checked.kind } });
    if (input.visibility === 'shared') await recordEvent(db, actor, ctx.correlationId, { event: 'object_set_shared', resource });
    return view(row);
  });
}

/**
 * A set as its reader may see it: their own or a shared one. A service principal (a Cron
 * watching or running its set, spec 40.2) reads as its owner, so it never sees a set its
 * owner could not.
 */
export async function getObjectSet(deps: OntologyDeps, ctx: Context, id: string): Promise<ObjectSetView> {
  await demandView(deps, ctx);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const principalId = ctx.request.membershipId === undefined ? ctx.request.servicePrincipalId : undefined;
    const reader = principalId === undefined ? person(ctx, 'reading an object set').membershipId
      : (await servicePrincipalRepo.findById(db, principalId))?.ownerMembershipId ?? null;
    if (reader === null) throw new AppError('forbidden', 'a principal with no owner reads no object set', { code: 'ontology.person_required' });
    return view(await visibleSet(db, id, reader));
  }, { readOnly: true });
}

export async function listObjectSets(deps: OntologyDeps, ctx: Context, limit: number): Promise<ObjectSetView[]> {
  const actor = person(ctx, 'listing object sets');
  await demandView(deps, ctx);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) =>
    (await objectSetRepo.listVisible(db, actor.membershipId, limit)).map(view), { readOnly: true });
}

export async function archiveObjectSet(deps: OntologyDeps, ctx: Context, id: string): Promise<ObjectSetView> {
  const actor = person(ctx, 'removing an object set');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const set = await visibleSet(db, id, actor.membershipId);
    if (set.ownerMembershipId !== actor.membershipId) throw new AppError('forbidden', 'only the owner removes a set', { code: 'object_set.not_owner' });
    const archived = (await objectSetRepo.update(db, id, { archivedAt: new Date().toISOString(), rowVersion: set.rowVersion + 1 }))!;
    // No longer a dependant of anything.
    await ontologyDependencyRepo.record(db, { kind: 'object_set', id }, set.ontologyVersionId, []);
    await recordEvent(db, actor, ctx.correlationId, { event: 'object_set_deleted', resource: { type: 'object_set', id } });
    return view(archived);
  });
}
