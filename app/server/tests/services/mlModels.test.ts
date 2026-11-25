// Machine learning models (D240) over the CRM's invoices: defined over a saved set, its label of the
// kind the task needs; trained as the owner into a version with the held-out fifth's figures and
// the fitted model sealed; a version that cannot fit says why; its detail and its predictions only
// for someone holding every marking on what it learnt from; predictions read as the caller, with
// drift, nothing stored; shared to see and predict with, never to copy.
// Real processes: the files cell.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { createNotebook, runNotebook, saveNotebook } from '../../src/contracts/workspace/notebook.contract.ts';
import {
  createMlModel, getMlModelVersion, listMlModels, listMlModelVersions, predictMlModel, publishMlModelVersion, shareMlModel, trainMlModel,
} from '../../src/contracts/workspace/mlModel.contract.ts';
import { INVOICES, createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let setId: string;
let modelId: string;
let firstVersion: string;

before(async () => {
  f = await createFilesCell();
  // Eighty more invoices: paid when small, open when large, across four customers.
  for (let i = 0; i < 80; i++) {
    const total = 20 + ((i * 37) % 280);
    INVOICES.push({ id: `i${100 + i}`, customer: ['Acme Ltd', 'Brill, plc', 'Cobalt', 'Delta'][i % 4]!, total, status: total < 150 ? 'paid' : 'open' });
  }
  setId = (await f.gateway.call(saveObjectSet, {
    body: { name: 'All invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } } },
  }, f.keyed(f.member))).id;
});

after(async () => {
  await f?.close();
});

const definition = (extra = {}) => ({
  name: 'Will it be paid?', task: 'classification' as const, objectSetId: setId, featurePropertyIds: [f.prop('total'), f.prop('customer')], labelPropertyId: f.prop('status'), ...extra,
});

describe('machine learning models (D240)', () => {
  test('defined over a set the owner may read, its label of the kind its task needs', async () => {
    await assert.rejects(f.gateway.call(createMlModel, { body: definition({ task: 'regression' }) }, f.keyed(f.member)), { code: 'workspace.ml_model_label_kind' });
    await assert.rejects(f.gateway.call(createMlModel, { body: definition({ featurePropertyIds: [f.prop('status')] }) }, f.keyed(f.member)));
    const made = await f.gateway.call(createMlModel, { body: definition() }, f.keyed(f.member));
    modelId = made.id;
    assert.deepEqual([made.access, made.publishedVersionId], ['owner', null]);
  });

  test('trained as the owner: the held-out fifth\'s figures, which features mattered, the fitted model sealed', async () => {
    const v = await f.gateway.call(trainMlModel, { params: { mlModelId: modelId } }, f.keyed(f.member));
    firstVersion = v.id;
    assert.equal(v.status, 'trained', v.failure ?? '');
    assert.equal((v.rowsTrained ?? 0) + (v.rowsTested ?? 0), 83);
    assert.ok(v.metrics?.kind === 'classification' && v.metrics.accuracy >= 0.8 && v.metrics.classes === 2, JSON.stringify(v.metrics));
    const detail = await f.gateway.call(getMlModelVersion, { params: { mlModelId: modelId, versionId: v.id } }, f.cell.as(f.member));
    assert.equal(detail.importance[0]!.feature, 'total', 'the total decides it');
    assert.deepEqual(detail.classes?.map((c) => c.label).sort(), ['open', 'paid']);
    const { rows } = await f.cell.migrate.query('select artifact from workspace.ml_model_versions where id = $1', [v.id]);
    const raw = (rows[0].artifact as Buffer).toString('latin1');
    assert.ok(!raw.includes('paid') && !raw.includes('Acme'), 'what it learnt, sealed');
  });

  test('a model that cannot fit is a failed version saying why', async () => {
    const few = (await f.gateway.call(saveObjectSet, {
      body: { name: 'Large invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'object.total > 280', properties: [f.prop('total')] } } },
    }, f.keyed(f.member))).id;
    const small = await f.gateway.call(createMlModel, { body: definition({ name: 'Too few', objectSetId: few }) }, f.keyed(f.member));
    const v = await f.gateway.call(trainMlModel, { params: { mlModelId: small.id } }, f.keyed(f.member));
    assert.equal(v.status, 'failed');
    assert.match(v.failure ?? '', /at least 20 are needed/);
    await assert.rejects(f.gateway.call(publishMlModelVersion, { params: { mlModelId: small.id, versionId: v.id } }, f.cell.as(f.member)), { code: 'workspace.ml_model_version_failed' });
  });

  test('predictions with the published version, read as the caller, with drift; nothing stored', async () => {
    await assert.rejects(f.gateway.call(predictMlModel, { params: { mlModelId: modelId }, body: {} }, f.cell.as(f.member)), { code: 'workspace.ml_model_unpublished' });
    await f.gateway.call(publishMlModelVersion, { params: { mlModelId: modelId, versionId: firstVersion } }, f.cell.as(f.member));
    const out = await f.gateway.call(predictMlModel, { params: { mlModelId: modelId }, body: {} }, f.cell.as(f.member));
    assert.equal(out.predictions.length, 83);
    assert.ok(out.predictions.every((p) => (p.value === 'open' || p.value === 'paid') && p.probability !== null && p.probability >= 0.5));
    const big = out.predictions.filter((p) => p.value === 'open').length;
    assert.ok(big > 20 && big < 63, String(big));
    assert.ok(out.drift.every((d) => d.level === 'stable'), JSON.stringify(out.drift));
    assert.equal((await f.cell.migrate.query(`select count(*)::int as n from platform.outbox where payload->>'event' = 'ml_model_predicted'`)).rows[0].n, 1);
  });

  test('a notebook predicts with it (D242): each object\'s prediction, joined to its properties by its id', async () => {
    const made = await f.gateway.call(createNotebook, { body: { name: 'Who will pay' } }, f.keyed(f.member));
    const saved = await f.gateway.call(saveNotebook, {
      params: { notebookId: made.id },
      body: {
        lockVersion: made.lockVersion,
        document: {
          schemaVersion: '1',
          cells: [
            { id: 'read', kind: 'objects', name: 'invoices', objectSetId: setId, propertyIds: [f.prop('invoice_id'), f.prop('total')], limit: 200, withIds: true },
            { id: 'score', kind: 'predict', name: 'scored', mlModelId: modelId, objectSetId: null, limit: 500 },
            { id: 'joined', kind: 'transform', name: 'with_predictions', input: 'invoices', steps: [
              { op: 'join', input: 'scored', on: [['object_id', 'object_id']], kind: 'inner' },
              { op: 'select', columns: [{ from: 'invoice_id' }, { from: 'total' }, { from: 'scored_prediction', as: 'prediction' }] },
            ] },
          ],
        },
      },
    }, f.cell.as(f.member));
    const { outputs } = await f.gateway.call(runNotebook, { params: { notebookId: saved.id }, body: {} }, f.cell.as(f.member));
    const scored = outputs.find((o) => o.cellId === 'score')!;
    assert.equal(scored.refused, null, JSON.stringify(scored));
    if (scored.output?.kind === 'table') assert.deepEqual([scored.output.columns, scored.output.total, scored.output.note], [['object_id', 'prediction', 'confidence'], 83, null]);
    const joined = outputs.find((o) => o.cellId === 'joined')!;
    assert.equal(joined.refused, null, JSON.stringify(joined));
    if (joined.output?.kind === 'table') {
      assert.equal(joined.output.total, 83);
      const big = joined.output.rows.filter((r) => Number(r[1]) >= 200);
      assert.ok(big.length > 0 && big.every((r) => r[2] === 'open'), 'large invoices predicted open');
    } else assert.fail('a table');
  });

  test('shared to see and predict with: refused where the caller cannot read the objects; a version marked more closely than the caller, refused', async () => {
    await f.gateway.call(shareMlModel, { params: { mlModelId: modelId }, body: { grantee: { kind: 'membership', membershipId: f.outsider.membershipId } } }, f.cell.as(f.member));
    assert.deepEqual((await f.gateway.call(listMlModels, { query: { filter: 'shared' } }, f.cell.as(f.outsider))).mlModels.map((m) => [m.id, m.access]), [[modelId, 'view']]);
    // The outsider has no grant on the connection: the objects are not read for them.
    await assert.rejects(f.gateway.call(predictMlModel, { params: { mlModelId: modelId }, body: {} }, f.cell.as(f.outsider)), { code: 'workspace.ml_model_set_refused' });

    const marking = await f.gateway.call(createMarking, { body: { name: 'Receivables', kind: 'classification', rank: 1 } }, f.cell.as(f.root));
    await f.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: f.member.membershipId } } }, f.cell.as(f.root));
    await f.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'object_type', id: invoiceType(f.manifest) } } }, f.cell.as(f.root));
    const marked = await f.gateway.call(trainMlModel, { params: { mlModelId: modelId } }, f.keyed(f.member));
    assert.deepEqual([marked.status, marked.version, marked.markingIds], ['trained', 2, [marking.id]]);
    await assert.rejects(f.gateway.call(getMlModelVersion, { params: { mlModelId: modelId, versionId: marked.id } }, f.cell.as(f.outsider)), { code: 'workspace.ml_model_not_cleared' });
    assert.equal((await f.gateway.call(getMlModelVersion, { params: { mlModelId: modelId, versionId: marked.id } }, f.cell.as(f.member))).version, 2);
    const versions = (await f.gateway.call(listMlModelVersions, { params: { mlModelId: modelId } }, f.cell.as(f.member))).versions;
    assert.deepEqual(versions.map((v) => [v.version, v.published]), [[2, false], [1, true]]);
  });
});
