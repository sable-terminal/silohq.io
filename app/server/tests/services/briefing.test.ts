// Home's briefing, following and Cron sharing (spec 33.7, 40.8; decision 2026-11-17).
//
// - A Cron is private to its owner until shared, as saved views are: shared, the sharee reads
//   it and its runs and can never change it; the owner's sharing policy is checked whenever
//   access is resolved, and a revoked share ends access at once.
// - A person follows another's Cron, or another's saved object set, that they can see; never
//   their own (they follow it already) and never a set private to its owner. Following grants
//   nothing.
// - The briefing brings the runs of followed Crons and the new findings on followed sets
//   since the last visit, and the person's favourites; each section is read on its own, and
//   one whose source could not be read says so instead of looking empty.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { configureDetector, listDetectors, runDetectors } from '../../src/contracts/recognition/detector.contract.ts';
import {
  createCron, deleteCron, getCron, listCronRuns, listCrons, listCronShares, pauseCron, revokeCronShare, runCronNow, shareCron,
} from '../../src/contracts/scheduler/cron.contract.ts';
import { setOrganisationSharingPolicy, shareView } from '../../src/contracts/workspace/sharing.contract.ts';
import { addFavourite, followResource, listFollows, markHomeSeen, readBriefing, unfollowResource } from '../../src/contracts/workspace/shell.contract.ts';
import { saveView } from '../../src/contracts/workspace/view.contract.ts';
import { service as recognitionService } from '../../src/routes/recognition/index.route.ts';
import { createSchedulerService } from '../../src/routes/scheduler/index.route.ts';
import { createWorkspaceService } from '../../src/routes/workspace/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;
let mia: Signed;
let outlier = '';
let followedView = '';
let privateView = '';
let cronId = '';

const as = (who: Signed) => r.cell.as(who);
const keyed = (who: Signed) => ({ ...r.cell.as(who), idempotencyKey: uuidv7() });
const detect = () => r.gateway.call(runDetectors, { body: { objectTypeId: r.type('supplier').id, detectors: ['outlier'] } }, as(r.root));
const briefing = (who: Signed, since?: string) => r.gateway.call(readBriefing, { query: since === undefined ? {} : { since } }, as(who));
const events = async (event: string) => (await r.cell.migrate.query(
  `select payload from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at`, [r.cell.org, event])).rows
  .map((row) => row.payload as { detail: Record<string, unknown> });

async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runNow(id: string): Promise<void> {
  const before = (await r.gateway.call(listCronRuns, { params: { cronId: id }, query: {} }, as(r.root))).runs.length;
  await r.gateway.call(runCronNow, { params: { cronId: id } }, as(r.root));
  await until('the run', async () => {
    const runs = (await r.gateway.call(listCronRuns, { params: { cronId: id }, query: {} }, as(r.root))).runs;
    return runs.length > before && runs[0]!.status !== 'running' ? runs : undefined;
  });
}

before(async () => {
  r = await startRecognitionCell([
    { definition: recognitionService, name: 'recognition' },
    { definition: createSchedulerService(), name: 'scheduler', env: { SCHEDULER_TICK_MS: '150' } },
    // Last: it reads from the others. No approvals service runs here, so that section is unavailable.
    { definition: createWorkspaceService(), name: 'workspace' },
  ]);
  outlier = (await r.gateway.call(listDetectors, {}, as(r.root))).detectors.find((d) => d.key === 'outlier')!.id;
  await r.gateway.call(configureDetector, {
    params: { objectTypeId: r.type('supplier').id, detector: 'outlier' },
    body: { properties: [r.prop('supplier', 'rating')], timeField: null, enabled: true },
  }, as(r.root));
  mia = await r.cell.member('mia@acme.example', 'Member');
  const set = (name: string, visibility: 'shared' | 'private') => r.gateway.call(saveObjectSet, {
    body: { name, visibility, definition: { kind: 'filter', base: { objectTypeId: r.type('supplier').id }, predicate: { cel: 'true', properties: [] } } },
  }, keyed(r.root));
  const view = async (name: string, objectSetId: string) => {
    const saved = await r.gateway.call(saveView, { body: { kind: 'object_set', name, objectSetId } }, keyed(r.root));
    await r.gateway.call(shareView, { params: { viewId: saved.id }, body: { grantee: { kind: 'membership', membershipId: mia.membershipId }, access: 'view' } },
      as(r.root));
    return saved.id;
  };
  followedView = await view('Suppliers to watch', (await set('Every supplier', 'shared')).id);
  privateView = await view('Root\'s private suppliers', (await set('Private suppliers', 'private')).id);
  cronId = (await r.gateway.call(createCron, {
    body: {
      name: 'Outliers anywhere', trigger: { schedule: '0 6 * * *' },
      condition: { kind: 'finding', operator: 'raised', detectorId: outlier, objectTypeId: r.type('supplier').id }, actions: [{ kind: 'notify' }],
    } as never,
  }, keyed(r.root))).id;
});

