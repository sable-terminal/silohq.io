// Derivation and confirmation (spec 22). Derivation reads a connection's declared structure
// (objects, fields, identifiers, foreign keys) and proposes, filled in, an object type per
// source object and a link type per declared foreign key between them, each with its
// confidence and the evidence that produced it. Proposals live on their own derivation
// branch, never on main, and nothing exists until a person confirms it.
//
// A person holding ontology.confirm, who did not request the derivation, accepts, corrects
// or rejects each decision. What they accept is committed on the derivation branch with
// them as the confirmer of every mapping, and their decision is the proposal's
// ontology.confirm approval; merge then brings it to main. Decisions left undecided move to
// a fresh derivation proposal, so the confident part can merge while the rest waits.
//
// Field profiles (spec 22.3) are taken first, best effort, through connect-runtime, which
// returns counts only (profiles.service.ts); with them an identifier is confirmed unique or
// flagged, a title is ranked by distinctness when no field is named for one, and a field
// whose values mostly do not read as its declared type is flagged. A source that cannot be
// profiled leaves the declared schema and naming as the evidence, and confidence says so.
//
// Value overlap (spec 22.4) follows (overlap.service.ts): where a field of the connection holds
// many of the identifiers another system already gives an existing type, derivation also
// proposes the object contributing to that type, matched on that property, with the counts
// as its evidence; only counts are kept. A reviewed concept template whose field names the
// object holds names its proposal (templates.service.ts, spec 22.7), says so, and is recorded
// on the type when it is confirmed.

import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { inferLinks, type InferredLink } from './linkInference.service.ts';
import type { LinkTypeDefinition, ObjectTypeDefinition } from '../../contracts/ontology/element.contract.ts';
import type { VersionView } from '../../contracts/ontology/manifest.contract.ts';
import type { DecisionView, ProposalView } from '../../contracts/ontology/proposal.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { conceptTemplateRepo, fieldAliasRepo, fieldProfileRepo, ontologyBranchRepo, ontologyProposalRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { classify, diff, findById, highest, withEntries, type AnyEntry, type Content, type ObjectTypeEntry } from './content.service.ts';
import { acting, demand, mainBranch, person, recordEvent, type Context, type OntologyDeps } from './deps.service.ts';
import { resolveLinkType, resolveObjectType } from './elements.service.ts';
import { findOverlaps, joined, type OverlapFinding } from './overlap.service.ts';
import { profileObjects, profileView, type ProfileView } from './profiles.service.ts';
import { nameFor, type TemplateMatch } from './templates.service.ts';
import { createSourceSchemas, PROPOSED_TYPE, type SourceObject, type SourceSchema } from './sourceSchema.service.ts';
import { commit, readContent, versionToView, type Write } from './store.service.ts';
import { computeImpact, openProposal, proposalView, recordApproval } from './versioning.service.ts';

type ObjectTypeProposal = Omit<ObjectTypeDefinition, 'expectedHeadVersionId'>;
type LinkTypeProposal = Omit<LinkTypeDefinition, 'expectedHeadVersionId'>;

const snake = (name: string): string => {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const lettered = /^[a-z]/.test(s) ? s : `f_${s}`;
  return lettered.slice(0, 63) || 'field';
};
const words = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim();
const title = (name: string): string => words(name).replace(/\b\w/g, (c) => c.toUpperCase());
const plural = (display: string): string => (/s$/i.test(display) ? display : /y$/i.test(display) ? `${display.slice(0, -1)}ies` : `${display}s`);

