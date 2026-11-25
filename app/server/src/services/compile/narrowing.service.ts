// Narrowing a large vocabulary (decision 2026-11-15): schema linking before the model call.
// When the reader may see more object types than the compile bound, the question is compiled
// against the types it is most about (ranked by description embeddings, ontology), with their
// properties and the links between them, so the prompt stays small and a wrong type is less
// likely. Always kept: a type the question names exactly, the type it is asked from, the types
// of the thread's earlier plans, and any type not yet embedded. Where the narrowed vocabulary
// cannot answer (the model says it is outside it, or names a type, property or link it lacks),
// compile widens once to the whole vocabulary. The set used, and whether it widened, is part
// of the compile's record.

import { rankObjectTypes } from '../../contracts/ontology/embedding.contract.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ReaderAccess } from '../planner/access.service.ts';
import { isAppError } from '../../utils/errors.util.ts';

/** The refusals that mean the narrowed vocabulary lacked what the question needs. */
export const WIDEN_ON: ReadonlySet<string> = new Set([
  'compile.outside_vocabulary', 'compile.object_type_unknown', 'compile.property_unknown', 'compile.link_type_unknown',
]);

const words = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The types the question names exactly: a display, plural or API name as whole words, in any case (pure). */
export function namedIn(question: string, access: ReaderAccess): string[] {
  const text = ` ${words(question)} `;
  return [...access.types.values()].filter(({ type }) => [type.displayName, type.pluralName, type.apiName]
    .map(words).some((name) => name.length > 0 && text.includes(` ${name} `))).map(({ type }) => type.id);
}

/** The vocabulary kept to these types, with the links between them (pure). */
export function within(access: ReaderAccess, keep: ReadonlySet<string>): ReaderAccess {
  const types = new Map([...access.types].filter(([id]) => keep.has(id)));
  const links = new Map([...access.links].filter(([, l]) => types.has(l.link.fromTypeId) && types.has(l.link.toTypeId)));
  return { ...access, types, links };
}

export interface Narrowing { access: ReaderAccess; objectTypeIds: string[] }

/**
 * The narrowed vocabulary, or undefined where none is needed (the reader sees no more types
 * than the bound) or none can be had (no ranking: the whole vocabulary, as before).
 */
export async function narrowFor(deps: { services: ServiceClient; logger: Logger }, options: Parameters<ServiceClient['call']>[2], input: {
  question: string; access: ReaderAccess; limit: number; keepAlso: readonly string[];
}): Promise<Narrowing | undefined> {
  const { access } = input;
  if (access.types.size <= input.limit) return undefined;
  let ranking;
  try {
    ranking = await deps.services.call(rankObjectTypes, { body: { question: input.question, objectTypeIds: [...access.types.keys()], limit: input.limit } }, options);
  } catch (error) {
    deps.logger.warn('the vocabulary could not be narrowed; the question is compiled against all of it', {
      event: 'compile.narrowing_unavailable', ...(isAppError(error) ? { errorCode: error.code } : {}),
    });
    return undefined;
  }
  const keep = new Set([...ranking.ranked.map((r) => r.objectTypeId), ...ranking.unembedded, ...namedIn(input.question, access), ...input.keepAlso]
    .filter((id) => access.types.has(id)));
  if (keep.size === 0 || keep.size >= access.types.size) return undefined;
  return { access: within(access, keep), objectTypeIds: [...keep].sort() };
}
