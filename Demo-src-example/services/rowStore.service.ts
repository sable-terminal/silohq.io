import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { refusal } from '../utils/error.util';
import { env, isProd } from '../config/env.config';
import * as bigquery from '../infra/bigquery.infra';
import * as siloRowRepo from '../repos/siloRow.repo';
import * as siloImportRepo from '../repos/siloImport.repo';
import * as siloRepo from '../repos/silo.repo';
import type { ExtractedRow, RowStoreKind, StoredField, StoredFieldType } from '../models/rowStore.model';
import type { LoadedConnection } from '../repos/connector.repo';
import type { ManifestObject } from '../schemas/manifest.schema';
import type { Pushdown, Query } from '../engine/execution/query.execution';

/** A Silo import's rows, read for a query. The engine reaches no store itself, so the service hands it one. */
export interface SiloReader {
  read(input: { object: Pick<ManifestObject, 'name' | 'fields'>; query: Query; pushed: Pushdown }): Promise<Record<string, unknown>[]>;
}

/**
 * Import §7 — the row store, whichever store it is.
 *
 * ── One interface, two stores ──────────────────────────────────────────────
 *
 * BigQuery in production, the `silo_rows` table everywhere else. The import
 * pipeline, the purge and the query path call this and nothing below it, so the
 * choice is made in one function and cannot be half-made.
 *
 * ── Never a silent fallback in production ──────────────────────────────────
 *
 * A production deployment with no BigQuery configured does not quietly put rows
 * in Postgres: import refuses. Rows landing somewhere the disclosure and the
 * residency configuration do not describe is exactly what §7 is guarding. An
 * operator who wants Postgres in production says so with `SILO_ROW_STORE`.
 */

export function kind(): RowStoreKind | null {
  if (env.SILO_ROW_STORE === 'bigquery') return bigquery.isConfigured() ? 'bigquery' : null;
  if (env.SILO_ROW_STORE === 'postgres') return 'postgres';
  if (!isProd) return 'postgres';
  return bigquery.isConfigured() ? 'bigquery' : null;
}

export function assertAvailable(): RowStoreKind {
  const chosen = kind();
  if (!chosen) {
    throw refusal({
      message: 'Import is not configured in this deployment: there is nowhere to hold imported records.',
      code: 'refusal.import_unconfigured',
    });
  }
  return chosen;
}

export function storedType(type: ManifestObject['fields'][number]['type'] | 'money'): StoredFieldType {
  return type === 'unknown' ? 'string' : type === 'money' ? 'number' : type;
}

export type ObjectShape = { name: string; fields: StoredField[] };

/** Make sure every object of a source has somewhere to put rows. Nothing to do in Postgres. */
export async function ensureObjects(input: {
  organisationId: string;
  sourceId: string;
  objects: ObjectShape[];
  retentionDays: number;
}): Promise<void> {
  if (assertAvailable() !== 'bigquery') return;

  await bigquery.ensureDataset(input.organisationId);
  for (const object of input.objects) {
    await bigquery.ensureTable({
      organisationId: input.organisationId,
      sourceId: input.sourceId,
      objectName: object.name,
      fields: object.fields,
      retentionDays: input.retentionDays,
    });
  }
}

export async function insertRows(input: {
  organisationId: string;
  siloId: string;
  sourceId: string;
  fileId: string;
  object: ObjectShape;
  receivedAt: Date;
  rows: ExtractedRow[];
}): Promise<number> {
  if (input.rows.length === 0) return 0;

  if (assertAvailable() === 'bigquery') {
    const loaded = await bigquery.load({
      organisationId: input.organisationId,
      sourceId: input.sourceId,
      objectName: input.object.name,
      fileId: input.fileId,
      receivedAt: input.receivedAt,
      fields: input.object.fields,
      rows: input.rows,
    });
    return loaded.rows;
  }

  return tenant(input.organisationId, (db) =>
    siloRowRepo.insertRows(db, {
      organisationId: input.organisationId,
      siloId: input.siloId,
      sourceId: input.sourceId,
      fileId: input.fileId,
      objectName: input.object.name,
      receivedAt: input.receivedAt,
      rows: input.rows,
    }),
  );
}

/** Every row one file produced, across the objects it fed. */
export async function removeFileRows(input: {
  organisationId: string;
  sourceId: string;
  fileId: string;
  objectNames: string[];
}): Promise<number> {
  if (assertAvailable() === 'bigquery') {
    let removed = 0;
    for (const objectName of input.objectNames) {
      removed += await bigquery.deleteRows({
        organisationId: input.organisationId,
        sourceId: input.sourceId,
        objectName,
        where: { fileId: input.fileId },
      });
    }
    return removed;
  }

  return tenant(input.organisationId, (db) => siloRowRepo.deleteRowsOfFile(db, input.fileId));
}