function freeName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base.slice(0, 60)}_${n}`;
  taken.add(name);
  return name;
}

/** A declared source field mapped to a property of its own name and declared type. */
const DECLARED_FIELD_CONFIDENCE = 0.9;

const TITLE_NAMES = /^(name|title|label|display_?name|full_?name|subject|description)$|_name$/i;

/** Below this share of a field's values reading as its declared type, the field is flagged. */
const TYPE_CONFORMANCE_FLOOR = 0.95;

/** The text field most distinct and least empty, when profiles rank them; ties go to declared order. */
function rankedTitle(o: SourceObject, profiles: ReadonlyMap<string, ProfileView>) {
  let best: { field: SourceObject['fields'][number]; score: number } | undefined;
  for (const f of o.fields) {
    const p = profiles.get(f.name);
    if (f.type !== 'string' || o.identifier.includes(f.name) || p === undefined || p.rowCount === 0) continue;
    const filled = (p.rowCount - p.nullCount - p.emptyCount) / p.rowCount;
    const distinct = p.distinctCount === null ? filled : p.distinctCount / p.rowCount;
    const score = distinct + filled;
    if (best === undefined || score > best.score) best = { field: f, score };
  }
  return best?.field;
}

/** One object type proposal per source object, filled in (spec 22.5). */
function proposeObjectType(source: SourceSchema, o: SourceObject, apiName: string, profiles: ReadonlyMap<string, ProfileView>, named?: TemplateMatch,
  aliases?: ReadonlyMap<string, string>)
  : DecisionView & { kind: 'object_type' } {
  const names = new Set<string>();
  const propertyOf = new Map<string, string>();
  for (const f of o.fields) propertyOf.set(f.name, freeName(snake(f.name), names));
  const identifier = o.identifier[0]!;
  const titled = o.fields.find((f) => f.type === 'string' && TITLE_NAMES.test(f.name));
  const ranked = titled === undefined ? rankedTitle(o, profiles) : undefined;
  const titleField = titled ?? ranked ?? o.fields.find((f) => f.type === 'string' && !o.identifier.includes(f.name));
  const evidence: DecisionView['evidence'] = [
    { source: 'schema', detail: `declared object ${o.name}: ${o.fields.length} fields, identifier ${o.identifier.join(', ')}` },
  ];
  if (named !== undefined) {
    evidence.push({ source: 'template', detail: `named by the concept template ${named.template.name}: ${named.matched} of its ${named.total} field names are ${o.name}'s` });
  }
  let confidence = 0.9;
  if (o.identifier.length > 1) {
    confidence = Math.min(confidence, 0.6);
    evidence.push({ source: 'schema', detail: `composite identifier: ${identifier} proposed alone; check it identifies a record` });
  }
  const id = profiles.get(identifier);
  if (id === undefined) {
    if (profiles.size === 0) evidence.push({ source: 'profile', detail: `${o.name} not profiled: the evidence is the declared schema` });
  } else if (id.distinctCount === id.rowCount && id.nullCount === 0) {
    evidence.push({ source: 'profile', detail: `identifier ${identifier}: unique and never null across all ${id.rowCount} rows` });
  } else if (id.distinctCount === null) {
    evidence.push({ source: 'profile', detail: `identifier ${identifier}: ${id.rowCount} rows examined of more, ${id.nullCount} null; uniqueness unchecked` });
    if (id.nullCount > 0) confidence = Math.min(confidence, 0.5);
  } else {
    confidence = Math.min(confidence, 0.5);
    evidence.push({ source: 'profile', detail: `identifier ${identifier}: ${id.distinctCount} distinct, ${id.nullCount} null in ${id.rowCount} rows; check it identifies a record` });
  }
  if (titleField && TITLE_NAMES.test(titleField.name)) {
    evidence.push({ source: 'naming', detail: `title ${titleField.name}, by its name` });
  } else if (ranked !== undefined) {
    confidence = Math.min(confidence, 0.75);
    evidence.push({ source: 'profile', detail: `title ${ranked.name}: the most distinct, least empty text field` });
  } else {
    confidence = Math.min(confidence, 0.6);
    evidence.push({ source: 'naming', detail: titleField ? `title ${titleField.name}: the first text field` : `title ${identifier}: no text field` });
  }
  for (const f of o.fields) {
    const p = profiles.get(f.name);
    const present = p === undefined ? 0 : p.rowCount - p.nullCount;
    if (p === undefined || present === 0 || f.type === 'json' || p.typeConformanceCount / present >= TYPE_CONFORMANCE_FLOOR) continue;
    confidence = Math.min(confidence, 0.7);
    evidence.push({ source: 'profile', detail: `${f.name}: ${present - p.typeConformanceCount} of ${present} values do not read as ${f.type}` });
  }
  // A single field the source declares unique, other than the identifier, is a match key
  // candidate for resolution across systems (spec 19.4, 23): a natural key such as an email
  // address. The identifier is not: a source's own record number means nothing elsewhere.
  const matchKeys = (o.uniqueKeys ?? []).filter((k) => k.length === 1 && k[0] !== identifier && propertyOf.has(k[0]!)).slice(0, 8)
    .map((k) => ({ property: propertyOf.get(k[0]!)! }));
  for (const k of matchKeys) evidence.push({ source: 'schema', detail: `${k.property} is declared unique: a match key candidate for resolution` });
  const timeFields = o.fields.filter((f) => f.type === 'date' || f.type === 'date-time').map((f) => ({
    property: propertyOf.get(f.name)!, meaning: words(f.name.replace(/(_at|_on|_date|At|On|Date)$/, '')).toLowerCase() || 'dated', isDefault: false,
  }));
  const definition: ObjectTypeProposal = {
    displayName: named?.template.name ?? o.label ?? title(o.name), pluralName: plural(named?.template.name ?? o.label ?? title(o.name)), description: undefined,
    contributingObjects: [{ connectionId: source.connectionId, sourceObject: o.name, identifierFieldPath: identifier }],
    properties: o.fields.map((f) => ({
      apiName: propertyOf.get(f.name)!, displayName: aliases?.get(f.name) ?? title(f.name), description: undefined, dataType: PROPOSED_TYPE[f.type], typeParams: {},
      nullable: f.nullable, mappings: [{ connectionId: source.connectionId, sourceObject: o.name, fieldPath: f.name }],
    })),
    primaryKey: propertyOf.get(identifier)!,
    title: propertyOf.get((titleField ?? { name: identifier }).name)!,
    // A derived type comes from one system: nothing to split.
    matchKeys, disjointSources: false, timeFields, implements: [], visual: {},
  };
  return { id: uuidv7(), kind: 'object_type', apiName, confidence, evidence, status: 'undecided', definition, ...(named === undefined ? {} : { templateId: named.template.id }) };
}

