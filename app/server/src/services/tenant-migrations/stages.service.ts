// The stage sweep (spec 6.4). Each tick looks at every migration this cell has work for,
// as the migration role (across organisations), and takes each one stage further. Every
// stage is safe to repeat: a tick that fails part way is finished by the next.
//
// In the source:
//   scheduled → read_only when the window opens (Actions and Crons pause)
//   read_only → exporting once writes admitted before the window have finished (the gateway
//     refuses every write from it) and the organisation's outbox is empty, then the bundle
//   exporting → source_read_only once the directory routes the organisation to the destination
//   source_read_only → purged, with a receipt, 30 days after the directory moved
// In the destination:
//   inbox: a bundle copied into object-backup is loaded and verified (→ verifying)
//   verifying → reauthorising once the organisation's keys are wrapped here
//   reauthorising → directory_updated → source_read_only: connections halted for
//     re-authorisation, the directory moved, every member's address registered here
//   source_read_only → source_purged → completed once the source's purge receipt is copied in
//   and, throughout, the count of connections still to re-authorise

import { importOrganisationKeys } from '../../contracts/credential/tenantKeys.contract.ts';
import { adoptMovedSiloes, releaseMovedSiloes } from '../../contracts/siloes/siloes.contract.ts';
import { directoryEmailHash } from '../../contracts/credential/identityProvider.contract.ts';
import { findOrganisation, moveOrganisation, registerIdentity } from '../../contracts/directory/registration.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { TenantMigration } from '../../models/platform/index.model.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { tenantMigrationRepo, tenantMigrationTableRepo } from '../../repos/platform/index.repo.ts';
import { tenantDataRepo } from '../../repos/platform/tenantData.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { readBundleHeader } from './bundle.service.ts';
import {
  asMigrate, bundleKey, DAY_MS, INBOX, nowOf, purgeReceiptKey, READ_ONLY_DAYS, REAUTHORISE_REASON, recordEvent, WRITES_SETTLE_MS,
  type TenantMigrationsDeps,
} from './deps.service.ts';
import {
  bundleKeys, bundleSource, exportBundle, loadBundle, organisationHoldsSiloes, purgeOrganisation, purgeSource, readPurgeReceipt,
} from './transfer.service.ts';

export interface StageOutcome { migrationId: string; from: string; to: string }

