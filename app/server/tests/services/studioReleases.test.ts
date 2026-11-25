// Staged releases (D230): a version approved with stages reaches people scope by scope. A member
// of a released stage's scope (or one below it) opens the new version and everyone else the one
// before, until the last stage is released; editors always open the newest. One release rolls out
// at a time; rolled back, everyone opens the version before again. Releasing needs app.publish in
// the stage's scopes. Real processes: studio over the clone cell.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  approveVersion, createApp, getAppVersion, listAppReleases, openApp, promoteAppRelease, returnVersion, rollBackAppRelease, saveDraft, shareApp, submitForReview,
} from '../../src/contracts/studio/app.contract.ts';
import { service as studioService } from '../../src/routes/studio/index.route.ts';
import type { Signed } from './connect.helper.ts';
import { startCloneCell, type CloneCell } from './clone.helper.ts';

let c: CloneCell;
let appId: string;
let engineer: Signed;
let seller: Signed;

type Def = { pages: { widgets: Record<string, unknown>[] }[] } & Record<string, unknown>;

before(async () => {
  c = await startCloneCell([{ definition: studioService, name: 'studio' }]);
  engineer = await c.cell.member('engineer@acme.example', 'Member', 'platform');
  seller = await c.cell.member('seller@acme.example', 'Member', 'sales');
});

after(async () => {
  await c?.close();
});

const opens = async (who: Signed) => (await c.gateway.call(openApp, { params: { appId }, query: {} }, c.cell.as(who))).version.version;
/** A new main draft (one widget moved), submitted by its author. */
async function nextDraft(from: number, grid: number[]): Promise<{ version: number; lockVersion: number }> {
  const def = structuredClone((await c.gateway.call(getAppVersion, { params: { appId, version: from } }, c.cell.as(c.member))).definition) as unknown as Def;
  def.pages[0]!.widgets[0]!['grid'] = grid;
  const draft = await c.gateway.call(saveDraft, { params: { appId }, body: { definition: def as never } }, c.cell.as(c.member));
  const review = await c.gateway.call(submitForReview, { params: { appId, version: draft.version }, body: { lockVersion: draft.lockVersion } }, c.cell.as(c.member));
  return { version: review.version, lockVersion: review.lockVersion };
}

