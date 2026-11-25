// Moving the rows (spec 6.4): the export in the source, the load and its verification in
// the destination, and the source purge with its receipt.
//
// - Export: "under the application role with app.org_id set by set local, so RLS bounds it
//   to the tenant". The cell-level rows an organisation's rows need (its member users, the
//   operators they name) are read by the migration role, filtered to the organisation. The
//   bundle is written as it is read: each table's rows come through a cursor in batches,
//   each stored file in chunks, and the upload takes the sealed segments as they are made,
//   so the export holds one batch, never the organisation.
// - Load: one transaction as silo_migrate in bulk mode, loading each record as it is read
//   from the bundle in ranges. The destination recomputes every table's count and checksum
//   inside it and refuses the whole load on any difference, so a load is all or nothing and
//   never half verified. A refusal is written beside the bundle for the operator, and the
//   source stays as it was.
// - Purge: one transaction as silo_migrate in bulk mode, every row of the organisation, then
//   its stored files. The receipt is written before the commit, so a purge that commits
//   always has one; a purge that fails is retried and writes it again.
//
// Both long transactions wait on object storage between statements, so each allows itself
// TRANSFER_IDLE_MS idle in transaction rather than the pool's default.

import type { StoredLedgerEntry } from '../../contracts/platform/purgeLedger.contract.ts';
import { exportOrganisationKeys, openTenantBundleKey, type TransferredKey } from '../../contracts/credential/tenantKeys.contract.ts';
import { objectKey, type Bucket, type ObjectKey, type ObjectUpload } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { TenantMigration } from '../../models/platform/index.model.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { tenantMigrationRepo, tenantMigrationTableRepo } from '../../repos/platform/index.repo.ts';
import { MEMBER_USERS, ORGANISATION_ROW, tenantDataRepo, type TenantTable } from '../../repos/platform/tenantData.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  CARRIED_APART, checksumOf, createBundleWriter, DATA_CHUNK_BYTES, openBundleReader, readBundleHeader, RECORD_ORDER, rowHasher, STAYS_BEHIND,
  type BundleHeader, type BundleRecord, type BundleWriter, type RangeSource, type TableChecksum,
} from './bundle.service.ts';
import { asMigrate, bundleKey, nowOf, purgeReceiptKey, refusalKey, type TenantMigrationsDeps } from './deps.service.ts';

const qualified = (t: { schema: string; table: string }): string => `${t.schema}.${t.table}`;
const MAX_OBJECTS = 1_000_000;
/** Rows fetched from a table's cursor at a time, by default. */
export const ROW_BATCH = 500;
/** How long the export and the load may wait on object storage inside their transactions. */
const TRANSFER_IDLE_MS = 600_000;

/** A migration refused for a reason the operator can act on; the category is recorded. */
export class Refusal extends AppError {
  readonly refusedFor: string;
  constructor(refusal: string, message: string) {
    super('conflict', message, { code: `tenant_migrations.${refusal}` });
    this.refusedFor = refusal;
  }
}

/** The tables that move as rows, from this cell's catalogue. */
export async function movingTables(db: Queryable): Promise<TenantTable[]> {
  return (await tenantDataRepo.tenantTables(db)).filter((t) => !(qualified(t) in STAYS_BEHIND) && !(qualified(t) in CARRIED_APART));
}

/** Whether the organisation holds Siloes, which may move only where the destination residency permits. */
export async function holdsSiloes(db: Queryable, organisationId: string, tables: readonly TenantTable[]): Promise<boolean> {
  const siloes = tables.find((t) => t.schema === 'siloes' && t.table === 'siloes');
  if (siloes === undefined) return false;
  const rows = await tenantDataRepo.rows(db, siloes, organisationId);
  return rows.some((row) => (JSON.parse(row) as { status: string }).status !== 'disabled');
}

