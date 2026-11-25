// App packages exported and imported (D231). Exporting needs edit access to the app and leave to
// export (Files checks file.export), and takes a published version (reviewed content only): the
// package goes into Files as the person's export, its lineage the app version, so it carries the
// version's markings and prints them. Importing needs app.create: the package's elements are found
// by API name in this organisation's ontology, the definition validated against main, and it
// becomes a new app's first draft, or main's next draft of an app the person may edit. Anything
// not found is named, and the draft's findings say what it breaks.

import type { AppPackage, AppVersionView, AppView } from '../../contracts/studio/app.contract.ts';
import { appPackage } from '../../contracts/studio/app.contract.ts';
import { listActionTypes } from '../../contracts/actions/actionType.contract.ts';
import { createExport, previewExportMarkings, type FileView } from '../../contracts/files/file.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { appRepo, appVersionRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { accessTo, appView, insertApp, saveDraft } from './apps.service.ts';
import { PACKAGE_FORMAT, referencesOf, remap, type Reference, type Vocabulary } from './appPackage.service.ts';
import { appNotFound, demand, mainManifest, member, recordEvent, type Context, type StudioDeps } from './deps.service.ts';

type Keyed = Context & Pick<HandlerContext, 'idempotencyKey'>;

/** This organisation's ontology and Action types, as the mapping reads them. */
async function vocabulary(deps: StudioDeps, ctx: Context): Promise<{ v: Vocabulary; sequence: number }> {
  const manifest = await mainManifest(deps, ctx);
  const actions = await deps.services.call(listActionTypes, { query: { limit: 500 } }, { request: ctx.request, correlationId: ctx.correlationId });
  return {
    v: {
      objectTypes: manifest.objectTypes.map((t) => ({ id: t.id, apiName: t.apiName, properties: t.properties.map((p) => ({ identityId: p.identityId, apiName: p.apiName })) })),
      linkTypes: manifest.linkTypes.map((l) => ({ id: l.id, apiName: l.apiName })),
      functions: manifest.functions.map((f) => ({ id: f.id, apiName: f.apiName })),
      sharedProperties: manifest.sharedProperties.map((p) => ({ id: p.id, apiName: p.apiName })),
      actionTypes: actions.actionTypes.map((a) => ({ id: a.id, apiName: a.apiName })),
    },
    sequence: manifest.version.sequence,
  };
}

export async function exportPackage(deps: StudioDeps, ctx: Keyed, appId: string, input: { version?: number | undefined; folderId?: string | undefined })
  : Promise<{ file: FileView; references: number; unresolved: number }> {
  const me = member(ctx);
  const { app, row } = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const found = await appRepo.findById(db, appId);
    if (!found || found.kind !== 'app' || found.archivedAt !== null) return { app: undefined, row: undefined };
    const held = await accessTo(db, found, me.membershipId);
    if (held !== 'owner' && held !== 'edit') return { app: undefined, row: undefined };
    const version = input.version === undefined
      ? (found.currentVersionId === null ? undefined : await appVersionRepo.findById(db, found.currentVersionId))
      : await appVersionRepo.findByAppIdAndVersion(db, { organisationId: me.organisationId, appId, version: input.version });
    return { app: found, row: version };
  }, { readOnly: true });
  if (app === undefined) throw appNotFound();
  if (row === undefined || (row.state !== 'published' && row.state !== 'superseded')) {
    throw new AppError('validation', 'a package is made of a version that was published', { code: 'studio.package_needs_published' });
  }
  const { v } = await vocabulary(deps, ctx);
  const definition = row.definition as Record<string, unknown>;
  const { references, unresolved } = referencesOf(definition, v);
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const inputs = [{ node: { kind: 'app_version' as const, refId: appId, version: row.id }, relation: 'exported_from' as const }];
  const { markings } = await deps.services.call(previewExportMarkings, { body: { inputs, carriedMarkingIds: row.markings } }, options);
  const pkg: AppPackage = {
    format: PACKAGE_FORMAT, formatVersion: 1, name: app.name, description: app.description, markings: markings.map((m) => m.name),
    sourceVersion: row.version, exportedAt: new Date().toISOString(), definition: definition as AppPackage['definition'], references,
  };
  const file = await deps.services.call(createExport, {
    body: {
      name: `${app.name.slice(0, 180)}.silo-app.json`, contentType: 'application/json', content: Buffer.from(JSON.stringify(pkg, null, 1)).toString('base64'),
      source: { kind: 'app_package', appVersionId: row.id }, ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      inputs, printedMarkingIds: markings.map((m) => m.id), carriedMarkingIds: row.markings, fieldPolicies: [], connectionIds: [],
    },
  }, { ...options, idempotencyKey: `studio.package.${ctx.idempotencyKey ?? row.id}` });
  await inTransaction(deps.databases.pool('control'), me.request, (db) => recordEvent(db, me, ctx.correlationId, {
    event: 'app_package_exported', resource: { type: 'app', id: appId },
    detail: { version: row.version, file_id: file.id, references: references.length, unresolved: unresolved.length, markings: markings.length },
  }));
  return { file, references: references.length, unresolved: unresolved.length };
}

export async function importPackage(deps: StudioDeps, ctx: Keyed, input: { package: Record<string, unknown>; name?: string | undefined; appId?: string | undefined })
  : Promise<{ app: AppView; draft: AppVersionView; mapped: number; unmapped: Omit<Reference, 'id'>[] }> {
  const me = member(ctx);
  const parsed = appPackage.safeParse(input.package);
  if (!parsed.success) throw new AppError('validation', 'this is not a Silo app package Studio can read', { code: 'studio.package_invalid' });
  const pkg = parsed.data;
  const { v, sequence } = await vocabulary(deps, ctx);
  const { definition, mapped, unmapped } = remap(pkg.definition as Record<string, unknown>, pkg.references, v);
  definition['ontologyVersion'] = sequence;
  let out: { app: AppView; draft: AppVersionView };
  if (input.appId === undefined) {
    await demand(deps, ctx, { permission: 'app.create' });
    out = await insertApp(deps, ctx, me, {
      name: input.name ?? pkg.name, ...(pkg.description === null ? {} : { description: pkg.description }), requireFullClearance: false, definition,
    });
  } else {
    // main's next draft of an app the person may edit: saveDraft refuses what it always refuses (a version in review, a draft open).
    const draft = await saveDraft(deps, ctx, input.appId, definition, undefined);
    const app = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
      const found = (await appRepo.findById(db, input.appId!))!;
      return appView(found, (await accessTo(db, found, me.membershipId))!, await appVersionRepo.inProgress(db, found.id));
    }, { readOnly: true });
    out = { app, draft };
  }
  await inTransaction(deps.databases.pool('control'), me.request, (db) => recordEvent(db, me, ctx.correlationId, {
    event: 'app_package_imported', resource: { type: 'app', id: out.app.id },
    detail: { source_version: pkg.sourceVersion, mapped, unmapped: unmapped.length, findings: out.draft.findings.length, into_existing: input.appId !== undefined },
  }));
  return { ...out, mapped, unmapped };
}
