// A connection's sources of change, from its manifest (spec 18.1): per streamed object the
// sources in order of preference, and the webhook block. A manifest version is immutable
// once used, so parsed manifests are kept by version id.

import {
  manifestSchema, type ChangeSourceKind, type ChangeStreamObject, type Manifest, type ManifestObject,
} from '../../contracts/connect/manifest.contract.ts';
import { inTransaction, type Databases, type RequestContext } from '../../infra/postgres.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface StreamedObject {
  object: ManifestObject;
  stream: ChangeStreamObject;
  kinds: ChangeSourceKind[];
}

export interface ConnectionSources {
  connection: Connection;
  manifest: Manifest;
  streamed: Map<string, StreamedObject>;
}

const MAX_CACHED = 500;

export function createSourceCatalogue(databases: Databases) {
  const control = databases.pool('control');
  const manifests = new Map<string, Manifest>();

  return {
    async load(request: RequestContext, connectionId: string): Promise<ConnectionSources> {
      const { connection, manifest } = await inTransaction(control, request, async (db) => {
        const connection = await connectionRepo.findById(db, connectionId);
        if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
        let manifest = manifests.get(connection.manifestId);
        if (manifest === undefined) {
          const row = await connectorManifestRepo.findById(db, connection.manifestId);
          if (!row) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
          manifest = manifestSchema.parse(row.document);
          if (manifests.size >= MAX_CACHED) manifests.delete(manifests.keys().next().value!);
          manifests.set(connection.manifestId, manifest);
        }
        return { connection, manifest };
      }, { readOnly: true });
      const streamed = new Map<string, StreamedObject>();
      for (const stream of manifest.changeStream?.objects ?? []) {
        const object = manifest.objects.find((o) => o.name === stream.object);
        if (object !== undefined) streamed.set(stream.object, { object, stream, kinds: stream.sources.map((s) => s.kind) });
      }
      return { connection, manifest, streamed };
    },
  };
}

export type SourceCatalogue = ReturnType<typeof createSourceCatalogue>;

/** The source identifier of a record, as the manifest's identifier fields give it. */
export function entityRefOf(object: ManifestObject, row: Record<string, unknown>): string | undefined {
  const parts = object.identifier.map((field) => row[field]);
  if (parts.some((p) => p === null || p === undefined || (typeof p === 'object'))) return undefined;
  return parts.length === 1 ? String(parts[0]) : JSON.stringify(parts.map(String));
}
