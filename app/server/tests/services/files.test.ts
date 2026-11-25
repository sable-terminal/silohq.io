// Files end to end (spec 41): exports rendered from a saved view through the real query path,
// stored with frozen permissions, provenance, markings and lineage; opening under the access
// and marking checks of 41.3; sharing; folders; deletion with its receipt; the retention
// sweep.

import { getOrganisationLogo, setOrganisationLogo } from '../../src/contracts/files/logo.contract.ts';
import assert from 'node:assert/strict';
import type { z } from 'zod';
import { after, before, describe, test } from 'node:test';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  createExport, createFolder, deleteFile, downloadFile, getFile, listFiles, listFileShares, previewExportMarkings, revokeFileShare, shareFile, updateFile, updateFolder,
  type FileView,
} from '../../src/contracts/files/file.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { renderExport } from '../../src/contracts/render/render.contract.ts';
import { exportLineage } from '../../src/contracts/lineage/export.contract.ts';
import { createLineageService } from '../../src/routes/lineage/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createFilesCell, invoiceType, until, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let viewId: string;
let planId: string;

const exportView = (who = f.member, name = 'Invoices', key = uuidv7()) => f.gateway.call(renderExport, {
  body: { planId, name, source: { kind: 'view', savedViewId: viewId } },
}, { ...f.cell.as(who), idempotencyKey: key });

async function exported(who = f.member, name = 'Invoices'): Promise<FileView> {
  const out = await exportView(who, name);
  assert.equal(out.outcome, 'exported', JSON.stringify(out));
  return (out as { file: FileView }).file;
}

const text = async (fileId: string, who = f.member) =>
  Buffer.from((await f.gateway.call(downloadFile, { params: { fileId } }, f.cell.as(who))).content, 'base64').toString('utf8');
const visible = async (who: typeof f.member) => (await f.gateway.call(listFiles, { query: {} }, f.cell.as(who))).files.map((x) => x.id);
const objectExists = async (fileId: string) => {
  try {
    await f.s3.send(new HeadObjectCommand({ Bucket: f.bucket, Key: `org/${f.cell.org}/exports/${fileId}` }));
    return true;
  } catch {
    return false;
  }
};

before(async () => {
  f = await createFilesCell({ files: { FILES_EXPORT_RETENTION_DAYS: '30', FILES_SWEEP_SECONDS: '1' } });
  ({ viewId, planId } = await f.view(f.member, {
    nodes: [{ objectTypeId: invoiceType(f.manifest), filters: [] }],
    select: [{ node: 0, property: f.prop('invoice_id') }, { node: 0, property: f.prop('customer') }, { node: 0, property: f.prop('total') }],
    sort: [{ property: f.prop('invoice_id'), direction: 'asc' }],
  }, 'Invoices'));
});

after(async () => {
  await f?.close();
});