/** One link type per declared foreign key between two of the connection's objects (spec 21.8, 22.1). */
function proposeLinks(source: SourceSchema, typeOf: Map<string, DecisionView & { kind: 'object_type' }>, taken: Set<string>)
  : (DecisionView & { kind: 'link_type' })[] {
  const links: (DecisionView & { kind: 'link_type' })[] = [];
  for (const o of source.objects) {
    for (const r of o.relationships) {
      const holder = typeOf.get(o.name);
      const target = typeOf.get(r.targetObject);
      // A reference without a declared key is not a link: Silo must be able to show the key.
      if (!holder || !target || r.kind === 'reference') continue;
      const unique = o.identifier.length === 1 && o.identifier[0] === r.field;
      const definition: LinkTypeProposal = {
        forwardName: `has ${holder.definition.pluralName.toLowerCase()}`.slice(0, 100),
        reverseName: `belongs to ${target.definition.displayName.toLowerCase()}`.slice(0, 100),
        from: target.apiName, to: holder.apiName, cardinality: unique ? 'one_to_one' : 'one_to_many',
        routes: [{ connectionId: source.connectionId, sourceObject: o.name, foreignKeyField: r.field, referencedField: r.targetField, origin: 'declared_fk' }],
        defaultRoute: 0,
      };
      links.push({
        id: uuidv7(), kind: 'link_type', apiName: freeName(snake(`${target.apiName}_${holder.apiName}`), taken), confidence: 0.95,
        evidence: [{ source: 'declared_fk', detail: `${o.name}.${r.field} references ${r.targetObject}.${r.targetField} (${unique ? 'unique' : 'not unique'})` }],
        status: 'undecided', definition,
      });
    }
  }
  return links;
}

/** Below a declared key's: a reference read from matching names and types is a guess a person checks. */
const REFERENCE_CONFIDENCE = 0.5;

/**
 * A reference the source states without a declared key (discovery infers them from matching
 * column names and types): proposed at lower confidence and labelled inferred (spec 19.4). A
 * person accepts or rejects it; accepted, its route keeps the origin inferred (D75).
 */
