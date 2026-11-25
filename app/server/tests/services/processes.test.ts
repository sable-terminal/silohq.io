// Process analyses (D234): events read from an object set (case, activity and time properties) as
// whoever opens the analysis, mined into the process map, variants, durations, rework and
// conformance with the owner's reference model; refused with why where nothing can be read for a
// person; a captured-changes source that cannot reach Capture says so; exported into Files as a PDF.
// Real processes: the files cell, its fake invoices standing in as an event log.

import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { downloadFile } from '../../src/contracts/files/file.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { createProcess, exportProcess, readProcessAnalysis, shareProcess } from '../../src/contracts/workspace/process.contract.ts';
import { createFilesCell, INVOICES, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let setId: string;
let processId: string;
const h = 3_600_000;

before(async () => {
  f = await createFilesCell();
  // Orders as events: the customer is the case, the status the activity, the total the time (epoch milliseconds).
  const log: [string, string, number][] = [
    ['o1', 'received', 0], ['o1', 'approved', 1 * h], ['o1', 'shipped', 3 * h],
    ['o2', 'received', 0], ['o2', 'approved', 2 * h], ['o2', 'shipped', 5 * h],
    ['o3', 'received', 0], ['o3', 'approved', 1 * h], ['o3', 'received', 2 * h], ['o3', 'approved', 4 * h], ['o3', 'shipped', 9 * h],
  ];
  INVOICES.splice(0, INVOICES.length, ...log.map(([customer, status, total], i) => ({ id: `e${i + 1}`, customer, status, total: 1_700_000_000_000 + total })));
  setId = (await f.gateway.call(saveObjectSet, {
    body: { name: 'Order events', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } } },
  }, f.keyed(f.member))).id;
});

after(async () => {
  await f?.close();
});

const source = () => ({ kind: 'events' as const, objectSetId: setId, caseProperty: f.prop('customer'), activityProperty: f.prop('status'), timeProperty: f.prop('total'), limit: 10_000 });

/** The text a PDF draws, each stream inflated. */
function pdfText(bytes: Buffer): string {
  const out: string[] = [];
  for (let at = bytes.indexOf('stream\n'); at >= 0; at = bytes.indexOf('stream\n', at + 7)) {
    try { out.push(inflateSync(bytes.subarray(at + 7, bytes.indexOf('\nendstream', at))).toString('latin1')); } catch { /* not deflated */ }
  }
  return out.join('\n');
}

describe('process analyses (D234)', () => {
  test('made over an event set; a property not of the set\'s type refused', async () => {
    await assert.rejects(f.gateway.call(createProcess, {
      body: { name: 'Wrong', document: { schemaVersion: '1', source: { ...source(), caseProperty: '00000000-0000-4000-8000-000000000001' } } },
    }, f.keyed(f.member)), { code: 'workspace.process_property_unknown' });
    const made = await f.gateway.call(createProcess, {
      body: { name: 'Order flow', document: { schemaVersion: '1', source: source(), reference: { transitions: [['received', 'approved'], ['approved', 'shipped']], starts: ['received'], ends: ['shipped'] } } },
    }, f.keyed(f.member));
    processId = made.id;
    assert.equal(made.access, 'owner');
  });

  test('mined for the owner: the map\'s activities and steps with times, the variants, rework and conformance', async () => {
    const a = await f.gateway.call(readProcessAnalysis, { params: { processId } }, f.cell.as(f.member));
    assert.deepEqual([a.refused, a.cases, a.events, a.skipped], [null, 3, 11, 0]);
    assert.deepEqual(a.activities.map((x) => [x.name, x.events]), [['approved', 4], ['received', 4], ['shipped', 3]]);
    const step = a.edges.find((e) => e.from === 'received' && e.to === 'approved')!;
    assert.deepEqual([step.count, step.cases, step.medianSeconds], [4, 3, 3600]);
    assert.deepEqual(a.variants.map((v) => [v.path.join('>'), v.cases]), [['received>approved>shipped', 2], ['received>approved>received>approved>shipped', 1]]);
    assert.deepEqual(a.conformance, { fitting: 2, deviating: 1, deviations: [{ from: 'approved', to: 'received', cases: 1 }], badStarts: [], badEnds: [] });
    assert.deepEqual(a.caseDuration.medianSeconds, 5 * 3600);
  });

  test('shared to open: mined from what the recipient may read, refused with why where that is nothing', async () => {
    await f.gateway.call(shareProcess, { params: { processId }, body: { grantee: { kind: 'membership', membershipId: f.outsider.membershipId }, access: 'view' } }, f.cell.as(f.member));
    const theirs = await f.gateway.call(readProcessAnalysis, { params: { processId } }, f.cell.as(f.outsider));
    assert.ok(theirs.refused !== null || theirs.cases === 0, 'the outsider has no grant on the connection');
  });

  test('captured changes, where Capture cannot be reached, say so rather than fail', async () => {
    const made = await f.gateway.call(createProcess, {
      body: { name: 'Status history', document: { schemaVersion: '1', source: { kind: 'changes', objectTypeId: invoiceType(f.manifest), propertyId: f.prop('status'), limit: 1000 } } },
    }, f.keyed(f.member));
    const a = await f.gateway.call(readProcessAnalysis, { params: { processId: made.id } }, f.cell.as(f.member));
    assert.match(a.refused ?? '', /Capture/);
  });

  test('exported into Files as a PDF of the analysis', async () => {
    const { file } = await f.gateway.call(exportProcess, { params: { processId }, body: {} }, f.keyed(f.member));
    assert.deepEqual([file.name, file.provenance?.sourceKind], ['Order flow.pdf', 'process_analysis']);
    const text = pdfText(Buffer.from((await f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.member))).content, 'base64'));
    for (const expected of ['Activities', 'Variants', 'Conformance', 'received > approved > shipped', '2 cases fit the reference model; 1 deviate.']) assert.ok(text.includes(expected), expected);
  });
});