export async function checkSiloesMayStay(deps: TenantMigrationsDeps, organisationId: string): Promise<void> {
  const control = deps.databases.pool('control');
  const holds = await inTransaction(control, { organisationId }, async (db) => holdsSiloes(db, organisationId, await movingTables(db)), { readOnly: true });
  if (holds) {
    throw new Refusal('siloes_not_permitted', 'the destination\'s residency does not permit Siloes: purge or disable every Silo first (spec 6.4)');
  }
}

/** A bundle in this cell's object-backup, read by range. */
export async function bundleSource(deps: TenantMigrationsDeps, key: ObjectKey): Promise<RangeSource> {
  const head = await deps.objects.head('backup', key);
  if (head === undefined) throw new AppError('not_found', 'no bundle at that key', { code: 'tenant_migrations.bundle_missing' });
  return { size: head.bytes, read: (start, end) => deps.objects.getRange('backup', key, start, end - 1) };
}

// ----------------------------------------------------------------------------- export (source)

/** Each stored file of the organisation, as a record and then its bytes in chunks. */
async function writeObjects(deps: TenantMigrationsDeps, writer: BundleWriter, organisationId: string): Promise<number> {
  let count = 0;
  for (const bucket of ['files', 'siloes'] as const) {
    let keys: ObjectKey[];
    try {
      keys = await deps.objects.list(bucket, objectKey.organisationFolder(organisationId), MAX_OBJECTS);
    } catch (error) {
      // A cell without a Siloes store holds no Siloes files.
      if (bucket === 'siloes' && (error as AppError).category === 'configuration') continue;
      throw error;
    }
    for (const key of keys) {
      const head = await deps.objects.head(bucket, key);
      if (head === undefined) continue;
      await writer.write({ kind: 'object', bucket, key, contentType: head.contentType ?? 'application/octet-stream', bytes: head.bytes });
      for (let start = 0; start < head.bytes; start += DATA_CHUNK_BYTES) {
        const end = Math.min(head.bytes, start + DATA_CHUNK_BYTES);
        const body = await deps.objects.getRange(bucket, key, start, end - 1);
        if (body.length !== end - start) {
          throw new AppError('unavailable', 'a stored file changed while it was exported; the export runs again', { code: 'tenant_migrations.object_changed' });
        }
        await writer.write({ kind: 'data', body });
      }
      count += 1;
    }
  }
  return count;
}

