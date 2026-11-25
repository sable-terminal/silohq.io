// The workspace (spec 33, 37) end to end: real credential, policy, auth and workspace
// processes on a harness database and Redis, with a fake query engine standing in for
// compile and the executor. Saved views are private by default, shared within the sharing
// policy (applied again at every resolution), re-run under the opener's own access, tiled
// onto dashboards, and transferred, flagged, to the admin above a removed member.

import { recordWorkspaceInteraction } from '../../src/contracts/workspace/interaction.contract.ts';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  getSharingPolicy, listShares, revokeShare, setOrganisationSharingPolicy, setScopeSharingPolicy, shareView,
} from '../../src/contracts/workspace/sharing.contract.ts';
import {
  addFavourite, getPreferences, markHomeSeen, setTerminologySkin, updatePreferences,
} from '../../src/contracts/workspace/shell.contract.ts';
import { listInheritedViews, reviewInheritedView, transferViews } from '../../src/contracts/workspace/transfer.contract.ts';
import {
  archiveView, copyView, favouriteView, getDashboard, listViews, moveTile, openView, renameView, runView, saveView, unfavouriteView,
} from '../../src/contracts/workspace/view.contract.ts';
import { unavailableEngine } from '../../src/services/workspace/queryEngine.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { startWorkspaceCell, type Signed, type WorkspaceCell } from './workspace.helper.ts';

let cell: WorkspaceCell;
let eng: string;
let platform: string;
let sales: string;
let engAdmin: Signed;
let alice: Signed;
let bob: Signed;
let carol: Signed;
let dave: Signed;

const keyed = () => ({ idempotencyKey: uuidv7() });
const save = async (who: Signed, name = 'Pipeline by region') =>
  cell.call(saveView, { body: { kind: 'result', name, manifestId: await cell.engine.manifest(who.membershipId) } }, who, keyed());

before(async () => {
  cell = await startWorkspaceCell();
  eng = await cell.scope('Engineering');
  platform = await cell.scope('Platform', eng);
  sales = await cell.scope('Sales');
  engAdmin = await cell.join('admin@acme.example', 'Admin', eng);
  alice = await cell.join('alice@acme.example', 'Member', platform);
  bob = await cell.join('bob@acme.example', 'Member', platform);
  carol = await cell.join('carol@acme.example', 'Member', sales);
  dave = await cell.join('dave@acme.example', 'Member');
});

after(async () => {
  await cell?.close();
});

