// studio end to end (spec 35): an app from a template, drafts saved with their findings and
// refused review until clean, review by someone other than the author, publication with
// lineage, opening under the viewer's own access (a withheld field reduces the app and is
// audited), sharing within the policy (edit to named members only), a return and a new
// draft, rollback through review, publication to a scope reaching its subtree, copying, and
// archive. Real processes: credential, policy, auth, connect-registry, ontology, studio.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  approveVersion, archiveApp, copyApp, createApp, getApp, listApps, listTemplates, openApp, publishToScope, returnVersion, rollbackApp,
  saveDraft, shareApp, submitForReview, withdrawPublication, listPublications,
} from '../../src/contracts/studio/app.contract.ts';
import { createObjectViewLayout, getObjectViewLayout, listObjectViewLayouts } from '../../src/contracts/studio/layout.contract.ts';
import { listNotifications } from '../../src/contracts/notify/notification.contract.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import { service as studioService } from '../../src/routes/studio/index.route.ts';
import { listInheritedApps, reviewInheritedApp, transferApps } from '../../src/contracts/studio/transfer.contract.ts';
import { maintenanceRepo } from '../../src/repos/platform/maintenance.repo.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { startCloneCell, type CloneCell } from './clone.helper.ts';

let c: CloneCell;
let appId: string;
let platformMember: Signed;