function referenceDecisions(source: SourceSchema, typeOf: Map<string, DecisionView & { kind: 'object_type' }>, taken: Set<string>)
  : (DecisionView & { kind: 'link_type' })[] {
  const links: (DecisionView & { kind: 'link_type' })[] = [];
  for (const o of source.objects) {
    for (const r of o.relationships) {
      const holder = typeOf.get(o.name);
      const target = typeOf.get(r.targetObject);
      if (!holder || !target || r.kind !== 'reference') continue;
      links.push({
        id: uuidv7(), kind: 'link_type', apiName: freeName(snake(`${target.apiName}_${holder.apiName}`), taken), confidence: REFERENCE_CONFIDENCE,
        evidence: [{ source: 'naming', detail: `${o.name}.${r.field} matches ${r.targetObject}.${r.targetField} by name and type. Inferred: no key is declared.` }],
        status: 'undecided',
        definition: {
          forwardName: `has ${holder.definition.pluralName.toLowerCase()}`.slice(0, 100),
          reverseName: `belongs to ${target.definition.displayName.toLowerCase()}`.slice(0, 100),
          from: target.apiName, to: holder.apiName, cardinality: 'one_to_many',
          routes: [{ connectionId: source.connectionId, sourceObject: o.name, foreignKeyField: r.field, referencedField: r.targetField, origin: 'inferred' }],
          defaultRoute: 0,
        },
      });
    }
  }
  return links;
}

/** Inferred link decisions (D75): low-confidence decisions a person accepts or rejects, with their evidence. */
function inferredDecisions(inferred: readonly InferredLink[], source: SourceSchema, typeOf: Map<string, DecisionView & { kind: 'object_type' }>,
  taken: Set<string>): (DecisionView & { kind: 'link_type' })[] {
  return inferred.flatMap((l) => {
    const holder = typeOf.get(l.holder);
    const target = typeOf.get(l.target);
    if (!holder || !target) return [];
    const definition: LinkTypeProposal = {
      forwardName: `has ${holder.definition.pluralName.toLowerCase()}`.slice(0, 100),
      reverseName: `belongs to ${target.definition.displayName.toLowerCase()}`.slice(0, 100),
      from: target.apiName, to: holder.apiName, cardinality: 'one_to_many',
      routes: [{ connectionId: source.connectionId, sourceObject: l.holder, foreignKeyField: l.field, referencedField: l.targetField, origin: 'inferred' }],
      defaultRoute: 0,
    };
    return [{
      id: uuidv7(), kind: 'link_type' as const, apiName: freeName(snake(`${target.apiName}_${holder.apiName}`), taken), confidence: l.probability,
      evidence: [{ source: 'overlap' as const, detail: `${l.contained} of ${l.distinct} distinct ${l.holder}.${l.field} values are ${l.target} identifiers. `
        + 'Inferred, because your organisation turned link inference on: no key is declared.' }],
      status: 'undecided' as const, definition,
    }];
  });
}

/** A decision to join a derived object to an existing type, matched on the overlapping property (spec 22.4). */
function overlapDecisions(findings: readonly OverlapFinding[], source: SourceSchema, content: Content): (DecisionView & { kind: 'object_type' })[] {
  // The strongest finding per object and type: one decision each.
  const best = new Map<string, OverlapFinding>();
  for (const f of findings) {
    const key = `${f.object}/${f.typeApiName}`;
    if ((best.get(key)?.probability ?? -1) < f.probability) best.set(key, f);
  }
  return [...best.values()].flatMap((f) => {
    const type = content.objectTypes.find((t) => t.apiName === f.typeApiName && t.status === 'active');
    if (type === undefined) return [];
    return [{
      id: uuidv7(), kind: 'object_type' as const, apiName: type.apiName, confidence: f.probability,
      evidence: [{ source: 'overlap' as const, detail: `${f.shared} of ${f.sampled} distinct ${f.object}.${f.field} values are held in ${f.sourceObject}.${f.fieldPath}, `
        + `which ${type.apiName}.${f.property} maps: ${f.object} proposed as contributing to ${type.apiName}, matched on ${f.property}.` }],
      status: 'undecided' as const, definition: joined(type, content, source, f),
    }];
  });
}

