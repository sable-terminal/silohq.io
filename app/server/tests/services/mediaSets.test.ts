// Media sets (D237): images, video, audio and PDFs kept in an Import Silo, each a Files upload
// with the facts its bytes give. Made and added to with file.upload and the Silo's own checks;
// what is not media refused before anything is stored. Shared to view (open its items without
// silo.import, every marking on the Silo still needed, checked by the Silo at each open) or to
// contribute; items paged and filtered by kind; removed from the set with the upload kept.
// Real processes: the files cell with Import Siloes.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getFile } from '../../src/contracts/files/file.contract.ts';
import {
  addMediaItem, archiveMediaSet, createMediaSet, listMediaItems, listMediaSets, openMediaItem, removeMediaItem, revokeMediaSetShare, shareMediaSet,
} from '../../src/contracts/files/media.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { createImportSilo, listFiles } from '../../src/contracts/siloes/import.contract.ts';
import { inTx } from '../db/harness.helper.ts';
import { jpeg, mp4, pdf, png, wav } from './media.helper.ts';
import { createFilesCell, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let siloId: string;
let mediaSetId: string;
const b64 = (b: Buffer) => b.toString('base64');

before(async () => {
  f = await createFilesCell({ siloes: true });
  await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query('update iam.organisations set storage_enabled = true where id = $1', [f.cell.org]));
  siloId = (await f.gateway.call(createImportSilo, { body: { name: 'Inspections', purpose: 'Site photographs and recordings', retentionDays: 365 } }, f.keyed(f.root))).id;
});

after(async () => {
  await f?.close();
});