describe('saved views (spec 37.2, 37.3)', () => {
  test('a view is saved private, with its own thread, from a plan the saver compiled; never from someone else\'s', async () => {
    const view = await save(alice);
    assert.equal(view.visibility, 'private');
    assert.equal(view.access, 'owner');
    assert.equal(view.favourited, false);
    const { rows } = await cell.migrate.query('select saved_view_id, scope_kind, owner_membership_id from workspace.ask_threads where id = $1', [view.threadId]);
    assert.deepEqual(rows[0], { saved_view_id: view.id, scope_kind: 'saved_view', owner_membership_id: alice.membershipId });

    const bobsPlan = await cell.engine.manifest(bob.membershipId);
    await assert.rejects(cell.call(saveView, { body: { kind: 'result', name: 'Not mine', manifestId: bobsPlan } }, alice, keyed()),
      { code: 'workspace.plan_not_found' });
    await assert.rejects(cell.call(saveView, { body: { kind: 'analysis', name: 'Wrong kind', manifestId: await cell.engine.manifest(alice.membershipId) } },
      alice, keyed()), { code: 'workspace.plan_not_found' }, 'an analysis view needs an analysis manifest');
    await assert.rejects(cell.call(saveView, { body: { kind: 'object_set', name: 'No set', objectSetId: uuidv7() } }, alice, keyed()),
      { code: 'workspace.plan_not_found' });
    assert.equal((await cell.events('view_saved')).filter((e) => e.resource?.id === view.id).length, 1);
  });

  test('a retried save returns the same view', async () => {
    const manifestId = await cell.engine.manifest(alice.membershipId);
    const key = keyed();
    const first = await cell.call(saveView, { body: { kind: 'result', name: 'Retried', manifestId } }, alice, key);
    const again = await cell.call(saveView, { body: { kind: 'result', name: 'Retried', manifestId } }, alice, key);
    assert.equal(again.id, first.id);
  });

  test('a view saved from an Ask turn keeps a copy of the values bound into its plan, under its own id', async () => {
    const manifestId = await cell.engine.manifest(alice.membershipId);
    const turn = uuidv7();
    await cell.engine.binding(turn, manifestId, alice.membershipId);
    const view = await cell.call(saveView, { body: { kind: 'result', name: 'From a turn', manifestId, fromBindingId: turn } }, alice, keyed());
    assert.deepEqual(cell.engine.bindings.at(-1), { from: turn, to: view.id });
    const other = await cell.engine.manifest(alice.membershipId);
    await assert.rejects(cell.call(saveView, { body: { kind: 'result', name: 'Mismatch', manifestId: other, fromBindingId: turn } }, alice, keyed()),
      { code: 'workspace.plan_not_found' }, 'values bound to another plan are not these');
    // Someone else's turn on a plan Alice also compiled: never their values in her view.
    const bobsTurn = uuidv7();
    await cell.engine.binding(bobsTurn, manifestId, bob.membershipId);
    await assert.rejects(cell.call(saveView, { body: { kind: 'result', name: 'Not mine', manifestId, fromBindingId: bobsTurn } }, alice, keyed()),
      { code: 'workspace.plan_not_found' });
  });

  test('nobody else sees a private view, an admin included (spec 37.3)', async () => {
    const view = await save(alice, 'Private one');
    for (const other of [bob, engAdmin, cell.root]) {
      await assert.rejects(cell.call(openView, { params: { viewId: view.id } }, other), { code: 'workspace.view_not_found' });
    }
    const mine = await cell.call(listViews, { query: {} }, alice);
    assert.ok(mine.views.some((v) => v.id === view.id));
    const searched = await cell.call(listViews, { query: { search: 'PRIVATE' } }, alice);
    assert.deepEqual(searched.views.map((v) => v.id), [view.id]);
  });

  test('rename checks the version; archive ends the view\'s shares and its tiles', async () => {
    const view = await save(alice, 'Old name');
    const renamed = await cell.call(renameView, { params: { viewId: view.id }, body: { name: 'New name', lockVersion: view.lockVersion } }, alice);
    assert.equal(renamed.name, 'New name');
    assert.equal(renamed.lockVersion, view.lockVersion + 1);
    await assert.rejects(cell.call(renameView, { params: { viewId: view.id }, body: { name: 'Stale', lockVersion: view.lockVersion } }, alice),
      { code: 'workspace.view_stale' });
    const { rows } = await cell.migrate.query('select title from workspace.ask_threads where id = $1', [view.threadId]);
    assert.equal(rows[0].title, 'New name', 'the view\'s thread carries its name');

    await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'view' } }, alice);
    await cell.call(favouriteView, { params: { viewId: view.id }, body: {} }, alice);
    const archived = await cell.call(archiveView, { params: { viewId: view.id } }, alice);
    assert.ok(archived.archivedAt);
    assert.equal(archived.favourited, false);
    assert.equal(archived.visibility, 'private');
    await assert.rejects(cell.call(openView, { params: { viewId: view.id } }, bob), { code: 'workspace.view_not_found' });
    await assert.rejects(cell.call(runView, { params: { viewId: view.id } }, alice), { code: 'workspace.view_archived' });
    const listed = await cell.call(listViews, { query: { set: 'archived' } }, alice);
    assert.ok(listed.views.some((v) => v.id === view.id));
    await assert.rejects(cell.call(renameView, { params: { viewId: view.id }, body: { name: 'x', lockVersion: 1 } }, bob), { code: 'workspace.view_not_found' });
  });
});