after(async () => {
  await r?.close();
});

describe('sharing a Cron (spec 40.8)', () => {
  test('private until shared; shared, its history is read and it is never changed; policy and revocation end it', async () => {
    await assert.rejects(r.gateway.call(getCron, { params: { cronId } }, as(mia)), { code: 'scheduler.cron_not_found' });
    const share = await r.gateway.call(shareCron, { params: { cronId }, body: { grantee: { kind: 'membership', membershipId: mia.membershipId } } }, as(r.root));
    assert.deepEqual({ state: share.state, access: share.access, viewId: share.viewId }, { state: 'live', access: 'view', viewId: cronId });
    assert.equal((await r.gateway.call(getCron, { params: { cronId } }, as(mia))).id, cronId);
    assert.deepEqual((await r.gateway.call(listCrons, { query: { which: 'shared' } }, as(mia))).crons.map((c) => c.id), [cronId]);
    await r.gateway.call(listCronRuns, { params: { cronId }, query: {} }, as(mia));
    await assert.rejects(r.gateway.call(pauseCron, { params: { cronId } }, as(mia)), { code: 'scheduler.cron_not_found' }, 'visibility, never authorisation');
    await assert.rejects(r.gateway.call(listCronShares, { params: { cronId } }, as(mia)), { code: 'scheduler.cron_not_found' }, 'only the owner sees who it is shared with');
    assert.equal((await events('automation_shared'))[0]?.detail['change'], 'shared');

    // The owner's policy is checked whenever access is resolved: disabled, the share grants nothing, unrewritten.
    await r.gateway.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'disabled', orgWideSharingPermitted: false } }, as(r.root));
    try {
      await assert.rejects(r.gateway.call(getCron, { params: { cronId } }, as(mia)), { code: 'scheduler.cron_not_found' });
      assert.equal((await r.gateway.call(listCronShares, { params: { cronId } }, as(r.root))).shares[0]?.state, 'forbidden_by_policy');
      await assert.rejects(r.gateway.call(shareCron, { params: { cronId }, body: { grantee: { kind: 'organisation' } } }, as(r.root)),
        { code: 'scheduler.share_forbidden' });
    } finally {
      await r.gateway.call(setOrganisationSharingPolicy, { body: { viewSharingPolicy: 'open', orgWideSharingPermitted: true } }, as(r.root));
    }
    assert.equal((await r.gateway.call(getCron, { params: { cronId } }, as(mia))).id, cronId, 'open again');
  });
});