export function createStages(deps: TenantMigrationsDeps) {
  const control = deps.databases.pool('control');
  const correlationId = (m: TenantMigration) => m.id;
  const update = (m: TenantMigration, changes: Parameters<typeof tenantMigrationRepo.update>[2]) =>
    inTransaction(control, { organisationId: m.organisationId }, async (db) => (await tenantMigrationRepo.update(db, m.id, changes))!);
  const slugOf = (m: TenantMigration) => inTransaction(control, { organisationId: m.organisationId },
    async (db) => (await organisationRepo.findById(db, m.organisationId))!.slug, { readOnly: true });

  // ----------------------------------------------------------------------------- source

  async function source(m: TenantMigration, at: Date): Promise<TenantMigration | undefined> {
    if (m.status === 'scheduled' && Date.parse(m.windowStartsAt!) <= at.getTime()) {
      return inTransaction(control, { organisationId: m.organisationId }, async (db) => {
        const next = (await tenantMigrationRepo.update(db, m.id, { status: 'read_only', readOnlyAt: at.toISOString() }))!;
        await recordEvent(db, { organisationId: m.organisationId, correlationId: correlationId(m), event: 'tenant_migration_started', migrationId: m.id,
          detail: { reason: m.reason, destination_cell_id: m.destinationCellId } });
        return next;
      });
    }
    if (m.status === 'read_only') {
      // A write the gateway admitted just before the window may still be running: the export waits it out.
      if (at.getTime() < Date.parse(m.readOnlyAt!) + WRITES_SETTLE_MS) return undefined;
      // The audit event of the start, and every other, is published before the export reads.
      const waiting = await inTransaction(control, { organisationId: m.organisationId },
        (db) => tenantMigrationRepo.unpublishedEvents(db, m.organisationId), { readOnly: true });
      if (waiting > 0) return undefined;
      return update(m, { status: 'exporting', exportStartedAt: at.toISOString() });
    }
    if (m.status === 'exporting' && m.exportCompletedAt === null) {
      const result = await exportBundle(deps, m, correlationId(m));
      return inTransaction(control, { organisationId: m.organisationId }, async (db) => {
        for (const c of result.checksums) {
          if (await tenantMigrationTableRepo.findById(db, c.id)) continue;
          await tenantMigrationTableRepo.insert(db, {
            id: c.id, organisationId: m.organisationId, migrationId: m.id, schemaName: c.schema, tableName: c.table,
            sourceRowCount: String(c.rowCount), sourceChecksum: Buffer.from(c.checksum, 'hex'),
          });
        }
        return (await tenantMigrationRepo.update(db, m.id, {
          bundleObjectKey: bundleKey(m.id), bundleBytes: String(result.bytes), bundleChecksum: result.checksum,
          exportCompletedAt: nowOf(deps).toISOString(),
        }))!;
      });
    }
    if (m.status === 'exporting') {
      // The destination moves the directory once its load is verified; here it is only read.
      const entry = await deps.services.call(findOrganisation, { params: { organisationSlug: await slugOf(m) } }, { correlationId: correlationId(m) });
      if (entry.cellId !== m.destinationCellId) return undefined;
      return update(m, {
        status: 'source_read_only', directoryUpdatedAt: at.toISOString(),
        sourceReadOnlyUntil: new Date(at.getTime() + READ_ONLY_DAYS * DAY_MS).toISOString(),
      });
    }
    if (m.status === 'source_read_only' && Date.parse(m.sourceReadOnlyUntil!) <= at.getTime()) {
      // This cell's BigQuery datasets of the organisation go, and its Warehouse access, before its rows (D212).
      if (m.moveSiloes && await organisationHoldsSiloes(deps, m.organisationId)) {
        await deps.services.call(releaseMovedSiloes, {}, { request: { organisationId: m.organisationId }, correlationId: correlationId(m) });
      }
      // Everything of the organisation goes, this row with it: the receipt is the record.
      await purgeSource(deps, m);
      return { ...m, status: 'source_purged' };
    }
    return undefined;
  }

  // ----------------------------------------------------------------------------- destination

  async function destination(m: TenantMigration, at: Date): Promise<TenantMigration | undefined> {
    if (m.status === 'verifying') {
      const keys = await bundleKeys(deps, m.id, correlationId(m));
      await deps.services.call(importOrganisationKeys, { body: { migrationId: m.id, keys } },
        { request: { organisationId: m.organisationId }, correlationId: correlationId(m) });
      const unmatched = (await inTransaction(control, { organisationId: m.organisationId },
        (db) => tenantMigrationTableRepo.listForMigration(db, m.id), { readOnly: true })).filter((t) => t.matched !== true);
      if (unmatched.length > 0) throw new AppError('integrity', 'a verified load has unmatched tables', { code: 'tenant_migrations.unmatched' });
      return update(m, { status: 'reauthorising', verifiedAt: at.toISOString() });
    }
    if (m.status === 'reauthorising') {
      // Credentials stayed behind: every connection that could reach its system is halted
      // until someone re-authorises it here.
      const halted = await asMigrate(deps, async (db) => {
        await tenantDataRepo.haltForReauthorisation(db, m.organisationId, REAUTHORISE_REASON);
        return tenantDataRepo.countHalted(db, m.organisationId, REAUTHORISE_REASON);
      });
      // What lived in the source's BigQuery is rebuilt or adopted here before the directory names this cell (D212).
      if (m.moveSiloes && await organisationHoldsSiloes(deps, m.organisationId)) {
        await deps.services.call(adoptMovedSiloes, {}, { request: { organisationId: m.organisationId }, correlationId: correlationId(m) });
      }
      const slug = await slugOf(m);
      await deps.services.call(moveOrganisation, {
        params: { organisationSlug: slug }, body: { fromCellId: m.sourceCellId, toCellId: deps.cellId },
      }, { correlationId: correlationId(m) });
      const emails = await asMigrate(deps, async (db) =>
        (await tenantDataRepo.memberUserRows(db, m.organisationId)).map((row) => (JSON.parse(row) as { email: string }).email));
      for (const email of emails) {
        const hashed = await deps.services.call(directoryEmailHash, { body: { email } }, { correlationId: correlationId(m) });
        await deps.services.call(registerIdentity, {
          body: { cellId: deps.cellId, emailHash: hashed.emailHash, hashKeyVersion: hashed.keyVersion },
        }, { correlationId: correlationId(m) });
      }
      const moved = await inTransaction(control, { organisationId: m.organisationId }, async (db) => {
        const row = (await tenantMigrationRepo.update(db, m.id, {
          status: 'directory_updated', directoryUpdatedAt: at.toISOString(), connectionsReauthorisedAt: null,
          connectionsPendingReauthorisation: halted,
        }))!;
        // directory_entry_changed (6.7): logins and links now route to this cell.
        await recordEvent(db, { organisationId: m.organisationId, correlationId: correlationId(m), event: 'directory_entry_changed', migrationId: m.id,
          detail: { change: 'moved', from_cell_id: m.sourceCellId, to_cell_id: deps.cellId, identities: emails.length } });
        return row;
      });
      return update(moved, { status: 'source_read_only', sourceReadOnlyUntil: new Date(at.getTime() + READ_ONLY_DAYS * DAY_MS).toISOString() });
    }
    if (m.status === 'source_read_only') {
      const head = await deps.objects.head('backup', purgeReceiptKey(m.id));
      if (head === undefined) return undefined;
      const receipt = readPurgeReceipt(await deps.objects.get('backup', purgeReceiptKey(m.id)), m);
      return inTransaction(control, { organisationId: m.organisationId }, async (db) => {
        await tenantMigrationRepo.update(db, m.id, {
          status: 'source_purged', sourcePurgedAt: receipt.purgedAt, purgeReceiptObjectKey: purgeReceiptKey(m.id),
          purgeReceiptSha256: receipt.sha256,
        });
        await recordEvent(db, { organisationId: m.organisationId, correlationId: correlationId(m), event: 'tenant_source_purged', migrationId: m.id,
          detail: { source_cell_id: m.sourceCellId, receipt_sha256: receipt.sha256.toString('hex') } });
        const tables = await tenantMigrationTableRepo.listForMigration(db, m.id);
        const rows = (side: 'sourceRowCount' | 'destinationRowCount') => tables.reduce((n, t) => n + Number(t[side] ?? 0), 0);
        const done = (await tenantMigrationRepo.update(db, m.id, { status: 'completed', completedAt: at.toISOString() }))!;
        // Read first (spec 6.7): the row counts at both ends and the bundle checksum.
        await recordEvent(db, { organisationId: m.organisationId, correlationId: correlationId(m), event: 'tenant_migration_completed', migrationId: m.id,
          detail: {
            source_cell_id: m.sourceCellId, destination_cell_id: m.destinationCellId, tables: tables.length,
            source_rows: rows('sourceRowCount'), destination_rows: rows('destinationRowCount'),
            bundle_checksum: m.bundleChecksum?.toString('hex') ?? null,
          } });
        return done;
      });
    }
    return undefined;
  }

  /** Re-authorisation is counted down as people re-authorise their connections here. */
  async function recount(m: TenantMigration): Promise<void> {
    if ((m.connectionsPendingReauthorisation ?? 0) === 0) return;
    const pending = await asMigrate(deps, (db) => tenantDataRepo.countHalted(db, m.organisationId, REAUTHORISE_REASON));
    if (pending === m.connectionsPendingReauthorisation) return;
    await update(m, { connectionsPendingReauthorisation: pending, ...(pending === 0 ? { connectionsReauthorisedAt: nowOf(deps).toISOString() } : {}) });
  }

  /** Bundles copied into this cell's object-backup and not yet loaded. */
  async function inbox(): Promise<number> {
    let loaded = 0;
    for (const key of await deps.objects.list('backup', INBOX, 1_000)) {
      if (!key.endsWith('/bundle')) continue;
      let header;
      try {
        header = await readBundleHeader(await bundleSource(deps, key));
      } catch {
        continue;
      }
      if (header.destinationCellId !== deps.cellId) continue;
      if (await deps.objects.head('backup', key.replace(/bundle$/, 'import-refused.json') as typeof key)) continue;
      const result = await loadBundle(deps, key, header.migrationId);
      if (result.outcome === 'loaded') loaded += 1;
    }
    return loaded;
  }

  /** A load stopped here before the directory moved is removed again. */
  async function removeAborted(): Promise<void> {
    const aborted = await asMigrate(deps, (db) => tenantMigrationRepo.abortedLoads(db, deps.cellId));
    for (const m of aborted) {
      await purgeOrganisation(deps, m.organisationId, async () => undefined);
      deps.logger.warn('an aborted tenant load was removed from this cell', {
        event: 'tenant_migrations.load_removed', organisationId: m.organisationId, resourceId: m.id, reason: m.abortReason ?? 'aborted',
      });
    }
  }

  return {
    async tick(): Promise<{ moved: StageOutcome[]; loaded: number; failed: number }> {
      const moved: StageOutcome[] = [];
      let failed = 0;
      let loaded = 0;
      try {
        loaded = await inbox();
      } catch (error) {
        failed += 1;
        deps.logger.failure('the tenant migration inbox could not be read', error, { event: 'tenant_migrations.inbox_failed' });
      }
      try {
        await removeAborted();
      } catch (error) {
        failed += 1;
        deps.logger.failure('an aborted tenant load could not be removed', error, { event: 'tenant_migrations.remove_failed' });
      }
      const work = await asMigrate(deps, (db) => tenantMigrationRepo.withWork(db, deps.cellId));
      for (let m of work) {
        try {
          // Each migration goes as far as it can in one tick.
          for (let step = 0; step < 8; step += 1) {
            const at = nowOf(deps);
            const next = m.sourceCellId === deps.cellId ? await source(m, at) : await destination(m, at);
            if (next === undefined) break;
            if (next.status !== m.status) moved.push({ migrationId: m.id, from: m.status, to: next.status });
            m = next;
            if (m.status === 'source_purged' && m.sourceCellId === deps.cellId) break;
          }
          if (m.destinationCellId === deps.cellId) await recount(m);
        } catch (error) {
          failed += 1;
          deps.logger.failure('a tenant migration stage failed; it is tried again next tick', error, {
            event: 'tenant_migrations.stage_failed', organisationId: m.organisationId, resourceId: m.id, outcome: m.status,
          });
        }
      }
      return { moved, loaded, failed };
    },
  };
}

export type Stages = ReturnType<typeof createStages>;