describe('running under the opener\'s access (spec 37.5)', () => {
  test('the owner runs it: never metered, the last result held as a reference, the run audited', async () => {
    const view = await save(alice, 'Runs');
    const before = cell.engine.compiles.length;
    const { run, view: after } = await cell.call(runView, { params: { viewId: view.id } }, alice);
    assert.equal(run.outcome, 'result');
    assert.equal(cell.engine.compiles.length, before, 'running compiles nothing');
    assert.deepEqual(cell.engine.runs.at(-1), { target: { manifestId: view.manifestId, bindingId: view.id }, membershipId: alice.membershipId },
      'the plan runs with the values the view keeps under its own id');
    assert.ok(after.lastRunAt);
    const opened = await cell.call(openView, { params: { viewId: view.id } }, alice);
    assert.equal(opened.lastRun?.resultRef, run.outcome === 'result' ? run.resultRef : undefined);
    assert.ok((await cell.events('view_run')).some((e) => e.resource?.id === view.id));
  });

  test('a shared view runs as the opener, and a reduced run is audited', async () => {
    const view = await save(alice, 'Salaries by team');
    await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'view' } }, alice);
    const seen = await cell.call(openView, { params: { viewId: view.id } }, bob);
    assert.equal(seen.view.access, 'view');
    await assert.rejects(cell.call(runView, { params: { viewId: view.id } }, bob), { code: 'workspace.access_insufficient' });

    // Re-sharing updates the one share rather than adding another.
    await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'run' } }, alice);
    const shares = await cell.call(listShares, { params: { viewId: view.id } }, alice);
    assert.equal(shares.shares.length, 1);
    assert.equal(shares.shares[0]!.access, 'run');

    cell.engine.reducedFor.add(bob.membershipId);
    const { run } = await cell.call(runView, { params: { viewId: view.id } }, bob);
    assert.equal(run.outcome === 'result' && run.reduced, true);
    assert.equal(cell.engine.runs.at(-1)!.membershipId, bob.membershipId, 'the engine ran it under bob, never alice');
    const reduced = (await cell.events('view_opened_with_reduced_permissions')).filter((e) => e.resource?.id === view.id);
    assert.equal(reduced.length, 1);
    assert.equal(reduced[0]!.subjectMembershipId, alice.membershipId);
    cell.engine.reducedFor.delete(bob.membershipId);
  });

  test('a plan that no longer validates is refused, never half-run (spec 37.10)', async () => {
    const view = await save(alice, 'Stale plan');
    cell.engine.runOutcome = (target) => ('manifestId' in target && target.manifestId === view.manifestId
      ? { outcome: 'refused', reason: 'invalid_manifest', invalidSinceVersionId: uuidv7() } : undefined);
    const { run, view: after } = await cell.call(runView, { params: { viewId: view.id } }, alice);
    assert.equal(run.outcome, 'refused');
    assert.equal(after.lastRunAt, null);
    cell.engine.runOutcome = () => undefined;
  });

  test('without the compile and executor services, runs are refused as unavailable', async () => {
    const outcome = await unavailableEngine.run({ manifestId: uuidv7() }, { request: {}, correlationId: uuidv7() });
    assert.deepEqual(outcome, { outcome: 'refused', reason: 'unavailable', invalidSinceVersionId: null });
    await assert.rejects(unavailableEngine.compile({} as never, { request: {}, correlationId: uuidv7() }), { code: 'ask.compile_unavailable' });
  });
});

