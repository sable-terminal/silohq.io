// Restores and the purge ledger (spec 8.2, 12.5; D251), the cell's half of a recovery the
// deployment runs (the database restored from its backups, in the standby site or in isolation):
//
// - manifest: with every backup, each pg-control table's row count in one snapshot, kept in
//   object-backup beside the backup (cell/row-counts/<taken at>.json);
// - check: a restored database counted again and compared with the manifest it was restored to,
//   table by table: the monthly isolated restore test's "row count checks";
// - replay: before the restored cell opens to traffic, every purge made since the restore point
//   done again, so purged data never returns to service. The ledger is in object-backup, which a
//   restore of pg-control does not rewind: the purge ledger's entries (the outbox relay's), and
//   the receipts of organisations purged from this cell after moving (tenant migrations). Each
//   entry goes to the service that owns its kind, which wipes again what came back.

import { z } from 'zod';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import {
  replayFilePurges, replayOrganisationPurges, replayReceiptPurges, replaySiloPurges, replaySpatialPurges, storedLedgerEntry,
  type StoredLedgerEntry,
} from '../../contracts/platform/purgeLedger.contract.ts';
import { objectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type createPool } from '../../infra/postgres.infra.ts';
import { rowCountsRepo } from '../../repos/platform/rowCounts.repo.ts';
import { AppError } from '../../utils/errors.util.ts';

const manifest = z.strictObject({ format: z.literal('silo.row_counts.v1'), takenAt: z.string(), tables: z.record(z.string(), z.int().min(0)) });
export type RowCountManifest = z.infer<typeof manifest>;

const DAY_MS = 86_400_000;
const LISTING = 10_000;
const BATCH = 500;

/** Counts every table in one snapshot and keeps the manifest in object-backup; its key. */
export async function takeManifest(migrate: ReturnType<typeof createPool>, store: ObjectStore): Promise<{ key: string; takenAt: string; tables: number }> {
  const counts = await inTransaction(migrate, {}, (db) => rowCountsRepo.countAll(db), { readOnly: true });
  const key = objectKey.cell('row-counts', `${counts.takenAt.replaceAll(':', '')}.json`);
  const body: RowCountManifest = { format: 'silo.row_counts.v1', takenAt: counts.takenAt, tables: counts.tables };
  await store.put('backup', key, Buffer.from(JSON.stringify(body)), 'application/json');
  return { key, takenAt: counts.takenAt, tables: Object.keys(counts.tables).length };
}

/** A restored database against its manifest: each table whose count differs, and those only one side has. */
export async function checkAgainst(migrate: ReturnType<typeof createPool>, store: ObjectStore, key: string): Promise<{
  takenAt: string; tables: number; matched: number; differing: { table: string; manifest: number | null; restored: number | null }[];
}> {
  const expected = manifest.parse(JSON.parse((await store.get('backup', key as never)).toString('utf8')));
  const found = await inTransaction(migrate, {}, (db) => rowCountsRepo.countAll(db), { readOnly: true });
  const names = [...new Set([...Object.keys(expected.tables), ...Object.keys(found.tables)])].sort();
  const differing = names.filter((t) => expected.tables[t] !== found.tables[t])
    .map((t) => ({ table: t, manifest: expected.tables[t] ?? null, restored: found.tables[t] ?? null }));
  return { takenAt: expected.takenAt, tables: names.length, matched: names.length - differing.length, differing };
}

/** Every ledger entry made after `since`, oldest first: the purge ledger's, and moved organisations' purge receipts. */
export async function ledgerSince(store: ObjectStore, since: string, now = new Date()): Promise<StoredLedgerEntry[]> {
  const from = Date.parse(since);
  if (Number.isNaN(from)) throw new AppError('validation', 'since is an instant (ISO 8601)', { code: 'restore.since_invalid' });
  const entries: StoredLedgerEntry[] = [];
  for (let day = from - (from % DAY_MS); day <= now.getTime(); day += DAY_MS) {
    const at = new Date(day).toISOString();
    for (const key of await store.list('backup', objectKey.cell('purge-ledger', at.slice(0, 4), at.slice(5, 7), at.slice(8, 10)), LISTING)) {
      const stored = storedLedgerEntry.parse(JSON.parse((await store.get('backup', key)).toString('utf8')));
      if (Date.parse(stored.occurredAt) > from) entries.push(stored);
    }
  }
  // A moved organisation's purge: its receipt, written to object-backup as it was purged (6.4).
  for (const key of await store.list('backup', objectKey.cell('tenant-migrations'), LISTING)) {
    if (!key.endsWith('/purge-receipt.json')) continue;
    const receipt = JSON.parse((await store.get('backup', key)).toString('utf8')) as Record<string, unknown>;
    const purgedAt = String(receipt['purged_at'] ?? '');
    if (receipt['format'] !== 'silo.tenant_purge_receipt.v1' || !(Date.parse(purgedAt) > from)) continue;
    const migrationId = String(receipt['migration_id']);
    entries.push(storedLedgerEntry.parse({
      id: migrationId, organisationId: receipt['organisation_id'], occurredAt: new Date(purgedAt).toISOString(), correlationId: migrationId,
      entry: { kind: 'organisation', migrationId },
    }));
  }
  return entries.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
}

type Counts = { replayed: number; skipped: number };
type Kind = StoredLedgerEntry['entry']['kind'];

/** Sends each entry to the service that owns its kind, in order, in batches; the counts each gave back. */
export async function replayLedger(services: ServiceClient, entries: readonly StoredLedgerEntry[], correlationId: string): Promise<Record<Kind, Counts>> {
  const options = { correlationId, timeoutMs: 240_000 };
  const send = async (kind: Kind, call: (batch: StoredLedgerEntry[]) => Promise<Counts>): Promise<Counts> => {
    const mine = entries.filter((e) => e.entry.kind === kind);
    const total = { replayed: 0, skipped: 0 };
    for (let i = 0; i < mine.length; i += BATCH) {
      const got = await call(mine.slice(i, i + BATCH));
      total.replayed += got.replayed;
      total.skipped += got.skipped;
    }
    return total;
  };
  // Each kind to its owner. A moved organisation last: nothing of it should be left to replay into.
  return {
    silo_wipe: await send('silo_wipe', (batch) => services.call(replaySiloPurges, { body: { entries: batch } }, options)),
    receipt_values: await send('receipt_values', (batch) => services.call(replayReceiptPurges, { body: { entries: batch } }, options)),
    files: await send('files', (batch) => services.call(replayFilePurges, { body: { entries: batch } }, options)),
    spatial: await send('spatial', (batch) => services.call(replaySpatialPurges, { body: { entries: batch } }, options)),
    organisation: await send('organisation', (batch) => services.call(replayOrganisationPurges, { body: { entries: batch } }, options)),
  };
}