export async function startDerivation(deps: OntologyDeps, ctx: Context, connectionId: string, options: { profile?: boolean; overlap?: boolean } = {})
  : Promise<ProposalView> {
  const actor = acting(ctx);
  await demand(deps, ctx, 'ontology.propose');
  const main = await mainBranch(deps, actor);
  // discover objects -> profile fields -> ... (spec 22.2): best effort, outside the transaction.
  if (options.profile !== false) await profileObjects(deps, ctx, connectionId);
  // Inferred links (D75), where the organisation turned it on: bounded reads, outside the transaction.
  const inferring = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => (await organisationRepo.findById(db, actor.organisationId))?.inferenceLinks === true,
    { readOnly: true });
  const inferred = !inferring ? [] : await inferLinks(deps, ctx,
    await inTransaction(deps.databases.pool('control'), ctx.request, (db) => createSourceSchemas(db).of(connectionId), { readOnly: true }));
  // Value overlap with the types other systems already feed (spec 22.4): bounded reads, outside the transaction.
  const overlaps = options.overlap === false ? [] : await findOverlaps(deps, ctx, ...await inTransaction(deps.databases.pool('control'), ctx.request,
    async (db) => [await createSourceSchemas(db).of(connectionId), await readContent(db, actor.organisationId, main.headVersionId!)] as const, { readOnly: true }));
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const source = await createSourceSchemas(db).of(connectionId);
    const profiles = new Map<string, Map<string, ProfileView>>();
    for (const p of (await fieldProfileRepo.latestForConnection(db, connectionId)).map(profileView)) {
      if (!profiles.has(p.sourceObject)) profiles.set(p.sourceObject, new Map());
      profiles.get(p.sourceObject)!.set(p.fieldPath, p);
    }
    const mainContent = await readContent(db, actor.organisationId, main.headVersionId!);
    const taken = new Set([...mainContent.objectTypes, ...mainContent.linkTypes].map((e) => e.apiName));
    const typeOf = new Map<string, DecisionView & { kind: 'object_type' }>();
    const templates = await conceptTemplateRepo.listReviewed(db);
    // The organisation's names for the connection's columns (21.6): each property built over one is named by it.
    const aliases = new Map((await fieldAliasRepo.live(db, connectionId)).map((a) => [a.fieldPath, a.alias]));
    for (const o of source.objects) {
      const named = nameFor(templates, o.fields.map((f) => f.name));
      typeOf.set(o.name, proposeObjectType(source, o, freeName(snake(named?.template.name ?? o.name), taken), profiles.get(o.name) ?? new Map(), named, aliases));
    }
    const joins = overlapDecisions(overlaps, source, mainContent);
    const decisions: DecisionView[] = [
      ...typeOf.values(), ...joins, ...proposeLinks(source, typeOf, taken), ...referenceDecisions(source, typeOf, taken),
      ...inferredDecisions(inferred, source, typeOf, taken),
    ];

    const branchId = uuidv7();
    await ontologyBranchRepo.insert(db, {
      id: branchId, organisationId: actor.organisationId, name: `derivation ${source.connectionName} ${branchId.slice(-8)}`.slice(0, 100),
      kind: 'derivation', baseVersionId: main.headVersionId, headVersionId: main.headVersionId, ownerMembershipId: actor.membershipId ?? null, status: 'open',
    });
    const resource = { type: 'connection', id: connectionId };
    await recordEvent(db, actor, ctx.correlationId, { event: 'derivation_started', resource, detail: { branch_id: branchId } });
    // Counts only: the values were never kept.
    for (const f of overlaps) {
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'overlap_computed', resource,
        detail: { object: f.object, field: f.field, object_type: f.typeApiName, property: f.property, sampled: f.sampled, shared: f.shared },
      });
    }
    const branch = (await ontologyBranchRepo.findById(db, branchId))!;
    const proposal = await openProposal(db, actor, ctx.correlationId, branch, {
      title: `Derived from ${source.connectionName}`.slice(0, 200), description: null, origin: 'derivation', decisions,
    });
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'derivation_completed', resource,
      detail: { proposal_id: proposal.id, object_types: typeOf.size, joins: joins.length, link_types: decisions.length - typeOf.size - joins.length },
    });
    return proposalView(db, proposal);
  });
}

