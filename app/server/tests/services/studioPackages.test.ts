// App packages (D231): a published version exported into Files as a package naming every
// ontology element it uses by API name, carrying the version's markings; imported as if from
// another organisation (every id in it foreign), each element found here by its name and its id
// put in place, so the app is the same app; an element this ontology lacks named, and the draft's
// findings saying what it breaks; imported as main's next draft of an existing app. Real
// processes: studio, actions and files over the clone cell.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { downloadFile } from '../../src/contracts/files/file.contract.ts';
import {
  approveVersion, createApp, exportAppPackage, getAppVersion, importAppPackage, submitForReview, type AppPackage,
} from '../../src/contracts/studio/app.contract.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { createFilesService } from '../../src/routes/files/index.route.ts';
import { service as studioService } from '../../src/routes/studio/index.route.ts';
import { referencesOf, remap } from '../../src/services/studio/appPackage.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { startCloneCell, type CloneCell } from './clone.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';

let c: CloneCell;
let appId: string;
let pkg: AppPackage;

before(async () => {
  c = await startCloneCell([
    { definition: createActionsService({ sweep: false }), name: 'actions' },
    { definition: createFilesService({ store: createMemoryStore() }), name: 'files', env: { OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true' } },
    { definition: studioService, name: 'studio' },
  ]);
});

after(async () => {
  await c?.close();
});

/** The package as another organisation would hold it: every element id replaced by one foreign here. */
function foreign(p: AppPackage): AppPackage {
  let text = JSON.stringify(p);
  for (const r of p.references) text = text.split(r.id).join(uuidv7());
  return JSON.parse(text) as AppPackage;
}

describe('app packages (D231)', () => {
  test('the mapping: every element by API name, a property with its type; ids put in place in one pass; one not found named', () => {
    const v = {
      objectTypes: [{ id: '00000000-0000-4000-8000-000000000001', apiName: 'pump', properties: [{ identityId: '00000000-0000-4000-8000-000000000002', apiName: 'pressure' }] }],
      linkTypes: [], functions: [], sharedProperties: [], actionTypes: [],
    };
    const def = { variables: { pumps: { kind: 'objectSet', objectTypeId: v.objectTypes[0]!.id } }, pages: [{ id: 'p', title: 'T', widgets: [{ id: 'w', kind: 'markdown', text: `{{label:${v.objectTypes[0]!.id}}}` }] }], other: '00000000-0000-4000-8000-0000000000ff' };
    const { references, unresolved } = referencesOf(def, v);
    assert.deepEqual(references, [{ id: v.objectTypes[0]!.id, kind: 'object_type', apiName: 'pump' }]);
    assert.deepEqual(unresolved, ['00000000-0000-4000-8000-0000000000ff']);
    const there = { ...v, objectTypes: [{ ...v.objectTypes[0]!, id: '00000000-0000-4000-8000-0000000000aa' }] };
    const out = remap(def, [...references, { id: '00000000-0000-4000-8000-000000000003', kind: 'property', apiName: 'flow', objectType: 'pump' }], there);
    assert.equal(JSON.stringify(out.definition).includes('0000000000aa'), true);
    assert.equal(JSON.stringify(out.definition).includes('000000000001'), false, 'in text too: a label names the type by id');
    assert.deepEqual([out.mapped, out.unmapped], [1, [{ kind: 'property', apiName: 'flow', objectType: 'pump' }]]);
  });

  test('a published version exported into Files names each element it uses; a draft is not packaged', async () => {
    const created = await c.gateway.call(createApp, {
      body: { name: 'Pump monitor', template: { name: 'monitor', bindings: { objectTypeId: c.pump.id, measurePropertyId: c.prop('pressure') } } },
    }, c.keyed(c.member));
    appId = created.app.id;
    await assert.rejects(c.gateway.call(exportAppPackage, { params: { appId }, body: { version: 1 } }, c.keyed(c.member)), { code: 'studio.package_needs_published' });
    const review = await c.gateway.call(submitForReview, { params: { appId, version: 1 }, body: { lockVersion: created.draft.lockVersion } }, c.cell.as(c.member));
    await c.gateway.call(approveVersion, { params: { appId, version: 1 }, body: { lockVersion: review.lockVersion } }, c.cell.as(c.editor));
    const exported = await c.gateway.call(exportAppPackage, { params: { appId }, body: {} }, c.keyed(c.member));
    assert.deepEqual([exported.file.contentType, exported.file.name, exported.file.provenance?.sourceKind, exported.unresolved], ['application/json', 'Pump monitor.silo-app.json', 'app_package', 0]);
    pkg = JSON.parse(Buffer.from((await c.gateway.call(downloadFile, { params: { fileId: exported.file.id } }, c.cell.as(c.member))).content, 'base64').toString()) as AppPackage;
    assert.deepEqual([pkg.format, pkg.sourceVersion, pkg.markings], ['silo.app-package', 1, []]);
    assert.ok(pkg.references.some((r) => r.kind === 'object_type' && r.apiName === 'pump'));
    assert.ok(pkg.references.some((r) => r.kind === 'property' && r.apiName === 'pressure' && r.objectType === 'pump'));
    assert.equal(exported.references, pkg.references.length);
  });

  test('imported from another organisation, every element found here by name: the same app, validating', async () => {
    const imported = await c.gateway.call(importAppPackage, { body: { package: foreign(pkg) as never, name: 'Pump monitor (imported)' } }, c.keyed(c.member));
    assert.deepEqual([imported.app.name, imported.draft.version, imported.mapped, imported.unmapped, imported.draft.findings], ['Pump monitor (imported)', 1, pkg.references.length, [], []]);
    const original = (await c.gateway.call(getAppVersion, { params: { appId, version: 1 } }, c.cell.as(c.member))).definition;
    assert.deepEqual({ ...imported.draft.definition, ontologyVersion: 0 }, { ...original, ontologyVersion: 0 });
    assert.deepEqual((await c.events('app_package_imported')).map((e) => [e.detail['mapped'], e.detail['unmapped']]), [[pkg.references.length, 0]]);
  });

  test('an element this ontology lacks is named, and the draft says what it breaks; into an existing app, main\'s next draft; not a package, refused', async () => {
    const missing = foreign(pkg);
    const property = missing.references.find((r) => r.kind === 'property')!;
    property.apiName = 'no_such_field';
    const imported = await c.gateway.call(importAppPackage, { body: { package: missing as never } }, c.keyed(c.member));
    assert.deepEqual(imported.unmapped, [{ kind: 'property', apiName: 'no_such_field', objectType: property.objectType }]);
    assert.ok(imported.draft.findings.length > 0, 'its widgets name a property this ontology does not have');
    const into = await c.gateway.call(importAppPackage, { body: { package: foreign(pkg) as never, appId } }, c.keyed(c.member));
    assert.deepEqual([into.app.id, into.draft.version, into.draft.state], [appId, 2, 'draft']);
    await assert.rejects(c.gateway.call(importAppPackage, { body: { package: { format: 'something else' } } }, c.keyed(c.member)), { code: 'studio.package_invalid' });
  });
});
