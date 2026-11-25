// The ontology's versions in the database (spec 25.1; design: "Ontology domain").
//
// A version's content is read by walking its chain (the version, its parent, and back to
// main's first version) and taking, for each element, the newest entry in the chain: an
// object type version for a type, an element revision for a link type, interface, shared
// property or function. A branch's first version has main's head as its parent, so a
// branch sees main as it stood at its base plus its own changes; a merge copies the
// branch's entries onto main, so main's chain holds its whole history itself.
//
// A commit writes one new version: the version row, then the rows of each element it
// writes, all in one transaction (the schema refuses child rows added later). Its manifest
// hash is computed before anything is written, from the parent's content and the writes,
// so it equals the hash of the content read back.
//
// Elements created on a branch also get their current-state row (status proposed, with the
// branch as origin) so other rows can refer to them; main readers never see those rows,
// because main's content comes from main's chain. A merge brings the current-state rows
// level with main.
//
// Every entry says where its element stands in that version (spec 25.7): active,
// deprecated (with its replacement and earliest retirement), or retired. A retired entry
// takes the element out of the content from that version on; earlier versions, which
// lineage references, keep it. A change keeps the element where it stood; deprecation,
// retirement and rollback say otherwise. Only a rollback brings a retired or deprecated
// element back to active (spec 25.8).

import { versionView, type FunctionView, type InterfaceView, type LinkTypeView, type SharedPropertyView, type VersionView,
  functionView, interfaceView, linkTypeView, sharedPropertyView } from '../../contracts/ontology/manifest.contract.ts';
import type { ChangeClass, ElementKind } from '../../contracts/ontology/proposal.contract.ts';
import type { Queryable } from '../../infra/postgres.infra.ts';
import type { JsonValue } from '../../models/table.model.ts';
import type { OntologyBranch } from '../../models/ontology/ontologyBranch.model.ts';
import type { OntologyVersion } from '../../models/ontology/ontologyVersion.model.ts';
import {
  contributingObjectRepo, elementRevisionRepo, functionRepo, functionVersionRepo, interfaceImplementationRepo, interfaceRepo,
  interfaceRequiredPropertyRepo, linkTypeRepo, linkTypeRouteRepo, objectTypeRepo, objectTypeVersionRepo, ontologyBranchRepo,
  ontologyVersionRepo, propertyIdentityRepo, propertyMappingRepo, propertyRepo, sharedPropertyRepo, timeFieldRepo,
} from '../../repos/ontology/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  contentHash, ELEMENT_KIND_LIST, emptyContent, findById, withEntries, type AnyEntry, type Content, type MappingEntry, type ObjectTypeEntry,
  type PropertyEntry,
} from './content.service.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { writeLineage } from '../lineage/writer.service.ts';

export interface Actor {
  membershipId?: string | undefined;
  servicePrincipalId?: string | undefined;
}

const createdBy = (actor: Actor) => (actor.membershipId !== undefined
  ? { createdByMembershipId: actor.membershipId, createdByServicePrincipalId: null }
  : { createdByMembershipId: null, createdByServicePrincipalId: actor.servicePrincipalId! });

export interface LoadedVersion {
  version: VersionView;
  branch: OntologyBranch;
  content: Content;
}

export function versionToView(row: OntologyVersion, branch: Pick<OntologyBranch, 'kind'>): VersionView {
  return versionView.parse({
    id: row.id, branchId: row.branchId, branchKind: branch.kind, sequence: Number(row.sequence), parentVersionId: row.parentVersionId,
    kind: row.kind, manifestHash: row.manifestHash.toString('hex'), createdAt: row.createdAt,
  });
}

// ----------------------------------------------------------------------------- reading

// Versions never change, so their content is kept once read. Bounded; oldest out first.
const cache = new Map<string, Content>();
const CACHE_LIMIT = 256;
const remember = (key: string, content: Content): void => {
  cache.set(key, content);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
};

export type Lifecycle = 'active' | 'deprecated' | 'retired';