describe('staged releases (D230)', () => {
  test('a first version reaches everyone; a later one reaches the first stage\'s scopes, everyone else keeping the one before', async () => {
    const created = await c.gateway.call(createApp, {
      body: { name: 'Pump monitor', template: { name: 'monitor', bindings: { objectTypeId: c.pump.id, measurePropertyId: c.prop('pressure') } } },
    }, c.keyed(c.member));
    appId = created.app.id;
    const first = await c.gateway.call(submitForReview, { params: { appId, version: 1 }, body: { lockVersion: created.draft.lockVersion } }, c.cell.as(c.member));
    await assert.rejects(c.gateway.call(approveVersion, {
      params: { appId, version: 1 }, body: { lockVersion: first.lockVersion, stages: [{ scopeIds: [c.cell.scopes['engineering']!] }] },
    }, c.cell.as(c.editor)), { code: 'studio.release_needs_previous' });
    await c.gateway.call(approveVersion, { params: { appId, version: 1 }, body: { lockVersion: first.lockVersion } }, c.cell.as(c.editor));
    for (const who of [engineer, seller]) {
      await c.gateway.call(shareApp, { params: { appId }, body: { grantee: { kind: 'membership', membershipId: who.membershipId }, access: 'view' } }, c.cell.as(c.member));
    }

    const second = await nextDraft(1, [1, 1, 6, 3]);
    await c.gateway.call(approveVersion, {
      params: { appId, version: second.version },
      body: { lockVersion: second.lockVersion, stages: [{ scopeIds: [c.cell.scopes['engineering']!] }, { scopeIds: [c.cell.scopes['sales']!] }] },
    }, c.cell.as(c.editor));
    assert.deepEqual([await opens(engineer), await opens(seller), await opens(c.member)], [second.version, 1, second.version],
      'platform sits below engineering, the first stage; sales waits; the owner always opens the newest');
    const [release] = (await c.gateway.call(listAppReleases, { params: { appId } }, c.cell.as(c.member))).releases;
    assert.deepEqual([release!.status, release!.fromVersion, release!.toVersion, release!.stages.map((s) => s.releasedAt !== null)], ['rolling_out', 1, second.version, [true, false]]);

    // One release at a time: another version waits for this one to finish.
    const third = await nextDraft(second.version, [1, 1, 4, 3]);
    await assert.rejects(c.gateway.call(approveVersion, { params: { appId, version: third.version }, body: { lockVersion: third.lockVersion } }, c.cell.as(c.editor)),
      { code: 'studio.release_in_progress' });
    await c.gateway.call(returnVersion, { params: { appId, version: third.version }, body: { lockVersion: third.lockVersion } }, c.cell.as(c.editor));
  });

  test('the next stage released completes it: everyone opens the new version', async () => {
    const [release] = (await c.gateway.call(listAppReleases, { params: { appId } }, c.cell.as(c.member))).releases;
    await assert.rejects(c.gateway.call(promoteAppRelease, { params: { appId, releaseId: release!.id }, body: { lockVersion: release!.lockVersion } }, c.cell.as(c.member)),
      { code: 'studio.not_permitted' });
    const done = await c.gateway.call(promoteAppRelease, { params: { appId, releaseId: release!.id }, body: { lockVersion: release!.lockVersion } }, c.cell.as(c.editor));
    assert.equal(done.status, 'complete');
    assert.deepEqual([await opens(engineer), await opens(seller)], [done.toVersion, done.toVersion]);
    assert.deepEqual((await c.events('app_release_stage_released')).map((e) => e.detail['ordinal']), [2]);
  });

  test('rolled back, everyone opens the version before again, the new one kept for its editors', async () => {
    const current = (await c.gateway.call(listAppReleases, { params: { appId } }, c.cell.as(c.member))).releases[0]!.toVersion;
    const next = await nextDraft(current, [1, 1, 12, 3]);
    await c.gateway.call(approveVersion, {
      params: { appId, version: next.version }, body: { lockVersion: next.lockVersion, stages: [{ scopeIds: [c.cell.scopes['sales']!] }, { scopeIds: [c.cell.scopes['engineering']!] }] },
    }, c.cell.as(c.editor));
    assert.deepEqual([await opens(seller), await opens(engineer)], [next.version, current]);
    const [release] = (await c.gateway.call(listAppReleases, { params: { appId } }, c.cell.as(c.member))).releases;
    const back = await c.gateway.call(rollBackAppRelease, { params: { appId, releaseId: release!.id }, body: { lockVersion: release!.lockVersion } }, c.cell.as(c.editor));
    assert.equal(back.status, 'rolled_back');
    assert.deepEqual([await opens(seller), await opens(engineer), await opens(c.member)], [current, current, next.version]);
    await assert.rejects(c.gateway.call(promoteAppRelease, { params: { appId, releaseId: release!.id }, body: { lockVersion: back.lockVersion } }, c.cell.as(c.editor)),
      { code: 'studio.release_closed' });
    assert.deepEqual((await c.events('app_release_rolled_back')).map((e) => e.detail['stages_released']), [1]);
    // The next release keeps everyone else on what they open now, never on the version rolled back.
    const fixed = await nextDraft(next.version, [1, 1, 8, 3]);
    await c.gateway.call(approveVersion, {
      params: { appId, version: fixed.version }, body: { lockVersion: fixed.lockVersion, stages: [{ scopeIds: [c.cell.scopes['sales']!] }] },
    }, c.cell.as(c.editor));
    const latest = (await c.gateway.call(listAppReleases, { params: { appId } }, c.cell.as(c.member))).releases[0]!;
    assert.deepEqual([latest.fromVersion, latest.toVersion, await opens(engineer), await opens(seller)], [current, fixed.version, current, fixed.version]);
    assert.equal((await c.events('app_release_started')).length, 3);
  });
});
