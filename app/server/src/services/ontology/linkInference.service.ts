// Inferred links (decision 2026-11-11; D75), only where the organisation turns link inference
// on. The spec's rule is that links are read from keys the sources declare, never inferred;
// with the switch on, derivation also proposes, for objects of one connection with no declared
// key between them, a link where a field's values are nearly all the other object's
// identifiers. Each is a decision a person accepts, corrects or rejects; nothing exists until
// they do, and an accepted one keeps its route's origin as inferred.
//
// The evidence is value containment: of the field's distinct values (a bounded read, at most
// READ_ROWS records of each object), how many are identifiers of the other object. It counts
// as a link where the chance that at least MIN_CONTAINMENT of its values are identifiers is at
// least CREDIBILITY (a uniform prior), so a few values that happen to match never do. The
// field must be of the identifier's type and have at least MIN_DISTINCT distinct values.
// Values live only in this process's memory for the derivation.

import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import { probabilityAbove } from '../../utils/bayes.util.ts';
import type { Context, OntologyDeps } from './deps.service.ts';
import type { SourceSchema } from './sourceSchema.service.ts';

export const READ_ROWS = 5_000;
export const MIN_CONTAINMENT = 0.9;
export const CREDIBILITY = 0.9;
export const MIN_DISTINCT = 10;

export interface InferredLink {
  holder: string;
  field: string;
  target: string;
  targetField: string;
  contained: number;
  distinct: number;
  probability: number;
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() || null);

/** The judgement on one candidate (pure): its probability, or undefined where it is not a link. */
export function judgeContainment(values: readonly (string | null)[], identifiers: ReadonlySet<string>): { contained: number; distinct: number; probability: number } | undefined {
  const distinct = new Set(values.filter((v): v is string => v !== null));
  if (distinct.size < MIN_DISTINCT) return undefined;
  const contained = [...distinct].filter((v) => identifiers.has(v)).length;
  const probability = probabilityAbove(MIN_CONTAINMENT, contained, distinct.size);
  return probability >= CREDIBILITY ? { contained, distinct: distinct.size, probability: Math.round(probability * 10_000) / 10_000 } : undefined;
}

/** Candidates across one connection's objects with no declared key between them. */
export async function inferLinks(deps: OntologyDeps, ctx: Context, source: SourceSchema): Promise<InferredLink[]> {
  const read = async (object: string, fields: string[]): Promise<Record<string, unknown>[]> => {
    try {
      const out = await deps.services.call(readObject, {
        body: { connectionId: source.connectionId, reason: 'query', step: { object, fields, limit: READ_ROWS } },
      }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 60_000 });
      return out.rows;
    } catch (error) {
      deps.logger.warn('an object could not be read for link inference', { event: 'ontology.link_inference_unread', resourceType: 'connection', resourceId: source.connectionId });
      return [];
    }
  };
  const declared = new Set(source.objects.flatMap((o) => o.relationships.map((r) => `${o.name}.${r.field}`)));
  const identifiers = new Map<string, Set<string>>();
  const out: InferredLink[] = [];
  for (const target of source.objects.filter((o) => o.identifier.length === 1)) {
    const targetField = target.identifier[0]!;
    const targetType = target.fields.find((f) => f.name === targetField)?.type;
    for (const holder of source.objects.filter((o) => o.name !== target.name)) {
      const candidates = holder.fields.filter((f) => f.type === targetType && !holder.identifier.includes(f.name) && !declared.has(`${holder.name}.${f.name}`));
      if (candidates.length === 0) continue;
      if (!identifiers.has(target.name)) {
        identifiers.set(target.name, new Set((await read(target.name, [targetField])).map((r) => text(r[targetField])).filter((v): v is string => v !== null)));
      }
      const ids = identifiers.get(target.name)!;
      if (ids.size === 0) continue;
      const rows = await read(holder.name, candidates.map((f) => f.name));
      for (const f of candidates) {
        const judged = judgeContainment(rows.map((r) => text(r[f.name])), ids);
        if (judged !== undefined) out.push({ holder: holder.name, field: f.name, target: target.name, targetField, ...judged });
      }
    }
  }
  return out;
}
