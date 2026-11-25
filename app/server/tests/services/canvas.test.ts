// canvas-layout end to end (spec 28 to 32): state rules proposed, refused where they read
// what they did not declare, confirmed by a person and revised; staleness thresholds against
// the manifest's cadence; layout configuration checked against main; canvas views saved with
// their lineage, opened under the opener's own access (a withheld field reduces the open and
// is audited for someone other than the owner), shared, favourited and archived; the render
// record; precomputed layouts held only in the state plane; and the Estate map.
// Real processes: credential, policy, auth, connect-registry, ontology, canvas-layout.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  archiveCanvasView, favouriteCanvasView, listCanvasViews, openCanvasView, saveCanvasView, shareCanvasView, unfavouriteCanvasView,
  updateCanvasView,
} from '../../src/contracts/canvas-layout/canvasView.contract.ts';
import { compareEstateSnapshots, getEstateMap, takeEstateSnapshot } from '../../src/contracts/canvas-layout/estate.contract.ts';
import {
  getPrecomputedLayout, listCloneLayouts, precomputeLayout, readViewPreference, recordRenderSelection, setCloneLayout, setViewPreference,
} from '../../src/contracts/canvas-layout/layout.contract.ts';
import {
  confirmStateRule, evaluateCloneStates, getActiveStateRules, listStalenessThresholds, listStateRules, proposeStateRule, retireStateRule, setStalenessThreshold,
} from '../../src/contracts/canvas-layout/stateRule.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { service as canvasLayoutService } from '../../src/routes/canvas-layout/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { recordCanvasInteraction } from '../../src/contracts/canvas-layout/interaction.contract.ts';
import { startCloneCell, type CloneCell } from './clone.helper.ts';

let c: CloneCell;

before(async () => {
  c = await startCloneCell([{ definition: canvasLayoutService, name: 'canvas-layout' }]);
});

after(async () => {
  await c?.close();
});

const pumpRules = () => ({
  objectTypeId: c.pump.id,
  inputPropertyIds: [c.prop('status_code'), c.prop('pressure'), c.prop('last_service')],
  rules: [
    { state: 'failed' as const, when: 'self.status_code in ["TRIP", "FAULT"]', reason: 'Status reports trip or fault' },
    { state: 'warning' as const, when: 'self.pressure > 9.5', reason: 'Discharge pressure above 9.5 bar' },
  ],
  freshnessWindowSeconds: 900,
});

