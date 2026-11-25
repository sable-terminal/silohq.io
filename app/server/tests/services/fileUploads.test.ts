// Uploads in Files (spec 41.4 to 41.6): a document stored against an Import Silo. It carries the
// Silo's retention and markings; an SVG is rebuilt from an allowlist before it is stored; a person
// a share reaches but who cannot open the Silo is refused and that is recorded; and deleting it is
// a purge of its Silo file, after which the entry goes with the purge's receipt.

import { replayFilePurges } from '../../src/contracts/platform/purgeLedger.contract.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { deleteFile, downloadFile, getFile, shareFile, uploadFile } from '../../src/contracts/files/file.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { createImportSilo } from '../../src/contracts/siloes/import.contract.ts';
import { getPurge, setSiloesEnabled, type SiloView } from '../../src/contracts/siloes/siloes.contract.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createFilesService } from '../../src/routes/files/index.route.ts';
import { createImportLoaderService } from '../../src/routes/import-loader/index.route.ts';
import { createSiloesCaptureService } from '../../src/routes/siloes-capture/index.route.ts';
import { createSiloesImportService } from '../../src/routes/siloes-import/index.route.ts';
import { createSiloStore } from '../../src/services/connect-runtime/siloStore.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { beginFileUpload, completeFileUpload, getFileDownloadLink } from '../../src/contracts/files/file.contract.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';
import { createFakeBigQuery } from './warehouse.helper.ts';
import { freePort } from './writeback.helper.ts';

let rc: RecognitionCell;
let gateway: RecognitionCell['gateway'];
let silo: SiloView;
const store = createMemoryStore();
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const sql = (text: string, values: unknown[] = []) => inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query(text, values));
const upload = (body: { name: string; content: string; siloId?: string }, who = rc.root) => gateway.call(uploadFile, {
  body: { siloId: body.siloId ?? silo.id, name: body.name, contentBase64: b64(body.content) },
}, { ...rc.cell.as(who), idempotencyKey: uuidv7() });

async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

before(async () => {
  const bq = createFakeBigQuery();
  rc = await startRecognitionCell([], { siloStore: createSiloStore(bq, 'silo-test-proj') });
  const env = {
    BIGQUERY_PROJECT_ID: 'silo-test-proj', BIGQUERY_LOCATION: 'europe-west2', SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20',
    SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02', SILOES_PURGE_POLL_SECONDS: '1', SILOES_IMPORT_PROCESS_SECONDS: '1',
    SILOES_CAPTURE_DRAIN_SECONDS: '1', SILOES_RETENTION_SWEEP_SECONDS: '604800', OBJECT_STORE: 's3', OBJECT_BUCKET_SILOES: 'silo-test-siloes',
    OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
  };
  await rc.cell.start(approvalsService, 'approvals', 'test_app');
  await rc.cell.start(createImportLoaderService({ bigQuery: bq }), 'import-loader', 'test_app', env);
  // Files and siloes-capture call each other, and a service learns only the addresses of those
  // started before it: Files' port is chosen first and given to siloes-capture.
  const filesPort = await freePort();
  await rc.cell.start(createSiloesCaptureService({ store }), 'siloes-capture', 'test_app', { ...env, SERVICE_URL_FILES: `http://127.0.0.1:${filesPort}` });
  // An upload is a request body of up to the export bound in base64: the processes take one (as deployed).
  const big = { HTTP_MAX_BODY_BYTES: String(8 * 1024 * 1024) };
  await rc.cell.start(createSiloesImportService({ store }), 'siloes-import', 'test_app', { ...env, ...big });
  await rc.cell.start(createFilesService({ store }), 'files', 'test_app', { ...env, ...big, HTTP_PORT: String(filesPort) });
  gateway = rc.cell.client('gateway');
  await gateway.call(setSiloesEnabled, { body: { enabled: true } }, rc.cell.as(rc.root));
  silo = await gateway.call(createImportSilo, { body: { name: 'Contracts', purpose: 'Signed contracts', retentionDays: 365 } }, rc.keyed(rc.root));
});

after(async () => {
  await rc?.close();
});

