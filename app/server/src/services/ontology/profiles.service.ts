// Field profiles for derivation and confirmation (spec 22.1 to 22.3): each object of a
// connection profiled through connect-runtime, which reads the values and returns counts
// only, stored in ontology.field_profiles (field_profiled, one event per object).
//
// Profiling reaches the source, so it runs outside any transaction, object by object, and a
// source that cannot be profiled leaves derivation to the declared schema: an object whose
// profile failed is skipped and named in the result, never retried in a loop.
//
// What profiles say to derivation (derivation.service.ts):
// - an identifier is confirmed unique when every row was examined and its distinct count
//   equals the rows, with no nulls; seen repeated or null, it is flagged;
// - with no title by its name, the text field most distinct and least null is proposed;
// - a field whose values mostly do not parse as its declared type is flagged.

import { profileObject } from '../../contracts/connect-runtime/profile.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { FieldProfile } from '../../models/ontology/fieldProfile.model.ts';
import { connectionRepo } from '../../repos/connect/index.repo.ts';
import { fieldProfileRepo } from '../../repos/ontology/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { acting, demand, demandView, recordEvent, type Context, type OntologyDeps } from './deps.service.ts';
import { createSourceSchemas } from './sourceSchema.service.ts';

/** At most this many objects of one connection are profiled in one request. */
const MAX_OBJECTS = 50;
/** Rows read per object. */
const PROFILE_ROWS = 10_000;

export const profileView = (p: FieldProfile) => ({
  sourceObject: p.sourceObject, fieldPath: p.fieldPath, rowCount: Number(p.rowCount),
  distinctCount: p.distinctCount === null ? null : Number(p.distinctCount), nullCount: Number(p.nullCount), emptyCount: Number(p.emptyCount),
  minLength: p.minLength, maxLength: p.maxLength, typeConformanceCount: Number(p.typeConformanceCount), profiledAt: p.profiledAt,
  connectorVersion: p.connectorVersion,
});
export type ProfileView = ReturnType<typeof profileView>;

/** Profiles the connection's objects (ontology.propose); returns what was profiled and what could not be. */
export async function profileConnection(deps: OntologyDeps, ctx: Context, connectionId: string, objects?: string[])
  : Promise<{ profiled: string[]; failed: { object: string; code: string }[] }> {
  await demand(deps, ctx, 'ontology.propose');
  return profileObjects(deps, ctx, connectionId, objects);
}

/** The profiling itself, for a caller that has already been allowed (derivation). */
export async function profileObjects(deps: OntologyDeps, ctx: Context, connectionId: string, objects?: string[])
  : Promise<{ profiled: string[]; failed: { object: string; code: string }[] }> {
  const actor = acting(ctx);
  const control = deps.databases.pool('control');
  const { schema, active } = await inTransaction(control, ctx.request, async (db) => {
    const connection = await connectionRepo.findById(db, connectionId);
    return { schema: await createSourceSchemas(db).of(connectionId), active: connection?.status === 'active' };
  }, { readOnly: true });
  const wanted = (objects === undefined ? schema.objects : schema.objects.filter((o) => objects.includes(o.name))).slice(0, MAX_OBJECTS);
  const profiled: string[] = [];
  const failed: { object: string; code: string }[] = [];
  for (const object of wanted) {
    let counts;
    try {
      counts = await deps.services.call(profileObject, {
        body: { connectionId, object: object.name, reason: active ? 'query' : 'probe', maxRows: PROFILE_ROWS },
      }, { request: ctx.request, correlationId: ctx.correlationId });
    } catch (error) {
      failed.push({ object: object.name, code: isAppError(error) ? error.code : 'unhandled' });
      continue;
    }
    const at = new Date().toISOString();
    await inTransaction(control, ctx.request, async (db) => {
      for (const f of counts.fields) {
        await fieldProfileRepo.insert(db, {
          id: uuidv7(), organisationId: actor.organisationId, connectionId, sourceObject: object.name, fieldPath: f.field,
          rowCount: String(f.rowCount), distinctCount: f.distinctCount === null ? null : String(f.distinctCount), nullCount: String(f.nullCount),
          emptyCount: String(f.emptyCount), minLength: f.minLength, maxLength: f.maxLength, typeConformanceCount: String(f.typeConformanceCount),
          profiledAt: at, connectorVersion: counts.connectorVersion,
        });
      }
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'field_profiled', resource: { type: 'connection', id: connectionId },
        detail: { source_object: object.name, fields: counts.fields.length, rows_examined: counts.rowsExamined, complete: counts.complete },
      });
    });
    profiled.push(object.name);
  }
  return { profiled, failed };
}

/** The latest profile of each field of a connection. */
export async function listProfiles(deps: OntologyDeps, ctx: Context, connectionId: string, depth = 1): Promise<ProfileView[]> {
  await demandView(deps, ctx);
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request,
    (db) => depth === 1 ? fieldProfileRepo.latestForConnection(db, connectionId) : fieldProfileRepo.recentForConnection(db, connectionId, depth),
    { readOnly: true });
  return rows.map(profileView);
}