describe('sharing within the policy (spec 37.4)', () => {
  test('explicit_only (the default): named members only; a revoked or expired share grants nothing', async () => {
    const view = await save(alice, 'Explicit');
    await assert.rejects(cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'scope', scopeId: platform }, access: 'view' } }, alice),
      { code: 'workspace.share_forbidden' });
    await assert.rejects(cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'organisation' }, access: 'view' } }, alice),
      { code: 'workspace.share_forbidden' });
    await assert.rejects(cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: uuidv7() }, access: 'view' } }, alice),
      { code: 'workspace.share_grantee_unknown' }, 'sharing never adds anyone to the organisation');
    await assert.rejects(cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: carol.membershipId }, access: 'view' } }, bob),
      { code: 'workspace.view_not_found' }, 'only the owner shares');

    const share = await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: carol.membershipId }, access: 'view' } }, alice);
    assert.equal(share.state, 'live');
    const shared = await cell.call(listViews, { query: { set: 'shared' } }, carol);
    assert.ok(shared.views.some((v) => v.id === view.id && v.access === 'view'));
    assert.equal((await cell.call(openView, { params: { viewId: view.id } }, alice)).view.visibility, 'shared');

    await cell.call(revokeShare, { params: { viewId: view.id, shareId: share.id } }, alice);
    await assert.rejects(cell.call(openView, { params: { viewId: view.id } }, carol), { code: 'workspace.view_not_found' });
    assert.equal((await cell.call(openView, { params: { viewId: view.id } }, alice)).view.visibility, 'private');

    const again = await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: carol.membershipId }, access: 'view' } }, alice);
    assert.equal(again.id, share.id, 're-sharing reuses the share');
    await cell.migrate.query(`update workspace.view_shares set expires_at = now() - interval '1 minute' where id = $1`, [share.id]);
    await assert.rejects(cell.call(openView, { params: { viewId: view.id } }, carol), { code: 'workspace.view_not_found' },
      'access ends at expires_at, whatever the sweep');
    assert.equal((await cell.call(listShares, { params: { viewId: view.id } }, alice)).shares[0]!.state, 'expired');
  });

  test('only a super admin sets the organisation policy; a later, stricter policy applies at resolution', async () => {
    await assert.rejects(cell.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'open', orgWideSharingPermitted: true } }, engAdmin),
      { code: 'workspace.not_permitted' });
    await cell.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'open', orgWideSharingPermitted: true } }, cell.root);
    const view = await save(alice, 'For everyone');
    await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'organisation' }, access: 'view' } }, alice);
    assert.equal((await cell.call(openView, { params: { viewId: view.id } }, dave)).view.access, 'view');
    assert.equal((await cell.call(openView, { params: { viewId: view.id } }, alice)).view.visibility, 'org_visible');

    await cell.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'disabled', orgWideSharingPermitted: false } }, cell.root);
    await assert.rejects(cell.call(openView, { params: { viewId: view.id } }, dave), { code: 'workspace.view_not_found' });
    const shares = await cell.call(listShares, { params: { viewId: view.id } }, alice);
    assert.equal(shares.shares[0]!.state, 'forbidden_by_policy', 'the share is kept and shown as forbidden, not rewritten');
    assert.ok((await cell.events('sharing_policy_changed')).length >= 2);
    await cell.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'explicit_only', orgWideSharingPermitted: false } }, cell.root);
  });

  test('scope_only: members who sit together, and scopes the owner sits in', async () => {
    await cell.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'scope_only', orgWideSharingPermitted: false } }, cell.root);
    const view = await save(alice, 'Scope only');
    await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'view' } }, alice);
    await assert.rejects(cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: carol.membershipId }, access: 'view' } }, alice),
      { code: 'workspace.share_forbidden' });
    await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'scope', scopeId: platform }, access: 'view' } }, alice);
    await assert.rejects(cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'scope', scopeId: sales }, access: 'view' } }, alice),
      { code: 'workspace.share_forbidden' });
    await cell.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'explicit_only', orgWideSharingPermitted: false } }, cell.root);
  });

  test('a scope admin narrows sharing in their subtree, never loosens it', async () => {
    await cell.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'open', orgWideSharingPermitted: false } }, cell.root);
    await assert.rejects(cell.call(setScopeSharingPolicy, { params: { scopeId: sales }, body: { viewSharingPolicy: 'disabled' } }, engAdmin),
      { code: 'workspace.not_permitted' }, 'not their subtree');
    const policy = await cell.call(setScopeSharingPolicy, { params: { scopeId: eng }, body: { viewSharingPolicy: 'explicit_only' } }, engAdmin);
    assert.equal(policy.scopes.find((s) => s.scopeId === eng)?.viewSharingPolicy, 'explicit_only');
    await assert.rejects(cell.call(setScopeSharingPolicy, { params: { scopeId: platform }, body: { viewSharingPolicy: 'open' } }, engAdmin),
      { code: 'workspace.scope_policy_looser' });

    // Alice sits under Engineering: its policy binds her; Carol in Sales shares openly.
    const mine = await cell.call(getSharingPolicy, {}, alice);
    assert.equal(mine.effective.viewSharingPolicy, 'explicit_only');
    const view = await save(alice, 'Narrowed');
    await assert.rejects(cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'scope', scopeId: platform }, access: 'view' } }, alice),
      { code: 'workspace.share_forbidden' });
    const carols = await save(carol, 'Open in sales');
    await cell.call(shareView, { params: { viewId: carols.id }, body: { grantee: { kind: 'scope', scopeId: sales }, access: 'view' } }, carol);
    assert.ok((await cell.events('scope_sharing_narrowed')).some((e) => e.detail['to'] === 'explicit_only'));
    await cell.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'explicit_only', orgWideSharingPermitted: false } }, cell.root);
  });
});

