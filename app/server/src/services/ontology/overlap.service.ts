// Value overlap (spec 22.4): whether a field of a newly derived connection identifies the same
// things as a property of an existing object type that another system already feeds. A
// bounded set of distinct values is read from the new side, the other side is asked which of
// them it holds (a bounded semi-join: an `in` filter, chunked), and only the count is kept.
// The values live in this process's memory for the derivation and are discarded with it
// (as for inferred links, D75); they never reach the control plane, a proposal or a model.
//
// Candidates are bounded and chosen by structure, never decided by names: the existing type's
// match keys, and its properties named as identities (an email, a registration, a code), each
// mapped plainly from another connection, paired with fields of the new object of the same
// type whose names point at the same thing. The overlap decides: a pair counts where at least
// MIN_SHARED values are shared and the chance that at least MIN_SHARE of the sampled values are
// held on the other side is at least CREDIBILITY (a uniform prior). Below that it proposes
// nothing.

import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import type { ObjectTypeDefinition } from '../../contracts/ontology/element.contract.ts';
import { probabilityAbove } from '../../utils/bayes.util.ts';
import type { Content, ObjectTypeEntry } from './content.service.ts';
import type { Context, OntologyDeps } from './deps.service.ts';
import { PROPOSED_TYPE, type SourceObject, type SourceSchema } from './sourceSchema.service.ts';

export const SAMPLE_ROWS = 5_000;
export const MAX_VALUES = 1_000;
export const CHUNK = 200;
export const MAX_PAIRS = 20;
export const MIN_SHARED = 10;
export const MIN_SHARE = 0.2;
export const CREDIBILITY = 0.9;

/** Names that say a field identifies something outside the system that holds it. */
const IDENTITY = /(^|_)(email|e_mail|registration|reg_no|reg_number|company_number|vat|vat_number|tax_id|tin|duns|lei|iban|sku|ean|gtin|isbn|external_id|code)($|_)/;
const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const token = (name: string): string | undefined => IDENTITY.exec(snake(name))?.[2]?.replace(/^(reg_number|registration)$/, 'reg_no').replace(/^e_mail$/, 'email');

export interface OverlapFinding {
  /** The new connection's object and field. */
  object: string;
  field: string;
  /** The existing type, the property, and where it is mapped. */
  typeApiName: string;
  property: string;
  connectionId: string;
  sourceObject: string;
  fieldPath: string;
  sampled: number;
  shared: number;
  probability: number;
}

interface Pair { object: SourceObject; field: string; type: ObjectTypeEntry; property: string; connectionId: string; sourceObject: string; fieldPath: string }

/** The candidate pairs, bounded: the type's match keys and identity-named properties against same-typed fields named alike. */
export function candidatePairs(source: SourceSchema, content: Content): Pair[] {
  const pairs: Pair[] = [];
  for (const type of content.objectTypes.filter((t) => t.status === 'active')) {
    if (type.contributingObjects.every((c) => c.connectionId === source.connectionId)) continue;
    const keys = new Set(type.matchKeys.map((k) => k.propertyIdentityId));
    for (const p of type.properties.filter((x) => x.status !== 'retired' && x.computedFunctionVersionId === null)) {
      const named = token(p.apiName);
      if (!keys.has(p.identityId) && named === undefined) continue;
      const mapping = p.mappings.find((m) => m.connectionId !== source.connectionId && m.valueMap === null && m.sourceTimeZone === null);
      if (mapping === undefined) continue;
      for (const object of source.objects) {
        if (type.contributingObjects.some((c) => c.connectionId === source.connectionId && c.sourceObject === object.name)) continue;
        for (const f of object.fields) {
          if (PROPOSED_TYPE[f.type] !== p.dataType) continue;
          const alike = snake(f.name) === p.apiName || snake(f.name) === snake(mapping.fieldPath) || (named !== undefined && token(f.name) === named);
          if (alike) pairs.push({ object, field: f.name, type, property: p.apiName, connectionId: mapping.connectionId, sourceObject: mapping.sourceObject, fieldPath: mapping.fieldPath });
        }
      }
    }
  }
  return pairs.slice(0, MAX_PAIRS);
}

