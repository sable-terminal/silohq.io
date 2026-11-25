// The reader's vocabulary (spec 26.3, 57.4, 57.6 steps 3 to 5): which object types,
// properties and link routes of a manifest this reader may plan over, and the field-policy
// effect on each property. Compile names only these to the model; the planner and the
// executor resolve it again when a plan runs, never trusting what compile saw.
//
// Enforcement is by omission:
// - an object type is in the vocabulary when policy shows it and the reader holds every
//   connection contributing to it (an answer from some of its systems would look complete
//   and not be; spec 27.12), and its identifying fields are not denied;
//   A type left out because the reader lacks a marking on it or on a contributing connection
//   (spec 21.15) is listed with how many markings it lacks, for type_dropped_from_plan (57.11);
// - a property when policy shows it and neither it nor any field it maps to is denied; its
//   effect is the strictest of the property's and its fields' (deny, then redact, then
//   mask). Computed properties wait for function expansion and are omitted;
// - a link type when policy shows it, both ends are in the vocabulary, and at least one
//   route runs through a connection the reader holds, on fields not denied; only those
//   routes are offered. Routes through a junction object are not run yet and are omitted.
// Property ids sent to policy are property identity ids, stable across type versions.

import { resolveAccess, type FieldEffect } from '../../contracts/policy/decision.contract.ts';
import type { z } from 'zod';
import type {
  contributingObjectView, linkRouteView, LinkTypeView, ObjectTypeView, OntologyManifest, PropertyView,
} from '../../contracts/ontology/manifest.contract.ts';
import type { Refusal } from '../../contracts/planner/plan.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { callOptions, type PlanCall, type PlannerDeps } from './deps.service.ts';

export type ShownEffect = Exclude<FieldEffect, 'deny'>;
export type LinkRouteView = z.infer<typeof linkRouteView>;
export type ContributingObjectView = z.infer<typeof contributingObjectView>;

export interface PropertyAccess {
  property: PropertyView;
  effect: ShownEffect;
  /**
   * A computed property (spec 21.11): its function's expression, the object's own properties it
   * reads, and the links it reads: for each, the linked type and the linked properties given to
   * the expression as links.<link api name>, a list of the linked objects' values by API name.
   */
  computed?: {
    functionVersionId: string; expression: string; inputs: string[]; costLimit: number;
    links?: { linkTypeId: string; apiName: string; otherTypeId: string; properties: { identityId: string; apiName: string }[] }[] | undefined;
  } | undefined;
}

export interface TypeAccess {
  type: ObjectTypeView;
  /** By property identity id. */
  properties: Map<string, PropertyAccess>;
  /**
   * Properties a field policy hides from this reader, whose existence is not itself restricted:
   * the object view lists them by name, "not visible to you" (34.3). A property a marking
   * restricts the existence of is never here (chapter 58).
   */
  withheld: PropertyView[];
}

export interface LinkAccess {
  link: LinkTypeView;
  routes: LinkRouteView[];
}

export interface ReaderAccess {
  manifest: OntologyManifest;
  types: Map<string, TypeAccess>;
  links: Map<string, LinkAccess>;
  /** The interfaces whose every marking the reader holds (spec 21.15). */
  interfaces: ReadonlySet<string>;
  /**
   * Object types left out because the reader does not hold every marking on the type or on a
   * connection contributing to it (spec 21.15), each with how many distinct markings it lacks.
   * Compile records each as type_dropped_from_plan (57.11). Never shown to the reader.
   */
  droppedForMarkings: { objectTypeId: string; unsatisfiedMarkings: number }[];
  /** Changes whenever what this actor may see changes: part of the result cache key (spec 24.6). */
  fingerprint: string;
}

const RANK: Record<FieldEffect, number> = { allow: 0, mask: 1, redact: 2, deny: 3 };
const strictest = (effects: readonly FieldEffect[]): FieldEffect =>
  effects.reduce<FieldEffect>((a, b) => (RANK[b] > RANK[a] ? b : a), 'allow');

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out.length > 0 ? out : [[]];
};