describe('state rules (spec 28.4)', () => {
  test('state_rule.manage proposes; a rule reading what it did not declare, or a property the type lacks, is refused', async () => {
    await assert.rejects(c.gateway.call(proposeStateRule, { body: pumpRules() }, c.keyed(c.member)), { code: 'clone.not_permitted' });
    await assert.rejects(c.gateway.call(proposeStateRule, {
      body: { ...pumpRules(), rules: [{ state: 'warning', when: 'self.name == "P-104"', reason: 'r' }] },
    }, c.keyed(c.editor)), (error: { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'clone.state_rule_invalid' && error.details?.['reason'] === 'undeclared_input' && error.details['rule'] === 0);
    await assert.rejects(c.gateway.call(proposeStateRule, {
      body: { ...pumpRules(), inputPropertyIds: [c.prop('status_code'), c.site.properties[0]!.identityId] },
    }, c.keyed(c.editor)), { code: 'clone.input_unknown' });
  });

  test('proposed is not active; a person confirms it; a revision retires the one before, in one step', async () => {
    const key = uuidv7();
    const proposed = await c.gateway.call(proposeStateRule, { body: pumpRules() }, { ...c.cell.as(c.editor), idempotencyKey: key });
    const replayed = await c.gateway.call(proposeStateRule, { body: pumpRules() }, { ...c.cell.as(c.editor), idempotencyKey: key });
    assert.deepEqual(replayed, proposed, 'a retried proposal returns the first');
    assert.equal(proposed.status, 'proposed');
    assert.equal(proposed.version, 1);
    assert.match(proposed.compiledHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(proposed.inputs.map((i) => i.apiName), ['status_code', 'pressure', 'last_service']);
    assert.deepEqual((await c.gateway.call(getActiveStateRules, { body: { objectTypeIds: [c.pump.id] } }, c.cell.as(c.member))).rules, []);

    await assert.rejects(c.gateway.call(confirmStateRule, { params: { ruleId: proposed.id }, body: { lockVersion: 9 } }, c.cell.as(c.root)),
      { code: 'clone.state_rule_stale' });
    const confirmed = await c.gateway.call(confirmStateRule, { params: { ruleId: proposed.id }, body: { lockVersion: proposed.lockVersion } }, c.cell.as(c.root));
    assert.equal(confirmed.status, 'active');
    assert.equal(confirmed.confirmedBy, c.root.membershipId);

    const revised = await c.gateway.call(proposeStateRule, {
      body: { ...pumpRules(), rules: [...pumpRules().rules, { state: 'warning', when: 'now - self.last_service > duration("8760h")', reason: 'Service overdue' }] },
    }, c.keyed(c.editor));
    assert.equal(revised.version, 2);
    await c.gateway.call(confirmStateRule, { params: { ruleId: revised.id }, body: { lockVersion: revised.lockVersion } }, c.cell.as(c.root));
    const all = await c.gateway.call(listStateRules, { query: { objectTypeId: c.pump.id } }, c.cell.as(c.member));
    assert.deepEqual(all.rules.map((r) => [r.version, r.status]), [[2, 'active'], [1, 'retired']]);
    const active = await c.gateway.call(getActiveStateRules, { body: { objectTypeIds: [c.pump.id, c.site.id] } }, c.cell.as(c.member));
    assert.deepEqual(active.rules.map((r) => r.version), [2]);
    assert.deepEqual((await c.events('state_rule_revised')).map((e) => e.detail['replaced_version']), [1]);
    assert.equal((await c.events('state_rule_confirmed')).length, 1);
  });

  test('states for values a caller read (35.5): the active rule now; an input not sent is unknown, with why; a type without a rule is normal, saying so', async () => {
    const out = await c.gateway.call(evaluateCloneStates, {
      body: {
        objectTypeId: c.pump.id, objects: [
          { ref: 'p1', values: { status_code: 'TRIP', pressure: 7, last_service: new Date().toISOString() } },
          { ref: 'p2', values: { status_code: 'OK', pressure: 9.8, last_service: new Date().toISOString() } },
          { ref: 'p3', values: { status_code: 'OK', pressure: 7, last_service: new Date().toISOString() } },
          { ref: 'p4', values: { status_code: 'OK' } },
        ],
      },
    }, c.cell.as(c.member));
    assert.equal(out.rule, true);
    assert.deepEqual(out.states.slice(0, 2).map((x) => [x.ref, x.state, x.reason]), [['p1', 'failed', 'Status reports trip or fault'], ['p2', 'warning', 'Discharge pressure above 9.5 bar']]);
    assert.equal(out.states[2]!.state, 'normal');
    assert.equal(out.states[3]!.state, 'unknown', 'inputs not sent are not guessed');
    const site = await c.gateway.call(evaluateCloneStates, { body: { objectTypeId: c.site.id, objects: [{ ref: 's1', values: {} }] } }, c.cell.as(c.member));
    assert.deepEqual([site.rule, site.states[0]!.state, site.states[0]!.reason], [false, 'normal', 'no state rule is active for this type']);
  });

  test('a rule proposed and never wanted is retired; a confirmed rule never changes', async () => {
    const proposed = await c.gateway.call(proposeStateRule, { body: pumpRules() }, c.keyed(c.editor));
    const retired = await c.gateway.call(retireStateRule, { params: { ruleId: proposed.id }, body: { lockVersion: proposed.lockVersion } }, c.cell.as(c.root));
    assert.equal(retired.status, 'retired');
    await assert.rejects(c.gateway.call(confirmStateRule, { params: { ruleId: proposed.id }, body: { lockVersion: retired.lockVersion } }, c.cell.as(c.root)),
      { code: 'clone.state_rule_not_proposed' });
  });
});

describe('staleness thresholds (spec 28.5)', () => {
  test('the default is two polls of the manifest; a longer threshold is loosening, audited with both', async () => {
    await assert.rejects(c.gateway.call(setStalenessThreshold, { params: { connectionId: c.connectionId }, body: { objectTypeId: c.pump.id, thresholdSeconds: 900 } },
      c.cell.as(c.member)), { code: 'clone.not_permitted' });
    const set = await c.gateway.call(setStalenessThreshold, {
      params: { connectionId: c.connectionId }, body: { objectTypeId: c.pump.id, thresholdSeconds: 1_200 },
    }, c.cell.as(c.editor));
    assert.deepEqual([set.manifestCadenceSeconds, set.defaultThresholdSeconds, set.loosened], [300, 600, true]);
    const tightened = await c.gateway.call(setStalenessThreshold, {
      params: { connectionId: c.connectionId }, body: { objectTypeId: c.pump.id, thresholdSeconds: 400 },
    }, c.cell.as(c.editor));
    assert.equal(tightened.id, set.id, 'one threshold per connection and type');
    assert.equal(tightened.loosened, false);
    const site = await c.gateway.call(setStalenessThreshold, {
      params: { connectionId: c.connectionId }, body: { objectTypeId: c.site.id, thresholdSeconds: 900 },
    }, c.cell.as(c.editor));
    assert.deepEqual([site.defaultThresholdSeconds, site.loosened], [900, false], 'sites are not streamed: the freshness window');
    const audited = await c.events('staleness_threshold_changed');
    assert.deepEqual(audited.slice(0, 2).map((e) => [e.detail['from_seconds'], e.detail['to_seconds'], e.detail['loosened']]), [[600, 1200, true], [1200, 400, false]]);
    const listed = await c.gateway.call(listStalenessThresholds, { query: { connectionId: c.connectionId } }, c.cell.as(c.member));
    assert.deepEqual(listed.thresholds.map((t) => t.thresholdSeconds).sort(), [400, 900]);
  });
});

describe('clone layouts (spec 29.2)', () => {
  test('checked against main: a Located property must be geographic, containment a link with the type at one end', async () => {
    await assert.rejects(c.gateway.call(setCloneLayout, {
      params: { objectTypeId: c.pump.id }, body: { labelPropertyId: c.prop('name'), geoPropertyId: c.prop('name'), crs: 'EPSG:4326' },
    }, c.cell.as(c.editor)), (error: { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'clone.layout_invalid' && error.details?.['field'] === 'geoPropertyId');
    await assert.rejects(c.gateway.call(setCloneLayout, {
      params: { objectTypeId: c.pump.id }, body: { labelPropertyId: c.site.properties[0]!.identityId },
    }, c.cell.as(c.editor)), (error: { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'clone.layout_invalid' && error.details?.['field'] === 'labelPropertyId');
    await assert.rejects(c.gateway.call(setCloneLayout, {
      params: { objectTypeId: c.pump.id }, body: { labelPropertyId: c.prop('name') },
    }, c.cell.as(c.member)), { code: 'clone.not_permitted' });
    const first = await c.gateway.call(setCloneLayout, {
      params: { objectTypeId: c.pump.id },
      body: { labelPropertyId: c.prop('name'), timePropertyId: c.prop('last_service'), containmentLinkTypeId: c.linkTypeId },
    }, c.cell.as(c.editor));
    const second = await c.gateway.call(setCloneLayout, {
      params: { objectTypeId: c.pump.id }, body: { labelPropertyId: c.prop('name'), lanePropertyId: c.prop('status_code') },
    }, c.cell.as(c.editor));
    const live = await c.gateway.call(listCloneLayouts, { body: { objectTypeIds: [c.pump.id, c.site.id] } }, c.cell.as(c.member));
    assert.deepEqual(live.layouts.map((l) => l.id), [second.id], 'superseded, never edited: one live row');
    assert.notEqual(first.id, second.id);
  });
});

describe('canvas views (spec 29.6, 29.10)', () => {
  let setId: string;
  let viewId: string;

  test('saved over a set the saver may see, with its lineage: the set and the set\'s type', async () => {
    const set = await c.gateway.call(saveObjectSet, {
      body: { name: 'Pumps', visibility: 'shared', definition: { kind: 'filter', base: { objectTypeId: c.pump.id }, predicate: { cel: 'true', properties: [] } } },
    }, c.keyed(c.member));
    setId = set.id;
    await assert.rejects(c.gateway.call(saveCanvasView, {
      body: { canvasScope: 'set', objectSetId: uuidv7(), name: 'x', layoutKind: 'list' },
    }, c.keyed(c.member)), { code: 'clone.object_set_not_found' });
    const view = await c.gateway.call(saveCanvasView, {
      body: { canvasScope: 'set', objectSetId: setId, name: 'Pumps, north', layoutKind: 'graph_layered', stateFilter: ['failed', 'warning'],
        pinnedObjectRefs: [uuidv7()], layers: { live_state: true, history: false }, camera: { centre: [0, 0], zoom: 2 } },
    }, c.keyed(c.member));
    viewId = view.id;
    assert.deepEqual([view.access, view.visibility, view.canvasScope, view.ontologyVersion], ['owner', 'private', 'set', c.manifest.version.sequence]);
    const { rows } = await inTx(c.cell.app, { orgId: c.cell.org }, () => c.cell.app.query(
      `select src.kind from gov.lineage_edges e join gov.lineage_nodes n on n.id = e.to_node_id join gov.lineage_nodes src on src.id = e.from_node_id
       where n.kind = 'view' and n.ref_id = $1 order by src.kind`, [viewId]));
    assert.deepEqual(rows.map((r) => r.kind), ['object_set', 'object_type_version']);
  });

  test('opened by its owner in full; not found by anyone it is not shared with', async () => {
    const opened = await c.gateway.call(openCanvasView, { params: { canvasViewId: viewId } }, c.cell.as(c.member));
    assert.equal(opened.objectTypeId, c.pump.id);
    assert.equal(opened.visibleProperties.length, c.pump.properties.length);
    assert.deepEqual(opened.withheld, { properties: 0, pins: 0 });
    assert.equal(opened.statement, null);
    await assert.rejects(c.gateway.call(openCanvasView, { params: { canvasViewId: viewId } }, c.cell.as(c.outsider)), { code: 'clone.canvas_view_not_found' });
  });

  test('shared, it opens under the opener\'s own access: a withheld field is absent, stated and audited', async () => {
    const share = await c.gateway.call(shareCanvasView, {
      params: { canvasViewId: viewId }, body: { grantee: { kind: 'membership', membershipId: c.outsider.membershipId }, access: 'view' },
    }, c.cell.as(c.member));
    assert.equal(share.state, 'live');
    // A field policy denying discharge pressure to members (spec 57.4).
    await c.cell.migrate.query(
      `insert into iam.field_policies (id, organisation_id, property_id, effect, applies_to_role_id, created_by) values ($1, $2, $3, 'deny', $4, $5)`,
      [uuidv7(), c.cell.org, c.prop('pressure'), c.cell.roles['Member'], c.root.membershipId]);
    const opened = await c.gateway.call(openCanvasView, { params: { canvasViewId: viewId } }, c.cell.as(c.outsider));
    assert.equal(opened.view.access, 'view');
    assert.equal(opened.withheld.properties, 1);
    assert.ok(!opened.visibleProperties.some((p) => p.id === c.prop('pressure')));
    assert.ok(opened.statement);
    const reduced = await c.events('canvas_view_opened_with_reduced_permissions');
    assert.equal(reduced.length, 1, 'the owner\'s own reduced open is not audited; the outsider\'s is');
    assert.equal(reduced[0]!.detail['withheld_properties'], 1);
    const shared = await c.gateway.call(listCanvasViews, { query: { filter: 'shared' } }, c.cell.as(c.outsider));
    assert.deepEqual(shared.views.map((v) => v.id), [viewId]);
  });

  test('updated by its owner under its lock; favourited onto the dashboard; archived, its shares end', async () => {
    const before = (await c.gateway.call(openCanvasView, { params: { canvasViewId: viewId } }, c.cell.as(c.member))).view;
    await assert.rejects(c.gateway.call(updateCanvasView, {
      params: { canvasViewId: viewId }, body: { name: 'x', layoutKind: 'list', lockVersion: before.lockVersion + 5 },
    }, c.cell.as(c.member)), { code: 'clone.canvas_view_stale' });
    await assert.rejects(c.gateway.call(updateCanvasView, {
      params: { canvasViewId: viewId }, body: { name: 'x', layoutKind: 'list', lockVersion: before.lockVersion },
    }, c.cell.as(c.outsider)), { code: 'clone.canvas_view_not_found' });
    const updated = await c.gateway.call(updateCanvasView, {
      params: { canvasViewId: viewId }, body: { name: 'Pumps, north line', layoutKind: 'hierarchy', lockVersion: before.lockVersion },
    }, c.cell.as(c.member));
    assert.equal(updated.layoutKind, 'hierarchy');

    const favourite = await c.gateway.call(favouriteCanvasView, { params: { canvasViewId: viewId }, body: { grid: [1, 1, 4, 3] } }, c.cell.as(c.member));
    assert.equal(favourite.favourited, true);
    await c.gateway.call(favouriteCanvasView, { params: { canvasViewId: viewId }, body: {} }, c.cell.as(c.outsider));
    const tiles = async () => (await inTx(c.cell.app, { orgId: c.cell.org }, () => c.cell.app.query(
      'select membership_id from workspace.dashboard_tiles where canvas_view_id = $1 order by membership_id', [viewId]))).rows.length;
    assert.equal(await tiles(), 2, 'the owner\'s tile and the sharee\'s own');
    const unfavourited = await c.gateway.call(unfavouriteCanvasView, { params: { canvasViewId: viewId } }, c.cell.as(c.outsider));
    assert.equal(unfavourited.favourited, true, 'the flag is the owner\'s');
    assert.equal(await tiles(), 1);

    const archived = await c.gateway.call(archiveCanvasView, { params: { canvasViewId: viewId } }, c.cell.as(c.member));
    assert.ok(archived.archivedAt);
    assert.equal(archived.favourited, false);
    assert.equal(await tiles(), 0);
    await assert.rejects(c.gateway.call(openCanvasView, { params: { canvasViewId: viewId } }, c.cell.as(c.outsider)), { code: 'clone.canvas_view_not_found' });
  });

  test('preferences are a person\'s, for a view they may open', async () => {
    const view = await c.gateway.call(saveCanvasView, {
      body: { canvasScope: 'set', objectSetId: setId, name: 'Pumps list', layoutKind: 'list' },
    }, c.keyed(c.member));
    const set = await c.gateway.call(setViewPreference, { body: { canvasViewId: view.id, preferredRepresentation: 'list' } }, c.cell.as(c.member));
    assert.equal(set.preferredRepresentation, 'list');
    assert.deepEqual(await c.gateway.call(readViewPreference, { query: { canvasViewId: view.id } }, c.cell.as(c.member)), { preferredRepresentation: 'list', updatedAt: set.updatedAt });
    await assert.rejects(c.gateway.call(readViewPreference, { query: { canvasViewId: view.id } }, c.cell.as(c.outsider)), { code: 'render.view_not_found' });
    await assert.rejects(c.gateway.call(setViewPreference, { body: { canvasViewId: view.id, preferredRepresentation: 'canvas' } }, c.cell.as(c.outsider)),
      { code: 'render.view_not_found' });
  });
});

describe('the render record (spec 31.4, 31.9)', () => {
  const structure = {
    rowCount: 412, measureCount: 0, measureFromTwoSources: false, hasTimeField: true, orderedByTime: false, hasEdges: true, edgesDirected: true,
    hasCycle: false, singleParent: true, sumsToWhole: false, deviationComputed: false,
  };

  test('the floor is always offered; an override names what was offered, and is audited with the structure', async () => {
    await assert.rejects(c.gateway.call(recordRenderSelection, {
      body: { surface: 'canvas', resultRef: uuidv7(), resultStructure: structure, chosen: 'schematic', alternativesOffered: ['hierarchy'] },
    }, c.cell.as(c.member)), { code: 'render.floor_missing' });
    await assert.rejects(c.gateway.call(recordRenderSelection, {
      body: { surface: 'view', resultRef: uuidv7(), resultStructure: structure, chosen: 'chain', alternativesOffered: ['table'], overriddenTo: 'network' },
    }, c.cell.as(c.member)), { code: 'render.override_not_offered' });
    const recorded = await c.gateway.call(recordRenderSelection, {
      body: { surface: 'canvas', resultRef: uuidv7(), resultStructure: structure, chosen: 'schematic', alternativesOffered: ['hierarchy', 'list'], overriddenTo: 'hierarchy' },
    }, c.cell.as(c.member));
    assert.equal(recorded.userOverride, true);
    const overridden = await c.events('layout_overridden');
    assert.deepEqual([overridden[0]!.detail['chosen'], overridden[0]!.detail['overridden_to'], overridden[0]!.detail['row_count']], ['schematic', 'hierarchy', 412]);
  });

  test('what the person did, as the client reports it: a clone opened, an element drilled, a flag opened; only about a type they can see (D208)', async () => {
    const objectId = uuidv7();
    await c.gateway.call(recordCanvasInteraction, { body: { event: 'clone_opened', objectTypeId: c.pump.id, objectId, layout: 'schematic' } }, c.cell.as(c.member));
    const view = uuidv7();
    await c.gateway.call(recordCanvasInteraction, { body: { event: 'element_drilled', surface: 'canvas', resultRef: view, element: 'node', objectTypeId: c.pump.id, records: 3 } },
      c.cell.as(c.member));
    await c.gateway.call(recordCanvasInteraction, { body: { event: 'flag_opened', flag: 'dispute', objectTypeId: c.pump.id, objectId, surface: 'object_view' } }, c.cell.as(c.member));
    assert.deepEqual((await c.events('clone_opened')).map((e) => [e.resource?.id, e.detail['object_type_id'], e.detail['layout']]), [[objectId, c.pump.id, 'schematic']]);
    assert.deepEqual((await c.events('element_drilled')).map((e) => [e.resource?.id, e.detail['element'], e.detail['records']]), [[view, 'node', 3]]);
    assert.deepEqual((await c.events('flag_opened')).map((e) => [e.detail['flag'], e.detail['surface']]), [['dispute', 'object_view']]);
    await assert.rejects(c.gateway.call(recordCanvasInteraction, { body: { event: 'clone_opened', objectTypeId: uuidv7(), objectId } }, c.cell.as(c.member)),
      { code: 'clone.not_visible' });
  });
});

describe('precomputed layouts (spec 29.8)', () => {
  test('positions are held in the state plane only; the same graph is reused, a changed one is computed again', async () => {
    const body = {
      layout: 'graph_layered' as const, setDefinitionHash: 'a'.repeat(64), objectSetId: (await c.gateway.call(saveObjectSet, {
        body: { name: 'All pumps', definition: { kind: 'filter', base: { objectTypeId: c.pump.id }, predicate: { cel: 'true', properties: [] } } },
      }, c.keyed(c.member))).id,
      ontologyVersion: c.manifest.version.sequence,
      nodes: Array.from({ length: 6 }, () => ({ ref: uuidv7() })),
      edges: [[0, 1], [1, 2], [2, 0], [3, 4]] as [number, number][],
    };
    const first = await c.gateway.call(precomputeLayout, { body }, c.cell.as(c.member));
    assert.equal(first.reused, false);
    const again = await c.gateway.call(precomputeLayout, { body }, c.cell.as(c.member));
    assert.deepEqual([again.reused, again.id], [true, first.id]);
    const changed = await c.gateway.call(precomputeLayout, { body: { ...body, edges: [[0, 1]] } }, c.cell.as(c.member));
    assert.equal(changed.reused, false);
    const read = await c.gateway.call(getPrecomputedLayout, { params: { precomputationId: first.id } }, c.cell.as(c.member));
    assert.equal(read.positions.length, 6);
    assert.equal(read.layout, 'graph_layered');
    const { rows } = await inTx(c.cell.app, { orgId: c.cell.org }, () => c.cell.app.query(
      'select parameters, cache_key from clone.layout_precomputations where id = $1', [first.id]));
    assert.deepEqual(Object.keys(rows[0].parameters).sort(), ['edgeCount', 'graphHash', 'notPlaced'], 'parameters and hashes only, never positions');
    assert.equal((await c.events('layout_precomputed')).length, 2);
  });
});

describe('the Estate map (spec 32)', () => {
  test('connections, types and links with their evidence; health by Silo\'s rules; opens as a graph when there is something to act on', async () => {
    await assert.rejects(c.gateway.call(getEstateMap, {}, c.cell.as(c.member)), { code: 'clone.not_permitted' });
    // A super admin without a grant on the connection does not reach it (spec 57.3): absent, stated.
    const ungranted = await c.gateway.call(getEstateMap, {}, c.cell.as(c.editor));
    assert.ok(!ungranted.nodes.some((n) => n.id === c.connectionId));
    assert.equal(ungranted.statement, 'Part of the estate is not visible to you.');
    // Its owner does.
    const map = await c.gateway.call(getEstateMap, {}, c.cell.as(c.root));
    const connection = map.nodes.find((n) => n.id === c.connectionId)!;
    assert.deepEqual([connection.kind, connection.health, connection.healthReason, connection.actionable], ['connection', 'unknown', 'never_probed', true]);
    assert.equal(connection.ownerMembershipId, c.root.membershipId);
    const pump = map.nodes.find((n) => n.id === c.pump.id)!;
    assert.equal(pump.attributes['state_rule'], true);
    assert.equal(map.nodes.find((n) => n.id === c.site.id)!.attributes['state_rule'], false);
    assert.ok(map.edges.some((e) => e.from === c.connectionId && e.to === c.pump.id && e.kind === 'maps_to' && e.evidence === 'confirmed_mapping'));
    assert.ok(map.edges.some((e) => e.from === c.site.id && e.to === c.pump.id && e.kind === 'link' && e.evidence === 'declared_fk'));
    assert.equal(map.opensAs, 'graph');
    assert.ok(map.missing.some((m) => m.kind === 'object_counts'));
    assert.equal(map.statement, null);
  });

  test('a type the viewer lacks clearance for is absent, with a statement and no count; snapshots compare what they may see', async () => {
    const first = await c.gateway.call(takeEstateSnapshot, { body: {} }, c.cell.as(c.root));
    assert.equal(first.nodeCounts['object_type']!['none'], 2);
    const marking = uuidv7();
    await c.cell.migrate.query(`insert into gov.markings (id, organisation_id, name, kind, created_by) values ($1, $2, 'Restricted', 'compartment', $3)`,
      [marking, c.cell.org, c.root.membershipId]);
    await c.cell.migrate.query('insert into iam.object_type_markings (organisation_id, object_type_id, marking_id, applied_by) values ($1, $2, $3, $4)',
      [c.cell.org, c.site.id, marking, c.root.membershipId]);
    const map = await c.gateway.call(getEstateMap, {}, c.cell.as(c.root));
    assert.ok(!map.nodes.some((n) => n.id === c.site.id));
    assert.ok(!map.edges.some((e) => e.from === c.site.id || e.to === c.site.id));
    assert.equal(map.statement, 'Part of the estate is not visible to you.');
    const second = await c.gateway.call(takeEstateSnapshot, { body: {} }, c.cell.as(c.root));
    const diff = await c.gateway.call(compareEstateSnapshots, { query: { from: first.id, to: second.id } }, c.cell.as(c.root));
    assert.deepEqual(diff.removed['object_type'], [], 'the site went from view, but it is not named to someone who may not see it');
    assert.equal(diff.statement, 'Part of the estate is not visible to you.');
  });
});