describe('following (decision 2026-11-17)', () => {
  test('another\'s Cron or saved object set the person can see; never their own, a private set, or what they cannot see', async () => {
    const cron = await r.gateway.call(followResource, { body: { resourceType: 'cron', resourceId: cronId } }, as(mia));
    assert.equal((await r.gateway.call(followResource, { body: { resourceType: 'cron', resourceId: cronId } }, as(mia))).id, cron.id, 'following again is the same follow');
    await r.gateway.call(followResource, { body: { resourceType: 'view', resourceId: followedView } }, as(mia));
    await assert.rejects(r.gateway.call(followResource, { body: { resourceType: 'view', resourceId: privateView } }, as(mia)),
      { code: 'workspace.follow_set_private' });
    await assert.rejects(r.gateway.call(followResource, { body: { resourceType: 'cron', resourceId: cronId } }, as(r.root)), { code: 'workspace.follow_own' });
    await assert.rejects(r.gateway.call(followResource, { body: { resourceType: 'cron', resourceId: uuidv7() } }, as(mia)),
      { code: 'workspace.follow_target_not_found' });
    const follows = (await r.gateway.call(listFollows, {}, as(mia))).follows;
    assert.deepEqual(follows.map((f) => f.resourceType).sort(), ['cron', 'view']);
    await assert.rejects(r.gateway.call(unfollowResource, { params: { followId: cron.id } }, as(r.root)), { code: 'workspace.follow_not_found' },
      'a follow is its person\'s own');
  });
});

describe('the briefing (spec 33.7)', () => {
  test('runs of followed Crons, new findings on followed sets and favourites, each section on its own', async () => {
    const first = await briefing(mia);
    assert.equal(first.since, null, 'before a first visit: the last seven days');
    assert.deepEqual([first.crons, first.findings, first.clones, first.apps, first.dashboard].map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.equal(first.approvals.status, 'unavailable', 'its source does not run here: said, never shown empty');
    assert.match(first.approvals.status === 'unavailable' ? first.approvals.reason : '', /did not answer/);

    await detect();
    await runNow(cronId);
    const read = await briefing(mia);
    assert.ok(read.crons.status === 'ok' && read.findings.status === 'ok' && read.clones.status === 'ok');
    const [run] = read.crons.items;
    assert.deepEqual({ cron: run?.cronName, owned: run?.owned, outcome: run?.conditionOutcome }, { cron: 'Outliers anywhere', owned: false, outcome: 'met' });
    const [finding] = read.findings.items;
    assert.equal(finding?.detector, 'outlier');
    assert.equal(finding?.objectTypeName, r.type('supplier').displayName);
    assert.deepEqual(finding?.sets, [{ viewId: followedView, name: 'Suppliers to watch' }], 'the followed set, not the private one');
    assert.ok(finding!.objectCount > 0);

    // A favourited object, by reference and type.
    await r.gateway.call(addFavourite, { body: { target: { kind: 'object', objectTypeId: r.type('supplier').id, objectRef: uuidv7() } } }, as(mia));
    const favourited = await briefing(mia);
    assert.ok(favourited.clones.status === 'ok');
    assert.equal(favourited.clones.items[0]?.objectTypeName, r.type('supplier').displayName);

    // Marked seen: the next briefing starts after it; a tab that kept the earlier marker still sees what it showed.
    const seen = await r.gateway.call(markHomeSeen, {}, as(mia));
    const after = await briefing(mia);
    assert.equal(after.since, seen.seenAt);
    assert.ok(after.crons.status === 'ok' && after.crons.items.length === 0 && after.findings.status === 'ok' && after.findings.items.length === 0);
    const kept = await briefing(mia, new Date(Date.now() - 3_600_000).toISOString());
    assert.ok(kept.crons.status === 'ok' && kept.crons.items.length === 1);

    // The share revoked: the follow stays, but the Cron's runs are no longer the person's to see.
    const [share] = (await r.gateway.call(listCronShares, { params: { cronId } }, as(r.root))).shares;
    await r.gateway.call(revokeCronShare, { params: { cronId, shareId: share!.id } }, as(r.root));
    const revoked = await briefing(mia, new Date(Date.now() - 3_600_000).toISOString());
    assert.ok(revoked.crons.status === 'ok' && revoked.crons.items.length === 0);
    assert.equal((await r.gateway.call(listFollows, {}, as(mia))).follows.filter((f) => f.resourceType === 'cron').length, 1);
  });

  test('a deleted Cron ends the follows of it', async () => {
    await r.gateway.call(deleteCron, { params: { cronId } }, as(r.root));
    assert.deepEqual((await r.gateway.call(listFollows, {}, as(mia))).follows.map((f) => f.resourceType), ['view']);
  });
});
