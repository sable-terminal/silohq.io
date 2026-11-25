// An app's object set variable run for its viewer (spec 35.2, 35.6; D214), on the recognition
// cell (suppliers in a CRM and an ERP): the definition the version holds, evaluated by the
// executor under the viewer's own access, the app's parameter variables bound by name and never
// written into the predicate. A different value is a different answer, never a cached one; an
// unset parameter is null to the predicate; only the app's own parameters and object set
// variables are accepted; someone the app is not shared with finds nothing.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp, evaluateAppExpressions, getApp, runAppVariable, saveDraft } from '../../src/contracts/studio/app.contract.ts';
import { service as studioService } from '../../src/routes/studio/index.route.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;
let appId: string;

before(async () => {
  r = await startRecognitionCell([{ definition: studioService, name: 'studio', env: { REDIS_STATE_URL: `${LOCAL.redisUrl}/2` } }]);
  const created = await r.gateway.call(createApp, { body: { name: 'Suppliers by region' } }, r.keyed(r.root));
  appId = created.app.id;
  const supplier = r.type('supplier');
  const region = r.prop('supplier', 'region');
  const draft = (await r.gateway.call(getApp, { params: { appId } }, r.cell.as(r.root))).versions.find((v) => v.version === 1)!;
  const saved = await r.gateway.call(saveDraft, {
    params: { appId },
    body: {
      definition: {
        schemaVersion: '1', ontologyVersion: r.manifest.version.sequence,
        variables: {
          region: { kind: 'parameter', type: 'enumeration', options: ['north', 'south', 'east', 'west'] },
          inRegion: { kind: 'objectSet', objectTypeId: supplier.id, filter: { cel: 'region == null || object.region == region', properties: [region] } },
          picked: { kind: 'selection', objectTypeId: supplier.id },
        },
        pages: [{ id: 'home', title: 'Suppliers', widgets: [
          { id: 'table', kind: 'objectTable', source: 'inRegion', columns: [r.prop('supplier', 'name'), region], grid: [1, 1, 12, 6], emits: { selectionChanged: 'picked' } },
          { id: 'detail', kind: 'propertyList', source: 'picked', properties: [r.prop('supplier', 'name')], grid: [1, 7, 12, 4], visibleWhen: 'size(picked) > 0' },
        ] }],
        events: [{ source: { widget: 'table', event: 'selectionChanged' }, condition: 'region == "north"', effects: [{ kind: 'refreshWidget', widget: 'detail' }] }],
      },
      lockVersion: draft.lockVersion,
    },
  }, r.cell.as(r.root));
  assert.deepEqual(saved.findings, []);
});

after(async () => {
  await r?.close();
});

type Answer = { outcome: 'answer'; result: { total: number; page: { objects: { values: Record<string, unknown> }[] } } };
const run = (parameters: Record<string, string | null>, variable = 'inRegion', who = r.root) => r.gateway.call(runAppVariable, {
  params: { appId, variable }, body: { version: 1, select: [r.prop('supplier', 'name'), r.prop('supplier', 'region')], parameters },
}, r.cell.as(who));
/** Each object's region, as the answer gives it (names are disputed between the two systems for some suppliers). */
const regions = (out: Awaited<ReturnType<typeof run>>) => {
  assert.equal(out.outcome, 'answer', JSON.stringify(out));
  return (out as Answer).result.page.objects.map((o) => String(o.values['region'] ?? 'none')).sort();
};

describe('an app\'s expressions, evaluated for its viewer\'s values (spec 35.2)', () => {
  const evaluate = (values: Record<string, string | string[] | null>) =>
    r.gateway.call(evaluateAppExpressions, { params: { appId }, body: { version: 1, values } }, r.cell.as(r.root));

  test('a visibility rule and an event condition, read with the same CEL the validator compiles them with', async () => {
    assert.deepEqual(await evaluate({}), { widgets: { detail: false }, events: { 0: false } }, 'nothing picked, no region: neither holds');
    assert.deepEqual(await evaluate({ picked: ['00000000-0000-7000-8000-000000000001'], region: 'north' }), { widgets: { detail: true }, events: { 0: true } });
    await assert.rejects(evaluate({ country: 'uk' }), { code: 'studio.variable_unknown' });
  });
});

describe('an app\'s object set variable, run for its viewer (spec 35.2, 35.6)', () => {
  test('the parameter is bound by name: each value its own answer, never another value\'s cached one', async () => {
    assert.deepEqual(regions(await run({ region: 'north' })), ['north', 'north', 'north', 'north']);
    assert.deepEqual(regions(await run({ region: 'west' })), ['west', 'west']);
    assert.deepEqual(regions(await run({ region: 'north' })), ['north', 'north', 'north', 'north'], 'the first value again');
  });

  test('an unset parameter is null to the predicate', async () => {
    const all = regions(await run({}));
    assert.ok(all.length >= 12, 'region == null holds: every supplier');
    assert.deepEqual(regions(await run({ region: null })), all);
  });

  test('only the app\'s own parameters and object set variables; someone it is not shared with finds nothing', async () => {
    await assert.rejects(run({ country: 'uk' }), { code: 'studio.parameter_unknown' });
    await assert.rejects(run({}, 'picked'), { code: 'studio.variable_not_found' }, 'a selection is not run');
    await assert.rejects(run({}, 'nothing'), { code: 'studio.variable_not_found' });
    await assert.rejects(run({ region: 'north' }, 'inRegion', r.viewer), { category: 'not_found' });
  });
});
