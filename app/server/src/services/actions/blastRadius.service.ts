// The blast radius walk (spec 43.7): before the preview, what else the change touches.
//
// For each record a mutation deletes, the records that reference it: by the foreign keys the
// connection's manifest declares, and by the ontology's link types whose route runs on the
// same connection. A reference the source would cascade (declared onDelete cascade) is a
// cascading delete, and the walk goes on from it, hop by hop; any other is a dependent record,
// or an ontology link, whose holder is re-pointed on revert where its key is writable
// (46.6). For a record an update changes the key of, the records referencing the old key are
// relationships that would break.
//
// The walk is bounded in hops and in records per relationship and overall. Where a bound is
// reached the result says so and at which hop: a bounded walk is never presented as complete.
// Results hold references and counts, never values.
//
// A link whose route runs on another system (43.7: "a dependency between two systems with no
// shared foreign key is still reported"): the deleted record's type also contributes there,
// so its counterpart is found as resolution matches records, by the type's match keys in
// order (23.1), read on that system by the key's mapped field; the records holding the
// counterpart's key are the dependants. A key's normalisation is not applied to the read, so
// a counterpart stored differently is missed; a link that cannot be followed (no match key
// value, no mapping there, a source that cannot answer) leaves the walk bounded, never
// complete. Hop 1 only: the walk does not go on from what it finds there.
//
// A route that reads its referenced end in the deleted record's system while holding the key in
// another (D248: a component in one Silo, its specification in another) names the record's key
// directly: the records there holding it are the dependants, at hop 1 too.

import type { Manifest } from '../../contracts/connect/manifest.contract.ts';
import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { callOptions, readConnections, type ConnectionWithManifest, type Context, type WriteBackDeps } from './deps.service.ts';
import { objectIdentity, type PlannedTarget } from './store.service.ts';

export const BLAST_BOUNDS = { hops: 2, perRelationship: 100, total: 1_000 } as const;

export type BlastKind = 'dependent_record' | 'cascading_delete' | 'broken_relationship' | 'ontology_link';

export interface BlastRow {
  sourceTargetId: string;
  kind: BlastKind;
  connectionId: string;
  dependentReference: string;
  via: string;
  linkTypeId: string | null;
  dependentObjectId: string | null;
  repointable: boolean;
  hop: number;
  bounded: boolean;
}

export interface BlastSummary {
  computed: true;
  reason: null;
  hops: number;
  /** The hop at which a bound was reached, or null when the walk ran to its end. */
  boundedAtHop: number | null;
  counts: Record<BlastKind, number>;
  relationships: { via: string; kind: BlastKind; connectionId: string; sourceObject: string; count: number; bounded: boolean }[];
}

interface Relationship {
  connectionId: string;
  holderObject: string;
  holderField: string;
  referencedField: string;
  via: string;
  cascade: boolean;
  repointable: boolean;
  linkTypeId: string | null;
  dependentTypeId: string | null;
}

/** What references `object` on the connection: declared foreign keys, then the ontology's same-connection link routes. */
export function relationshipsInto(connection: ConnectionWithManifest, object: string, ontology: OntologyManifest | null, objectTypeId: string | null)
  : Relationship[] {
  const manifest: Manifest = connection.manifest;
  const out: Relationship[] = [];
  if (ontology !== null && objectTypeId !== null) {
    for (const link of ontology.linkTypes.filter((l) => l.fromTypeId === objectTypeId && l.status !== 'proposed')) {
      for (const route of link.routes) {
        // A route reading its referenced end in another system is followed from there (D248).
        if (route.connectionId !== connection.connection.id || route.junctionObject !== null || route.referencedConnectionId != null) continue;
        const holder = manifest.objects.find((o) => o.name === route.sourceObject);
        out.push({
          connectionId: route.connectionId, holderObject: route.sourceObject, holderField: route.foreignKeyField, referencedField: route.referencedField,
          via: link.apiName, cascade: holder?.relationships.find((r) => r.field === route.foreignKeyField)?.onDelete === 'cascade',
          repointable: holder?.writes?.update !== undefined, linkTypeId: link.id, dependentTypeId: link.toTypeId,
        });
      }
    }
  }
  for (const holder of manifest.objects) {
    for (const r of holder.relationships) {
      if (r.targetObject !== object || r.kind === 'reference') continue;
      if (out.some((o) => o.holderObject === holder.name && o.holderField === r.field)) continue;
      out.push({
        connectionId: connection.connection.id, holderObject: holder.name, holderField: r.field, referencedField: r.targetField,
        via: `${holder.name}.${r.field}`, cascade: r.onDelete === 'cascade', repointable: holder.writes?.update !== undefined,
        linkTypeId: null, dependentTypeId: null,
      });
    }
  }
  return out;
}