export async function removeObjectRows(input: {
  organisationId: string;
  sourceId: string;
  objectName: string;
}): Promise<number> {
  if (assertAvailable() === 'bigquery') {
    return bigquery.deleteRows({ ...input, where: 'all' });
  }
  return tenant(input.organisationId, (db) => siloRowRepo.deleteRowsOfObject(db, input));
}

/** §5 — a confirmed value, certain from now on wherever the rows are held. */
export async function certifyField(input: {
  organisationId: string;
  sourceId: string;
  objectName: string;
  fileId: string;
  rowRef: string;
  field: string;
}): Promise<void> {
  if (assertAvailable() === 'bigquery') {
    await bigquery.certifyField(input);
    return;
  }
  await tenant(input.organisationId, (db) => siloRowRepo.certifyField(db, input));
}

/** §9 — bytes the row store holds for these sources' objects. */
export async function bytesHeld(input: {
  organisationId: string;
  siloId: string;
  sources: Array<{ sourceId: string; objectNames: string[] }>;
}): Promise<number> {
  const chosen = kind();
  if (!chosen) return 0;

  if (chosen === 'bigquery') {
    let bytes = 0;
    for (const source of input.sources) {
      for (const objectName of source.objectNames) {
        bytes += await bigquery.tableBytes({ organisationId: input.organisationId, sourceId: source.sourceId, objectName });
      }
    }
    return bytes;
  }

  return tenant(input.organisationId, (db) => siloRowRepo.bytesOfRows(db, input.siloId));
}

/**
 * §1 — the reader a Silo import answers queries through.
 *
 * ── Only what is inside the window ─────────────────────────────────────────
 *
 * Rows received longer ago than the Silo's retention window are not returned,
 * whether or not the sweep has deleted them yet. "Past its window it can no
 * longer be read, even before it is deleted" is a sentence in the disclosure.
 *
 * ── Every read is metered ──────────────────────────────────────────────────
 *
 * §9: BigQuery charges per byte scanned, so a badly shaped question against a
 * large Silo costs in a way Postgres does not. The bytes are recorded against
 * the Silo whichever store answered.
 *
 * ── Provenance travels with the row ────────────────────────────────────────
 *
 * `_provenance` names the file and the place in it. A value that was not read
 * certainly also carries `_certainty` — which, for a spreadsheet, it never is.
 */
export function readerFor(input: {
  organisationId: string;
  membershipId: string;
  connection: LoadedConnection;
}): SiloReader {
  return {
    async read({ object, query, pushed }) {
      const chosen = assertAvailable();
      const transport = input.connection.manifest.transport;
      if (transport.kind !== 'silo_import') {
        throw refusal({ message: 'Not a Silo import.', code: 'refusal.wrong_transport' });
      }

      const context = await runWithTenant(
        { organisationId: input.organisationId, membershipId: input.membershipId },
        () =>
          withTransaction(async (db) => {
            const source = await siloImportRepo.findSource(db, transport.sourceId);
            const silo = source ? await siloRepo.find(db, source.siloId) : null;
            return source && silo ? { siloId: silo.id, retentionDays: silo.retentionDays } : null;
          }),
      );

      if (!context) {
        throw refusal({ message: 'This Silo import no longer exists.', code: 'refusal.silo_source_missing' });
      }

      const fields: StoredField[] = object.fields.map((f) => ({ name: f.name, type: storedType(f.type) }));
      const sinceReceived = new Date(Date.now() - context.retentionDays * 24 * 60 * 60 * 1000);
      const filters = pushed.filters as Array<{ field: string; op: siloRowRepo.Comparison; value?: unknown }>;
      const sort = pushed.sort ? query.sort : [];

      const result =
        chosen === 'bigquery'
          ? await bigquery
              .read({
                organisationId: input.organisationId,
                sourceId: transport.sourceId,
                object: { name: object.name, fields },
                filters,
                sort,
                fields: pushed.fields ? query.fields : [],
                limit: query.limit,
                sinceReceived,
              })
              .then((read) => ({ rows: read.rows, bytes: read.bytesScanned }))
          : await tenant(input.organisationId, (db) =>
              siloRowRepo.readRows(db, {
                sourceId: transport.sourceId,
                objectName: object.name,
                fields,
                filters,
                sort,
                limit: query.limit,
                sinceReceived,
              }),
            );

      await tenant(input.organisationId, (db) => siloRepo.recordScan(db, context.siloId, result.bytes));

      return result.rows.map((row) => ({
        ...row.values,
        _provenance: { fileId: row.fileId, rowRef: row.rowRef },
        ...(Object.keys(row.methods).length > 0 ? { _certainty: row.methods } : {}),
      }));
    },
  };
}

function tenant<T>(
  organisationId: string,
  work: (db: Parameters<Parameters<typeof withTransaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return runWithTenant({ organisationId, membershipId: null }, () => withTransaction(work));
}
