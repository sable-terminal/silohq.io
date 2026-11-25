// Field aliases (spec 21.6): one live alias per column of a connection, and one column per
// alias. Setting replaces the column's alias; removing keeps the row, marked removed, for
// audit. field_alias_set and field_alias_removed name the alias and the connection, never the
// alias's words.

import type { FieldAliasView } from '../../contracts/ontology/fieldAlias.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { FieldAlias } from '../../models/ontology/index.model.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { fieldAliasRepo } from '../../repos/ontology/index.repo.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { demand, demandView, person, recordEvent, type Context, type OntologyDeps } from './deps.service.ts';

const view = (a: FieldAlias): FieldAliasView => ({
  id: a.id, connectionId: a.connectionId, fieldPath: a.fieldPath, alias: a.alias, declaredBy: a.declaredBy, declaredAt: a.declaredAt,
});

export async function setFieldAlias(deps: OntologyDeps, ctx: Context, input: { connectionId: string; fieldPath: string; alias: string }): Promise<FieldAliasView> {
  const actor = person(ctx, 'declaring a field alias');
  await demand(deps, ctx, 'ontology.confirm');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const connection = await connectionRepo.findById(db, input.connectionId);
    const manifest = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
    if (connection === undefined || manifest === undefined) throw new AppError('not_found', 'no such connection', { code: 'ontology.connection_unknown' });
    const parsed = manifestSchema.safeParse(manifest.document);
    if (!parsed.success || !parsed.data.objects.some((o) => o.fields.some((f) => f.name === input.fieldPath))) {
      throw new AppError('validation', 'the connection has no such field', { code: 'ontology.field_unknown' });
    }
    const before = await fieldAliasRepo.liveForField(db, input.connectionId, input.fieldPath);
    if (before?.alias === input.alias) return view(before);
    const at = new Date().toISOString();
    if (before !== undefined) await fieldAliasRepo.update(db, before.id, { removedBy: actor.membershipId, removedAt: at });
    let row: FieldAlias;
    try {
      row = await fieldAliasRepo.insert(db, {
        id: uuidv7(), organisationId: actor.organisationId, connectionId: input.connectionId, fieldPath: input.fieldPath, alias: input.alias,
        declaredBy: actor.membershipId, declaredAt: at,
      });
    } catch (error) {
      const mapped = isAppError(error) ? error : fromDatabaseError(error);
      if (mapped.category === 'conflict') throw new AppError('conflict', 'another field of this connection has that alias', { code: 'ontology.alias_taken' });
      throw mapped;
    }
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'field_alias_set', resource: { type: 'field_alias', id: row.id },
      detail: { connection_id: input.connectionId, ...(before === undefined ? {} : { replaced_alias_id: before.id }) },
    });
    return view(row);
  });
}

export async function removeFieldAlias(deps: OntologyDeps, ctx: Context, aliasId: string): Promise<{ removed: boolean }> {
  const actor = person(ctx, 'removing a field alias');
  await demand(deps, ctx, 'ontology.confirm');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = await fieldAliasRepo.findById(db, aliasId);
    if (row === undefined) throw new AppError('not_found', 'no such field alias', { code: 'ontology.alias_unknown' });
    if (row.removedAt !== null) return { removed: false };
    await fieldAliasRepo.update(db, row.id, { removedBy: actor.membershipId, removedAt: new Date().toISOString() });
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'field_alias_removed', resource: { type: 'field_alias', id: row.id }, detail: { connection_id: row.connectionId },
    });
    return { removed: true };
  });
}

export async function listFieldAliases(deps: OntologyDeps, ctx: Context, connectionId: string | undefined): Promise<{ aliases: FieldAliasView[] }> {
  await demandView(deps, ctx);
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => fieldAliasRepo.live(db, connectionId), { readOnly: true });
  return { aliases: rows.map(view) };
}