interface Frontier {
  targetId: string;
  connectionId: string;
  object: string;
  /** Field values of the record, as far as they are known. */
  values: Record<string, unknown>;
  reference: string;
}

export async function walkBlastRadius(deps: WriteBackDeps, ctx: Context, input: {
  organisationId: string; objectTypeId: string; targets: readonly PlannedTarget[]; connections: ReadonlyMap<string, ConnectionWithManifest>;
  ontology: OntologyManifest | null; bounds?: typeof BLAST_BOUNDS;
}): Promise<{ rows: BlastRow[]; summary: BlastSummary }> {
  const bounds = input.bounds ?? BLAST_BOUNDS;
  const rows: BlastRow[] = [];
  const perRelationship = new Map<string, BlastSummary['relationships'][number]>();
  let boundedAtHop: number | null = null;
  let maxHop = 0;
  const seen = new Set<string>();
  const bound = (hop: number) => { boundedAtHop = boundedAtHop === null ? hop : Math.min(boundedAtHop, hop); };

  const readRows = async (connectionId: string, object: string, field: string, value: unknown): Promise<Record<string, unknown>[] | 'bounded'> => {
    try {
      const read = await deps.services.call(readObject, {
        body: {
          connectionId, reason: 'query',
          step: { object, filters: [{ field, op: 'eq', value: value as string }], sort: [], limit: bounds.perRelationship + 1 },
        },
      }, callOptions(ctx));
      return read.rows;
    } catch (error) {
      if (isAppError(error) && (error.category === 'bounds' || error.category === 'validation' || error.category === 'forbidden'
        || error.category === 'not_found')) return 'bounded';
      throw error;
    }
  };
  const elsewhere = new Map<string, ConnectionWithManifest | null>();
  const connectionOf = async (id: string): Promise<ConnectionWithManifest | null> => {
    if (input.connections.has(id)) return input.connections.get(id)!;
    if (!elsewhere.has(id)) {
      elsewhere.set(id, await readConnections(deps, ctx.request, [id]).then((m) => m.get(id) ?? null).catch(() => null));
    }
    return elsewhere.get(id)!;
  };

  /** A deleted record's links on other systems, through its counterpart there (see the header). */
  const across = async (item: Frontier): Promise<void> => {
    const type = input.ontology?.objectTypes.find((t) => t.id === input.objectTypeId);
    if (input.ontology === null || type === undefined || type.matchKeys.length === 0) return;
    for (const link of input.ontology.linkTypes.filter((l) => l.fromTypeId === type.id && l.status !== 'proposed')) {
      for (const route of link.routes) {
        if (route.connectionId === item.connectionId || route.junctionObject !== null || route.referencedConnectionId != null) continue;
        const counterpart = type.contributingObjects.find((c) => c.connectionId === route.connectionId);
        if (counterpart === undefined) continue;
        const kind: BlastKind = 'ontology_link';
        const key = `${link.apiName}:1`;
        const tally = perRelationship.get(key) ?? { via: link.apiName, kind, connectionId: route.connectionId, sourceObject: route.sourceObject, count: 0, bounded: false };
        perRelationship.set(key, tally);
        const unfollowable = () => {
          tally.bounded = true;
          bound(1);
        };
        const there = await connectionOf(route.connectionId);
        const holder = there?.manifest.objects.find((o) => o.name === route.sourceObject);
        const holderId = holder?.identifier[0];
        if (there === null || holder === undefined || holderId === undefined) { unfollowable(); continue; }
        // The first match key with a value here and a field there.
        const match = type.matchKeys.map((k) => {
          const property = type.properties.find((p) => p.identityId === k.propertyIdentityId);
          const from = property?.mappings.find((m) => m.connectionId === item.connectionId)?.fieldPath;
          const to = property?.mappings.find((m) => m.connectionId === route.connectionId && m.sourceObject === counterpart.sourceObject)?.fieldPath;
          return { to, value: from === undefined ? undefined : item.values[from] };
        }).find((k) => k.to !== undefined && k.value !== undefined && k.value !== null);
        if (match === undefined) { unfollowable(); continue; }
        const counterparts = await readRows(route.connectionId, counterpart.sourceObject, match.to!, match.value);
        if (counterparts === 'bounded') { unfollowable(); continue; }
        for (const found of counterparts.slice(0, bounds.perRelationship)) {
          const held = found[route.referencedField];
          if (held === undefined || held === null) continue;
          let dependants = await readRows(route.connectionId, route.sourceObject, route.foreignKeyField, held);
          if (dependants === 'bounded') { unfollowable(); continue; }
          if (dependants.length > bounds.perRelationship) {
            dependants = dependants.slice(0, bounds.perRelationship);
            unfollowable();
          }
          for (const record of dependants) {
            const reference = String(record[holderId] ?? '');
            const mark = `${route.connectionId}/${route.sourceObject}/${reference}/${link.apiName}`;
            if (reference === '' || seen.has(mark)) continue;
            seen.add(mark);
            if (rows.length >= bounds.total) { bound(1); return; }
            rows.push({
              sourceTargetId: item.targetId, kind, connectionId: route.connectionId, dependentReference: reference, via: link.apiName, linkTypeId: link.id,
              dependentObjectId: objectIdentity(input.organisationId, link.toTypeId, route.connectionId, route.sourceObject, reference),
              repointable: holder.writes?.update !== undefined, hop: 1, bounded: false,
            });
            tally.count += 1;
            maxHop = Math.max(maxHop, 1);
          }
        }
        if (counterparts.length > bounds.perRelationship) unfollowable();
      }
    }
  };

  /** A deleted record's links held in other systems by routes that read it here (D248). */
  const intoHere = async (item: Frontier): Promise<void> => {
    if (input.ontology === null) return;
    const here = input.connections.get(item.connectionId);
    const identifier = here?.manifest.objects.find((o) => o.name === item.object)?.identifier[0];
    for (const link of input.ontology.linkTypes.filter((l) => (l.fromTypeId === input.objectTypeId || l.toTypeId === input.objectTypeId) && l.status !== 'proposed')) {
      for (const route of link.routes) {
        if (route.referencedConnectionId !== item.connectionId || route.referencedObject !== item.object) continue;
        const kind: BlastKind = 'ontology_link';
        const tally = perRelationship.get(`${link.apiName}:x`) ?? { via: link.apiName, kind, connectionId: route.connectionId, sourceObject: route.sourceObject, count: 0, bounded: false };
        perRelationship.set(`${link.apiName}:x`, tally);
        const unfollowable = () => { tally.bounded = true; bound(1); };
        const key = route.referencedField === identifier ? item.reference : item.values[route.referencedField];
        if (key === undefined || key === null) { unfollowable(); continue; }
        const there = await connectionOf(route.connectionId);
        const holder = there?.manifest.objects.find((o) => o.name === route.sourceObject);
        const holderId = holder?.identifier[0];
        if (there === null || holder === undefined || holderId === undefined) { unfollowable(); continue; }
        let dependants = await readRows(route.connectionId, route.sourceObject, route.foreignKeyField, key);
        if (dependants === 'bounded') { unfollowable(); continue; }
        if (dependants.length > bounds.perRelationship) { dependants = dependants.slice(0, bounds.perRelationship); unfollowable(); }
        const holderTypeId = link.fromTypeId === input.objectTypeId ? link.toTypeId : link.fromTypeId;
        for (const record of dependants) {
          const reference = String(record[holderId] ?? '');
          const mark = `${route.connectionId}/${route.sourceObject}/${reference}/${link.apiName}`;
          if (reference === '' || seen.has(mark)) continue;
          seen.add(mark);
          if (rows.length >= bounds.total) { bound(1); return; }
          rows.push({
            sourceTargetId: item.targetId, kind, connectionId: route.connectionId, dependentReference: reference, via: link.apiName, linkTypeId: link.id,
            dependentObjectId: objectIdentity(input.organisationId, holderTypeId, route.connectionId, route.sourceObject, reference),
            repointable: holder.writes?.update !== undefined, hop: 1, bounded: false,
          });
          tally.count += 1;
          maxHop = Math.max(maxHop, 1);
        }
      }
    }
  };

  // Hop 1 starts from the deleted records and the updated records whose key changes.
  let frontier: (Frontier & { changedFields: readonly string[] | null })[] = input.targets
    .filter((t) => t.operation === 'delete' || t.operation === 'update_partial' || t.operation === 'update_full')
    .map((t) => ({
      targetId: t.id, connectionId: t.connectionId, object: t.sourceObject, reference: t.entityReference,
      values: { ...(t.prior ?? {}) },
      // A full update sends every field; the ones it changes are those whose value differs.
      changedFields: t.operation === 'delete' ? null
        : t.operation === 'update_full' ? t.fields.filter((f) => JSON.stringify(t.newValues[f] ?? null) !== JSON.stringify(t.prior?.[f] ?? null)) : t.fields,
    }));

  for (let hop = 1; hop <= bounds.hops && frontier.length > 0; hop += 1) {
    const next: typeof frontier = [];
    for (const item of frontier) {
      if (hop === 1 && item.changedFields === null) {
        await across(item);
        await intoHere(item);
      }
      const connection = input.connections.get(item.connectionId);
      if (connection === undefined) continue;
      const identifier = connection.manifest.objects.find((o) => o.name === item.object)?.identifier[0];
      const relationships = relationshipsInto(connection, item.object, hop === 1 ? input.ontology : null, hop === 1 ? input.objectTypeId : null)
        // An update matters only where it changes the key the reference holds.
        .filter((r) => item.changedFields === null || item.changedFields.includes(r.referencedField));
      for (const r of relationships) {
        if (rows.length >= bounds.total) { bound(hop); break; }
        const key = r.referencedField === identifier ? item.reference : item.values[r.referencedField];
        if (key === undefined || key === null) continue;
        const kind: BlastKind = item.changedFields !== null ? 'broken_relationship' : r.cascade ? 'cascading_delete' : r.linkTypeId !== null ? 'ontology_link' : 'dependent_record';
        const holder = connection.manifest.objects.find((o) => o.name === r.holderObject);
        const holderId = holder?.identifier[0];
        if (holder === undefined || holderId === undefined) continue;
        let found: Record<string, unknown>[];
        let overBound = false;
        try {
          const read = await deps.services.call(readObject, {
            body: {
              connectionId: r.connectionId, reason: 'query',
              step: { object: r.holderObject, filters: [{ field: r.holderField, op: 'eq', value: key as string }], sort: [], limit: bounds.perRelationship + 1 },
            },
          }, callOptions(ctx));
          found = read.rows;
        } catch (error) {
          // A source that cannot answer within its bounds leaves this relationship bounded, never complete.
          if (isAppError(error) && (error.category === 'bounds' || error.category === 'validation')) {
            bound(hop);
            const tally = perRelationship.get(`${r.via}:${hop}`) ?? { via: r.via, kind, connectionId: r.connectionId, sourceObject: r.holderObject, count: 0, bounded: true };
            tally.bounded = true;
            perRelationship.set(`${r.via}:${hop}`, tally);
            continue;
          }
          throw error;
        }
        if (found.length > bounds.perRelationship) {
          overBound = true;
          found = found.slice(0, bounds.perRelationship);
          bound(hop);
        }
        const tally = perRelationship.get(`${r.via}:${hop}`) ?? { via: r.via, kind, connectionId: r.connectionId, sourceObject: r.holderObject, count: 0, bounded: false };
        for (const record of found) {
          const reference = String(record[holderId] ?? '');
          const mark = `${r.connectionId}/${r.holderObject}/${reference}/${r.via}`;
          if (reference === '' || seen.has(mark)) continue;
          seen.add(mark);
          if (rows.length >= bounds.total) { bound(hop); break; }
          rows.push({
            sourceTargetId: item.targetId, kind, connectionId: r.connectionId, dependentReference: reference, via: r.via, linkTypeId: r.linkTypeId,
            dependentObjectId: r.dependentTypeId === null ? null
              : objectIdentity(input.organisationId, r.dependentTypeId, r.connectionId, r.holderObject, reference),
            repointable: r.repointable, hop, bounded: overBound,
          });
          tally.count += 1;
          maxHop = Math.max(maxHop, hop);
          // A cascade deletes the dependant too: the walk goes on from it.
          if (kind === 'cascading_delete') {
            next.push({ targetId: item.targetId, connectionId: r.connectionId, object: r.holderObject, reference, values: record, changedFields: null });
          }
        }
        tally.bounded ||= overBound;
        perRelationship.set(`${r.via}:${hop}`, tally);
      }
    }
    // At the last hop, the walk is bounded only if something could reference what it would go on from.
    if (hop === bounds.hops && next.some((n) => {
      const c = input.connections.get(n.connectionId);
      return c !== undefined && relationshipsInto(c, n.object, null, null).length > 0;
    })) bound(hop);
    frontier = next;
  }

  const counts: Record<BlastKind, number> = { dependent_record: 0, cascading_delete: 0, broken_relationship: 0, ontology_link: 0 };
  for (const row of rows) counts[row.kind] += 1;
  return {
    rows,
    summary: { computed: true, reason: null, hops: maxHop, boundedAtHop, counts, relationships: [...perRelationship.values()] },
  };
}