/** The judgement on one pair (pure): its probability, or undefined where it proposes nothing. */
export function judgeOverlap(sampled: number, shared: number): number | undefined {
  if (shared < MIN_SHARED || sampled === 0) return undefined;
  const probability = probabilityAbove(MIN_SHARE, shared, sampled);
  return probability >= CREDIBILITY ? Math.round(probability * 10_000) / 10_000 : undefined;
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() || null);

/** The overlaps that count, for one connection being derived. Best effort: a side that cannot be read gives nothing. */
export async function findOverlaps(deps: OntologyDeps, ctx: Context, source: SourceSchema, content: Content): Promise<OverlapFinding[]> {
  const options = { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 60_000 };
  const read = async (connectionId: string, object: string, field: string, values?: string[]): Promise<(string | null)[] | undefined> => {
    try {
      const out = await deps.services.call(readObject, {
        body: { connectionId, reason: 'query', step: values === undefined
          ? { object, fields: [field], limit: SAMPLE_ROWS }
          : { object, fields: [field], filters: [{ field, op: 'in', value: values }] } },
      }, options);
      return out.rows.map((r) => text(r[field]));
    } catch {
      deps.logger.warn('a side of a value overlap could not be read', { event: 'ontology.overlap_unread', resourceType: 'connection', resourceId: connectionId });
      return undefined;
    }
  };
  const samples = new Map<string, string[] | undefined>();
  const out: OverlapFinding[] = [];
  for (const pair of candidatePairs(source, content)) {
    const sampleKey = `${pair.object.name}/${pair.field}`;
    if (!samples.has(sampleKey)) {
      const values = await read(source.connectionId, pair.object.name, pair.field);
      samples.set(sampleKey, values === undefined ? undefined : [...new Set(values.filter((v): v is string => v !== null))].slice(0, MAX_VALUES));
    }
    const sample = samples.get(sampleKey);
    if (sample === undefined || sample.length === 0) continue;
    const held = new Set<string>();
    let unread = false;
    for (let i = 0; i < sample.length && !unread; i += CHUNK) {
      const chunk = sample.slice(i, i + CHUNK);
      const found = await read(pair.connectionId, pair.sourceObject, pair.fieldPath, chunk);
      if (found === undefined) unread = true;
      else for (const v of found) if (v !== null && chunk.includes(v)) held.add(v);
    }
    if (unread) continue;
    const probability = judgeOverlap(sample.length, held.size);
    if (probability === undefined) continue;
    out.push({
      object: pair.object.name, field: pair.field, typeApiName: pair.type.apiName, property: pair.property,
      connectionId: pair.connectionId, sourceObject: pair.sourceObject, fieldPath: pair.fieldPath, sampled: sample.length, shared: held.size, probability,
    });
  }
  return out;
}

type ObjectTypeProposal = Omit<ObjectTypeDefinition, 'expectedHeadVersionId'>;