describe('views compiled on an ontology branch (spec 25.3)', () => {
  test('are their author\'s alone: a shared view always runs against main', async () => {
    // A working branch and its version, as the ontology service writes them, and a plan compiled against it.
    const versionId = uuidv7();
    const branchId = uuidv7();
    const { rows: [main] } = await cell.migrate.query(`select head_version_id from ontology.ontology_branches where organisation_id = $1 and kind = 'main'`, [cell.org]);
    await cell.migrate.query('begin');
    try {
      await cell.migrate.query(
        `insert into ontology.ontology_versions (id, organisation_id, branch_id, sequence, kind, manifest_hash, created_by_membership_id)
         values ($1, $2, $3, 1, 'change', $4, $5)`, [versionId, cell.org, branchId, randomBytes(32), alice.membershipId]);
      await cell.migrate.query(
        `insert into ontology.ontology_branches (id, organisation_id, name, kind, base_version_id, head_version_id, owner_membership_id)
         values ($1, $2, 'what if', 'working', $3, $4, $5)`, [branchId, cell.org, main.head_version_id, versionId, alice.membershipId]);
      await cell.migrate.query('commit');
    } catch (error) {
      await cell.migrate.query('rollback');
      throw error;
    }
    const planId = uuidv7();
    await cell.migrate.query(
      `insert into ontology.compiled_manifests (id, organisation_id, kind, manifest, manifest_hash, schema_version, ontology_version_id,
         policy_version, compile_class, created_by_membership_id)
       values ($1, $2, 'query', '{"steps": []}', $3, '1', $4, 1, 'standard', $5)`, [planId, cell.org, randomBytes(32), versionId, alice.membershipId]);
    const view = await cell.call(saveView, { body: { kind: 'result', name: 'On the branch', manifestId: planId } }, alice, keyed());
    await assert.rejects(cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'view' } }, alice),
      { code: 'workspace.view_on_branch' });
  });
});

describe('what the person did, as the client reports it (spec 33.5, 37; D208)', () => {
  test('a palette command, a tile that fell back, an analysis step refused at its bound: each recorded as the member', async () => {
    const view = uuidv7();
    await cell.gateway.call(recordWorkspaceInteraction, { body: { event: 'palette_command_run', command: 'switch_representation', page: 'view' } }, cell.as(alice));
    await cell.gateway.call(recordWorkspaceInteraction, { body: { event: 'dashboard_tile_fallback', savedViewId: view, from: 'network', to: 'table', reason: 'below_minimum_size' } },
      cell.as(alice));
    await cell.gateway.call(recordWorkspaceInteraction, {
      body: { event: 'analysis_step_refused', savedViewId: view, step: 'traverse', stepIndex: 2, bound: 'max_rows_per_step', count: 120_000 },
    }, cell.as(alice));
    assert.deepEqual((await cell.events('palette_command_run')).map((e) => [e.detail['command'], e.detail['page']]), [['switch_representation', 'view']]);
    assert.deepEqual((await cell.events('dashboard_tile_fallback')).map((e) => [e.resource?.id, e.detail['from'], e.detail['to']]), [[view, 'network', 'table']]);
    assert.deepEqual((await cell.events('analysis_step_refused')).map((e) => [e.detail['step'], e.detail['bound'], e.detail['count']]), [['traverse', 'max_rows_per_step', 120_000]]);
    await assert.rejects(cell.gateway.call(recordWorkspaceInteraction, { body: { event: 'palette_command_run', command: 'drop_tables', page: 'view' } as never }, cell.as(alice)));
  });
});