describe('exports (spec 41.2)', () => {
  test('a frozen result in Files: the document, its provenance, its frozen permissions and its lineage', async () => {
    const file = await exported();
    assert.equal(file.kind, 'export');
    assert.equal(file.name, 'Invoices.csv');
    assert.equal(file.contentType, 'text/csv');
    assert.equal(file.createdBy, f.member.membershipId);
    assert.deepEqual(file.markings, []);
    assert.equal(file.provenance?.sourceKind, 'view');
    assert.equal(file.provenance?.sourceId, viewId);
    const { rows: viewed } = await f.cell.migrate.query(
      `select payload->'resource'->>'id' as view, payload->'detail'->>'file_id' as file from platform.outbox where organisation_id = $1 and payload->>'event' = 'view_exported'`, [f.cell.org]);
    assert.deepEqual(viewed.at(-1), { view: viewId, file: file.id }, 'the view\'s record of being exported');
    assert.ok(file.expiresAt !== null, 'the cell\'s export retention');
    assert.ok(await objectExists(file.id));

    const csv = await text(file.id);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'Silo export,Invoices');
    assert.equal(lines[1], 'Markings,None');
    assert.ok(lines.includes('Invoice number,Customer,Total'));
    assert.ok(lines.includes('i1,Acme Ltd,120'));
    assert.ok(lines.includes('i3,"Brill, plc",300'));
    assert.ok(lines.includes('i2,"\'=HYPERLINK(""http://evil.example"")",80'), 'a formula from the source is made inert');

    const { rows } = await f.cell.migrate.query(
      `select p.connection_grants, p.markings, (select count(*)::int from gov.lineage_edges e
         join gov.lineage_nodes n on n.id = e.to_node_id where n.kind = 'export' and n.ref_id = p.file_id) as inputs
       from files.file_permissions p where p.file_id = $1`, [file.id]);
    assert.deepEqual(rows[0].connection_grants, [{ connectionId: f.crm, access: 'read' }]);
    assert.deepEqual(rows[0].markings, []);
    assert.ok(rows[0].inputs >= 3, 'the view, the type and the connection');
  });

  test('a retried export makes one file', async () => {
    const key = uuidv7();
    const first = await exportView(f.member, 'Once', key);
    const again = await exportView(f.member, 'Once', key);
    assert.equal(first.outcome, 'exported');
    assert.equal((again as { file: FileView }).file.id, (first as { file: FileView }).file.id);
  });
});

describe('sharing (spec 41.3)', () => {
  test('a share reaches its grantee at the access it gives; revoking ends it; organisation-wide needs the organisation\'s leave', async () => {
    const file = await exported(f.member, 'Shared');
    assert.ok(!(await visible(f.outsider)).includes(file.id));
    await assert.rejects(f.gateway.call(getFile, { params: { fileId: file.id } }, f.cell.as(f.outsider)), { code: 'files.file_not_found' });

    const share = await f.gateway.call(shareFile, {
      params: { fileId: file.id }, body: { grantee: { membershipId: f.outsider.membershipId }, access: 'view' },
    }, f.cell.as(f.member));
    assert.equal(share.recipientCanOpen, 'yes');
    assert.equal((await f.gateway.call(getFile, { params: { fileId: file.id } }, f.cell.as(f.outsider))).access, 'view');
    await assert.rejects(f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.outsider)), { code: 'files.cannot_open' });
    await f.gateway.call(shareFile, { params: { fileId: file.id }, body: { grantee: { membershipId: f.outsider.membershipId }, access: 'download' } },
      f.cell.as(f.member));
    assert.ok((await text(file.id, f.outsider)).includes('i1,Acme Ltd,120'), 'the frozen file, not a fresh run under the recipient\'s access');
    await assert.rejects(f.gateway.call(shareFile, { params: { fileId: file.id }, body: { grantee: { membershipId: f.member.membershipId } } },
      f.cell.as(f.outsider)), { code: 'files.not_owner' });
    await assert.rejects(f.gateway.call(shareFile, { params: { fileId: file.id }, body: { grantee: { organisation: true } } }, f.cell.as(f.member)),
      { code: 'files.org_wide_sharing_off' });

    const shares = (await f.gateway.call(listFileShares, { params: { fileId: file.id } }, f.cell.as(f.member))).shares;
    assert.equal(shares.length, 1, 'a second share to the same member updates the first');
    await f.gateway.call(revokeFileShare, { params: { fileId: file.id, shareId: shares[0]!.id } }, f.cell.as(f.member));
    assert.ok(!(await visible(f.outsider)).includes(file.id));
  });

  test('a scope share reaches the members of the scope\'s subtree', async () => {
    const platform = await f.cell.member('platform@acme.example', 'Member', 'platform');
    const file = await exported(f.member, 'Scoped');
    await f.gateway.call(shareFile, { params: { fileId: file.id }, body: { grantee: { scopeId: f.cell.scopes['engineering']! } } }, f.cell.as(f.member));
    assert.ok((await visible(platform)).includes(file.id), 'platform sits under engineering');
    assert.ok(!(await visible(f.outsider)).includes(file.id));
  });
});