export async function exportBundle(deps: TenantMigrationsDeps, migration: TenantMigration, correlationId: string): Promise<{
  bytes: number; checksum: Buffer; checksums: TableChecksum[];
}> {
  const organisationId = migration.organisationId;
  const control = deps.databases.pool('control');
  const tenant = { organisationId };
  if (!migration.moveSiloes) await checkSiloesMayStay(deps, organisationId);
  const slug = await inTransaction(control, tenant, async (db) => {
    const found = await organisationRepo.findById(db, organisationId);
    if (found === undefined) throw new AppError('not_found', 'no such organisation here', { code: 'tenant_migrations.organisation_unknown' });
    return found.slug;
  }, { readOnly: true });

  const { users, operators } = await asMigrate(deps, async (db) => {
    const ids = new Set<string>();
    for (const reference of await tenantDataRepo.operatorReferences(db)) {
      for (const id of await tenantDataRepo.operatorIds(db, reference, organisationId)) ids.add(id);
    }
    return { users: await tenantDataRepo.memberUserRows(db, organisationId), operators: await tenantDataRepo.operatorRows(db, [...ids]) };
  });

  const { keys } = await deps.services.call(exportOrganisationKeys, {
    body: { migrationId: migration.id, destinationKey: migration.destinationImportKey! },
  }, { request: tenant, correlationId });

  const upload = await deps.objects.openUpload('backup', bundleKey(migration.id), 'application/octet-stream');
  let writer: BundleWriter | undefined;
  try {
    writer = await createBundleWriter(upload, {
      migrationId: migration.id, organisationId, organisationSlug: slug, sourceCellId: migration.sourceCellId,
      destinationCellId: migration.destinationCellId, destinationKeyId: migration.destinationKeyId!, createdAt: nowOf(deps).toISOString(),
    }, migration.destinationImportKey!);
    const out = writer;
    await out.write({ kind: 'keys', keys });
    await out.write({ kind: 'operators', rows: operators });

    // Every table in one transaction under the organisation's context, read through cursors.
    // Not retried: the rows already went into the bundle.
    const checksums = await inTransaction(control, tenant, async (db) => {
      await tenantDataRepo.allowIdle(db, TRANSFER_IDLE_MS);
      const sums: TableChecksum[] = [];
      const organisation = await tenantDataRepo.organisationRow(db, organisationId);
      await out.write({ kind: 'organisation', rows: organisation });
      sums.push({ id: uuidv7(), ...ORGANISATION_ROW, ...checksumOf(organisation) });
      await out.write({ kind: 'users', rows: users });
      sums.push({ id: uuidv7(), ...MEMBER_USERS, ...checksumOf(users) });
      for (const table of await movingTables(db)) {
        if (!table.readable) throw new Refusal('unreadable_table', `${qualified(table)} cannot be read under the tenant's context`);
        await out.write({ kind: 'table', schema: table.schema, table: table.table, insertable: table.insertable });
        const hasher = rowHasher();
        for await (const rows of tenantDataRepo.rowBatches(db, table, organisationId, deps.rowBatch ?? ROW_BATCH)) {
          hasher.add(rows);
          await out.writeRows(rows);
        }
        sums.push({ id: uuidv7(), schema: table.schema, table: table.table, ...hasher.result() });
      }
      const all = await tenantDataRepo.tenantTables(db);
      const of = (name: string) => all.find((t) => qualified(t) === name)!;
      const migrations = await tenantDataRepo.rows(db, of('platform.tenant_migrations'), organisationId);
      const migrationTables = await tenantDataRepo.rows(db, of('platform.tenant_migration_tables'), organisationId);
      await out.write({
        kind: 'migration',
        migration: migrations.find((r) => (JSON.parse(r) as { id: string }).id === migration.id)!,
        history: {
          migrations: migrations.filter((r) => (JSON.parse(r) as { id: string }).id !== migration.id),
          tables: migrationTables.filter((r) => (JSON.parse(r) as { migration_id: string }).migration_id !== migration.id),
        },
      });
      return sums;
    }, { readOnly: true, attempts: 1 });

    await out.write({ kind: 'checksums', checksums });
    const objects = await writeObjects(deps, out, organisationId);
    await out.write({ kind: 'end', objects });
    const sealed = await out.finish();
    await upload.finish();
    return { bytes: sealed.bytes, checksum: sealed.checksum, checksums };
  } catch (error) {
    writer?.discard();
    await upload.abort().catch(() => undefined);
    throw error;
  }
}

// ----------------------------------------------------------------------------- load (destination)

export interface LoadResult {
  header: BundleHeader;
  outcome: 'loaded' | 'already_present' | 'refused';
  category?: string;
}

/** The bundle key, unsealed by this cell's credential service; the caller zeroes it. */
async function unsealKey(deps: TenantMigrationsDeps, header: BundleHeader, correlationId: string): Promise<Buffer> {
  const { key } = await deps.services.call(openTenantBundleKey, {
    body: { migrationId: header.migrationId, sealedKey: header.sealedKey },
  }, { correlationId });
  return Buffer.from(key, 'base64');
}

/** The organisation's keys, the bundle's first record, read without the rest. */
export async function bundleKeys(deps: TenantMigrationsDeps, migrationId: string, correlationId: string): Promise<TransferredKey[]> {
  const source = await bundleSource(deps, bundleKey(migrationId));
  const raw = await unsealKey(deps, await readBundleHeader(source), correlationId);
  try {
    const reader = await openBundleReader(source, raw, { windowBytes: 1 << 20 });
    for await (const record of reader.records()) {
      if (record.kind === 'keys') return record.keys;
      break;
    }
  } finally {
    raw.fill(0);
  }
  throw new AppError('integrity', 'the bundle does not start with the organisation\'s keys', { code: 'tenant_migrations.bundle_malformed' });
}