describe('copies and dashboards (spec 37.4, 37.6)', () => {
  test('copy access makes a new private view owned by the recipient', async () => {
    const view = await save(alice, 'Copy me');
    await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'run' } }, alice);
    await assert.rejects(cell.call(copyView, { params: { viewId: view.id }, body: {} }, bob, keyed()), { code: 'workspace.access_insufficient' });
    await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'copy' } }, alice);
    const copied = await cell.call(copyView, { params: { viewId: view.id }, body: { name: 'My copy' } }, bob, keyed());
    assert.equal(copied.ownerMembershipId, bob.membershipId);
    assert.equal(copied.visibility, 'private');
    assert.equal(copied.manifestId, view.manifestId);
    assert.notEqual(copied.threadId, view.threadId);
    await assert.rejects(cell.call(openView, { params: { viewId: copied.id } }, alice), { code: 'workspace.view_not_found' });
  });

  test('favourites form the dashboard; a tile of a revoked share disappears', async () => {
    const view = await save(alice, 'Dash');
    const fav = await cell.call(favouriteView, { params: { viewId: view.id }, body: {} }, alice);
    assert.equal(fav.view.favourited, true);
    const share = await cell.call(shareView, { params: { viewId: view.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'view' } }, alice);
    const bobs = await cell.call(favouriteView, { params: { viewId: view.id }, body: { grid: [3, 1, 2, 1] } }, bob);
    assert.equal(bobs.view.favourited, true, 'the owner\'s flag, unchanged by bob');
    assert.ok((await cell.call(getDashboard, {}, bob)).tiles.some((t) => t.view.id === view.id && t.grid[0] === 3));
    const moved = await cell.call(moveTile, { params: { tileId: bobs.tileId }, body: { grid: [1, 5, 4, 2] } }, bob);
    assert.deepEqual(moved.grid, [1, 5, 4, 2]);
    await assert.rejects(cell.call(moveTile, { params: { tileId: bobs.tileId }, body: { grid: [1, 1, 1, 1] } }, alice), { code: 'workspace.tile_not_found' });

    await cell.call(revokeShare, { params: { viewId: view.id, shareId: share.id } }, alice);
    assert.ok(!(await cell.call(getDashboard, {}, bob)).tiles.some((t) => t.view.id === view.id));
    const { rows } = await cell.migrate.query('select count(*)::int as n from workspace.dashboard_tiles where saved_view_id = $1 and membership_id = $2',
      [view.id, bob.membershipId]);
    assert.equal(rows[0].n, 0);

    const unfav = await cell.call(unfavouriteView, { params: { viewId: view.id } }, alice);
    assert.equal(unfav.favourited, false);
    assert.ok(!(await cell.call(getDashboard, {}, alice)).tiles.some((t) => t.view.id === view.id));
  });
});