describe('folders (spec 41.1)', () => {
  test('an arrangement, never a boundary: files move in, a folder never moves under itself, and only its maker rearranges it', async () => {
    const reports = await f.gateway.call(createFolder, { body: { name: 'Reports' } }, f.cell.as(f.member));
    const monthly = await f.gateway.call(createFolder, { body: { name: 'Monthly', parentId: reports.id } }, f.cell.as(f.member));
    const file = await exported(f.member, 'Filed');
    await f.gateway.call(updateFile, { params: { fileId: file.id }, body: { folderId: monthly.id } }, f.cell.as(f.member));
    const inside = (await f.gateway.call(listFiles, { query: { folderId: monthly.id } }, f.cell.as(f.member))).files;
    assert.deepEqual(inside.map((x) => x.id), [file.id]);
    await assert.rejects(f.gateway.call(updateFolder, { params: { folderId: reports.id }, body: { parentId: monthly.id } }, f.cell.as(f.member)),
      { code: 'files.folder_cycle' });
    await assert.rejects(f.gateway.call(updateFolder, { params: { folderId: reports.id }, body: { name: 'Mine now' } }, f.cell.as(f.outsider)),
      { code: 'files.file_not_found' });
    await assert.rejects(f.gateway.call(createFolder, { body: { name: 'Monthly', parentId: reports.id } }, f.cell.as(f.member)),
      { code: 'files.folder_name_taken' });
  });
});

describe('deletion and retention (spec 41.5)', () => {
  test('deleting removes the document first and keeps the receipt; nobody else may', async () => {
    const file = await exported(f.member, 'Gone');
    await f.gateway.call(shareFile, { params: { fileId: file.id }, body: { grantee: { membershipId: f.outsider.membershipId } } }, f.cell.as(f.member));
    await assert.rejects(f.gateway.call(deleteFile, { params: { fileId: file.id } }, f.cell.as(f.outsider)), { code: 'files.file_not_found' });
    const receipt = await f.gateway.call(deleteFile, { params: { fileId: file.id } }, f.cell.as(f.member));
    assert.ok('counts' in receipt, 'an export is deleted at once, with its receipt');
    assert.deepEqual(receipt.counts, { files: 1, documents: 1, sharesRevoked: 1, extractions: 0 });
    assert.equal(await objectExists(file.id), false, 'no source document left behind');
    assert.ok(!(await visible(f.member)).includes(file.id));
    assert.ok(!(await visible(f.outsider)).includes(file.id));
    const { rows } = await f.cell.migrate.query('select scope_of_removal from files.file_deletions where file_id = $1', [file.id]);
    assert.equal(rows[0].scope_of_removal.reason, 'requested');
  });

  test('an export past its retention is swept, with its receipt', async () => {
    const file = await exported(f.member, 'Expiring');
    await f.cell.migrate.query(`update files.files set expires_at = now() - interval '1 minute' where id = $1`, [file.id]);
    const swept = await until('the sweep', async () => {
      const { rows } = await f.cell.migrate.query('select scope_of_removal from files.file_deletions where file_id = $1', [file.id]);
      return rows[0];
    }, 15_000);
    assert.equal(swept.scope_of_removal.reason, 'retention');
    assert.equal(await objectExists(file.id), false);
  });
});