/** Loads a bundle in this cell's object-backup, verified, in one transaction. */
export async function loadBundle(deps: TenantMigrationsDeps, key: ObjectKey, correlationId: string): Promise<LoadResult> {
  const source = await bundleSource(deps, key);
  const header = await readBundleHeader(source);
  if (header.destinationCellId !== deps.cellId) {
    throw new AppError('conflict', 'the bundle is for another cell', { code: 'tenant_migrations.wrong_cell' });
  }
  if (await asMigrate(deps, (db) => tenantMigrationRepo.exists(db, header.migrationId))) return { header, outcome: 'already_present' };
  try {
    const raw = await unsealKey(deps, header, correlationId);
    try {
      await load(deps, header, source, raw);
    } finally {
      raw.fill(0);
    }
    deps.logger.info('tenant bundle loaded and verified', {
      event: 'tenant_migrations.loaded', organisationId: header.organisationId, resourceId: header.migrationId,
    });
    return { header, outcome: 'loaded' };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    await deps.objects.put('backup', refusalKey(header.migrationId), canonicalJsonBytes({
      format: 'silo.tenant_import_refusal.v1', migration_id: header.migrationId, organisation_id: header.organisationId,
      category: error.refusedFor, refused_at: nowOf(deps).toISOString(),
    }), 'application/json');
    deps.logger.error('tenant bundle refused', {
      event: 'tenant_migrations.load_refused', organisationId: header.organisationId, resourceId: header.migrationId, reason: error.refusedFor,
    });
    return { header, outcome: 'refused', category: error.refusedFor };
  }
}

const outOfOrder = (why: string): AppError =>
  new AppError('integrity', `the bundle's records are out of order: ${why}`, { code: 'tenant_migrations.bundle_malformed' });

/** Records that come once each, all of them before the end. */
const ONCE = new Set<string>(['keys', 'operators', 'organisation', 'users', 'migration', 'checksums', 'end']);