before(async () => {
  c = await startCloneCell([
    { definition: createNotifyService(), name: 'notify', env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/' } },
    { definition: studioService, name: 'studio' },
  ]);
  platformMember = await c.cell.member('platform@acme.example', 'Member', 'platform');
});

after(async () => {
  await c?.close();
});

const version = async (v: number) => (await c.gateway.call(getApp, { params: { appId } }, c.cell.as(c.member))).versions.find((x) => x.version === v)!;

describe('building and review (spec 35.7, 35.9)', () => {
  test('templates are structural; an app from one is a draft owned by its maker, valid as instantiated', async () => {
    const templates = await c.gateway.call(listTemplates, {}, c.cell.as(c.member));
    assert.deepEqual(templates.templates.map((t) => t.name), ['inbox_detail', 'triage_queue', 'monitor', 'map_list', 'scenario_workbench']);
    const created = await c.gateway.call(createApp, {
      body: { name: 'Pump monitor', template: { name: 'monitor', bindings: { objectTypeId: c.pump.id, measurePropertyId: c.prop('pressure') } } },
    }, c.keyed(c.member));
    appId = created.app.id;
    assert.deepEqual([created.app.access, created.app.visibility, created.draft.state, created.draft.version], ['owner', 'private', 'draft', 1]);
    assert.deepEqual(created.draft.findings, []);
    assert.equal(created.draft.ontologyVersion, c.manifest.version.sequence);
  });

  test('an invalid draft saves with its findings and cannot be submitted; fixed, it goes to review', async () => {
    const draft = await version(1);
    const full = (await c.gateway.call(saveDraft, { params: { appId }, body: { definition: {}, lockVersion: draft.lockVersion } }, c.cell.as(c.member)));
    assert.ok(full.findings.length > 0, 'an empty document is saved, with what is wrong with it');
    const bad = await c.gateway.call(saveDraft, {
      params: { appId },
      body: {
        definition: {
          schemaVersion: '1', ontologyVersion: c.manifest.version.sequence,
          variables: { pumps: { kind: 'objectSet', objectTypeId: c.pump.id } },
          pages: [{ id: 'home', title: 'Pumps', widgets: [
            { id: 'table', kind: 'objectTable', source: 'pumps', columns: [c.prop('name'), c.site.properties[0]!.identityId], grid: [1, 1, 12, 6] },
          ] }],
        },
        lockVersion: full.lockVersion,
      },
    }, c.cell.as(c.member));
    assert.deepEqual(bad.findings.map((f) => f.code), ['property_unknown']);
    await assert.rejects(c.gateway.call(submitForReview, { params: { appId, version: 1 }, body: { lockVersion: bad.lockVersion } }, c.cell.as(c.member)),
      { code: 'studio.draft_invalid' });
    const afterRefusal = await version(1);
    const fixed = await c.gateway.call(saveDraft, {
      params: { appId },
      body: {
        definition: {
          schemaVersion: '1', ontologyVersion: c.manifest.version.sequence,
          variables: { pumps: { kind: 'objectSet', objectTypeId: c.pump.id } },
          pages: [{ id: 'home', title: 'Pumps', widgets: [
            { id: 'table', kind: 'objectTable', source: 'pumps', columns: [c.prop('name'), c.prop('status_code'), c.prop('pressure')], grid: [1, 1, 12, 6] },
            { id: 'peak', kind: 'metric', source: 'pumps', aggregate: 'max', property: c.prop('pressure'), grid: [1, 7, 3, 2] },
            { id: 'count', kind: 'metric', source: 'pumps', aggregate: 'count', grid: [4, 7, 3, 2] },
          ] }],
        },
        lockVersion: afterRefusal.lockVersion,
      },
    }, c.cell.as(c.member));
    assert.deepEqual(fixed.findings, []);
    const review = await c.gateway.call(submitForReview, { params: { appId, version: 1 }, body: { lockVersion: fixed.lockVersion } }, c.cell.as(c.member));
    assert.equal(review.state, 'review');
    await assert.rejects(c.gateway.call(saveDraft, { params: { appId }, body: { definition: {} } }, c.cell.as(c.member)), { code: 'studio.version_in_review' });
    const { rows } = await inTx(c.cell.app, { orgId: c.cell.org }, () => c.cell.app.query(
      `select count(*) filter (where property_id is not null)::int as properties, count(*) filter (where object_type_id is not null)::int as types
       from workspace.app_references where app_version_id = $1`, [review.id]));
    assert.deepEqual(rows[0], { properties: 3, types: 1 });
  });

  test('the author never reviews their own version; a holder of app.publish approves, and the version is published with its lineage', async () => {
    const review = await version(1);
    await assert.rejects(c.gateway.call(approveVersion, { params: { appId, version: 1 }, body: { lockVersion: review.lockVersion } }, c.cell.as(c.member)),
      { code: 'studio.not_permitted' });
    const published = await c.gateway.call(approveVersion, { params: { appId, version: 1 }, body: { lockVersion: review.lockVersion } }, c.cell.as(c.editor));
    assert.deepEqual([published.state, published.reviewedBy], ['published', c.editor.membershipId]);
    const app = await c.gateway.call(getApp, { params: { appId } }, c.cell.as(c.member));
    assert.equal(app.app.currentVersionId, published.id);
    const { rows } = await inTx(c.cell.app, { orgId: c.cell.org }, () => c.cell.app.query(
      `select src.kind from gov.lineage_edges e join gov.lineage_nodes n on n.id = e.to_node_id join gov.lineage_nodes src on src.id = e.from_node_id
       where n.kind = 'app_version' and n.ref_id = $1 and n.version = $2`, [appId, published.id]));
    assert.deepEqual(rows.map((r) => r.kind), ['object_type_version']);
    const audited = await c.events('app_version_published');
    assert.deepEqual([audited[0]!.detail['author'], audited[0]!.detail['reviewer']], [c.member.membershipId, c.editor.membershipId]);
  });
});

describe('opening under the viewer\'s own access (spec 35.6)', () => {
  test('its owner opens the published version in full; someone it is not shared with gets not found', async () => {
    const opened = await c.gateway.call(openApp, { params: { appId }, query: {} }, c.cell.as(c.member));
    assert.deepEqual(opened.widgets.map((w) => w.status), ['available', 'available', 'available']);
    assert.equal(opened.statement, null);
    const recorded = (await c.events('app_opened')).at(-1)!;
    assert.deepEqual([recorded.detail['version'], recorded.detail['published'], recorded.detail['reduced']], [1, true, false], 'every open audited: who opened which version');
    await assert.rejects(c.gateway.call(openApp, { params: { appId }, query: {} }, c.cell.as(c.outsider)), { code: 'studio.app_not_found' });
  });

  test('shared, it opens for the recipient with a withheld field dropped, a widget that needs it unavailable, and the reduced open audited', async () => {
    await assert.rejects(c.gateway.call(shareApp, {
      params: { appId }, body: { grantee: { kind: 'scope', scopeId: c.cell.scopes['sales']! }, access: 'edit' },
    }, c.cell.as(c.member)), { code: 'studio.edit_to_member_only' });
    const share = await c.gateway.call(shareApp, {
      params: { appId }, body: { grantee: { kind: 'membership', membershipId: c.outsider.membershipId }, access: 'view' },
    }, c.cell.as(c.member));
    assert.equal(share.state, 'live');
    await c.cell.migrate.query(
      `insert into iam.field_policies (id, organisation_id, property_id, effect, applies_to_role_id, created_by) values ($1, $2, $3, 'deny', $4, $5)`,
      [uuidv7(), c.cell.org, c.prop('pressure'), c.cell.roles['Member'], c.root.membershipId]);
    const opened = await c.gateway.call(openApp, { params: { appId }, query: {} }, c.cell.as(c.outsider));
    assert.equal(opened.app.access, 'view');
    const status = Object.fromEntries(opened.widgets.map((w) => [w.id, w.status]));
    assert.deepEqual(status, { table: 'reduced', peak: 'unavailable', count: 'available' });
    const table = (opened.definition['pages'] as { widgets: { id: string; columns?: string[] }[] }[])[0]!.widgets.find((w) => w.id === 'table')!;
    assert.deepEqual(table.columns, [c.prop('name'), c.prop('status_code')]);
    assert.equal(opened.withheld, 1);
    assert.ok(opened.statement);
    assert.equal((await c.events('app_opened_with_reduced_permissions')).length, 1);
    await assert.rejects(c.gateway.call(copyApp, { params: { appId }, body: { name: 'Mine' } }, c.keyed(c.outsider)), { code: 'studio.copy_not_shared' });
  });
});

describe('versions after the first (spec 35.7)', () => {
  test('a new draft after publication; a returned version stays returned and the author continues in a new one', async () => {
    const published = await version(1);
    const v2 = await c.gateway.call(saveDraft, {
      params: { appId },
      body: { definition: {
        schemaVersion: '1', ontologyVersion: c.manifest.version.sequence, variables: { pumps: { kind: 'objectSet', objectTypeId: c.pump.id } },
        pages: [{ id: 'home', title: 'Pumps v2', widgets: [{ id: 'count', kind: 'metric', source: 'pumps', aggregate: 'count', grid: [1, 1, 3, 2] }] }],
      } },
    }, c.cell.as(c.member));
    assert.deepEqual([v2.version, v2.state], [2, 'draft']);
    const inReview = await c.gateway.call(submitForReview, { params: { appId, version: 2 }, body: { lockVersion: v2.lockVersion } }, c.cell.as(c.member));
    const returned = await c.gateway.call(returnVersion, { params: { appId, version: 2 }, body: { lockVersion: inReview.lockVersion } }, c.cell.as(c.editor));
    assert.equal(returned.state, 'returned');
    const v3 = await c.gateway.call(saveDraft, { params: { appId }, body: { definition: v2.definition } }, c.cell.as(c.member));
    assert.deepEqual([v3.version, v3.state], [3, 'draft']);
    assert.equal((await version(1)).state, 'published', 'the published version is untouched');
    assert.equal(published.state, 'published');
  });

  test('rollback puts an earlier definition up for review as a new version, by someone other than its reviewer', async () => {
    const v3 = await version(3);
    // The open draft goes to review and is returned first: one version in progress at a time.
    const inReview = await c.gateway.call(submitForReview, { params: { appId, version: 3 }, body: { lockVersion: v3.lockVersion } }, c.cell.as(c.member));
    await c.gateway.call(returnVersion, { params: { appId, version: 3 }, body: { lockVersion: inReview.lockVersion } }, c.cell.as(c.editor));
    // Root may roll back an app only if they hold it: the owner shares edit with them.
    await assert.rejects(c.gateway.call(rollbackApp, { params: { appId }, body: { toVersion: 1 } }, c.cell.as(c.root)), { code: 'studio.app_not_found' });
    await c.gateway.call(shareApp, { params: { appId }, body: { grantee: { kind: 'membership', membershipId: c.root.membershipId }, access: 'edit' } },
      c.cell.as(c.member));
    await assert.rejects(c.gateway.call(rollbackApp, { params: { appId }, body: { toVersion: 3 } }, c.cell.as(c.root)), { code: 'studio.rollback_source' });
    const rolled = await c.gateway.call(rollbackApp, { params: { appId }, body: { toVersion: 1 } }, c.cell.as(c.root));
    assert.deepEqual([rolled.version, rolled.state, rolled.rolledBackFromVersion, rolled.authoredBy], [4, 'review', 1, c.root.membershipId]);
    await assert.rejects(c.gateway.call(approveVersion, { params: { appId, version: 4 }, body: { lockVersion: rolled.lockVersion } }, c.cell.as(c.root)),
      { code: 'studio.author_cannot_review' });
    const published = await c.gateway.call(approveVersion, { params: { appId, version: 4 }, body: { lockVersion: rolled.lockVersion } }, c.cell.as(c.editor));
    assert.equal(published.state, 'published');
    assert.equal((await version(1)).state, 'superseded');
  });
});

describe('publication, copying and archive (spec 35.8)', () => {
  test('published to a scope, the app reaches members in that subtree and its directory lists it', async () => {
    await assert.rejects(c.gateway.call(publishToScope, { params: { appId }, body: { scopeId: c.cell.scopes['engineering']! } }, c.cell.as(c.member)),
      { code: 'studio.not_permitted' });
    // The organisation's policy starts at explicit_only, under which scope publication is refused (35.8).
    await assert.rejects(c.gateway.call(publishToScope, { params: { appId }, body: { scopeId: c.cell.scopes['engineering']! } }, c.cell.as(c.root)),
      { code: 'studio.publication_forbidden' });
    await c.cell.migrate.query(`update iam.organisations set view_sharing_policy = 'open' where id = $1`, [c.cell.org]);
    const publication = await c.gateway.call(publishToScope, { params: { appId }, body: { scopeId: c.cell.scopes['engineering']!, mobileEnabled: true } },
      c.cell.as(c.root));
    const directory = await c.gateway.call(listApps, { query: { filter: 'published' } }, c.cell.as(platformMember));
    assert.deepEqual(directory.apps.map((a) => [a.id, a.access, a.visibility]), [[appId, 'published', 'published']]);
    const opened = await c.gateway.call(openApp, { params: { appId }, query: {} }, c.cell.as(platformMember));
    assert.equal(opened.version.version, 4);
    // The owner sees every live publication; the publisher sees the one they may withdraw; a viewer through it, none.
    assert.deepEqual((await c.gateway.call(listPublications, { params: { appId } }, c.cell.as(c.member))).publications.map((p) => [p.id, p.scopeId, p.mobileEnabled]),
      [[publication.id, c.cell.scopes['engineering']!, true]]);
    assert.deepEqual((await c.gateway.call(listPublications, { params: { appId } }, c.cell.as(c.root))).publications.map((p) => p.id), [publication.id]);
    assert.deepEqual((await c.gateway.call(listPublications, { params: { appId } }, c.cell.as(platformMember))).publications, []);
    await c.gateway.call(withdrawPublication, { params: { appId, publicationId: publication.id } }, c.cell.as(c.root));
    assert.deepEqual((await c.gateway.call(listPublications, { params: { appId } }, c.cell.as(c.member))).publications, []);
    await assert.rejects(c.gateway.call(openApp, { params: { appId }, query: {} }, c.cell.as(platformMember)), { code: 'studio.app_not_found' });
  });

  test('copy access duplicates the published version into a draft its new owner holds', async () => {
    await c.gateway.call(shareApp, { params: { appId }, body: { grantee: { kind: 'membership', membershipId: c.outsider.membershipId }, access: 'copy' } },
      c.cell.as(c.member));
    const copied = await c.gateway.call(copyApp, { params: { appId }, body: { name: 'My monitor' } }, c.keyed(c.outsider));
    assert.deepEqual([copied.app.ownerMembershipId, copied.app.access, copied.draft.version, copied.draft.state], [c.outsider.membershipId, 'owner', 1, 'draft']);
    const created = await c.events('app_created');
    assert.equal(created.at(-1)!.detail['copied_from'], appId);
  });

  test('archived, it opens for no one and its shares end', async () => {
    await assert.rejects(c.gateway.call(archiveApp, { params: { appId } }, c.cell.as(c.outsider)), { code: 'studio.not_permitted' });
    const archived = await c.gateway.call(archiveApp, { params: { appId } }, c.cell.as(c.member));
    assert.ok(archived.archivedAt);
    await assert.rejects(c.gateway.call(openApp, { params: { appId }, query: {} }, c.cell.as(c.member)), { code: 'studio.app_not_found' });
    await assert.rejects(c.gateway.call(openApp, { params: { appId }, query: {} }, c.cell.as(c.outsider)), { code: 'studio.app_not_found' });
    assert.equal((await c.events('app_archived'))[0]!.detail['shares_revoked'], 2);
  });
});

describe('object view layouts (spec 34.6)', () => {
  const layout = (who = c.member) => c.gateway.call(getObjectViewLayout, { params: { objectTypeId: c.pump.id } }, c.cell.as(who));
  let layoutAppId = '';

  test('every type has a generated default: the primary first, a link group per link, then the fixed sections', async () => {
    const generated = await layout();
    assert.equal(generated.generated, true);
    assert.equal(generated.layout!.properties[0], c.pump.primaryKeyPropertyIdentityId ?? c.pump.titlePropertyIdentityId);
    assert.equal(generated.layout!.properties.length, c.pump.properties.filter((p) => p.status === 'active').length);
    assert.deepEqual(generated.layout!.linkGroups, [{ linkTypeId: c.linkTypeId, direction: 'incoming' }]);
    assert.deepEqual(generated.layout!.sections, ['timeline', 'actions', 'findings', 'scenarios', 'ask']);
  });

  test('a custom layout is a single page bound to the object; reviewed and approved, it is the type\'s, and a later one supersedes it', async () => {
    const created = await c.gateway.call(createObjectViewLayout, { body: { objectTypeId: c.pump.id } }, c.keyed(c.member));
    layoutAppId = created.app.id;
    assert.deepEqual([created.app.kind, created.draft.findings], ['object_view_layout', []]);
    const definition = created.draft.definition;
    const twoPages = await c.gateway.call(saveDraft, { params: { appId: layoutAppId }, body: {
      definition: { ...definition, pages: [...(definition['pages'] as never[]), { id: 'more', title: 'More', widgets: [] }] } as never, lockVersion: created.draft.lockVersion,
    } }, c.cell.as(c.member));
    assert.deepEqual(twoPages.findings.map((f) => f.code), ['layout.single_page']);
    const fixed = await c.gateway.call(saveDraft, { params: { appId: layoutAppId }, body: { definition, lockVersion: twoPages.lockVersion } }, c.cell.as(c.member));
    const review = await c.gateway.call(submitForReview, { params: { appId: layoutAppId, version: 1 }, body: { lockVersion: fixed.lockVersion } }, c.cell.as(c.member));
    await c.gateway.call(approveVersion, { params: { appId: layoutAppId, version: 1 }, body: { lockVersion: review.lockVersion } }, c.cell.as(c.editor));
    const custom = await layout();
    assert.deepEqual([custom.generated, custom.custom?.appId, custom.custom?.version], [false, layoutAppId, 1]);
    const listed = (await c.gateway.call(listObjectViewLayouts, {}, c.cell.as(c.editor))).layouts;
    assert.deepEqual(listed.map((l) => [l.objectTypeId, l.appId, l.version, l.status]), [[c.pump.id, layoutAppId, 1, 'active']]);
    assert.equal((await c.events('object_view_layout_published')).length, 1);

    const second = await c.gateway.call(createObjectViewLayout, { body: { objectTypeId: c.pump.id, name: 'Pump, compact' } }, c.keyed(c.member));
    const secondReview = await c.gateway.call(submitForReview, { params: { appId: second.app.id, version: 1 }, body: { lockVersion: second.draft.lockVersion } }, c.cell.as(c.member));
    await c.gateway.call(approveVersion, { params: { appId: second.app.id, version: 1 }, body: { lockVersion: secondReview.lockVersion } }, c.cell.as(c.editor));
    assert.equal((await layout()).custom?.appId, second.app.id);
    const { rows } = await inTx(c.cell.app, { orgId: c.cell.org }, () => c.cell.app.query(
      'select status from workspace.object_view_layouts where object_type_id = $1 order by created_at', [c.pump.id]));
    assert.deepEqual(rows.map((r) => r.status), ['superseded', 'active']);
    await c.gateway.call(archiveApp, { params: { appId: second.app.id } }, c.cell.as(c.member));
    assert.equal((await layout()).generated, true, 'archived, the generated default returns');
    await c.gateway.call(createApp, { body: { name: 'x', generatedBy: 'ai_fde' } }, c.keyed(c.member)).then(
      () => assert.fail('a person cannot mark an app as generated'), (error: { code?: string }) => assert.equal(error.code, 'studio.generated_by_fde_only'));
  });

  test('one an ontology change breaks is marked invalid on read, its author told, and the generated default used', async () => {
    const created = await c.gateway.call(createObjectViewLayout, { body: { objectTypeId: c.pump.id } }, c.keyed(c.member));
    const review = await c.gateway.call(submitForReview, { params: { appId: created.app.id, version: 1 }, body: { lockVersion: created.draft.lockVersion } }, c.cell.as(c.member));
    await c.gateway.call(approveVersion, { params: { appId: created.app.id, version: 1 }, body: { lockVersion: review.lockVersion } }, c.cell.as(c.editor));
    // As if main had moved on and dropped a property the layout shows: checked against an older version, it names one main lacks.
    // A published definition is frozen: the change is made with triggers off, as the migration role may.
    await c.cell.migrate.query('begin');
    await c.cell.migrate.query('set local session_replication_role = replica');
    await c.cell.migrate.query(`update workspace.app_versions set definition = jsonb_set(definition, '{pages,0,widgets,0,properties}', $2::jsonb)
      where app_id = $1`, [created.app.id, JSON.stringify([uuidv7()])]);
    await c.cell.migrate.query('commit');
    await c.cell.migrate.query(`update workspace.object_view_layouts set ontology_version = 0 where status = 'active' and object_type_id = $1`, [c.pump.id]);
    const read = await layout(c.editor);
    assert.equal(read.generated, true, 'a broken layout never renders partially');
    const { rows } = await inTx(c.cell.app, { orgId: c.cell.org }, () => c.cell.app.query(
      'select status from workspace.object_view_layouts where app_version_id in (select id from workspace.app_versions where app_id = $1)', [created.app.id]));
    assert.deepEqual(rows.map((r) => r.status), ['invalid']);
    const invalidated = await c.events('object_view_layout_invalidated');
    assert.equal(invalidated.length, 1);
    // Listed as broken until another is approved for the type, so its author can find it from the notification.
    const broken = (await c.gateway.call(listObjectViewLayouts, {}, c.cell.as(c.member))).layouts;
    assert.deepEqual(broken.map((l) => [l.appId, l.status]), [[created.app.id, 'invalid']]);
    assert.equal(broken[0]!.id, invalidated[0]!.resource?.id);
    const told = (await c.gateway.call(listNotifications, { query: {} }, c.cell.as(c.member))).notifications;
    assert.ok(told.some((n) => n.kind === 'object_view_layout_invalidated'), 'the author is told');
  });

  test('an app an ontology change breaks opens with those widgets unavailable, and the invalidation is audited once per ontology version (35.13)', async () => {
    const created = await c.gateway.call(createApp, {
      body: { name: 'Pump watch', template: { name: 'monitor', bindings: { objectTypeId: c.pump.id, measurePropertyId: c.prop('pressure') } } },
    }, c.keyed(c.member));
    const review = await c.gateway.call(submitForReview, { params: { appId: created.app.id, version: 1 }, body: { lockVersion: created.draft.lockVersion } }, c.cell.as(c.member));
    await c.gateway.call(approveVersion, { params: { appId: created.app.id, version: 1 }, body: { lockVersion: review.lockVersion } }, c.cell.as(c.editor));
    // As if built on an older ontology that had a property main has since dropped (made with triggers off, as the migration role may).
    await c.cell.migrate.query('begin');
    await c.cell.migrate.query('set local session_replication_role = replica');
    const older = c.manifest.version.sequence - 1;
    assert.ok(older >= 1, 'main has moved past an earlier version');
    await c.cell.migrate.query(`update workspace.app_versions set definition = jsonb_set(jsonb_set(definition, '{ontologyVersion}', $3::jsonb),
      '{pages,0,widgets,1,property}', $2::jsonb) where app_id = $1`, [created.app.id, JSON.stringify(uuidv7()), JSON.stringify(older)]);
    await c.cell.migrate.query('commit');
    const opened = await c.gateway.call(openApp, { params: { appId: created.app.id }, query: {} }, c.cell.as(c.member));
    assert.ok(opened.widgets.some((w) => w.status === 'unavailable' && /^unavailable since ontology version/.test(w.reason ?? '')), JSON.stringify(opened.widgets));
    await c.gateway.call(openApp, { params: { appId: created.app.id }, query: {} }, c.cell.as(c.member));
    const invalidated = (await c.events('app_invalidated_by_ontology_change')).filter((e) => e.detail['built_on'] === older);
    assert.equal(invalidated.length, 1, 'once, however often it is opened');
    assert.deepEqual([invalidated[0]!.detail['version'], invalidated[0]!.detail['built_on'], invalidated[0]!.detail['ontology_version']],
      [1, c.manifest.version.sequence - 1, c.manifest.version.sequence]);
  });
});

describe('apps of a removed member, and expired shares (spec 37.7)', () => {
  test('a removed member\'s apps go to the admin above, flagged, shares suspended; the admin shares onward', async () => {
    const leaver = await c.cell.member('leaver@acme.example', 'Member', 'platform');
    const created = await c.gateway.call(createApp, { body: { name: 'Leaver app' } }, c.keyed(leaver));
    await c.gateway.call(shareApp, {
      params: { appId: created.app.id }, body: { grantee: { kind: 'membership', membershipId: platformMember.membershipId }, access: 'view' },
    }, c.cell.as(leaver));
    await assert.rejects(c.gateway.call(transferApps, { body: { membershipId: leaver.membershipId, reason: 'member_removed' } }, c.cell.as(c.root)),
      { code: 'caller.not_listed' }, 'only policy hands apps over');
    const result = await c.cell.client('policy').call(transferApps, { body: { membershipId: leaver.membershipId, reason: 'member_removed' } }, c.cell.as(c.root));
    assert.deepEqual([result.appsTransferred, result.sharesSuspended], [1, 1]);
    const receiver = [c.root, c.member, c.outsider, platformMember].find((s) => s.membershipId === result.receivingMembershipId)!;
    assert.ok(receiver !== undefined, 'an admin above the member receives them');
    const queue = await c.gateway.call(listInheritedApps, {}, c.cell.as(receiver));
    const flag = queue.inherited.find((f) => f.appId === created.app.id)!;
    assert.deepEqual([flag.name, flag.transferredFrom, flag.reason], ['Leaver app', leaver.membershipId, 'member_removed']);
    const reviewed = await c.gateway.call(reviewInheritedApp, { params: { flagId: flag.flagId }, body: { decision: 'shared' } }, c.cell.as(receiver));
    assert.deepEqual([reviewed.decision, reviewed.sharesResumed], ['shared', 1]);
    await assert.rejects(c.gateway.call(reviewInheritedApp, { params: { flagId: flag.flagId }, body: { decision: 'retained' } }, c.cell.as(receiver)),
      { code: 'studio.transfer_reviewed' });
    const events = await c.cell.migrate.query(`select payload->>'event' as event from platform.outbox where organisation_id = $1 and payload->>'event' in ('app_transferred', 'app_transfer_reviewed') order by created_at`, [c.cell.org]);
    assert.deepEqual(events.rows.map((r) => r.event), ['app_transferred', 'app_transfer_reviewed']);
  });

  test('an app share past its expiry is ended at it by maintenance', async () => {
    const created = await c.gateway.call(createApp, { body: { name: 'Short share' } }, c.keyed(c.member));
    const share = await c.gateway.call(shareApp, {
      params: { appId: created.app.id }, body: { grantee: { kind: 'membership', membershipId: platformMember.membershipId }, access: 'view' },
    }, c.cell.as(c.member));
    await c.cell.migrate.query(`update workspace.app_shares set expires_at = now() - interval '1 minute' where id = $1`, [share.id]);
    const expired = await maintenanceRepo.expireAppShares(c.cell.migrate, 100);
    assert.deepEqual(expired.map((e) => e.id), [share.id]);
    const { rows } = await c.cell.migrate.query('select revoked_at = expires_at as at_expiry from workspace.app_shares where id = $1', [share.id]);
    assert.equal(rows[0].at_expiry, true);
  });
});
