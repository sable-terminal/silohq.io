import { invalid } from '../utils/error.util';
import { withTransaction } from '../infra/db.infra';
import { derive, type Prober } from '../engine/discovery/derive.discovery';
import { compileCatalogue } from '../engine/compile/sql.compile';
import { foreignKeysOf, tablesOf } from '../engine/transports/sql/catalogue.sql';
import { runRead } from '../engine/read/run.read';
import { ReadBudget } from '../engine/read/budget.read';
import { BlobStore } from '../engine/read/blob.read';
import type { ReadContext } from '../engine/read/context.read';
import { manifestV2, type ManifestV2 } from '../schemas/manifest.schema';
import * as connectorRepo from '../repos/connector.repo';
import { createDraft, validate } from './connectorBuilder.service';
import * as connectorService from './connector.service';
import { withConnection } from './connectorRuntime.service';
import type { Actor } from './scope.service';

/**
 * Deriving a connector from a connection that already works (MANIFEST-V2 WP10).
 *
 * CONNECT FIRST. The person has a connection — a base address and a way in,
 * even with no objects described — and asks Silo to find out what is there.
 * Every request is made through that connection exactly as a question would
 * be: its credential opened once, audited, and placed only where its pins
 * allow. What comes back is a DRAFT in the same connector's lineage, with notes
 * on what was compiled, observed and confirmed; publishing it and moving the
 * connection onto it are the person's steps.
 *
 * NO RECORD IS KEPT. Values decide a field's type and are dropped.
 */

/** A stand-in object, so the connection opens before anything is known about what it holds. */
const probeObject = (kind: string) => ({
  name: '__probe',
  identifier: ['body'],
  fields: [{ name: 'body', type: 'json' }],
  read: { request: kind === 'sql' ? { table: '__probe' } : kind === 'https_rest' ? { path: '/' } : { method: 'POST', body: {} }, records: '{{ response }}' },
});

function withObject(manifest: ManifestV2, object: Record<string, unknown>): { manifest: ManifestV2; object: ManifestV2['objects'][number] } {
  const parsed = manifestV2.parse({ ...manifest, objects: [object] });
  return { manifest: parsed, object: parsed.objects[0]! };
}

function prober(ctx: ReadContext): Prober {
  const run = async (object: Record<string, unknown>, maxPages: number): Promise<unknown[][] | null> => {
    const pages: unknown[][] = [];
    try {
      const { manifest, object: parsed } = withObject(ctx.manifest, object);
      const probe: ReadContext = { ...ctx, manifest, object: parsed, budget: new ReadBudget(), blobs: new BlobStore(), observe: (records) => pages.push(records) };
      await runRead(probe, { object: parsed.name, filters: [], sort: [], fields: [], limit: 1_000 }, { want: 1_000 });
      return pages.slice(0, maxPages);
    } catch {
      return pages.length > 0 ? pages : null;
    }
  };
  const kind = ctx.manifest.transport.kind;
  return {
    async fetch(request) {
      const pages = await run(
        {
          name: '__probe',
          identifier: ['body'],
          fields: [{ name: 'body', type: 'json' }],
          read: {
            request: {
              ...(request.method ? { method: request.method } : {}),
              ...(kind === 'https_rest' && request.path ? { path: request.path } : {}),
              ...(request.query && Object.keys(request.query).length ? { query: request.query } : {}),
              ...(request.body !== undefined ? { body: request.body } : {}),
            },
            format: request.format ?? 'auto',
            records: '{{ [{ "body": response, "headers": headers }] }}',
          },
        },
        1,
      );
      const first = pages?.[0]?.[0] as { body: unknown; headers: Record<string, string | string[]> } | undefined;
      return first ? { body: first.body, headers: first.headers ?? {} } : null;
    },
    pages: (object, maxPages) => run(object, maxPages),
  };
}

export async function deriveFor(actor: Actor, connectionId: string, input: { paths: string[] }) {
  const connection = await connectorService.manageableConnection(actor, connectionId);
  const credential = (await withTransaction((db) => connectorRepo.credentialsFor(db, [connectionId]))).get(connectionId);
  const manifest = connection.manifest;
  const kind = manifest.transport.kind;
  if (kind !== 'https_rest' && kind !== 'graphql' && kind !== 'sql') {
    throw invalid({ message: 'Silo derives connectors for HTTP APIs, GraphQL and databases. Build this one in the builder.', code: 'invalid.derive_unsupported' });
  }

  const { objects, notes, from } = await withConnection({
    actor,
    connection: { ...connection, manifest: withObject(manifest, probeObject(kind)).manifest },
    credential,
    reason: 'connection-verify',
    use: async (open) => {
      const ctx = await open('__probe');
      if (manifest.transport.kind === 'sql') {
        const tables = (await tablesOf(ctx)) ?? [];
        const compiled = compileCatalogue({ tables, foreignKeys: await foreignKeysOf(ctx) }, { name: manifest.identity.name, driver: manifest.transport.driver, grammar: manifest.transport.grammar });
        return { objects: compiled.document.objects as Array<Record<string, unknown>>, notes: compiled.notes, from: 'catalogue' as const };
      }
      const base = 'baseUrl' in manifest.transport ? String(manifest.transport.baseUrl) : 'endpoint' in manifest.transport ? String(manifest.transport.endpoint) : '';
      const derived = await derive(prober(ctx), { kind: kind === 'graphql' ? 'graphql' : 'https_rest', baseUrl: base, paths: input.paths.slice(0, 20) });
      return { objects: derived.objects, notes: derived.notes, from: derived.compiledFrom ?? ('derived' as const) };
    },
  });

  /* The connection's document with what was found added: its transport, sign-in and settings stay as they work. */
  const known = new Set(manifest.objects.map((o) => o.name));
  const added = objects.filter((o) => !known.has(String(o.name)));
  const document: Record<string, unknown> = {
    ...manifest,
    objects: [...manifest.objects, ...added],
    authoring: { from, notes: notes.slice(0, 100).map((n) => n.slice(0, 500)) },
  };
  const draft = await createDraft(actor, { name: manifest.identity.name, document, sourceRoute: 'ai' });
  return { draft, validation: validate(draft.document), found: added.length, notes };
}