async function load(deps: TenantMigrationsDeps, header: BundleHeader, source: RangeSource, raw: Buffer): Promise<void> {
  const organisationId = header.organisationId;
  const at = nowOf(deps).toISOString();
  const put: { bucket: Bucket; key: ObjectKey }[] = [];
  let upload: ObjectUpload | undefined;
  try {
    await asMigrate(deps, async (db) => {
      await tenantDataRepo.bulkMode(db);
      await tenantDataRepo.allowIdle(db, TRANSFER_IDLE_MS);
      if (await tenantDataRepo.organisationExists(db, organisationId)) {
        throw new Refusal('already_present', 'the organisation is already in this cell');
      }
      const here = new Map((await tenantDataRepo.tenantTables(db)).map((t) => [qualified(t), t]));
      const reader = await openBundleReader(source, raw);
      if (reader.header.migrationId !== header.migrationId) throw outOfOrder('the header changed');

      const seen = new Set<string>();
      let stage = -1;
      let table: TenantTable | undefined;
      let object: { expected: number; received: number } | undefined;
      let objects = 0;
      const enter = (kind: BundleRecord['kind']): void => {
        const position = RECORD_ORDER.indexOf(kind as typeof RECORD_ORDER[number]);
        if (position < stage || (position === stage && ONCE.has(kind))) throw outOfOrder(`${kind} after ${RECORD_ORDER[stage]}`);
        for (const earlier of RECORD_ORDER.slice(0, position)) if (ONCE.has(earlier) && !seen.has(earlier)) throw outOfOrder(`${kind} before ${earlier}`);
        stage = position;
        seen.add(kind);
      };
      const closeObject = async (): Promise<void> => {
        if (object === undefined) return;
        if (object.received !== object.expected) throw outOfOrder('a stored file is short');
        await upload!.finish();
        upload = undefined;
        object = undefined;
        objects += 1;
      };

      for await (const record of reader.records()) {
        if (record.kind !== 'data') await closeObject();
        switch (record.kind) {
          case 'keys':
            enter(record.kind);
            break;
          case 'operators':
            enter(record.kind);
            await tenantDataRepo.loadOperators(db, record.rows);
            break;
          case 'organisation':
            enter(record.kind);
            await tenantDataRepo.loadOrganisation(db, await tenantDataRepo.columnsOf(db, ORGANISATION_ROW), record.rows, deps.cellId);
            break;
          case 'users':
            enter(record.kind);
            try {
              await tenantDataRepo.loadUsers(db, await tenantDataRepo.columnsOf(db, MEMBER_USERS), record.rows);
            } catch (error) {
              if (fromDatabaseError(error).category === 'conflict') {
                throw new Refusal('user_conflict', 'a person in the organisation already has a different user in this cell');
              }
              throw error;
            }
            break;
          case 'table': {
            enter(record.kind);
            const mine = here.get(qualified(record));
            if (mine === undefined || mine.insertable.join(',') !== record.insertable.join(',')) {
              throw new Refusal('schema_mismatch', `${qualified(record)} differs between the cells: both must run the same release`);
            }
            table = mine;
            break;
          }
          case 'rows':
            if (table === undefined || RECORD_ORDER[stage] !== 'table') throw outOfOrder('rows outside a table');
            await tenantDataRepo.load(db, table, record.rows);
            break;
          case 'migration': {
            enter(record.kind);
            // The migration itself, now in this cell's hands, and its history. Its size and
            // checksum are set once the whole bundle has been read.
            const current = JSON.parse(record.migration) as Record<string, unknown>;
            Object.assign(current, {
              status: 'verifying', import_started_at: at, import_completed_at: at, bundle_object_key: bundleKey(header.migrationId),
            });
            await tenantDataRepo.load(db, here.get('platform.tenant_migrations')!, [...record.history.migrations, JSON.stringify(current)]);
            await tenantDataRepo.load(db, here.get('platform.tenant_migration_tables')!, record.history.tables);
            break;
          }
          case 'checksums':
            enter(record.kind);
            await verify(deps, db, header, here, record.checksums, at);
            break;
          case 'object':
            // The stored files, before the commit: a load that then fails removes them again.
            enter(record.kind);
            if (!record.key.startsWith(`${objectKey.organisationFolder(organisationId)}/`)) throw new Refusal('foreign_object', 'a file outside the organisation');
            try {
              upload = await deps.objects.openUpload(record.bucket, record.key as ObjectKey, record.contentType);
            } catch (error) {
              if ((error as AppError).category === 'configuration') throw new Refusal('store_missing', `this cell has no ${record.bucket} store`);
              throw error;
            }
            put.push({ bucket: record.bucket, key: record.key as ObjectKey });
            object = { expected: record.bytes, received: 0 };
            break;
          case 'data':
            if (object === undefined) throw outOfOrder('file bytes outside a file');
            object.received += record.body.length;
            if (object.received > object.expected) throw outOfOrder('a stored file is long');
            await upload!.write(record.body);
            break;
          case 'end':
            enter(record.kind);
            if (record.objects !== objects) throw outOfOrder('the stored files are not all there');
            break;
        }
      }
      if (!seen.has('end')) throw outOfOrder('no end record');
      const { bytes, checksum } = reader.digest();
      await tenantMigrationRepo.update(db, header.migrationId, { bundleBytes: String(bytes), bundleChecksum: checksum });
    });
  } catch (error) {
    await upload?.abort().catch(() => undefined);
    for (const p of put) await deps.objects.purge(p.bucket, p.key).catch(() => undefined);
    throw error;
  }
}