type DecisionInput =
  | { decisionId: string; action: 'accept' }
  | { decisionId: string; action: 'reject' }
  | { decisionId: string; action: 'correct'; objectType?: ObjectTypeProposal | undefined; linkType?: LinkTypeProposal | undefined };

export async function confirmDecisions(deps: OntologyDeps, ctx: Context, proposalId: string, inputs: DecisionInput[])
  : Promise<{ proposal: ProposalView; version: VersionView | null; followUpProposalId: string | null }> {
  const actor = person(ctx, 'confirming');
  await demand(deps, ctx, 'ontology.confirm');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const p = await ontologyProposalRepo.lock(db, proposalId);
    if (!p) throw new AppError('not_found', 'no such proposal', { code: 'ontology.proposal_not_found' });
    if (p.origin !== 'derivation') throw new AppError('conflict', 'only a derivation proposal has decisions', { code: 'ontology.not_derivation' });
    if (p.status !== 'in_review') throw new AppError('conflict', `the proposal is ${p.status}`, { code: 'ontology.proposal_not_open' });
    // The person who asked for the derivation does not confirm it (spec 25.4).
    if (p.authorMembershipId === actor.membershipId) {
      throw new AppError('forbidden', 'the author of a proposal does not approve it', { code: 'ontology.author_cannot_approve' });
    }
    const stored = (p.changes as unknown as { decisions?: DecisionView[] }).decisions ?? [];
    const byId = new Map(stored.map((d) => [d.id, d]));
    const seen = new Set<string>();
    for (const input of inputs) {
      const d = byId.get(input.decisionId);
      if (!d) throw new AppError('validation', 'no such decision on this proposal', { code: 'ontology.decision_unknown', details: { decisionId: input.decisionId } });
      if (d.status !== 'undecided' || seen.has(d.id)) throw new AppError('conflict', 'that decision is decided', { code: 'ontology.decision_decided' });
      seen.add(d.id);
      if (input.action === 'correct' && (d.kind === 'object_type' ? input.objectType === undefined : input.linkType === undefined)) {
        throw new AppError('validation', `a correction of a ${d.kind} gives its corrected definition`, { code: 'ontology.correction_missing' });
      }
    }

    const branch = (await ontologyBranchRepo.lock(db, p.branchId))!;
    if (branch.status !== 'open') throw new AppError('conflict', 'the branch is closed', { code: 'ontology.branch_closed' });
    const head = await readContent(db, actor.organisationId, branch.headVersionId!);
    const sources = createSourceSchemas(db);
    const now = new Date().toISOString();
    const decided = stored.map((d): DecisionView => {
      const input = inputs.find((i) => i.decisionId === d.id);
      if (!input) return d;
      if (input.action === 'reject') return { ...d, status: 'rejected' };
      if (input.action === 'accept') return { ...d, status: 'accepted' };
      return d.kind === 'object_type' ? { ...d, status: 'corrected', definition: input.objectType! } : { ...d, status: 'corrected', definition: input.linkType! };
    });

    // Types first, then the links between them, each resolved against what is accepted so far.
    let content: Content = head;
    const writes: Write[] = [];
    for (const kind of ['object_type', 'link_type'] as const) {
      for (const d of decided.filter((x) => x.kind === kind && (x.status === 'accepted' || x.status === 'corrected'))) {
        const authoring = {
          content, sources, confirmer: actor.membershipId, now,
          // A mapping accepted as derived keeps the derivation's confidence in a declared field
          // mapped by its own name; a corrected one is the person's.
          confidence: () => (d.status === 'accepted' ? DECLARED_FIELD_CONFIDENCE : 1),
        };
        let entry: AnyEntry;
        try {
          entry = d.kind === 'object_type' ? await resolveObjectType(d.definition, d.apiName, authoring) : await resolveLinkType(d.definition, d.apiName, authoring);
        } catch (error) {
          if (d.kind === 'link_type' && error instanceof AppError && error.code === 'ontology.object_type_unknown') {
            throw new AppError('validation', 'a link is accepted only with both of its object types', {
              code: 'ontology.decision_depends_on_rejected', details: { decisionId: d.id },
            });
          }
          throw error;
        }
        const before = findById(content, d.kind, entry.id);
        writes.push({
          kind: d.kind, entry, operation: before ? 'change' : 'create', changeClass: classify(d.kind, before as never, entry as never).changeClass,
          // The template that named a type it creates (spec 22.7), kept with the type.
          ...(d.kind === 'object_type' && d.templateId !== undefined && !before ? { templateId: d.templateId } : {}),
        });
        content = withEntries(content, [{ kind: d.kind, entry }]);
      }
    }

    let version: VersionView | null = null;
    if (writes.length > 0) {
      const result = await commit(db, {
        organisationId: actor.organisationId, branch, parentVersionId: branch.headVersionId!, parentContent: head, kind: 'change', actor, writes,
      });
      version = versionToView(result.version, branch);
    }
    for (const d of decided.filter((x) => seen.has(x.id))) {
      const resource = { type: 'ontology_proposal', id: p.id };
      if (d.status === 'accepted') await recordEvent(db, actor, ctx.correlationId, { event: 'proposal_decision_confirmed', resource, detail: { decision_id: d.id, kind: d.kind } });
      if (d.status === 'corrected') await recordEvent(db, actor, ctx.correlationId, { event: 'proposal_decision_corrected', resource, detail: { decision_id: d.id, kind: d.kind } });
      if (d.status === 'rejected' && d.kind === 'object_type') {
        await recordEvent(db, actor, ctx.correlationId, { event: 'object_type_rejected', resource, detail: { decision_id: d.id } });
      }
    }

    // What waits moves to its own proposal, so this one can merge.
    const waiting = decided.filter((d) => d.status === 'undecided');
    let followUpProposalId: string | null = null;
    if (waiting.length > 0) {
      const main = (await ontologyBranchRepo.findMain(db))!;
      const followBranchId = uuidv7();
      await ontologyBranchRepo.insert(db, {
        id: followBranchId, organisationId: actor.organisationId, name: `${branch.name.slice(0, 80)} rest ${followBranchId.slice(-6)}`,
        kind: 'derivation', baseVersionId: main.headVersionId, headVersionId: main.headVersionId, ownerMembershipId: branch.ownerMembershipId, status: 'open',
      });
      const follow = await openProposal(db, actor, ctx.correlationId, (await ontologyBranchRepo.findById(db, followBranchId))!, {
        title: p.title, description: p.description, origin: 'derivation', decisions: waiting,
        author: { organisationId: actor.organisationId, membershipId: p.authorMembershipId ?? undefined, servicePrincipalId: p.authorServicePrincipalId ?? undefined },
      });
      followUpProposalId = follow.id;
    }

    const kept = decided.filter((d) => d.status !== 'undecided');
    const moved = (await ontologyBranchRepo.findById(db, branch.id))!;
    if (writes.length === 0) {
      // Everything was rejected or moved on: nothing here to merge.
      const closed = (await ontologyProposalRepo.update(db, p.id, {
        changes: { changes: [], decisions: kept } as never, status: 'rejected', decidedAt: now, rowVersion: p.rowVersion + 1,
      }))!;
      await ontologyBranchRepo.update(db, branch.id, { status: 'abandoned', closedAt: now, rowVersion: moved.rowVersion + 1 });
      await recordEvent(db, actor, ctx.correlationId, { event: 'proposal_rejected', resource: { type: 'ontology_proposal', id: p.id } });
      return { proposal: await proposalView(db, closed), version, followUpProposalId };
    }
    const [base, headNow] = await Promise.all([readContent(db, actor.organisationId, moved.baseVersionId!), readContent(db, actor.organisationId, moved.headVersionId!)]);
    const changes = diff(base, headNow);
    const main = (await ontologyBranchRepo.findMain(db))!;
    const updated = (await ontologyProposalRepo.update(db, p.id, {
      changes: { changes, decisions: kept } as never, highestChangeClass: highest(changes.map((c) => c.changeClass)) ?? 'additive',
      impact: (await computeImpact(db, changes, base, headNow, main.headVersionId!)) as never, impactComputedAt: now, rowVersion: p.rowVersion + 1,
    }))!;
    const approved = await recordApproval(db, actor, ctx.correlationId, updated, 'ontology.confirm');
    return { proposal: await proposalView(db, approved), version, followUpProposalId };
  });
}

export type { ObjectTypeEntry };
