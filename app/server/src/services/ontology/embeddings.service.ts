// Description embeddings (decision 2026-11-15; spec 7.4: metadata embeddings in pgvector).
// What each object type, property and link type on main is called and described, embedded so
// that compile can narrow a large vocabulary to the types a question is about (schema linking).
// Metadata only: names and descriptions people wrote, never a record value.
//
// - Texts: a type's display and plural names and its description; a property's type, name
//   and description; a link type's two directions between its two types (a link has no
//   description of its own). Each kept with the hash of its text.
// - Upkeep: whatever changed since it was embedded (its text hash differs), or is new, is
//   embedded again, in batches; what main no longer holds goes. Run after a merge to main,
//   and before every ranking, so a ranking never reads a stale description.
// - Ranking: the question embedded as a query; each candidate type scores the best of its own
//   description's similarity, its properties' and its links' (a question naming a property
//   pulls its type in). A type with nothing embedded is returned apart, for compile to keep.

import { createHash } from 'node:crypto';
import { embedTexts } from '../../contracts/model-gateway/embedding.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { descriptionEmbeddingRepo, ontologyBranchRepo } from '../../repos/ontology/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { Content } from './content.service.ts';
import type { Context, OntologyDeps } from './deps.service.ts';
import { readContent } from './store.service.ts';

export type EmbeddedKind = 'object_type' | 'property' | 'link_type';

export interface EmbeddingText {
  kind: EmbeddedKind;
  elementId: string;
  objectTypeId: string;
  otherObjectTypeId: string | null;
  text: string;
  hash: string;
}

/** Texts embedded per batch: under the gateway's bound on one request. */
export const BATCH = 50;
const MAX_TEXT = 2_000;

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const keyOf = (t: Pick<EmbeddingText, 'kind' | 'elementId'>): string => `${t.kind}:${t.elementId}`;

/** What is embedded for the content's live elements (pure). */
export function embeddingTexts(content: Content): EmbeddingText[] {
  const out: EmbeddingText[] = [];
  const live = content.objectTypes.filter((t) => t.status !== 'retired');
  const typeName = new Map(live.map((t) => [t.id, t.displayName]));
  const add = (kind: EmbeddedKind, elementId: string, objectTypeId: string, otherObjectTypeId: string | null, raw: string) => {
    const text = clean(raw);
    if (text.length > 0) out.push({ kind, elementId, objectTypeId, otherObjectTypeId, text, hash: hashOf(text) });
  };
  for (const t of live) {
    add('object_type', t.id, t.id, null, `${t.displayName} (${t.pluralName}). ${t.description ?? ''}`);
    for (const p of t.properties.filter((x) => x.status !== 'retired')) {
      add('property', p.identityId, t.id, null, `${t.displayName}: ${p.displayName}. ${p.description ?? ''}`);
    }
  }
  for (const l of content.linkTypes.filter((x) => x.status !== 'retired')) {
    const from = typeName.get(l.fromTypeId);
    const to = typeName.get(l.toTypeId);
    if (from === undefined || to === undefined) continue;
    add('link_type', l.id, l.fromTypeId, l.toTypeId, `${from} ${l.forwardName} ${to}. ${to} ${l.reverseName} ${from}.`);
  }
  return out;
}

/** Embeds what changed on main since it was last embedded, and drops what main no longer holds. */
export async function refreshEmbeddings(deps: OntologyDeps, organisationId: string, correlationId: string): Promise<{ embedded: number; removed: number }> {
  const pool = deps.databases.pool('control');
  const request = { organisationId };
  const loaded = await inTransaction(pool, request, async (db) => {
    const main = await ontologyBranchRepo.findMain(db);
    if (main === undefined || main.headVersionId === null) return undefined;
    return { content: await readContent(db, organisationId, main.headVersionId), stored: await descriptionEmbeddingRepo.hashes(db) };
  }, { readOnly: true });
  if (loaded === undefined) return { embedded: 0, removed: 0 };
  const wanted = embeddingTexts(loaded.content);
  const stored = new Map(loaded.stored.map((s) => [keyOf(s), s.textHash]));
  const stale = wanted.filter((w) => stored.get(keyOf(w)) !== w.hash);
  let embedded = 0;
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    const out = await deps.services.call(embedTexts, { body: { texts: batch.map((t) => t.text), task: 'document' } }, { request, correlationId });
    await inTransaction(pool, request, async (db) => {
      for (const [j, t] of batch.entries()) {
        await descriptionEmbeddingRepo.put(db, {
          id: uuidv7(), organisationId, kind: t.kind, elementId: t.elementId, objectTypeId: t.objectTypeId, otherObjectTypeId: t.otherObjectTypeId,
          textHash: t.hash, embedding: out.vectors[j]!, model: out.model,
        });
      }
    });
    embedded += batch.length;
  }
  const keep = new Set(wanted.map(keyOf));
  const gone = loaded.stored.filter((s) => !keep.has(keyOf(s)));
  if (gone.length > 0) await inTransaction(pool, request, (db) => descriptionEmbeddingRepo.removeElements(db, gone.map((g) => ({ kind: g.kind, elementId: g.elementId }))));
  return { embedded, removed: gone.length };
}

export interface Ranking { ranked: { objectTypeId: string; score: number }[]; unembedded: string[] }

/** The candidate types most like the question, best first, at most `limit`; and those with nothing embedded. */
export async function rankObjectTypes(deps: OntologyDeps, ctx: Context, input: { question: string; objectTypeIds: string[]; limit: number }): Promise<Ranking> {
  const organisationId = ctx.request.organisationId!;
  await refreshEmbeddings(deps, organisationId, ctx.correlationId);
  const query = await deps.services.call(embedTexts, { body: { texts: [clean(input.question)], task: 'query' } }, {
    request: ctx.request, correlationId: ctx.correlationId,
  });
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request,
    (db) => descriptionEmbeddingRepo.similarTo(db, query.vectors[0]!, input.objectTypeIds), { readOnly: true });
  const candidates = new Set(input.objectTypeIds);
  const best = new Map<string, number>();
  const embeddedTypes = new Set<string>();
  for (const r of rows) {
    if (r.kind === 'object_type') embeddedTypes.add(r.objectTypeId);
    for (const t of [r.objectTypeId, r.otherObjectTypeId]) {
      if (t === null || !candidates.has(t)) continue;
      best.set(t, Math.max(best.get(t) ?? Number.NEGATIVE_INFINITY, r.similarity));
    }
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, input.limit)
    .map(([objectTypeId, score]) => ({ objectTypeId, score: Math.round(score * 10_000) / 10_000 }));
  return { ranked, unembedded: input.objectTypeIds.filter((id) => !embeddedTypes.has(id)) };
}