/** Row counts and checksums: every table, recomputed here, or nothing loads. */
async function verify(deps: TenantMigrationsDeps, db: Queryable, header: BundleHeader, here: ReadonlyMap<string, TenantTable>,
  checksums: readonly TableChecksum[], at: string): Promise<void> {
  const organisationId = header.organisationId;
  const mismatched: string[] = [];
  for (const c of checksums) {
    let mine: { rowCount: number; checksum: string };
    if (qualified(c) === qualified(ORGANISATION_ROW)) mine = checksumOf(await tenantDataRepo.organisationRow(db, organisationId));
    else if (qualified(c) === qualified(MEMBER_USERS)) mine = checksumOf(await tenantDataRepo.memberUserRows(db, organisationId));
    else {
      const table = here.get(qualified(c));
      if (table === undefined) throw new Refusal('schema_mismatch', `${qualified(c)} is not a table in this cell`);
      const hasher = rowHasher();
      for await (const rows of tenantDataRepo.rowBatches(db, table, organisationId, deps.rowBatch ?? ROW_BATCH)) hasher.add(rows);
      mine = hasher.result();
    }
    const matched = mine.rowCount === c.rowCount && mine.checksum === c.checksum;
    if (!matched) mismatched.push(qualified(c));
    await tenantMigrationTableRepo.insert(db, {
      id: c.id, organisationId, migrationId: header.migrationId, schemaName: c.schema, tableName: c.table,
      sourceRowCount: String(c.rowCount), sourceChecksum: Buffer.from(c.checksum, 'hex'),
      destinationRowCount: String(mine.rowCount), destinationChecksum: Buffer.from(mine.checksum, 'hex'), matched, verifiedAt: at,
    });
  }
  if (mismatched.length > 0) {
    deps.logger.error('tenant load does not match its source', {
      event: 'tenant_migrations.checksum_mismatch', organisationId, resourceId: header.migrationId, rowCount: mismatched.length,
    });
    throw new Refusal('checksum_mismatch', `${mismatched.length} tables differ from the source`);
  }
}

// ----------------------------------------------------------------------------- purge (source, or an aborted load)

export interface PurgeCounts {
  tables: { schema: string; table: string; rows: number }[];
  users: number;
  objects: { files: number; siloes: number };
}

/**
 * Every row and file of the organisation, gone from this cell. before() runs inside the
 * transaction once the counts are known, and its failure leaves everything in place.
 */
export async function purgeOrganisation(deps: TenantMigrationsDeps, organisationId: string,
  before: (counts: PurgeCounts) => Promise<void>): Promise<PurgeCounts> {
  const objects = { files: [] as ObjectKey[], siloes: [] as ObjectKey[] };
  for (const bucket of ['files', 'siloes'] as const) {
    try {
      objects[bucket] = await deps.objects.list(bucket, objectKey.organisationFolder(organisationId), MAX_OBJECTS);
    } catch (error) {
      if (bucket === 'siloes' && (error as AppError).category === 'configuration') continue;
      throw error;
    }
  }
  const counts = await asMigrate(deps, async (db) => {
    await tenantDataRepo.bulkMode(db);
    const userIds = await tenantDataRepo.memberUserIds(db, organisationId);
    const tables: PurgeCounts['tables'] = [];
    for (const table of await tenantDataRepo.tenantTables(db)) {
      const rows = await tenantDataRepo.purge(db, table, organisationId);
      if (rows > 0) tables.push({ schema: table.schema, table: table.table, rows });
    }
    tables.push({ ...ORGANISATION_ROW, rows: await tenantDataRepo.purgeOrganisation(db, organisationId) });
    const users = await tenantDataRepo.purgeUsers(db, userIds);
    const counts: PurgeCounts = { tables, users: users.users, objects: { files: objects.files.length, siloes: objects.siloes.length } };
    await before(counts);
    return counts;
  });
  for (const bucket of ['files', 'siloes'] as const) {
    for (const key of objects[bucket]) await deps.objects.purge(bucket, key);
  }
  return counts;
}