// Last: once the type is marked, every later export carries the marking.
describe('markings (spec 41.2, 41.3)', () => {
  test('an export carries its inputs\' markings, printed on it; a recipient without them is refused and it is recorded', async () => {
    const marking = await f.gateway.call(createMarking, { body: { name: 'Finance', kind: 'classification', rank: 1 } }, f.cell.as(f.root));
    await f.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: f.member.membershipId } } }, f.cell.as(f.root));
    await f.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'object_type', id: invoiceType(f.manifest) } } }, f.cell.as(f.root));
    const file = await exported(f.member, 'Marked');
    assert.deepEqual(file.markings.map((m) => m.name), ['Finance']);
    assert.ok((await text(file.id)).includes('Markings,Finance\r\n'));

    const share = await f.gateway.call(shareFile, { params: { fileId: file.id }, body: { grantee: { membershipId: f.outsider.membershipId } } }, f.cell.as(f.member));
    assert.equal(share.recipientCanOpen, 'unknown', 'clearances are decided at every open');
    const theirs = (await f.gateway.call(listFiles, { query: {} }, f.cell.as(f.outsider))).files.find((x) => x.id === file.id)!;
    assert.equal(theirs.canOpen, false, 'the file says it cannot be opened rather than failing silently');
    await assert.rejects(f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.outsider)),
      { category: 'forbidden', code: 'files.cannot_open' });
    const { rows } = await f.cell.migrate.query(
      `select payload->'detail'->>'reason' as reason from platform.outbox where payload->>'event' = 'file_download_refused'
       and payload->'resource'->>'id' = $1`, [file.id]);
    assert.deepEqual(rows.map((r) => r.reason), ['marking_unsatisfied']);
  });

  test('a site plan or 3D model drawn into an export carries its own markings with the file (D228): printed, stored, and refused unprinted', async () => {
    const site = await f.gateway.call(createMarking, { body: { name: 'Site security', kind: 'classification', rank: 1 } }, f.cell.as(f.root));
    const canvas = f.cell.client('canvas-layout');
    const inputs = [{ node: { kind: 'view' as const, refId: viewId, version: '1' }, relation: 'exported_from' as const }];
    const preview = await canvas.call(previewExportMarkings, { body: { inputs, carriedMarkingIds: [site.id] } }, f.cell.as(f.member));
    assert.deepEqual(preview.markings.map((m) => m.name), ['Site security']);
    const body = (printed: string[]) => ({
      name: 'Plan.png', contentType: 'image/png' as const, content: Buffer.from('png').toString('base64'), source: { kind: 'view' as const, savedViewId: viewId },
      inputs, printedMarkingIds: printed, carriedMarkingIds: [site.id], fieldPolicies: [], connectionIds: [],
    });
    const file = await canvas.call(createExport, { body: body(preview.markings.map((m) => m.id)) }, { ...f.cell.as(f.member), idempotencyKey: uuidv7() });
    assert.deepEqual(file.markings.map((m) => m.name), ['Site security']);
    const { rows } = await f.cell.migrate.query('select markings from files.file_permissions where file_id = $1', [file.id]);
    assert.ok((rows[0].markings as string[]).includes(site.id), 'frozen with the file');
    await assert.rejects(canvas.call(createExport, { body: body(preview.markings.filter((m) => m.id !== site.id).map((m) => m.id)) }, { ...f.cell.as(f.member), idempotencyKey: uuidv7() }),
      { code: 'files.markings_changed' });
    await assert.rejects(canvas.call(previewExportMarkings, { body: { inputs, carriedMarkingIds: [uuidv7()] } }, f.cell.as(f.member)), { code: 'files.marking_unknown' });
  });
});

describe('spreadsheet and PDF exports (spec 41.2)', () => {
  test('the same answer as a workbook and as a PDF, stored with their types', async () => {
    for (const [format, contentType, magic] of [
      ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK'], ['pdf', 'application/pdf', '%PDF'],
    ] as const) {
      const out = await f.gateway.call(renderExport, { body: { planId, name: `Invoices ${format}`, format, source: { kind: 'view', savedViewId: viewId } } },
        { ...f.cell.as(f.member), idempotencyKey: uuidv7() });
      assert.equal(out.outcome, 'exported', JSON.stringify(out));
      const file = (out as { file: FileView }).file;
      assert.deepEqual([file.name, file.contentType], [`Invoices ${format}.${format}`, contentType]);
      const bytes = Buffer.from((await f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.member))).content, 'base64');
      assert.equal(bytes.subarray(0, magic.length).toString('latin1'), magic);
    }
  });
});

