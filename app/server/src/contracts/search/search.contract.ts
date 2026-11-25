// Search (spec 24.5, 33.5, 34.1): global search (Cmd-K) and Explorer search.
//
// - Ontology search runs over the vocabulary in the control plane: type, property and link
//   names and descriptions in the active ontology version, of the elements the person may
//   see (spec 21.2: what is outside their vocabulary does not exist for them).
// - Federated object search pushes the search term to each contributing system that
//   declares a search or filter capability on the type's title property, bounded per source.
//   Results merge by identity; a system that cannot search is named as not searched; a
//   source with more matches than the bound is refused for that source, never truncated
//   (invariant 2). A property the person may not see is never matched for them.
//
// Both are typed filters, not compiles: no model call, never metered (spec 33.5). Bodies, not
// query strings, carry the search text, so it stays out of access logs. The Object Index
// (spec 69) is not used: its engine is an open decision (69.6).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const VOCABULARY_KINDS = ['object_type', 'property', 'link_type', 'interface', 'shared_property'] as const;
export type VocabularyKind = (typeof VOCABULARY_KINDS)[number];

const CALLERS = ['gateway', 'ask', 'workspace', 'studio'] as const;
const text = z.string().trim().min(1).max(200);
/** Where the search was typed: an Explorer search is audited, a Cmd-K keystroke is not. */
const surface = z.enum(['cmdk', 'explorer']).default('cmdk');

export const vocabularyHit = z.object({
  kind: z.enum(VOCABULARY_KINDS),
  id: z.uuid(),
  /** The object type a property belongs to; null otherwise. */
  objectTypeId: z.uuid().nullable(),
  apiName: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  /** 0 to 1: exact, prefix, word, all words, then near spellings and descriptions. */
  score: z.number().min(0).max(1),
});
export type VocabularyHit = z.infer<typeof vocabularyHit>;

export const searchVocabulary = defineContract({
  service: 'search', name: 'searchVocabulary', method: 'POST', path: '/v1/search/vocabulary', callers: CALLERS,
  // A search changes nothing.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    text,
    kinds: z.array(z.enum(VOCABULARY_KINDS)).min(1).max(VOCABULARY_KINDS.length).optional(),
    limit: z.int().min(1).max(50).default(20),
    surface,
  }),
  response: z.object({
    method: z.literal('ontology'),
    ontologyVersionId: z.uuid(),
    hits: z.array(vocabularyHit),
  }),
  maxBodyBytes: 2048,
});

export const NOT_SEARCHED_REASONS = [
  // The person's grants do not reach the connection, or a marking on it is unsatisfied.
  'no_access',
  // The title is masked, redacted or denied for this person: never matched for them.
  'withheld',
  // The source declares no native contains or starts-with filter on the title's field.
  'no_search_capability',
  // The title's source field is not a plain field the source can filter on.
  'not_mappable',
  // More matches than the bound: refused for this source, narrow the search.
  'over_bound',
  // The source did not answer: unreachable, timed out or refused.
  'source_unreachable',
] as const;

export const searchObjects = defineContract({
  service: 'search', name: 'searchObjects', method: 'POST', path: '/v1/search/objects', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    text,
    /** The types searched; every type the person may see when absent. */
    objectTypeIds: z.array(z.uuid()).min(1).max(50).optional(),
    /** Matches allowed per source: more is refused for that source. */
    perSourceLimit: z.int().min(1).max(100).default(25),
    surface,
  }),
  response: z.object({
    /**
     * How the types were answered (spec 69.3): from the sources, from the Object Index, or
     * some of each; each group says which, so an indexed result is never mixed with a
     * source's refusal unsaid.
     */
    method: z.enum(['federated', 'index', 'mixed']),
    ontologyVersionId: z.uuid(),
    results: z.array(z.object({
      objectTypeId: z.uuid(),
      /** The source identifier, unique within the type for a single-source type; the Silo object id from the index. */
      identifier: z.string(),
      /** The title as the source holds it, or as the index last read it. */
      title: z.string().nullable(),
      /** Every source the object was found in; empty for an index result. */
      sources: z.array(z.object({ connectionId: z.uuid(), sourceObject: z.string() })),
      /** For an index result, its last refresh: never presented as live. Null for a live result. */
      refreshedAt: z.string().nullable(),
    })),
    /** Per type: how many results, and whether that is exact (every source answered within bounds). */
    groups: z.array(z.object({
      objectTypeId: z.uuid(),
      count: z.int().min(0),
      exact: z.boolean(),
      /** Results merged across sources by identity; false for a resolvable type until resolution is applied. */
      mergedByIdentity: z.boolean(),
      route: z.enum(['federated', 'index']),
      /** The index's last refresh for an index-answered type; null when answered live. */
      refreshedAt: z.string().nullable(),
    })),
    searched: z.array(z.object({ objectTypeId: z.uuid(), connectionId: z.uuid(), sourceObject: z.string(), matches: z.int().min(0) })),
    notSearched: z.array(z.object({
      objectTypeId: z.uuid(),
      connectionId: z.uuid().nullable(),
      sourceObject: z.string().nullable(),
      reason: z.enum(NOT_SEARCHED_REASONS),
    })),
  }),
  maxBodyBytes: 4096,
});
