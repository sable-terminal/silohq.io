// App branches (D229): work beside main, each branch with its own draft; compared element by
// element; merged into main's next draft by the definitions' structure, changes on both sides
// kept, a conflict shown with both sides until a person decides it; main busy refuses a merge;
// a branch built on an ontology branch merges only after that has; a branch's draft never goes
// to review itself; abandoned, kept as a record. Real processes: studio over the clone cell.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  abandonAppBranch, approveVersion, compareAppVersions, createApp, getApp, listAppBranches, mergeAppBranch, openAppBranch, saveAppBranchDraft, saveDraft,
  shareApp, submitForReview,
} from '../../src/contracts/studio/app.contract.ts';
import { openBranch } from '../../src/contracts/ontology/proposal.contract.ts';
import { service as studioService } from '../../src/routes/studio/index.route.ts';
import { startCloneCell, type CloneCell } from './clone.helper.ts';

let c: CloneCell;
let appId: string;

type Def = { pages: { id: string; title: string; widgets: Record<string, unknown>[] }[] } & Record<string, unknown>;

before(async () => {
  c = await startCloneCell([{ definition: studioService, name: 'studio' }]);
});

after(async () => {
  await c?.close();
});

const app = () => c.gateway.call(getApp, { params: { appId } }, c.cell.as(c.member));
const definitionOf = async (version: number) => (await app()).versions.find((v) => v.version === version)!;
const draftOf = async (version: number) => (await c.gateway.call((await import('../../src/contracts/studio/app.contract.ts')).getAppVersion,
  { params: { appId, version } }, c.cell.as(c.member)));
/** Main's draft through review: the member submits, the editor publishes. */
async function publish(version: number): Promise<void> {
  const draft = await draftOf(version);
  const review = await c.gateway.call(submitForReview, { params: { appId, version }, body: { lockVersion: draft.lockVersion } }, c.cell.as(c.member));
  await c.gateway.call(approveVersion, { params: { appId, version }, body: { lockVersion: review.lockVersion } }, c.cell.as(c.editor));
}
const widget = (def: Def, id: string) => def.pages[0]!.widgets.find((w) => w['id'] === id)!;