describe('the organisation\'s logo (spec 56.2)', () => {
  const png = (width: number, height: number) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const chunk = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), ihdr, Buffer.alloc(4)]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk]).toString('base64');
  };
  const set = (content: string, who = f.root) => f.gateway.call(setOrganisationLogo, { body: { contentBase64: content } }, f.cell.as(who));

  test('a super admin sets it; its type comes from its bytes and its size from its header; anything else is refused', async () => {
    await assert.rejects(set(png(256, 256), f.member), { code: 'files.not_permitted' });
    const logo = await set(png(256, 128));
    assert.deepEqual([logo.contentType, logo.width, logo.height], ['image/png', 256, 128]);
    await assert.rejects(set(png(2048, 512)), { code: 'bound.logo_pixels' });
    await assert.rejects(set(Buffer.from('GIF89a not a logo').toString('base64')), { code: 'files.logo_type' }, 'never by the name or the header the client gives');
    const read = await f.gateway.call(getOrganisationLogo, {}, f.cell.as(f.member));
    assert.deepEqual([read.contentType, read.contentBase64], ['image/png', png(256, 128)], 'shown to members through the route');
    const { rows } = await f.cell.migrate.query('select logo_object_key from iam.organisations where id = $1', [f.cell.org]);
    assert.ok(String(rows[0].logo_object_key).includes(f.cell.org), 'under the organisation\'s own path');
  });

  test('an SVG is rebuilt from the allowlist before it is kept: no script survives; each replacement recorded', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32" onload="alert(1)"><script>alert(2)</script><rect width="64" height="32" fill="#123"/></svg>';
    const logo = await set(Buffer.from(svg).toString('base64'));
    assert.deepEqual([logo.contentType, logo.width, logo.height], ['image/svg+xml', 64, 32]);
    const kept = Buffer.from((await f.gateway.call(getOrganisationLogo, {}, f.cell.as(f.member))).contentBase64, 'base64').toString();
    assert.ok(kept.includes('<rect') && !kept.includes('script') && !kept.includes('onload'), kept);
    const { rows } = await f.cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'logo_replaced' order by seq`, [f.cell.org]);
    assert.deepEqual(rows.map((r) => [r.detail.content_type, r.detail.replaced]), [['image/png', false], ['image/svg+xml', true]]);
  });
});

describe('a lineage graph exported (spec 59.4, 59.7)', () => {
  let reviewer: typeof f.member;
  let cleared: typeof f.member;
  let gateway: typeof f.gateway;
  type Body = z.input<typeof exportLineage.body>;
  const ask = (who: typeof f.member, body: Body, key = uuidv7()) =>
    gateway.call(exportLineage, { body }, { ...f.cell.as(who), idempotencyKey: key });
  const event = async (name: string) => (await f.cell.migrate.query(
    `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by seq`,
    [f.cell.org, name])).rows.map((r) => r.detail as Record<string, unknown>);

  before(async () => {
    await f.cell.start(createLineageService(), 'lineage', 'test_app');
    gateway = f.cell.client('gateway');
    reviewer = await f.cell.member('reviewer@acme.example', 'Security reviewer');
    cleared = await f.cell.member('cleared@acme.example', 'Security reviewer');
    // The invoice type carries Finance since the markings test; one reviewer is cleared for it.
    const { rows } = await f.cell.migrate.query(`select id from gov.markings where organisation_id = $1 and name = 'Finance'`, [f.cell.org]);
    await f.gateway.call(grantClearance, { body: { markingId: rows[0].id, holder: { kind: 'membership', id: cleared.membershipId } } }, f.cell.as(f.root));
  });

  test('a reviewer takes a graph out as a document, its markings printed, stored with its own lineage and provenance', async () => {
    const source = await exported(f.member, 'Traced');
    const upstream = { kind: 'export', refId: source.id, direction: 'upstream' } as const;
    await assert.rejects(ask(f.member, upstream), { code: 'lineage.not_permitted' });
    await assert.rejects(ask(reviewer, upstream), { code: 'lineage.node_not_found' }, 'the export carries Finance, which this reviewer does not hold');

    const key = uuidv7();
    const out = await ask(cleared, upstream, key);
    assert.deepEqual([out.file.contentType, out.file.name, out.withheld], ['application/json', `Lineage upstream of export ${source.id}.json`, 0]);
    assert.deepEqual(out.file.markings.map((m) => m.name), ['Finance'], 'the markings of every node it names');
    assert.deepEqual([out.file.provenance?.sourceKind, out.file.provenance?.runReference], ['lineage', null]);
    const doc = JSON.parse(await text(out.file.id, cleared)) as {
      root: string; markings: string[]; withheld: number; statement: string | null;
      nodes: { id: string; kind: string; refId: string; depth: number; markings: string[] }[]; edges: { from: string; to: string; relation: string }[];
    };
    assert.equal(out.file.provenance?.sourceId, doc.root, 'sourced to the node the walk began at');
    assert.deepEqual([doc.markings, doc.withheld, doc.statement], [['Finance'], 0, null]);
    assert.deepEqual([doc.nodes.length, doc.edges.length], [out.nodes, out.edges]);
    assert.deepEqual(doc.nodes.filter((n) => n.depth === 0).map((n) => [n.kind, n.refId]), [['export', source.id]]);
    for (const kind of ['object_type_version', 'connection', 'view']) assert.ok(doc.nodes.some((n) => n.kind === kind), kind);
    assert.ok(doc.nodes.find((n) => n.kind === 'object_type_version')!.markings.includes('Finance'));
    assert.equal((await ask(cleared, upstream, key)).file.id, out.file.id, 'a keyed retry returns the file the first request made');

    const { rows } = await f.cell.migrate.query(
      `select count(*)::int as n from gov.lineage_edges e join gov.lineage_nodes t on t.organisation_id = e.organisation_id and t.id = e.to_node_id
       where t.organisation_id = $1 and t.kind = 'export' and t.ref_id = $2 and e.relation = 'exported_from'`, [f.cell.org, out.file.id]);
    assert.equal(rows[0].n, out.nodes, 'its own lineage: an edge from every node it names');
    const exportedEvent = (await event('lineage_exported')).at(-1)!;
    assert.deepEqual([exportedEvent['file_id'], exportedEvent['query'], exportedEvent['format'], exportedEvent['nodes']], [out.file.id, 'upstream', 'json', out.nodes]);
    assert.ok((await event('file_exported')).some((d) => d['source'] === 'lineage'));

    const csv = await ask(cleared, { ...upstream, format: 'csv', name: 'Traced lineage' });
    assert.deepEqual([csv.file.name, csv.file.contentType], ['Traced lineage.csv', 'text/csv']);
    const lines = (await text(csv.file.id, cleared)).split('\r\n');
    assert.deepEqual(lines.slice(0, 2), ['Name,Traced lineage', 'Markings,Finance']);
    assert.ok(lines.includes('record,id,kind,ref_id,version,depth,created_at,markings,from,to,relation'));
    assert.equal(lines.filter((l) => l.startsWith('node,')).length, csv.nodes);
    assert.equal(lines.filter((l) => l.startsWith('edge,')).length, csv.edges);
  });

  test('what the reviewer\'s markings do not reach is counted in the document, never named; bounds refuse, never truncate', async () => {
    const { rows } = await f.cell.migrate.query(`select ref_id from gov.lineage_nodes where organisation_id = $1 and kind = 'connection' limit 1`, [f.cell.org]);
    const downstream = { kind: 'connection', refId: rows[0].ref_id as string, direction: 'downstream' } as const;
    const out = await ask(reviewer, downstream);
    assert.ok(out.withheld > 0, 'the exports carrying Finance');
    assert.deepEqual(out.file.markings, []);
    const doc = JSON.parse(await text(out.file.id, reviewer)) as { withheld: number; statement: string; nodes: { kind: string; markings: string[] }[] };
    assert.equal(doc.withheld, out.withheld);
    assert.match(doc.statement, /withheld: counted, never named$/);
    assert.ok(doc.nodes.every((n) => n.markings.length === 0 && n.kind !== 'export'), JSON.stringify(doc.nodes));
    await assert.rejects(ask(cleared, { ...downstream, maxNodes: 1 }), { category: 'bounds', code: 'lineage.node_bound' });
  });
});