/** The source purge (spec 6.4: "source purge with receipt"), 30 days after the directory moved. */
export async function purgeSource(deps: TenantMigrationsDeps, migration: TenantMigration): Promise<{ receiptSha256: string }> {
  const slug = await inTransaction(deps.databases.pool('control'), { organisationId: migration.organisationId },
    async (db) => (await organisationRepo.findById(db, migration.organisationId))?.slug ?? null, { readOnly: true });
  let receiptSha256 = '';
  await purgeOrganisation(deps, migration.organisationId, async (counts) => {
    const receipt = canonicalJsonBytes({
      format: 'silo.tenant_purge_receipt.v1', migration_id: migration.id, organisation_id: migration.organisationId,
      organisation_slug: slug, source_cell_id: migration.sourceCellId, destination_cell_id: migration.destinationCellId,
      bundle_checksum: migration.bundleChecksum?.toString('hex') ?? null, directory_updated_at: migration.directoryUpdatedAt,
      purged_at: nowOf(deps).toISOString(),
      tables: counts.tables.map((t) => ({ table: qualified(t), rows: t.rows })),
      users: counts.users, objects: counts.objects,
    });
    receiptSha256 = sha256(receipt).toString('hex');
    await deps.objects.put('backup', purgeReceiptKey(migration.id), receipt, 'application/json');
  });
  await deps.objects.purge('backup', bundleKey(migration.id)).catch(() => undefined);
  deps.logger.info('organisation purged from the source cell', {
    event: 'tenant_migrations.source_purged', organisationId: migration.organisationId, resourceId: migration.id, reason: receiptSha256,
  });
  return { receiptSha256 };
}

/** A receipt handed over from the source: it must name this migration. */
export interface PurgeReceipt { migrationId: string; organisationId: string; sourceCellId: string; purgedAt: string; sha256: Buffer }

export function readPurgeReceipt(bytes: Buffer, migration: TenantMigration): PurgeReceipt {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError('integrity', 'the purge receipt is not JSON', { code: 'tenant_migrations.receipt_malformed' });
  }
  if (document['format'] !== 'silo.tenant_purge_receipt.v1' || document['migration_id'] !== migration.id
    || document['organisation_id'] !== migration.organisationId || document['source_cell_id'] !== migration.sourceCellId
    || typeof document['purged_at'] !== 'string') {
    throw new AppError('integrity', 'the purge receipt is not this migration\'s', { code: 'tenant_migrations.receipt_mismatch' });
  }
  return {
    migrationId: migration.id, organisationId: migration.organisationId, sourceCellId: migration.sourceCellId,
    purgedAt: document['purged_at'], sha256: sha256(bytes),
  };
}

/** Whether the organisation holds any Silo here: what the move-in and move-out of its Silo stores need asking about (D212). */
export async function organisationHoldsSiloes(deps: TenantMigrationsDeps, organisationId: string): Promise<boolean> {
  return inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => holdsSiloes(db, organisationId, await movingTables(db)), { readOnly: true });
}

/**
 * Replays organisations purged from this cell after it is restored (spec 8.2, 12.5; D251). Their
 * ledger is the purge receipts in object-backup (purgeReceiptKey), which a restore of pg-control
 * does not rewind: each organisation the restore brought back is purged again, rows and objects,
 * with no new receipt (the first one stands). One the restore does not hold is skipped.
 */
export async function replayOrganisationPurges(deps: TenantMigrationsDeps, entries: readonly StoredLedgerEntry[]): Promise<{ replayed: number; skipped: number }> {
  let replayed = 0;
  let skipped = 0;
  for (const stored of entries) {
    if (stored.entry.kind !== 'organisation') { skipped += 1; continue; }
    const counts = await purgeOrganisation(deps, stored.organisationId, async () => undefined);
    if (counts.tables.every((t) => t.rows === 0) && counts.objects.files + counts.objects.siloes === 0) skipped += 1; else replayed += 1;
  }
  return { replayed, skipped };
}