describe('media sets (D237)', () => {
  test('made over an Import Silo by someone who may upload into it; a member who may not is refused', async () => {
    await assert.rejects(f.gateway.call(createMediaSet, { body: { name: 'Pumps', siloId } }, f.keyed(f.member)), { code: 'files.not_permitted' });
    const made = await f.gateway.call(createMediaSet, { body: { name: 'Pump inspections', description: 'Photos and clips from site visits', siloId } }, f.keyed(f.root));
    mediaSetId = made.id;
    assert.deepEqual([made.access, made.itemCount, made.siloId], ['owner', 0, siloId]);
  });

  test('items added with the facts their bytes give; what is not media refused before anything is stored', async () => {
    const add = (name: string, bytes: Buffer) => f.gateway.call(addMediaItem, { params: { mediaSetId }, body: { name, contentBase64: b64(bytes) } }, f.keyed(f.root));
    const photo = await add('pump-17.jpg', jpeg({ width: 4000, height: 3000, orientation: 6, taken: '2026:03:01 09:30:00' }));
    assert.deepEqual([photo.kind, photo.contentType, photo.width, photo.height, photo.capturedAt], ['image', 'image/jpeg', 3000, 4000, '2026-03-01T09:30:00']);
    const clip = await add('walkround.mp4', mp4({ seconds: 95, tracks: [{ handler: 'vide', width: 1920, height: 1080 }, { handler: 'soun' }] }));
    assert.deepEqual([clip.kind, clip.durationMs, clip.width, clip.height], ['video', 95_000, 1920, 1080]);
    const note = await add('voice-note.wav', wav(3));
    assert.deepEqual([note.kind, note.contentType, note.durationMs], ['audio', 'audio/wav', 3000]);
    const report = await add('report.pdf', pdf(12));
    assert.deepEqual([report.kind, report.pages], ['document', 12]);
    await add('diagram.png', png(640, 480));

    const before = (await f.gateway.call(listFiles, { params: { siloId } }, f.cell.as(f.root))).files.length;
    await assert.rejects(add('readings.csv', Buffer.from('id,reading\n1,42\n')), { code: 'import.not_media' });
    await assert.rejects(add('logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')), { code: 'import.not_media' });
    assert.equal((await f.gateway.call(listFiles, { params: { siloId } }, f.cell.as(f.root))).files.length, before, 'nothing stored');

    // Kept in the Silo as media, as their own type: never read by the import worker.
    const { rows } = await f.cell.migrate.query(`select content_class, content_type, status from siloes.silo_files where silo_id = $1 order by received_at`, [siloId]);
    assert.ok(rows.every((r) => r.content_class === 'media' && r.status === 'processed'), JSON.stringify(rows));
    assert.ok(rows.some((r) => r.content_type === 'video/mp4'));
  });

  test('paged newest first and filtered by kind', async () => {
    const all = await f.gateway.call(listMediaItems, { params: { mediaSetId }, query: {} }, f.cell.as(f.root));
    assert.deepEqual(all.items.map((i) => i.name), ['diagram.png', 'report.pdf', 'voice-note.wav', 'walkround.mp4', 'pump-17.jpg']);
    const first = await f.gateway.call(listMediaItems, { params: { mediaSetId }, query: { limit: 2 } }, f.cell.as(f.root));
    assert.equal(first.items.length, 2);
    const second = await f.gateway.call(listMediaItems, { params: { mediaSetId }, query: { limit: 2, after: first.next! } }, f.cell.as(f.root));
    assert.deepEqual(second.items.map((i) => i.name), ['voice-note.wav', 'walkround.mp4']);
    const videos = await f.gateway.call(listMediaItems, { params: { mediaSetId }, query: { kind: 'video' } }, f.cell.as(f.root));
    assert.deepEqual(videos.items.map((i) => i.name), ['walkround.mp4']);
  });

  test('shared to view: opened without silo.import, every marking still needed and checked by the Silo at each open; adding refused', async () => {
    await assert.rejects(f.gateway.call(listMediaItems, { params: { mediaSetId }, query: {} }, f.cell.as(f.member)), { code: 'files.media_set_not_found' });
    const share = await f.gateway.call(shareMediaSet, { params: { mediaSetId }, body: { grantee: { membershipId: f.member.membershipId }, access: 'view' } }, f.cell.as(f.root));
    const theirs = await f.gateway.call(listMediaSets, { query: { filter: 'shared' } }, f.cell.as(f.member));
    assert.deepEqual(theirs.mediaSets.map((s) => [s.id, s.access, s.itemCount]), [[mediaSetId, 'view', 5]]);
    const items = (await f.gateway.call(listMediaItems, { params: { mediaSetId }, query: {} }, f.cell.as(f.member))).items;
    const diagram = items.find((i) => i.name === 'diagram.png')!;
    const opened = await f.gateway.call(openMediaItem, { params: { mediaSetId, itemId: diagram.id }, body: {} }, f.cell.as(f.member));
    assert.equal(opened.kind, 'content');
    if (opened.kind === 'content') assert.equal(opened.content, b64(png(640, 480)), 'the member holds no silo.import');
    await assert.rejects(f.gateway.call(addMediaItem, { params: { mediaSetId }, body: { name: 'x.png', contentBase64: b64(png(1, 1)) } }, f.keyed(f.member)),
      { code: 'files.media_set_view_only' });

    const marking = await f.gateway.call(createMarking, { body: { name: 'Site security', kind: 'classification', rank: 1 } }, f.cell.as(f.root));
    await f.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: f.root.membershipId } } }, f.cell.as(f.root));
    await f.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'silo', id: siloId } } }, f.cell.as(f.root));
    await assert.rejects(f.gateway.call(openMediaItem, { params: { mediaSetId, itemId: diagram.id }, body: {} }, f.cell.as(f.member)), { code: 'files.cannot_open' });
    const { rows } = await f.cell.migrate.query(`select payload->'detail' as d from platform.outbox where payload->>'event' = 'file_download_refused' order by seq desc limit 1`);
    assert.equal(rows[0].d.media_set_id, mediaSetId, 'the refusal is recorded');
    await f.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: f.member.membershipId } } }, f.cell.as(f.root));
    assert.equal((await f.gateway.call(openMediaItem, { params: { mediaSetId, itemId: diagram.id }, body: {} }, f.cell.as(f.member))).kind, 'content');

    await f.gateway.call(revokeMediaSetShare, { params: { mediaSetId, shareId: share.id } }, f.cell.as(f.root));
    await assert.rejects(f.gateway.call(openMediaItem, { params: { mediaSetId, itemId: diagram.id }, body: {} }, f.cell.as(f.member)), { code: 'files.media_set_not_found' });
  });

  test('shared to contribute, adding still needs file.upload; an item removed by its owner leaves its upload in Files; archived, it leaves the shared list', async () => {
    await f.gateway.call(shareMediaSet, { params: { mediaSetId }, body: { grantee: { membershipId: f.member.membershipId }, access: 'contribute' } }, f.cell.as(f.root));
    await assert.rejects(f.gateway.call(addMediaItem, { params: { mediaSetId }, body: { name: 'x.png', contentBase64: b64(png(1, 1)) } }, f.keyed(f.member)),
      { code: 'files.not_permitted' });
    const items = (await f.gateway.call(listMediaItems, { params: { mediaSetId }, query: {} }, f.cell.as(f.root))).items;
    const report = items.find((i) => i.name === 'report.pdf')!;
    await assert.rejects(f.gateway.call(removeMediaItem, { params: { mediaSetId, itemId: report.id } }, f.cell.as(f.member)), { code: 'files.media_item_not_yours' });
    await f.gateway.call(removeMediaItem, { params: { mediaSetId, itemId: report.id } }, f.cell.as(f.root));
    assert.equal((await f.gateway.call(listMediaItems, { params: { mediaSetId }, query: {} }, f.cell.as(f.root))).items.length, 4);
    assert.equal((await f.gateway.call(getFile, { params: { fileId: report.fileId } }, f.cell.as(f.root))).name, 'report.pdf', 'the upload stays in Files');

    await f.gateway.call(archiveMediaSet, { params: { mediaSetId } }, f.cell.as(f.root));
    assert.equal((await f.gateway.call(listMediaSets, { query: { filter: 'shared' } }, f.cell.as(f.member))).mediaSets.length, 0);
    assert.deepEqual((await f.gateway.call(listMediaSets, { query: { filter: 'archived' } }, f.cell.as(f.root))).mediaSets.map((s) => s.id), [mediaSetId]);
    const events = (await f.cell.migrate.query(`select distinct payload->>'event' as e from platform.outbox where payload->>'event' like 'media_%'`)).rows.map((r) => r.e).sort();
    assert.deepEqual(events, ['media_item_added', 'media_item_removed', 'media_set_archived', 'media_set_created', 'media_set_share_revoked', 'media_set_shared']);
  });
});