export async function readerAccess(deps: PlannerDeps, call: PlanCall, manifest: OntologyManifest): Promise<ReaderAccess | Refusal> {
  const types = manifest.objectTypes.filter((t) => t.status !== 'retired');
  const connections = new Set<string>();
  const fields = new Map<string, { connectionId: string; path: string }>();
  const addField = (connectionId: string, path: string) => fields.set(`${connectionId}\u0000${path}`, { connectionId, path });
  for (const t of types) {
    for (const c of t.contributingObjects) {
      connections.add(c.connectionId);
      addField(c.connectionId, c.identifierFieldPath);
    }
    for (const p of t.properties) for (const m of p.mappings) addField(m.connectionId, m.fieldPath);
  }
  for (const l of manifest.linkTypes) {
    for (const r of l.routes) {
      connections.add(r.connectionId);
      addField(r.connectionId, r.foreignKeyField);
      // The referenced end is read in its own system (D248).
      if (r.referencedConnectionId != null) connections.add(r.referencedConnectionId);
      addField(r.referencedConnectionId ?? r.connectionId, r.referencedField);
    }
  }
  const propertyIds = types.flatMap((t) => t.properties.map((p) => p.identityId));

  // Policy takes at most 500 ids of a kind and 2,000 fields a call: large ontologies take
  // several rounds, every id asked exactly once.
  const lists = {
    connections: chunks([...connections], 500), objectTypes: chunks(types.map((t) => t.id), 500),
    linkTypes: chunks(manifest.linkTypes.map((l) => l.id), 500), properties: chunks(propertyIds, 500), fields: chunks([...fields.values()], 2_000),
    // Functions and interfaces carry markings of their own (spec 21.15).
    functions: chunks([...new Set(manifest.functions.map((f) => f.id))], 500), interfaces: chunks(manifest.interfaces.map((x) => x.id), 500),
  };
  const rounds = Math.max(...Object.values(lists).map((l) => l.length));
  const results = [];
  for (let i = 0; i < rounds; i += 1) {
    results.push(await deps.services.call(resolveAccess, {
      body: {
        connections: lists.connections[i] ?? [], objectTypes: lists.objectTypes[i] ?? [], linkTypes: lists.linkTypes[i] ?? [],
        properties: lists.properties[i] ?? [], fields: lists.fields[i] ?? [], functions: lists.functions[i] ?? [], interfaces: lists.interfaces[i] ?? [],
        ...(call.purposeSessionIds === undefined ? {} : { purposeSessionIds: [...call.purposeSessionIds] }),
      },
    }, callOptions(call)));
  }
  const first = results[0]!;
  if (first.decision === 'deny') {
    return {
      code: 'query.not_permitted', reason: `this request may not read the ontology (${first.reason})`,
      ...(first.reason === 'mfa_required' ? { remedy: 'complete multi-factor authentication' } : {}),
    };
  }
  const connectionAccess = new Map(results.flatMap((r) => r.connections.map((c) => [c.id, c.access] as const)));
  const typeVisible = new Map(results.flatMap((r) => r.objectTypes.map((t) => [t.id, t.visible] as const)));
  const linkVisible = new Map(results.flatMap((r) => r.linkTypes.map((l) => [l.id, l.visible] as const)));
  const functionVisible = new Map(results.flatMap((r) => r.functions.map((f) => [f.id, f.visible] as const)));
  const interfaces = new Set(results.flatMap((r) => r.interfaces.filter((x) => x.visible).map((x) => x.id)));
  const propertyEffect = new Map<string, FieldEffect>();
  const propertyVisible = new Map<string, boolean>();
  const fieldEffect = new Map<string, FieldEffect>();
  for (const r of results) {
    for (const p of r.properties) {
      propertyEffect.set(p.id, p.visible ? p.effect : 'deny');
      propertyVisible.set(p.id, p.visible);
    }
    for (const f of r.fields) fieldEffect.set(`${f.connectionId}\u0000${f.path}`, f.effect);
  }
  const held = (connectionId: string) => (connectionAccess.get(connectionId) ?? 'none') !== 'none';
  const typeLacks = new Map(results.flatMap((r) => r.objectTypes.map((t) => [t.id, t.unsatisfiedMarkingIds] as const)));
  const connectionLacks = new Map(results.flatMap((r) => r.connections.map((c) => [c.id, c.unsatisfiedMarkingIds] as const)));
  const droppedForMarkings = types.flatMap((t) => {
    const lacking = new Set([...(typeLacks.get(t.id) ?? []), ...t.contributingObjects.flatMap((c) => connectionLacks.get(c.connectionId) ?? [])]);
    return lacking.size === 0 ? [] : [{ objectTypeId: t.id, unsatisfiedMarkings: lacking.size }];
  });
  const fieldOf = (connectionId: string, path: string): FieldEffect => fieldEffect.get(`${connectionId}\u0000${path}`) ?? 'deny';

  const visibleTypes = new Map<string, TypeAccess>();
  // Computed properties over links, decided once every type and link is.
  const overLinks: { type: ObjectTypeView; property: PropertyView; fn: OntologyManifest['functions'][number] }[] = [];
  for (const t of types) {
    if (typeVisible.get(t.id) !== true) continue;
    if (!t.contributingObjects.every((c) => held(c.connectionId) && fieldOf(c.connectionId, c.identifierFieldPath) !== 'deny')) continue;
    const properties = new Map<string, PropertyAccess>();
    const withheld: PropertyView[] = [];
    for (const p of t.properties) {
      if (p.status === 'retired' || p.computedFunctionVersionId !== null || p.mappings.length === 0) continue;
      const effect = strictest([propertyEffect.get(p.identityId) ?? 'deny', ...p.mappings.map((m) => fieldOf(m.connectionId, m.fieldPath))]);
      if (effect !== 'deny') properties.set(p.identityId, { property: p, effect });
      // Denied by a field policy, its markings (its own and its fields') held: named, not shown.
      else if (propertyVisible.get(p.identityId) === true) withheld.push(p);
    }
    // A computed property is the reader's only where every input is shown to them plainly: a function never reads a
    // property the caller cannot see, and is absent for that caller (21.11); nor where a marking on the function is not
    // held (21.15). A function over links is not evaluated here yet.
    for (const p of t.properties) {
      if (p.status === 'retired' || p.computedFunctionVersionId === null) continue;
      const fn = manifest.functions.find((f) => f.version.id === p.computedFunctionVersionId && f.kind === 'computed_property');
      if (fn === undefined || functionVisible.get(fn.id) !== true) continue;
      if (fn.version.inputs.linkTypeIds.length > 0) {
        overLinks.push({ type: t, property: p, fn });
        continue;
      }
      const inputs = fn.version.inputs.propertyIdentityIds;
      if (!inputs.every((id) => properties.get(id)?.effect === 'allow')) continue;
      const effect = propertyEffect.get(p.identityId) ?? 'deny';
      if (effect === 'deny') continue;
      properties.set(p.identityId, {
        property: p, effect, computed: { functionVersionId: fn.version.id, expression: fn.version.expression, inputs, costLimit: fn.version.costLimit },
      });
    }
    // A resolvable type is merged by its match keys: without them, it cannot be resolved for this reader.
    if (t.resolutionClass === 'resolvable' && !t.matchKeys.every((k) => properties.has(k.propertyIdentityId))) continue;
    visibleTypes.set(t.id, { type: t, properties, withheld });
  }

  const visibleLinks = new Map<string, LinkAccess>();
  for (const l of manifest.linkTypes) {
    if (l.status === 'retired' || linkVisible.get(l.id) !== true) continue;
    if (!visibleTypes.has(l.fromTypeId) || !visibleTypes.has(l.toTypeId)) continue;
    const routes = l.routes.filter((r) => held(r.connectionId) && held(r.referencedConnectionId ?? r.connectionId)
      && fieldOf(r.connectionId, r.foreignKeyField) !== 'deny' && fieldOf(r.referencedConnectionId ?? r.connectionId, r.referencedField) !== 'deny');
    if (routes.length > 0) visibleLinks.set(l.id, { link: l, routes });
  }

  // A computed property over links (21.11) is the reader's only where its own inputs are shown
  // to them plainly and every link it reads is theirs, joining its type, with every linked input
  // shown plainly; otherwise it is absent for them, as a function over what they cannot see is.
  for (const { type: t, property: p, fn } of overLinks) {
    const own = visibleTypes.get(t.id);
    const effect = propertyEffect.get(p.identityId) ?? 'deny';
    if (own === undefined || effect === 'deny') continue;
    const declared = fn.version.inputs.propertyIdentityIds;
    const ownInputs = declared.filter((id) => t.properties.some((x) => x.identityId === id));
    if (!ownInputs.every((id) => own.properties.get(id)?.effect === 'allow')) continue;
    const links: NonNullable<NonNullable<PropertyAccess['computed']>['links']> = [];
    for (const linkId of fn.version.inputs.linkTypeIds) {
      const l = visibleLinks.get(linkId);
      const otherTypeId = l === undefined ? undefined : l.link.fromTypeId === t.id ? l.link.toTypeId : l.link.toTypeId === t.id ? l.link.fromTypeId : undefined;
      const other = otherTypeId === undefined ? undefined : visibleTypes.get(otherTypeId);
      if (l === undefined || other === undefined) break;
      const linked = declared.filter((id) => other.type.properties.some((x) => x.identityId === id));
      if (!linked.every((id) => other.properties.get(id)?.effect === 'allow')) break;
      links.push({
        linkTypeId: l.link.id, apiName: l.link.apiName, otherTypeId: other.type.id,
        properties: linked.map((id) => ({ identityId: id, apiName: other.properties.get(id)!.property.apiName })),
      });
    }
    if (links.length !== fn.version.inputs.linkTypeIds.length) continue;
    own.properties.set(p.identityId, {
      property: p, effect, computed: { functionVersionId: fn.version.id, expression: fn.version.expression, inputs: ownInputs, costLimit: fn.version.costLimit, links },
    });
  }

  const fingerprint = sha256(canonicalJsonBytes({
    actor: call.request.membershipId ?? call.request.servicePrincipalId ?? null,
    purposes: [...(call.purposeSessionIds ?? [])].sort(),
    version: manifest.version.id,
    types: [...visibleTypes.values()].map((t) => ({
      id: t.type.id, properties: [...t.properties.values()].map((p) => `${p.property.identityId}:${p.effect}`).sort(),
    })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    links: [...visibleLinks.values()].map((l) => `${l.link.id}:${l.routes.map((r) => r.id).sort().join(',')}`).sort(),
    interfaces: [...interfaces].sort(),
  })).toString('hex');

  return { manifest, types: visibleTypes, links: visibleLinks, interfaces, fingerprint, droppedForMarkings };
}

export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'code' in value && 'reason' in value && !('manifest' in value);
