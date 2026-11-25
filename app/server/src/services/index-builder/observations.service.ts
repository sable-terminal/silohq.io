// Object Index refresh from change streams (spec 69.4): see
// contracts/index-builder/observations.contract.ts. The latest observation of each property
// of each object is written to its entry, if the entry exists; one statement per property.
// Only for a property one system maps: one system's change cannot decide a value several
// systems hold (they may now agree, or disagree), so those wait for the next refresh.

import type { WarehouseObservation } from '../../contracts/warehouse/observations.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { indexDefinitionRepo } from '../../repos/siloes/index.repo.ts';
import { updateEntryValues } from '../warehouse-schema/generator/index.generator.ts';
import { nominatedProperties } from '../warehouse-schema/schema.service.ts';
import { columnFor, existingColumns, readManifest } from '../warehouse-schema/warehouse.service.ts';
import { bind } from '../warehouse-sync/sync.service.ts';
import { asIndex, datasetRef, indexTableOf, loadIndexSilo, type Context, type IndexDeps } from './index.service.ts';

export async function applyObservations(deps: IndexDeps, ctx: Context, siloId: string, entries: readonly WarehouseObservation[])
  : Promise<{ updated: number; skipped: number }> {
  const loaded = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const silo = await loadIndexSilo(db, siloId);
    return { silo, definitions: await indexDefinitionRepo.listForSilo(db, siloId, true) };
  }, { readOnly: true });
  const { silo, definitions } = loaded;
  // An index serves while provisioning (it answers as a source only after the engine decision, 69.6); not once it is being removed.
  if (silo.status === 'purging' || silo.status === 'disabled') return { updated: 0, skipped: entries.length };
  const manifest = await readManifest(deps, asIndex(silo, ctx.correlationId));
  const ref = datasetRef(deps, silo);
  const options = { labels: { organisation: silo.organisationId, service: 'index-builder', purpose: 'index_refresh' as const, silo: silo.id } };
  let updated = 0;
  let skipped = 0;
  for (const definition of definitions) {
    const ofType = entries.filter((e) => e.objectTypeId === definition.objectTypeId);
    if (ofType.length === 0) continue;
    const type = manifest.objectTypes.find((t) => t.id === definition.objectTypeId);
    const mappedOnce = new Set((type?.properties ?? []).filter((p) => new Set(p.mappings.map((m) => `${m.connectionId}/${m.sourceObject}`)).size === 1)
      .map((p) => p.apiName));
    const tableName = indexTableOf(definition.id);
    const info = await deps.bigQuery.getTable({ ...ref, table: tableName });
    if (info === undefined) { skipped += ofType.length; continue; }
    const existing = existingColumns(info);
    for (const p of nominatedProperties(manifest, definition.objectTypeId, definition.nominatedProperties)) {
      const column = columnFor(existing, p.apiName, p.type);
      if (!column.exists) continue;
      if (!mappedOnce.has(p.apiName)) {
        skipped += ofType.filter((e) => e.property === p.apiName).length;
        continue;
      }
      const latest = new Map<string, WarehouseObservation>();
      for (const e of ofType.filter((x) => x.property === p.apiName)) {
        const prior = latest.get(e.objectRef);
        if (prior === undefined || prior.observedAt <= e.observedAt) latest.set(e.objectRef, e);
      }
      if (latest.size === 0) continue;
      const rows = [...latest.values()].map((e) => ({ key: e.objectRef, value: bind(e.value, p.type) }));
      const out = await deps.bigQuery.run(ref, updateEntryValues(ref, tableName, { name: column.name, type: p.type }, rows), options);
      updated += out.affectedRows ?? 0;
    }
    skipped += ofType.filter((e) => !definition.nominatedProperties.includes(e.property)).length;
  }
  return { updated, skipped };
}