/** An object type as a definition a decision can carry: what resolveObjectType reads back. */
export function definitionOf(type: ObjectTypeEntry, content: Content): ObjectTypeProposal {
  const live = type.properties.filter((p) => p.status !== 'retired');
  const nameOf = (id: string | null) => live.find((p) => p.identityId === id)?.apiName;
  return {
    displayName: type.displayName, pluralName: type.pluralName, description: type.description ?? undefined,
    contributingObjects: type.contributingObjects.map((c) => ({ connectionId: c.connectionId, sourceObject: c.sourceObject, identifierFieldPath: c.identifierFieldPath })),
    properties: live.map((p) => ({
      apiName: p.apiName, displayName: p.displayName, description: p.description ?? undefined, dataType: p.dataType, typeParams: p.typeParams,
      nullable: p.nullable,
      ...(p.sharedPropertyId === null ? {} : { sharedProperty: content.sharedProperties.find((s) => s.id === p.sharedPropertyId)?.apiName }),
      ...(p.computedFunctionVersionId === null ? {} : { computedFunctionVersionId: p.computedFunctionVersionId }),
      mappings: p.mappings.map((m) => ({
        connectionId: m.connectionId, sourceObject: m.sourceObject, fieldPath: m.fieldPath,
        ...(m.valueMap === null ? {} : { valueMap: m.valueMap }), ...(m.sourceTimeZone === null ? {} : { sourceTimeZone: m.sourceTimeZone }),
      })),
    })) as ObjectTypeProposal['properties'],
    ...(nameOf(type.primaryKeyPropertyIdentityId) === undefined ? {} : { primaryKey: nameOf(type.primaryKeyPropertyIdentityId) }),
    title: nameOf(type.titlePropertyIdentityId)!,
    matchKeys: type.matchKeys.flatMap((k) => (nameOf(k.propertyIdentityId) === undefined ? [] : [{
      property: nameOf(k.propertyIdentityId)!, ...(k.normalisation === null ? {} : { normalisation: k.normalisation }),
    }])),
    timeFields: type.timeFields.flatMap((t) => (nameOf(t.propertyIdentityId) === undefined ? [] : [{ property: nameOf(t.propertyIdentityId)!, meaning: t.meaning, isDefault: t.isDefault }])),
    implements: type.implements.flatMap((i) => {
      const iface = content.interfaces.find((x) => x.id === i.interfaceId);
      if (iface === undefined) return [];
      return [{
        interface: iface.apiName,
        propertyBindings: Object.fromEntries(Object.entries(i.propertyBindings).flatMap(([sharedId, propertyId]) => {
          const shared = content.sharedProperties.find((s) => s.id === sharedId)?.apiName;
          return shared === undefined || nameOf(propertyId) === undefined ? [] : [[shared, nameOf(propertyId)!]];
        })),
        linkBindings: Object.fromEntries(Object.entries(i.linkBindings).flatMap(([name, linkId]) => {
          const link = content.linkTypes.find((l) => l.id === linkId)?.apiName;
          return link === undefined ? [] : [[name, link]];
        })),
      }];
    }),
    visual: type.visual,
  } as ObjectTypeProposal;
}

/**
 * The existing type with the new object contributing to it: matched on the overlapping
 * property (its match key from then on), each of the type's properties mapped from a field of
 * the new object of the same name and type, and no primary key (it becomes resolvable, spec
 * 22.6). A person confirms, corrects or rejects it.
 */
export function joined(type: ObjectTypeEntry, content: Content, source: SourceSchema, finding: OverlapFinding): ObjectTypeProposal {
  // Two systems make it resolvable: its objects are named by the entity graph, not by one system's key.
  const { primaryKey: _single, ...definition } = definitionOf(type, content);
  const object = source.objects.find((o) => o.name === finding.object)!;
  const fieldFor = (apiName: string, dataType: string): string | undefined => apiName === finding.property ? finding.field
    : object.fields.find((f) => snake(f.name) === apiName && PROPOSED_TYPE[f.type] === dataType)?.name;
  return {
    ...definition,
    contributingObjects: [...definition.contributingObjects, { connectionId: source.connectionId, sourceObject: object.name, identifierFieldPath: object.identifier[0]! }],
    properties: definition.properties.map((p) => {
      const field = p.computedFunctionVersionId === undefined ? fieldFor(p.apiName, p.dataType) : undefined;
      return field === undefined ? p : { ...p, mappings: [...p.mappings, { connectionId: source.connectionId, sourceObject: object.name, fieldPath: field }] };
    }),
    matchKeys: definition.matchKeys.some((k) => k.property === finding.property) ? definition.matchKeys
      : [...definition.matchKeys, { property: finding.property }].slice(0, 8),
  };
}
