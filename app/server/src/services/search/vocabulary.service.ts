// Ontology search (spec 24.5): type, property and link names and descriptions in the active
// ontology version, restricted to the person's vocabulary (spec 21.2, 57.8). An object type
// the person's markings withhold does not exist for them, nor do its properties or the links
// that reach it; a property they may not see is never matched. Interfaces and shared
// properties carry no markings and are shown as they are.

import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { VocabularyHit, VocabularyKind } from '../../contracts/search/search.contract.ts';
import { activeManifest, demandView, recordExplorerSearch, type Context, type SearchDeps } from './deps.service.ts';
import { score } from './scoring.service.ts';

const KIND_ORDER: Record<VocabularyKind, number> = { object_type: 0, property: 1, link_type: 2, interface: 3, shared_property: 4 };
const apiWords = (apiName: string): string => apiName.replaceAll('_', ' ');

export interface VocabularyQuery {
  text: string;
  kinds?: readonly VocabularyKind[] | undefined;
  limit: number;
  surface: 'cmdk' | 'explorer';
}

export async function searchVocabulary(deps: SearchDeps, ctx: Context, q: VocabularyQuery)
  : Promise<{ method: 'ontology'; ontologyVersionId: string; hits: VocabularyHit[] }> {
  await demandView(deps, ctx);
  const manifest = await activeManifest(deps, ctx);
  const wanted = new Set<VocabularyKind>(q.kinds ?? ['object_type', 'property', 'link_type', 'interface', 'shared_property']);
  const active = <T extends { status: string }>(items: readonly T[]): T[] => items.filter((i) => i.status === 'active');
  const types = active(manifest.objectTypes);
  // Properties are named to policy by identity, as everywhere (design D35, D36).
  const propertyIds = wanted.has('property') ? types.flatMap((t) => t.properties.map((p) => p.identityId)) : [];

  const access = await deps.services.call(resolveAccess, {
    body: {
      objectTypes: types.map((t) => t.id).slice(0, 500),
      linkTypes: active(manifest.linkTypes).map((l) => l.id).slice(0, 500),
      properties: propertyIds.slice(0, 500),
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  const visibleType = new Set(access.objectTypes.filter((t) => t.visible).map((t) => t.id));
  const visibleLink = new Set(access.linkTypes.filter((l) => l.visible).map((l) => l.id));
  const visibleProperty = new Set(access.properties.filter((p) => p.visible && p.effect !== 'deny').map((p) => p.id));

  const hits: VocabularyHit[] = [];
  const add = (hit: Omit<VocabularyHit, 'score'>, names: (string | null)[], description: string | null): void => {
    const s = score(q.text, { names, description });
    if (s > 0) hits.push({ ...hit, score: s });
  };
  for (const t of types) {
    if (!visibleType.has(t.id)) continue;
    if (wanted.has('object_type')) {
      add({ kind: 'object_type', id: t.id, objectTypeId: null, apiName: t.apiName, displayName: t.displayName, description: t.description },
        [t.displayName, t.pluralName, apiWords(t.apiName)], t.description);
    }
    if (wanted.has('property')) {
      for (const p of t.properties) {
        if (p.status !== 'active' || !visibleProperty.has(p.identityId)) continue;
        add({ kind: 'property', id: p.identityId, objectTypeId: t.id, apiName: p.apiName, displayName: p.displayName, description: p.description },
          [p.displayName, apiWords(p.apiName)], p.description);
      }
    }
  }
  if (wanted.has('link_type')) {
    for (const l of active(manifest.linkTypes)) {
      if (!visibleLink.has(l.id) || !visibleType.has(l.fromTypeId) || !visibleType.has(l.toTypeId)) continue;
      add({ kind: 'link_type', id: l.id, objectTypeId: null, apiName: l.apiName, displayName: l.forwardName, description: null },
        [l.forwardName, l.reverseName, apiWords(l.apiName)], null);
    }
  }
  if (wanted.has('interface')) {
    for (const i of active(manifest.interfaces)) {
      add({ kind: 'interface', id: i.id, objectTypeId: null, apiName: i.apiName, displayName: i.displayName, description: i.description },
        [i.displayName, apiWords(i.apiName)], i.description);
    }
  }
  if (wanted.has('shared_property')) {
    for (const sp of active(manifest.sharedProperties)) {
      add({ kind: 'shared_property', id: sp.id, objectTypeId: null, apiName: sp.apiName, displayName: sp.displayName, description: sp.description },
        [sp.displayName, apiWords(sp.apiName)], sp.description);
    }
  }
  hits.sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.displayName.localeCompare(b.displayName)
    || a.id.localeCompare(b.id));
  const shown = hits.slice(0, q.limit);
  if (q.surface === 'explorer') await recordExplorerSearch(deps, ctx, { method: 'ontology', hits: shown.length });
  return { method: 'ontology', ontologyVersionId: manifest.version.id, hits: shown };
}