/**
 * An entry's status and deprecation, from where it stands. Active reads as active on main
 * and proposed while only on a branch; the deprecation fields appear only when deprecated,
 * so an active element's manifest is unchanged by them.
 */
function standing(lifecycle: Lifecycle, onMain: boolean, replacedById: string | null, retireAfter: string | null) {
  if (lifecycle === 'active') return { status: onMain ? 'active' as const : 'proposed' as const };
  return { status: lifecycle, replacedById, ...(retireAfter === null ? {} : { retireAfter }) };
}

async function readObjectTypes(db: Queryable, chain: { id: string; depth: number; onMain: boolean }[]): Promise<ObjectTypeEntry[]> {
  const latest = await objectTypeVersionRepo.latestInChain(db, chain);
  if (latest.length === 0) return [];
  const versionIds = latest.map((l) => l.typeVersionId);
  const [types, versions, properties, mappings, objects, timeFields, implementations] = await Promise.all([
    objectTypeRepo.listByIds(db, latest.map((l) => l.objectTypeId)),
    objectTypeVersionRepo.listByIds(db, versionIds),
    propertyRepo.listForVersions(db, versionIds),
    propertyMappingRepo.listForVersions(db, versionIds),
    contributingObjectRepo.listForVersions(db, versionIds),
    timeFieldRepo.listForVersions(db, versionIds),
    interfaceImplementationRepo.listForVersions(db, versionIds),
  ]);
  const typeById = new Map(types.map((t) => [t.id, t]));
  const versionById = new Map(versions.map((v) => [v.id, v]));
  return latest.filter((l) => versionById.get(l.typeVersionId)!.lifecycle !== 'retired').map((l) => {
    const v = versionById.get(l.typeVersionId)!;
    const own = properties.filter((p) => p.objectTypeVersionId === v.id);
    const identityOfRow = new Map(own.map((p) => [p.id, p.propertyIdentityId]));
    const props: PropertyEntry[] = own.map((p) => ({
      identityId: p.propertyIdentityId, apiName: p.apiName, displayName: p.displayName, description: p.description,
      dataType: p.dataType as PropertyEntry['dataType'], typeParams: p.typeParams as PropertyEntry['typeParams'], nullable: p.nullable,
      isMatchKey: p.isMatchKey, sharedPropertyId: p.sharedPropertyId, computedFunctionVersionId: p.computedFunctionVersionId,
      status: p.status as PropertyEntry['status'],
      mappings: mappings.filter((m) => m.objectTypeVersionId === v.id && m.propertyId === p.id).map((m): MappingEntry => ({
        connectionId: m.connectionId, sourceObject: m.sourceObject, fieldPath: m.fieldPath,
        valueMap: m.valueMap as Record<string, string> | null, sourceTimeZone: m.sourceTimeZone, confidence: Number(m.confidence),
        confirmedBy: m.confirmedBy, confirmedAt: m.confirmedAt,
      })),
    }));
    const ownTime = timeFields.filter((t) => t.objectTypeVersionId === v.id);
    const strategy = v.matchStrategy as { keys?: { propertyIdentityId: string; normalisation: string | null }[]; disjointSources?: boolean };
    return {
      id: l.objectTypeId, typeVersionId: v.id, apiName: typeById.get(l.objectTypeId)!.apiName,
      ...standing(v.lifecycle, l.onMain, v.replacedById, v.retireAfter),
      displayName: v.displayName, pluralName: v.pluralName, description: v.description,
      resolutionClass: v.resolutionClass as ObjectTypeEntry['resolutionClass'], matchKeys: strategy.keys ?? [],
      ...(strategy.disjointSources === true ? { disjointSources: true } : {}),
      primaryKeyPropertyIdentityId: v.primaryKeyPropertyId === null ? null : identityOfRow.get(v.primaryKeyPropertyId)!,
      titlePropertyIdentityId: identityOfRow.get(v.titlePropertyId)!,
      defaultTimeFieldPropertyIdentityId: v.defaultTimeFieldId === null ? null
        : identityOfRow.get(ownTime.find((t) => t.id === v.defaultTimeFieldId)!.propertyId)!,
      contributingObjects: objects.filter((o) => o.objectTypeVersionId === v.id).map((o) => ({
        connectionId: o.connectionId, sourceObject: o.sourceObject, identifierFieldPath: o.identifierFieldPath, connectorVersion: o.connectorVersion,
      })),
      properties: props,
      timeFields: ownTime.map((t) => ({ propertyIdentityId: identityOfRow.get(t.propertyId)!, meaning: t.meaning, isDefault: t.isDefault })),
      implements: implementations.filter((i) => i.objectTypeVersionId === v.id).map((i) => ({
        interfaceId: i.interfaceId,
        propertyBindings: Object.fromEntries(Object.entries(i.propertyBindings as Record<string, string>).map(([sp, row]) => [sp, identityOfRow.get(row)!])),
        linkBindings: i.linkBindings as Record<string, string>,
      })),
      visual: v.visual as ObjectTypeEntry['visual'],
    };
  });
}