describe('uploads (spec 41.4)', () => {
  test('stored against the Silo, with its retention; opened again; nothing extracted', async () => {
    const file = await upload({ name: 'terms.txt', content: 'The supplier shall deliver.' });
    assert.equal(file.kind, 'upload');
    const days = (Date.parse(file.expiresAt!) - Date.parse(file.createdAt)) / 86_400_000;
    assert.ok(Math.abs(days - 365) < 0.01, 'the Silo\'s window');
    const opened = await gateway.call(downloadFile, { params: { fileId: file.id } }, rc.cell.as(rc.root));
    assert.equal(Buffer.from(opened.content, 'base64').toString('utf8'), 'The supplier shall deliver.');
    assert.equal(opened.contentType, 'text/plain', 'from the bytes');
    const { rows } = await sql('select f.status, f.content_type from siloes.silo_files f join files.files x on x.silo_file_id = f.id where x.id = $1', [file.id]);
    assert.deepEqual(rows[0], { status: 'processed', content_type: 'text/plain' }, 'stored only: the import worker never reads it');
  });

  test('an SVG is rebuilt from an allowlist before it is stored', async () => {
    const file = await upload({
      name: 'plan.svg',
      content: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="5" onclick="x()"/><a href="javascript:y()"><circle r="1"/></a></svg>',
    });
    const opened = await gateway.call(downloadFile, { params: { fileId: file.id } }, rc.cell.as(rc.root));
    const svg = Buffer.from(opened.content, 'base64').toString('utf8');
    assert.equal(opened.contentType, 'image/svg+xml');
    assert.ok(svg.includes('<rect width="5"/>'));
    assert.ok(!/script|onload|onclick|javascript/i.test(svg), svg);
    await assert.rejects(upload({ name: 'bad.svg', content: '<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>' }), { code: 'files.svg_refused' });
  });

  test('bounded; and only for a person who may import into the Silo', async () => {
    await assert.rejects(upload({ name: 'big.txt', content: 'x'.repeat(5 * 1024 * 1024 + 1) }), { code: 'files.upload_too_large' });
    await assert.rejects(upload({ name: 'nope.txt', content: 'no' }, rc.viewer), { code: 'files.not_permitted' }, 'a viewer holds no file.upload');
  });

  test('a share reaches a person who may not import: they open it, without silo.import, until the Silo is marked beyond them; refused, and recorded', async () => {
    const file = await upload({ name: 'shared.txt', content: 'For the viewer.' });
    await gateway.call(shareFile, { params: { fileId: file.id }, body: { grantee: { membershipId: rc.viewer.membershipId }, access: 'download' } }, rc.cell.as(rc.root));
    const opened = await gateway.call(downloadFile, { params: { fileId: file.id } }, rc.cell.as(rc.viewer));
    assert.equal(Buffer.from(opened.content as string, 'base64').toString('utf8'), 'For the viewer.', 'opening needs no silo.import (decided 2026-11-23)');
    const marking = (await gateway.call(createMarking, { body: { name: 'Counsel', kind: 'compartment' } }, rc.cell.as(rc.root))).id;
    await gateway.call(grantClearance, { body: { markingId: marking, holder: { kind: 'membership', id: rc.root.membershipId } } }, rc.cell.as(rc.root));
    await gateway.call(applyMarking, { body: { markingId: marking, resource: { type: 'silo', id: silo.id } } }, rc.cell.as(rc.root));
    await assert.rejects(gateway.call(downloadFile, { params: { fileId: file.id } }, rc.cell.as(rc.viewer)), { code: 'files.cannot_open' });
    const { rows } = await sql(`select payload -> 'detail' ->> 'reason' as reason from platform.outbox
      where payload ->> 'event' = 'file_download_refused' and payload -> 'resource' ->> 'id' = $1`, [file.id]);
    assert.deepEqual(rows.map((r: { reason: string }) => r.reason), ['silo_access'], 'the Silo checks its markings at every open');
  });

  test('the Silo\'s markings: clearance to upload, and the file carries them', async () => {
    const marking = (await gateway.call(createMarking, { body: { name: 'Legal', kind: 'compartment' } }, rc.cell.as(rc.root))).id;
    await gateway.call(applyMarking, { body: { markingId: marking, resource: { type: 'silo', id: silo.id } } }, rc.cell.as(rc.root));
    await assert.rejects(upload({ name: 'marked.txt', content: 'Privileged.' }), { code: 'import.not_cleared' });
    await gateway.call(grantClearance, { body: { markingId: marking, holder: { kind: 'membership', id: rc.root.membershipId } } }, rc.cell.as(rc.root));
    const file = await upload({ name: 'marked.txt', content: 'Privileged.' });
    assert.ok(file.markings.map((m) => m.id).includes(marking), 'it carries the Silo\'s markings (the earlier test marked it too)');
  });

  test('deleting an upload is a purge of its Silo file: the document, then the entry, with the receipt', async () => {
    const file = await upload({ name: 'gone.txt', content: 'Delete me.' });
    const [{ silo_file_id: siloFileId }] = (await sql('select silo_file_id from files.files where id = $1', [file.id])).rows;
    const asked = await gateway.call(deleteFile, { params: { fileId: file.id } }, rc.cell.as(rc.root));
    assert.ok('purgeId' in asked, JSON.stringify(asked));
    if (!('purgeId' in asked)) return;
    const done = await until('the purge', async () => {
      const p = await gateway.call(getPurge, { params: { siloId: silo.id, purgeId: asked.purgeId } }, rc.cell.as(rc.root));
      return p.status === 'completed' || p.status === 'failed' ? p : undefined;
    });
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.equal(store.keys('siloes').some((k) => k.endsWith(siloFileId)), false, 'the source document is gone');
    const deletion = await until('the entry to go', async () => {
      const { rows } = await sql('select purge_receipt_id from files.file_deletions where file_id = $1', [file.id]);
      return rows[0] as { purge_receipt_id: string } | undefined;
    });
    assert.equal(deletion.purge_receipt_id, done.receipt!.id);
    await assert.rejects(gateway.call(getFile, { params: { fileId: file.id } }, rc.cell.as(rc.root)), { code: 'files.file_not_found' });

    // The purge ledger (8.2; D251): the entry goes again after a restore that brought it back.
    const { rows: [ledger] } = await rc.cell.migrate.query(
      `select id, organisation_id, created_at, correlation_id, payload from platform.outbox where topic = 'platform.purge_ledger' and payload->>'kind' = 'files' and payload->'fileIds' ? $1`, [file.id]);
    assert.deepEqual(ledger.payload, { kind: 'files', fileIds: [file.id] });
    // As a restore would hold it: the row before its deletion (the deleted row's guard is off for this one update).
    await rc.cell.migrate.query('begin');
    await rc.cell.migrate.query(`set local session_replication_role = replica`);
    await rc.cell.migrate.query(`update files.files set status = 'available', deleted_at = null where id = $1`, [file.id]);
    await rc.cell.migrate.query('commit');
    const replayed = await rc.cell.client('maintenance').call(replayFilePurges, { body: { entries: [{
      id: ledger.id, organisationId: ledger.organisation_id, occurredAt: new Date(ledger.created_at).toISOString(), correlationId: ledger.correlation_id, entry: ledger.payload,
    }] } }, { correlationId: uuidv7() });
    assert.deepEqual(replayed, { replayed: 1, skipped: 0 });
    await assert.rejects(gateway.call(getFile, { params: { fileId: file.id } }, rc.cell.as(rc.root)), { code: 'files.file_not_found' });
  });
});

