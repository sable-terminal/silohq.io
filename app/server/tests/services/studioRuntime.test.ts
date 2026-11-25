// An app's object set variable run for its viewer (spec 35.2, 35.6; D214), on the recognition
// cell (suppliers in a CRM and an ERP): the definition the version holds, evaluated by the
// executor under the viewer's own access, the app's parameter variables bound by name and never
// written into the predicate. A different value is a different answer, never a cached one; an
// unset parameter is null to the predicate; only the app's own parameters and object set
// variables are accepted; someone the app is not shared with finds nothing. A chart of it continued
// as an analysis (37.8) keeps the set's filter as typed steps for the viewer's values.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp, evaluateAppExpressions, getApp, runAppVariable, saveDraft } from '../../src/contracts/studio/app.contract.ts';
import { service as studioService } from '../../src/routes/studio/index.route.ts';
import { service as compileService } from '../../src/routes/compile/index.route.ts';
import { createWorkspaceService } from '../../src/routes/workspace/index.route.ts';
import { createAnalysisFromAppChart, readAnalysis, runAnalysis } from '../../src/contracts/workspace/analysis.contract.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;
let appId: string;

before(async () => {
  r = await startRecognitionCell([
    { definition: compileService, name: 'compile' },
    { definition: studioService, name: 'studio', env: { REDIS_STATE_URL: `${LOCAL.redisUrl}/2` } },
    { definition: createWorkspaceService(), name: 'workspace' },
  ]);
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
          { id: 'by_region', kind: 'chart', source: 'inRegion', measure: { aggregate: 'count' }, groupBy: region, grid: [1, 11, 12, 4] },
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

describe('a chart of the app continued as an analysis (spec 37.8)', () => {
  const start = (body: { parameters: Record<string, string | null>; narrowing?: { facets: Record<string, string>; searched: boolean } }, who = r.root) =>
    r.gateway.call(createAnalysisFromAppChart, { body: { appId, widgetId: 'by_region', version: 1, ...body } }, r.cell.as(who));
  type Made = Extract<Awaited<ReturnType<typeof start>>, { outcome: 'analysis' }>;
  const made = (out: Awaited<ReturnType<typeof start>>): Made => {
    assert.equal(out.outcome, 'analysis', JSON.stringify(out).slice(0, 400));
    return out as Made;
  };
  const totals = async (m: Made) => {
    const ran = await r.gateway.call(runAnalysis, { params: { manifestId: m.manifestId }, body: { analysisId: m.analysisId } }, r.cell.as(r.root));
    return ran.steps.map((s) => (s.outcome === 'result' ? s.results[0]!.total : s.outcome));
  };

  test('the set\'s filter for the viewer\'s region, then the count by region; the region a parameter, never in the steps', async () => {
    const m = made(await start({ parameters: { region: 'north' } }));
    assert.deepEqual(m.steps.map((s) => s.operation), ['filter', 'group']);
    assert.deepEqual((m.steps[0]!.step as { filters: unknown[] }).filters, [{ property: r.prop('supplier', 'region'), op: 'eq', value: { param: 'p1' } }]);
    assert.ok(!JSON.stringify(m.steps).includes('north'));
    const values = await r.gateway.call(readAnalysis, { params: { manifestId: m.manifestId }, query: { analysisId: m.analysisId } }, r.cell.as(r.root));
    assert.deepEqual(values.parameters, { p1: 'north' }, 'kept under the analysis, for the one who made it');
    assert.deepEqual(await totals(m), [4, 1], 'four northern suppliers, one group');
  });

  test('no region: every supplier; a facet chosen in the app is a step of its own; a search is said not to be kept', async () => {
    const m = made(await start({ parameters: {}, narrowing: { facets: { [r.prop('supplier', 'region')]: 'west' }, searched: true } }));
    assert.deepEqual(m.steps.map((s) => s.operation), ['filter', 'filter', 'group']);
    assert.deepEqual((m.steps[0]!.step as { filters: unknown[] }).filters, []);
    assert.equal(m.notes.length, 1);
    assert.match(m.notes[0]!, /search/);
    const [all, west, groups] = await totals(m);
    assert.deepEqual([west, groups], [2, 1]);
    assert.ok(typeof all === 'number' && all >= 12, 'the whole set first');
  });

  test('only a chart of an app the viewer may run', async () => {
    await assert.rejects(start({ parameters: {} }, r.viewer), { category: 'not_found' });
    await assert.rejects(r.gateway.call(createAnalysisFromAppChart, { body: { appId, widgetId: 'table', version: 1, parameters: {} } }, r.cell.as(r.root)), { code: 'studio.chart_not_found' });
  });
});