describe('transfer on removal (spec 37.7)', () => {
  test('views go flagged to the nearest admin above, shares suspended until review; shares to the member end', async () => {
    const leaver = await cell.join('leaver@acme.example', 'Member', platform);
    const one = await save(leaver, 'Leaver one');
    const two = await save(leaver, 'Leaver two');
    await cell.call(shareView, { params: { viewId: one.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'view' } }, leaver);
    await cell.call(favouriteView, { params: { viewId: one.id }, body: {} }, leaver);
    const toLeaver = await save(alice, 'Shared to the leaver');
    await cell.call(shareView, { params: { viewId: toLeaver.id }, body: { grantee: { kind: 'membership', membershipId: leaver.membershipId }, access: 'view' } }, alice);
    const { rows: threadRows } = await cell.migrate.query(
      `insert into workspace.ask_threads (id, organisation_id, owner_membership_id, title) values ($1, $2, $3, 'Own thread') returning id`,
      [uuidv7(), cell.org, leaver.membershipId]);

    await assert.rejects(cell.gateway.call(transferViews, { body: { membershipId: leaver.membershipId, reason: 'member_removed' } }, cell.as(cell.root)),
      { code: 'caller.not_listed' }, 'only policy transfers');
    const result = await cell.policyClient.call(transferViews, { body: { membershipId: leaver.membershipId, reason: 'member_removed' } },
      { request: { organisationId: cell.org } });
    assert.deepEqual(result, {
      receivingMembershipId: engAdmin.membershipId, viewsTransferred: 2, sharesSuspended: 1, sharesRevoked: 1, threadsArchived: 1,
    });
    const { rows: archivedThread } = await cell.migrate.query('select archived_at from workspace.ask_threads where id = $1', [threadRows[0].id]);
    assert.ok(archivedThread[0].archived_at);

    await assert.rejects(cell.call(openView, { params: { viewId: one.id } }, bob), { code: 'workspace.view_not_found' }, 'suspended until reviewed');
    const opened = await cell.call(openView, { params: { viewId: one.id } }, engAdmin);
    assert.equal(opened.view.access, 'owner');
    assert.equal(opened.view.transferredFromMembershipId, leaver.membershipId);
    assert.equal(opened.view.favourited, false);
    const { rows: viewThread } = await cell.migrate.query('select owner_membership_id from workspace.ask_threads where id = $1', [one.threadId]);
    assert.equal(viewThread[0].owner_membership_id, engAdmin.membershipId, 'the view\'s thread moves with it');
    await assert.rejects(cell.call(shareView, { params: { viewId: one.id }, body: { grantee: { kind: 'membership', membershipId: carol.membershipId }, access: 'view' } }, engAdmin),
      { code: 'workspace.view_unreviewed' });

    const queue = await cell.call(listInheritedViews, {}, engAdmin);
    assert.deepEqual(queue.inherited.map((i) => i.view.id).sort(), [one.id, two.id].sort());
    const flagOne = queue.inherited.find((i) => i.view.id === one.id)!.flagId;
    const flagTwo = queue.inherited.find((i) => i.view.id === two.id)!.flagId;
    await assert.rejects(cell.call(reviewInheritedView, { params: { flagId: flagOne }, body: { decision: 'shared' } }, alice), { code: 'workspace.transfer_not_found' });
    const shared = await cell.call(reviewInheritedView, { params: { flagId: flagOne }, body: { decision: 'shared' } }, engAdmin);
    assert.equal(shared.sharesResumed, 1);
    assert.equal((await cell.call(openView, { params: { viewId: one.id } }, bob)).view.access, 'view');
    await assert.rejects(cell.call(reviewInheritedView, { params: { flagId: flagOne }, body: { decision: 'retained' } }, engAdmin), { code: 'workspace.transfer_reviewed' });
    const archived = await cell.call(reviewInheritedView, { params: { flagId: flagTwo }, body: { decision: 'archived' } }, engAdmin);
    assert.ok(archived.view.archivedAt);
    assert.equal((await cell.call(listInheritedViews, {}, engAdmin)).inherited.length, 0);
    await assert.rejects(cell.migrate.query('delete from workspace.view_transfer_flags where id = $1', [flagOne]), /append-only/,
      'flags are resolved, never deleted');
    const events = await cell.events('view_transferred');
    assert.equal(events.filter((e) => e.resource?.id === one.id || e.resource?.id === two.id).length, 2);
  });

  test('a member with no scope admin above goes to a super admin', async () => {
    const loner = await cell.join('loner@acme.example', 'Member');
    const view = await save(loner, 'Loner');
    const result = await cell.policyClient.call(transferViews, { body: { membershipId: loner.membershipId, reason: 'member_removed' } },
      { request: { organisationId: cell.org } });
    assert.equal(result.receivingMembershipId, cell.root.membershipId);
    assert.equal((await cell.call(openView, { params: { viewId: view.id } }, cell.root)).view.access, 'owner');
  });
});

describe('the shell (spec 33)', () => {
  test('preferences and the Home marker are the member\'s own', async () => {
    assert.deepEqual(await cell.call(getPreferences, {}, dave), { railCollapsed: false, askPanelOpen: false, lastHomeSeenAt: null });
    assert.equal((await cell.call(updatePreferences, { body: { askPanelOpen: true } }, dave)).askPanelOpen, true);
    const first = await cell.call(markHomeSeen, {}, dave);
    assert.equal(first.previous, null);
    const second = await cell.call(markHomeSeen, {}, dave);
    assert.equal(second.previous, first.seenAt, 'the next briefing starts after what was shown');
    assert.deepEqual(await cell.call(getPreferences, {}, carol), { railCollapsed: false, askPanelOpen: false, lastHomeSeenAt: null });
  });

  test('a favourite must name something that exists; skins need org.terminology.manage', async () => {
    await assert.rejects(cell.call(addFavourite, { body: { target: { kind: 'scenario', scenarioId: uuidv7() } } }, dave),
      { code: 'workspace.favourite_target_unknown' });
    await assert.rejects(cell.call(setTerminologySkin, { body: { target: { kind: 'link_type', linkTypeId: uuidv7() }, labelSingular: 'Matter' } }, alice),
      { code: 'workspace.not_permitted' });
    await assert.rejects(cell.call(setTerminologySkin, { body: { target: { kind: 'link_type', linkTypeId: uuidv7() }, labelSingular: 'Matter' } }, cell.root),
      { code: 'workspace.skin_target_unknown' });
  });
});
