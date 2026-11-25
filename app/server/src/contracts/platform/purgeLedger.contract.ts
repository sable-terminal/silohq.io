// The purge ledger (spec 8.2: "A purge removes data from the live database at once. Backups
// holding purged data expire on schedule (at most 12 months). A restore replays the purge
// ledger before opening to traffic, so purged data never returns to service"; 12.5; D251).
//
// Each purge writes one entry in the transaction that completes it, as an outbox row on topic
// platform.purge_ledger; the outbox relay delivers it to object-backup (write-once, outside
// pg-control) instead of the bus, so a restore of pg-control to an earlier time still finds
// every purge made since. An entry holds what replaying the purge needs: its kind and the
// references it removed, never a value. Replaying one is the owning service's (each wipe only
// deletes, so running it again removes what came back and nothing else).

import { z } from 'zod';
import type { OutboxMessage } from '../outbox-relay/catalogue.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

/** The outbox topic whose rows the relay delivers to object-backup. */
export const PURGE_LEDGER_TOPIC = 'platform.purge_ledger';

const id = z.uuid();

export const purgeLedgerEntry = z.discriminatedUnion('kind', [
  /** A Silo wipe (70.2): the Silo and the target its purge request named. */
  z.strictObject({
    kind: z.literal('silo_wipe'), siloId: id, purgeId: id,
    scope: z.enum(['entity', 'file', 'object', 'index', 'concept', 'silo']),
    objectTypeId: id.optional(), siloFileId: id.optional(), objectRef: z.string().max(500).optional(),
  }),
  /** An Action receipt's values purged (46.7): the receipts whose values went. */
  z.strictObject({ kind: z.literal('receipt_values'), purgeId: id, receiptIds: z.array(id).min(1).max(10_000) }),
  /** Files entries deleted as purges (41.5). */
  z.strictObject({ kind: z.literal('files'), fileIds: z.array(id).min(1).max(1_000) }),
  /** A site plan or 3D model purged (29.4, 29.5). */
  z.strictObject({ kind: z.literal('spatial'), planId: id.optional(), assetModelId: id.optional() }),
  /** A moved organisation purged from the cell it left (6.4). */
  z.strictObject({ kind: z.literal('organisation'), migrationId: id }),
]);
export type PurgeLedgerEntry = z.infer<typeof purgeLedgerEntry>;

export const purgeLedgerMessage: OutboxMessage<typeof purgeLedgerEntry> = {
  topic: 'platform.purge_ledger', name: 'purge_recorded', version: 1, schema: purgeLedgerEntry,
};

/**
 * Where the relay writes an entry in object-backup, under cell/: by the day it was made, then its
 * time (sortable, no colons) and id, so a day's entries list in the order they were made.
 */
export const purgeLedgerParts = (occurredAt: string, entryId: string): string[] => {
  const at = new Date(occurredAt).toISOString();
  return ['purge-ledger', at.slice(0, 4), at.slice(5, 7), at.slice(8, 10), `${at.replaceAll(':', '')}.${entryId}.json`];
};

/** An entry as it lies in object-backup: the outbox envelope (organisation, time, correlation) and the entry. */
export const storedLedgerEntry = z.strictObject({
  id, organisationId: id, occurredAt: z.iso.datetime({ offset: true }), correlationId: id, entry: purgeLedgerEntry,
});
export type StoredLedgerEntry = z.infer<typeof storedLedgerEntry>;

/** Replays a service's purges after a restore (12.5): what each removed, removed again; counts only back. */
export const replayPurgeLedger = (service: 'siloes-capture' | 'actions' | 'files' | 'canvas-layout' | 'tenant-migrations', path: `/${string}`) => defineContract({
  service, name: 'replayPurgeLedger', method: 'POST', path, callers: ['maintenance'],
  // Each replay only deletes what its entry names: repeating it removes nothing more.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ entries: z.array(storedLedgerEntry).min(1).max(500) }),
  response: z.object({ replayed: z.int(), skipped: z.int() }),
  timeoutMs: 240_000,
});

export const replaySiloPurges = replayPurgeLedger('siloes-capture', '/v1/purge-ledger/replays');
export const replayReceiptPurges = replayPurgeLedger('actions', '/v1/purge-ledger/replays');
export const replayFilePurges = replayPurgeLedger('files', '/v1/purge-ledger/replays');
export const replaySpatialPurges = replayPurgeLedger('canvas-layout', '/v1/purge-ledger/replays');
export const replayOrganisationPurges = replayPurgeLedger('tenant-migrations', '/v1/purge-ledger/replays');