const REVISION_KINDS = [
  ['linkTypeId', 'link_type'], ['interfaceId', 'interface'], ['sharedPropertyId', 'shared_property'], ['functionId', 'function'],
] as const;

async function readElements(db: Queryable, chain: { id: string; depth: number; onMain: boolean }[], content: Content): Promise<void> {
  for (const r of await elementRevisionRepo.latestInChain(db, chain)) {
    const kind = REVISION_KINDS.find(([column]) => r[column] !== null)?.[1];
    if (kind === undefined) continue; // field authorities: chapter 23, not part of the manifest yet
    if (r.lifecycle === 'retired') continue;
    const entry = { ...(r.snapshot as object), id: r.elementRef, ...standing(r.lifecycle, r.onMain, r.replacedByRef, r.retireAfter) };
    if (kind === 'link_type') content.linkTypes.push(linkTypeView.parse(entry));
    else if (kind === 'interface') content.interfaces.push(interfaceView.parse(entry));
    else if (kind === 'shared_property') content.sharedProperties.push(sharedPropertyView.parse(entry));
    else content.functions.push(functionView.parse(entry));
  }
}

/** The content of a version (cached: versions never change). */
export async function readContent(db: Queryable, organisationId: string, versionId: string): Promise<Content> {
  const key = `${organisationId}/${versionId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const chain = await ontologyVersionRepo.chain(db, versionId);
  if (chain.length === 0) throw new AppError('not_found', 'no such ontology version', { code: 'ontology.version_not_found' });
  const content = emptyContent();
  content.objectTypes = await readObjectTypes(db, chain);
  await readElements(db, chain, content);
  remember(key, content);
  return content;
}

export async function loadVersion(db: Queryable, organisationId: string, versionId: string): Promise<LoadedVersion> {
  const row = await ontologyVersionRepo.findById(db, versionId);
  if (!row) throw new AppError('not_found', 'no such ontology version', { code: 'ontology.version_not_found' });
  const branch = (await ontologyBranchRepo.findById(db, row.branchId))!;
  return { version: versionToView(row, branch), branch, content: await readContent(db, organisationId, versionId) };
}

// ----------------------------------------------------------------------------- main

/**
 * Main exists for every organisation (spec 25.3). It is created on first use, with an empty
 * first version, by whoever first touches the ontology. Call in its own transaction: a
 * concurrent creation loses on the one-main index and the caller reads the winner.
 */
export async function createMain(db: Queryable, organisationId: string, actor: Actor): Promise<OntologyBranch> {
  const branchId = uuidv7();
  const versionId = uuidv7();
  await ontologyBranchRepo.insert(db, {
    id: branchId, organisationId, name: 'main', kind: 'main', baseVersionId: null, headVersionId: versionId, status: 'open',
  });
  await ontologyVersionRepo.insert(db, {
    id: versionId, organisationId, branchId, sequence: '1', parentVersionId: null, kind: 'migration',
    manifestHash: contentHash(emptyContent()), ...createdBy(actor),
  });
  return (await ontologyBranchRepo.findById(db, branchId))!;
}

// ----------------------------------------------------------------------------- writing

export interface Write {
  kind: ElementKind;
  entry: AnyEntry;
  operation: 'create' | 'change' | 'deprecate' | 'retire';
  changeClass: ChangeClass;
  /** Where the element stands after: default, where it stood before (active for a new one). */
  lifecycle?: Lifecycle;
  /** Function writes: the version row is new and is written with this commit. */
  publishesFunctionVersion?: boolean;
  /** A new object type a concept template named (spec 22.7): kept on its row, which freezes it. */
  templateId?: string | undefined;
}

export interface CommitInput {
  organisationId: string;
  branch: OntologyBranch;
  parentVersionId: string;
  parentContent: Content;
  kind: 'change' | 'merge' | 'rollback' | 'migration';
  actor: Actor;
  writes: Write[];
  mergedFromProposalId?: string;
  /** Rebase: the branch's new base (main's head, also the parent). */
  newBaseVersionId?: string;
  /** Merge: the person whose approval confirms the elements it brings to main. */
  confirmer?: string;
  /** Rollback: the main version whose content this version restores. */
  rolledBackToVersionId?: string;
}

const snapshotOf = (entry: AnyEntry): { [key: string]: JsonValue } => {
  const { id: _id, status: _status, replacedById: _r, retireAfter: _a, ...rest } = entry as unknown as Record<string, JsonValue>;
  return rest;
};

const lifecycleOfStatus = (status: string | undefined): Lifecycle =>
  status === 'deprecated' ? 'deprecated' : status === 'retired' ? 'retired' : 'active';

/** The content without the elements a retired entry took out. */
function withoutRetired(content: Content): Content {
  const keep = <T extends { status: string }>(list: T[]) => list.filter((e) => e.status !== 'retired');
  return {
    objectTypes: keep(content.objectTypes), linkTypes: keep(content.linkTypes), sharedProperties: keep(content.sharedProperties),
    interfaces: keep(content.interfaces), functions: keep(content.functions),
  };
}

/** Writes one version and its element rows. Call inside a transaction holding the branch's lock. */
export async function commit(db: Queryable, input: CommitInput): Promise<{ version: OntologyVersion; content: Content }> {
  const { organisationId, branch, actor } = input;
  const onMain = branch.kind === 'main';
  // Only a rollback brings an element back to active (spec 25.8): the status trigger allows it in this transaction.
  if (input.kind === 'rollback') await ontologyVersionRepo.allowStatusRollback(db);
  // Status is where an element stands: active once on main, proposed while only on a branch;
  // deprecated and retired as its lifecycle says, wherever it is.
  const placed = input.writes.map((w) => {
    const before = findById(input.parentContent, w.kind, w.entry.id);
    const lifecycle: Lifecycle = w.lifecycle ?? lifecycleOfStatus(before?.status);
    const { replacedById, retireAfter, ...plain } = w.entry as AnyEntry & { replacedById?: string | null; retireAfter?: string };
    const status = lifecycle !== 'active' ? lifecycle : onMain || before?.status === 'active' ? 'active' : 'proposed';
    const deprecation = lifecycle === 'active' ? {} : {
      replacedById: replacedById !== undefined ? replacedById : before?.replacedById ?? null,
      ...((retireAfter ?? before?.retireAfter) === undefined ? {} : { retireAfter: retireAfter ?? before!.retireAfter }),
    };
    const entry = w.kind === 'object_type'
      ? { ...(plain as ObjectTypeEntry), typeVersionId: uuidv7(), status, ...deprecation } : { ...plain, status, ...deprecation };
    return { ...w, entry: entry as AnyEntry, before, lifecycle };
  }).sort((a, b) => ELEMENT_KIND_LIST.indexOf(a.kind) - ELEMENT_KIND_LIST.indexOf(b.kind));
  const content = withoutRetired(withEntries(input.parentContent, placed));

  const versionId = uuidv7();
  const version = await ontologyVersionRepo.insert(db, {
    id: versionId, organisationId, branchId: branch.id, sequence: String(await ontologyVersionRepo.nextSequence(db, branch.id)),
    parentVersionId: input.parentVersionId, kind: input.kind, mergedFromProposalId: input.mergedFromProposalId ?? null,
    rolledBackToVersionId: input.rolledBackToVersionId ?? null,
    manifestHash: contentHash(content), ...createdBy(actor),
  });
  const now = new Date().toISOString();
  for (const w of placed) {
    if (w.kind === 'object_type') {
      await writeObjectType(db, { organisationId, branch, versionId, actor, now, confirmer: input.confirmer, onMain },
        w.entry as ObjectTypeEntry, w.before as ObjectTypeEntry | undefined, w.changeClass, w.lifecycle, w.templateId);
    } else {
      await writeElement(db, { organisationId, branch, versionId, actor, now, confirmer: input.confirmer, onMain }, w);
    }
  }
  const moved = await ontologyBranchRepo.update(db, branch.id, {
    headVersionId: versionId, rowVersion: branch.rowVersion + 1,
    ...(input.newBaseVersionId === undefined ? {} : { baseVersionId: input.newBaseVersionId }),
  });
  if (!moved) throw new AppError('conflict', 'the branch moved', { code: 'ontology.branch_moved' });
  return { version, content };
}

interface Place {
  organisationId: string;
  branch: OntologyBranch;
  versionId: string;
  actor: Actor;
  now: string;
  confirmer: string | undefined;
  onMain: boolean;
}

/** The current-state row's status and lifecycle stamps on main, from where the element now stands. */
const stamped = (lifecycle: Lifecycle, at: Place, existing: { deprecatedAt?: string | null; retiredAt?: string | null } | undefined) => ({
  status: lifecycle,
  ...(lifecycle === 'deprecated' && !existing?.deprecatedAt ? { deprecatedAt: at.now } : {}),
  ...(lifecycle === 'retired' && !existing?.retiredAt ? { retiredAt: at.now } : {}),
});

async function writeObjectType(db: Queryable, at: Place, entry: ObjectTypeEntry, before: ObjectTypeEntry | undefined, changeClass: ChangeClass,
  lifecycle: Lifecycle, templateId?: string): Promise<void> {
  const { organisationId } = at;
  const existing = await objectTypeRepo.findById(db, entry.id);
  if (!existing) {
    await objectTypeRepo.insert(db, {
      id: entry.id, organisationId, apiName: entry.apiName, status: 'proposed', currentVersionId: null, ...createdBy(at.actor),
      originBranchId: at.onMain ? null : at.branch.id, templateId: templateId ?? null,
    });
  }
  await propertyIdentityRepo.ensure(db, entry.properties.map((p) => ({ id: p.identityId, organisationId, objectTypeId: entry.id })));
  const rowOf = new Map(entry.properties.map((p) => [p.identityId, uuidv7()]));
  const timeRowOf = new Map(entry.timeFields.map((t) => [t.propertyIdentityId, uuidv7()]));
  await objectTypeVersionRepo.insert(db, {
    id: entry.typeVersionId, organisationId, objectTypeId: entry.id, ontologyVersionId: at.versionId, branchId: at.branch.id,
    parentVersionId: before?.typeVersionId ?? null, displayName: entry.displayName, pluralName: entry.pluralName,
    description: entry.description, resolutionClass: entry.resolutionClass,
    // The match strategy: how the type's records across systems relate (its keys, and a declared disjoint split, 27.7).
    matchStrategy: entry.resolutionClass === 'resolvable' ? { keys: entry.matchKeys, ...(entry.disjointSources === true ? { disjointSources: true } : {}) } : {},
    primaryKeyPropertyId: entry.primaryKeyPropertyIdentityId === null ? null : rowOf.get(entry.primaryKeyPropertyIdentityId)!,
    titlePropertyId: rowOf.get(entry.titlePropertyIdentityId)!,
    defaultTimeFieldId: entry.defaultTimeFieldPropertyIdentityId === null ? null : timeRowOf.get(entry.defaultTimeFieldPropertyIdentityId)!,
    visual: entry.visual, changeClass, lifecycle,
    replacedById: lifecycle === 'active' ? null : entry.replacedById ?? null,
    retireAfter: lifecycle === 'active' ? null : entry.retireAfter ?? null,
    ...createdBy(at.actor),
  });
  for (const p of entry.properties) {
    await propertyRepo.insert(db, {
      id: rowOf.get(p.identityId)!, organisationId, objectTypeVersionId: entry.typeVersionId, propertyIdentityId: p.identityId,
      apiName: p.apiName, displayName: p.displayName, description: p.description, dataType: p.dataType, typeParams: p.typeParams,
      nullable: p.nullable, isMatchKey: p.isMatchKey, sharedPropertyId: p.sharedPropertyId,
      computedFunctionVersionId: p.computedFunctionVersionId, status: p.status,
    });
  }
  for (const o of entry.contributingObjects) {
    await contributingObjectRepo.insert(db, {
      id: uuidv7(), organisationId, objectTypeVersionId: entry.typeVersionId, connectionId: o.connectionId, sourceObject: o.sourceObject,
      identifierFieldPath: o.identifierFieldPath, connectorVersion: o.connectorVersion,
    });
  }
  const mappingIds: { identityId: string; id: string; connectionId: string }[] = [];
  for (const p of entry.properties) {
    for (const m of p.mappings) {
      const mappingId = uuidv7();
      mappingIds.push({ identityId: p.identityId, id: mappingId, connectionId: m.connectionId });
      await propertyMappingRepo.insert(db, {
        id: mappingId, organisationId, objectTypeVersionId: entry.typeVersionId, propertyId: rowOf.get(p.identityId)!,
        connectionId: m.connectionId, sourceObject: m.sourceObject, fieldPath: m.fieldPath, valueMap: m.valueMap,
        sourceTimeZone: m.sourceTimeZone, confidence: m.confidence.toFixed(3), confirmedBy: m.confirmedBy, confirmedAt: m.confirmedAt,
      });
    }
  }
  for (const t of entry.timeFields) {
    await timeFieldRepo.insert(db, {
      id: timeRowOf.get(t.propertyIdentityId)!, organisationId, objectTypeVersionId: entry.typeVersionId,
      propertyId: rowOf.get(t.propertyIdentityId)!, meaning: t.meaning, isDefault: t.isDefault,
    });
  }
  for (const i of entry.implements) {
    await interfaceImplementationRepo.insert(db, {
      id: uuidv7(), organisationId, interfaceId: i.interfaceId, objectTypeVersionId: entry.typeVersionId,
      propertyBindings: Object.fromEntries(Object.entries(i.propertyBindings).map(([sp, identity]) => [sp, rowOf.get(identity)!])),
      linkBindings: i.linkBindings,
    });
  }
  if (at.onMain) await typeLineage(db, at, entry, mappingIds);
  if (at.onMain) {
    await objectTypeRepo.update(db, entry.id, {
      currentVersionId: entry.typeVersionId, ...stamped(lifecycle, at, existing),
      originBranchId: null,
      ...(existing?.confirmedBy ? {} : { confirmedBy: at.confirmer ?? at.actor.membershipId!, confirmedAt: at.now }),
    });
  }
}

/**
 * A type version on main, in lineage (59.2): each mapped source field is read via its
 * connection (at the connector version it runs) and maps_to its property; each property is a
 * member_of the type version. Written in the commit's transaction, so a version cannot exist
 * without it (59.3), and the property inherits the field's and the connection's markings.
 */
async function typeLineage(db: Queryable, at: Place, entry: ObjectTypeEntry, mappings: readonly { identityId: string; id: string; connectionId: string }[])
  : Promise<void> {
  const actor = {
    organisationId: at.organisationId,
    createdBy: at.actor.membershipId !== undefined ? { membershipId: at.actor.membershipId } : { servicePrincipalId: at.actor.servicePrincipalId },
  };
  const versionOf = new Map<string, string>();
  for (const connectionId of new Set(mappings.map((m) => m.connectionId))) {
    const connection = await connectionRepo.findById(db, connectionId);
    const manifest = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
    versionOf.set(connectionId, (manifest?.document as { identity?: { version?: string } } | undefined)?.identity?.version ?? '0');
  }
  for (const m of mappings) {
    await writeLineage(db, actor, {
      artefact: { kind: 'source_field', refId: m.id, version: '1' },
      inputs: [{ node: { kind: 'connection', refId: m.connectionId, version: versionOf.get(m.connectionId)! }, relation: 'read_via' }],
    });
  }
  for (const p of entry.properties) {
    await writeLineage(db, actor, {
      artefact: { kind: 'property', refId: p.identityId, version: entry.typeVersionId },
      inputs: mappings.filter((m) => m.identityId === p.identityId).map((m) => ({ node: { kind: 'source_field' as const, refId: m.id, version: '1' }, relation: 'maps_to' as const })),
    });
  }
  await writeLineage(db, actor, {
    artefact: { kind: 'object_type_version', refId: entry.id, version: entry.typeVersionId },
    inputs: entry.properties.map((p) => ({ node: { kind: 'property' as const, refId: p.identityId, version: entry.typeVersionId }, relation: 'member_of' as const })),
  });
}

async function writeElement(db: Queryable, at: Place, w: Write & { entry: AnyEntry; lifecycle: Lifecycle }): Promise<void> {
  const { organisationId } = at;
  const id = w.entry.id;
  const lifecycle = w.lifecycle;
  const deprecation = w.entry as { replacedById?: string | null; retireAfter?: string };
  const origin = at.onMain ? null : at.branch.id;
  if (w.kind === 'link_type') {
    const e = w.entry as LinkTypeView;
    if (!await linkTypeRepo.findById(db, id)) {
      await linkTypeRepo.insert(db, {
        id, organisationId, ontologyVersionId: at.versionId, apiName: e.apiName, forwardName: e.forwardName, reverseName: e.reverseName,
        fromTypeId: e.fromTypeId, toTypeId: e.toTypeId, cardinality: e.cardinality, defaultRouteId: null, status: 'proposed', originBranchId: origin,
      });
    }
    if (at.onMain) {
      const live = await linkTypeRouteRepo.liveForLinkType(db, id);
      const wanted = new Set(e.routes.map((r) => r.id));
      for (const r of live) if (!wanted.has(r.id)) await linkTypeRouteRepo.update(db, r.id, { removedAt: at.now });
      const have = new Set(live.map((r) => r.id));
      for (const r of e.routes) {
        if (have.has(r.id)) continue;
        await linkTypeRouteRepo.insert(db, {
          id: r.id, organisationId, linkTypeId: id, position: r.position, connectionId: r.connectionId, sourceObject: r.sourceObject,
          foreignKeyField: r.foreignKeyField, referencedField: r.referencedField, junctionObject: r.junctionObject, origin: r.origin,
          referencedConnectionId: r.referencedConnectionId ?? null, referencedObject: r.referencedObject ?? null,
        });
      }
      const current = (await linkTypeRepo.findById(db, id))!;
      await linkTypeRepo.update(db, id, {
        forwardName: e.forwardName, reverseName: e.reverseName, fromTypeId: e.fromTypeId, toTypeId: e.toTypeId, cardinality: e.cardinality,
        defaultRouteId: e.defaultRouteId, status: lifecycle, originBranchId: null,
        ...(current.confirmedBy ? {} : { confirmedBy: at.confirmer ?? at.actor.membershipId!, confirmedAt: at.now }),
      });
    }
  } else if (w.kind === 'shared_property') {
    const e = w.entry as SharedPropertyView;
    if (!await sharedPropertyRepo.findById(db, id)) {
      await sharedPropertyRepo.insert(db, {
        id, organisationId, ontologyVersionId: at.versionId, apiName: e.apiName, displayName: e.displayName, description: e.description,
        dataType: e.dataType, typeParams: e.typeParams, status: 'proposed', originBranchId: origin,
      });
    }
    if (at.onMain) {
      const current = (await sharedPropertyRepo.findById(db, id))!;
      await sharedPropertyRepo.update(db, id, {
        displayName: e.displayName, description: e.description, dataType: e.dataType, typeParams: e.typeParams,
        status: lifecycle, originBranchId: null,
      });
    }
  } else if (w.kind === 'interface') {
    const e = w.entry as InterfaceView;
    const created = !await interfaceRepo.findById(db, id);
    if (created) {
      await interfaceRepo.insert(db, {
        id, organisationId, ontologyVersionId: at.versionId, apiName: e.apiName, displayName: e.displayName, description: e.description,
        requiredLinkTypeNames: e.requiredLinkTypeNames, status: 'proposed', originBranchId: origin,
      });
    }
    // The schema checks implementations against the live requirement rows, so a new
    // interface carries them from its first commit, and main's from each merge.
    if (created || at.onMain) {
      const live = await interfaceRequiredPropertyRepo.liveForInterface(db, id);
      for (const r of live) {
        if (!e.requiredSharedPropertyIds.includes(r.sharedPropertyId)) await interfaceRequiredPropertyRepo.update(db, r.id, { removedAt: at.now });
      }
      for (const sp of e.requiredSharedPropertyIds) {
        if (live.some((r) => r.sharedPropertyId === sp)) continue;
        await interfaceRequiredPropertyRepo.insert(db, { id: uuidv7(), organisationId, interfaceId: id, sharedPropertyId: sp });
      }
    }
    if (at.onMain) {
      const current = (await interfaceRepo.findById(db, id))!;
      await interfaceRepo.update(db, id, {
        displayName: e.displayName, description: e.description, requiredLinkTypeNames: e.requiredLinkTypeNames,
        status: lifecycle, originBranchId: null,
      });
    }
  } else {
    const e = w.entry as FunctionView;
    const exists = await functionRepo.findById(db, id);
    if (!exists) {
      await functionRepo.insert(db, {
        id, organisationId, apiName: e.apiName, description: e.description, kind: e.kind, latestVersionId: e.version.id,
        ownerMembershipId: at.actor.membershipId!, status: 'active', originBranchId: origin,
      });
    }
    if (w.publishesFunctionVersion) {
      await functionVersionRepo.insert(db, {
        id: e.version.id, organisationId, functionId: id, version: e.version.version, ontologyVersionId: at.versionId,
        expression: e.version.expression, inputs: e.version.inputs, outputType: e.version.outputType, costLimit: String(e.version.costLimit),
        checkedAt: at.now, publishedBy: at.actor.membershipId!, publishedAt: at.now,
      });
    }
    if (at.onMain) {
      await functionRepo.update(db, id, { description: e.description, latestVersionId: e.version.id, status: lifecycle, originBranchId: null });
    }
  }
  const snapshot = snapshotOf(w.entry);
  await elementRevisionRepo.insert(db, {
    id: uuidv7(), organisationId, ontologyVersionId: at.versionId,
    linkTypeId: w.kind === 'link_type' ? id : null, interfaceId: w.kind === 'interface' ? id : null,
    sharedPropertyId: w.kind === 'shared_property' ? id : null, functionId: w.kind === 'function' ? id : null,
    revision: (await elementRevisionRepo.maxRevision(db, id)) + 1, operation: w.operation, changeClass: w.changeClass, snapshot, lifecycle,
    replacedByRef: lifecycle === 'active' ? null : deprecation.replacedById ?? null,
    retireAfter: lifecycle === 'active' ? null : deprecation.retireAfter ?? null,
    contentHash: sha256(canonicalJsonBytes(snapshot)),
  });
}