describe('app branches (D229)', () => {
  test('a branch is opened from the published version with a draft of its own; a branch draft never goes to review itself', async () => {
    const created = await c.gateway.call(createApp, {
      body: { name: 'Pump monitor', template: { name: 'monitor', bindings: { objectTypeId: c.pump.id, measurePropertyId: c.prop('pressure') } } },
    }, c.keyed(c.member));
    appId = created.app.id;
    await assert.rejects(c.gateway.call(openAppBranch, { params: { appId }, body: { name: 'early' } }, c.cell.as(c.member)), { code: 'studio.branch_needs_published' });
    await publish(1);
    const opened = await c.gateway.call(openAppBranch, { params: { appId }, body: { name: 'alerts' } }, c.cell.as(c.member));
    assert.deepEqual([opened.branch.status, opened.branch.baseVersion, opened.draft.version, opened.draft.branchId, opened.draft.state], ['open', 1, 2, opened.branch.id, 'draft']);
    await assert.rejects(c.gateway.call(openAppBranch, { params: { appId }, body: { name: 'alerts' } }, c.cell.as(c.member)), { code: 'studio.branch_name_taken' });
    await assert.rejects(c.gateway.call(submitForReview, { params: { appId, version: 2 }, body: { lockVersion: opened.draft.lockVersion } }, c.cell.as(c.member)),
      { code: 'studio.branch_draft_merges' });
    await assert.rejects(c.gateway.call(listAppBranches, { params: { appId } }, c.cell.as(c.outsider)), { code: 'studio.app_not_found' });
  });

  test('changes on the branch and on main are both kept by the merge, which becomes main\'s next draft', async () => {
    const [branch] = (await c.gateway.call(listAppBranches, { params: { appId } }, c.cell.as(c.member))).branches;
    const onBranch = structuredClone((await draftOf(2)).definition) as unknown as Def;
    onBranch.pages[0]!.title = 'Pumps and alerts';
    onBranch.pages[0]!.widgets.push({ id: 'alerts', kind: 'markdown', text: 'Alerts appear here.', grid: [1, 9, 12, 2] });
    const saved = await c.gateway.call(saveAppBranchDraft, {
      params: { appId, branchId: branch!.id }, body: { definition: onBranch as never, lockVersion: (await draftOf(2)).lockVersion },
    }, c.cell.as(c.member));
    assert.deepEqual(saved.findings, []);

    // Main moves on meanwhile: another widget changed and published.
    const onMain = structuredClone((await draftOf(1)).definition) as unknown as Def;
    const metric = onMain.pages[0]!.widgets.find((w) => w['kind'] === 'metric')!;
    metric['grid'] = [9, 1, 4, 2];
    const mainDraft = await c.gateway.call(saveDraft, { params: { appId }, body: { definition: onMain as never } }, c.cell.as(c.member));
    assert.equal(mainDraft.branchId, null);
    await publish(mainDraft.version);

    const changes = await c.gateway.call(compareAppVersions, { params: { appId }, query: { from: 1, to: 2 } }, c.cell.as(c.member));
    const page = onBranch.pages[0]!.id;
    assert.deepEqual(changes.changes, [{ path: `pages.${page}.title`, change: 'changed' }, { path: `pages.${page}.widgets.alerts`, change: 'added' }]);

    const merged = await c.gateway.call(mergeAppBranch, { params: { appId, branchId: branch!.id }, body: { lockVersion: branch!.lockVersion } }, c.cell.as(c.member));
    assert.equal(merged.outcome, 'merged');
    if (merged.outcome !== 'merged') return;
    assert.deepEqual([merged.branch.status, merged.branch.mergedVersion, merged.draft.branchId, merged.draft.state], ['merged', merged.draft.version, null, 'draft']);
    const result = merged.draft.definition as unknown as Def;
    assert.equal(result.pages[0]!.title, 'Pumps and alerts');
    assert.ok(widget(result, 'alerts'), 'the branch\'s widget');
    assert.deepEqual(widget(result, String(metric['id']))['grid'], [9, 1, 4, 2], 'main\'s change since the branch opened');
    assert.deepEqual(merged.draft.findings, []);
    assert.deepEqual((await c.events('app_branch_merged')).map((e) => e.detail['decided']), [0]);
  });

  test('main busy refuses a merge; different changes to one widget are a conflict, shown both ways, until a person decides', async () => {
    await publish((await app()).versions.find((v) => v.branchId === null && v.state === 'draft')!.version);
    const opened = await c.gateway.call(openAppBranch, { params: { appId }, body: { name: 'layout' } }, c.cell.as(c.member));
    const target = String((opened.draft.definition as unknown as Def).pages[0]!.widgets.find((w) => w['kind'] === 'metric')!['id']);
    const page = (opened.draft.definition as unknown as Def).pages[0]!.id;
    const onBranch = structuredClone(opened.draft.definition) as unknown as Def;
    widget(onBranch, target)['grid'] = [1, 1, 6, 2];
    const saved = await c.gateway.call(saveAppBranchDraft, { params: { appId, branchId: opened.branch.id }, body: { definition: onBranch as never, lockVersion: opened.draft.lockVersion } }, c.cell.as(c.member));
    assert.deepEqual(saved.findings, []);

    const current = (await app()).versions.find((v) => v.state === 'published')!.version;
    const onMain = structuredClone((await draftOf(current)).definition) as unknown as Def;
    widget(onMain, target)['grid'] = [7, 1, 6, 2];
    const mainDraft = await c.gateway.call(saveDraft, { params: { appId }, body: { definition: onMain as never } }, c.cell.as(c.member));
    await assert.rejects(c.gateway.call(mergeAppBranch, { params: { appId, branchId: opened.branch.id }, body: { lockVersion: opened.branch.lockVersion } }, c.cell.as(c.member)),
      { code: 'studio.main_in_progress' });
    await publish(mainDraft.version);

    const first = await c.gateway.call(mergeAppBranch, { params: { appId, branchId: opened.branch.id }, body: { lockVersion: opened.branch.lockVersion } }, c.cell.as(c.member));
    assert.equal(first.outcome, 'conflicts');
    if (first.outcome !== 'conflicts') return;
    assert.deepEqual(first.conflicts.map((x) => [x.path, (x.main as { grid: number[] }).grid, (x.branch as { grid: number[] }).grid]),
      [[`pages.${page}.widgets.${target}`, [7, 1, 6, 2], [1, 1, 6, 2]]]);
    const decided = await c.gateway.call(mergeAppBranch, {
      params: { appId, branchId: opened.branch.id }, body: { lockVersion: opened.branch.lockVersion, decisions: [{ path: `pages.${page}.widgets.${target}`, take: 'branch' }] },
    }, c.cell.as(c.member));
    assert.equal(decided.outcome, 'merged');
    if (decided.outcome === 'merged') assert.deepEqual(widget(decided.draft.definition as unknown as Def, target)['grid'], [1, 1, 6, 2]);
  });

  test('a branch built on an ontology branch merges only after that branch has; abandoned, it is kept as a record', async () => {
    await publish((await app()).versions.find((v) => v.branchId === null && v.state === 'draft')!.version);
    const ontology = await c.gateway.call(openBranch, { body: { name: 'pump alarms' } }, c.keyed(c.root));
    // Building on an ontology branch needs leave to read it (ontology.branch); an editor of the app who holds it may.
    await assert.rejects(c.gateway.call(openAppBranch, { params: { appId }, body: { name: 'alarms', ontologyBranchId: ontology.id } }, c.cell.as(c.member)),
      { code: 'ontology.not_permitted' });
    await c.gateway.call(shareApp, { params: { appId }, body: { grantee: { kind: 'membership', membershipId: c.editor.membershipId }, access: 'edit' } }, c.cell.as(c.member));
    const bound = await c.gateway.call(openAppBranch, { params: { appId }, body: { name: 'alarms', ontologyBranchId: ontology.id } }, c.cell.as(c.editor));
    assert.equal(bound.branch.ontologyBranchId, ontology.id);
    await assert.rejects(c.gateway.call(mergeAppBranch, { params: { appId, branchId: bound.branch.id }, body: { lockVersion: bound.branch.lockVersion } }, c.cell.as(c.editor)),
      { code: 'studio.ontology_branch_open' });
    const abandoned = await c.gateway.call(abandonAppBranch, { params: { appId, branchId: bound.branch.id }, body: { lockVersion: bound.branch.lockVersion } }, c.cell.as(c.editor));
    assert.equal(abandoned.status, 'abandoned');
    const listed = (await c.gateway.call(listAppBranches, { params: { appId } }, c.cell.as(c.member))).branches;
    assert.deepEqual(listed.map((b) => [b.name, b.status]), [['alarms', 'abandoned'], ['layout', 'merged'], ['alerts', 'merged']]);
    assert.deepEqual((await c.events('app_branch_opened')).length, 3);
  });
});