describe('uploads larger than one request (spec 41.4)', () => {
  test('a signed transfer straight to the Silo\'s storage, completed into the same entry; opened through a signed link', async () => {
    const begun = await gateway.call(beginFileUpload, { body: { siloId: silo.id, sizeBytes: 64 } }, rc.cell.as(rc.root));
    const key = begun.url.replace('memory://siloes/', '');
    assert.equal(key, `org/${rc.cell.org}/silo/${silo.id}/drop/files/${begun.uploadId}`, 'into the Silo\'s drop prefix, under no filename');
    assert.ok(Date.parse(begun.expiresAt) - Date.now() <= 15 * 60_000);
    const complete = () => gateway.call(completeFileUpload, { params: { uploadId: begun.uploadId }, body: { siloId: silo.id, name: 'tender.txt' } },
      { ...rc.cell.as(rc.root), idempotencyKey: uuidv7() });
    await assert.rejects(complete(), { code: 'import.upload_not_found' });
    // The client sends the bytes to the URL; in memory, a put under its key.
    await store.put('siloes', key as never, Buffer.from('The tender closes on Friday.'), 'application/octet-stream');
    const file = await complete();
    assert.deepEqual([file.kind, file.name], ['upload', 'tender.txt']);
    assert.equal(store.keys('siloes').includes(key), false, 'the drop object is removed once stored');
    const link = await gateway.call(getFileDownloadLink, { params: { fileId: file.id } }, rc.cell.as(rc.root));
    assert.equal(link.contentType, 'text/plain');
    const stored = await store.get('siloes', link.url.replace('memory://siloes/', '') as never);
    assert.equal(stored.toString('utf8'), 'The tender closes on Friday.');
    const { rows } = await sql(`select payload -> 'detail' as detail from platform.outbox where payload ->> 'event' = 'file_opened' order by created_at desc limit 1`);
    assert.equal(rows[0].detail.link, true, 'a link handed out is recorded as opening the file');
  });

  test('bounded by the import bound; refused to a person who may not import into the Silo; an export opens in a reply', async () => {
    await assert.rejects(gateway.call(beginFileUpload, { body: { siloId: silo.id, sizeBytes: 10 * 1024 * 1024 * 1024 } }, rc.cell.as(rc.root)),
      { code: 'import.file_too_large' });
    await assert.rejects(gateway.call(beginFileUpload, { body: { siloId: silo.id, sizeBytes: 64 } }, rc.cell.as(rc.viewer)), { code: 'files.not_permitted' });
  });
});
