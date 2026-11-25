// What identity is made of (spec 23.1, 24.7): the normalised match key of a record, the
// Silo object identifier derived from it, and the shape of a key for the model. Pure.
//
// - A record's key is the type's match key properties in their declared order, each
//   normalised by the type's declared CEL normalisation (null keeps the value) and then by
//   every confirmed normalisation rule of the type, oldest first. The composite is its JSON
//   array text, hashed under the organisation key (credential service): equal composites,
//   equal hashes, the same object. A component that is missing, empty or fails to
//   normalise leaves the record unkeyed: it is its own object, never merged by a guess.
// - silo_object_id = UUIDv5(organisation namespace, object_type_id ":" sorted key hashes).
//   The organisation namespace is UUIDv5(Silo's namespace, organisation_id). A single-source
//   type, and an unkeyed record, is keyed by its source identifier hash. Recorded on first
//   resolution and never recomputed; when the derived id is already taken by another object
//   (after a remap), a counter is appended until it is free.
// - A key's shape is its runs of character classes (U upper, L lower, D digit, X other)
//   with separators shown as themselves: what the model may see (spec 23.2), never a key.

import { AppError } from '../../utils/errors.util.ts';
import {
  identifierText as keyedIdentifier, organisationNamespace, SILO_NAMESPACE, siloObjectIdOf, sourceIdentifierHash, sourceKeyText, uuidv5,
} from '../../utils/siloObjectId.util.ts';
import { compileCel, type CompiledCel } from '../expression-evaluator/cel.service.ts';

// One derivation for every service (utils/siloObjectId.util.ts); re-exported for this service's callers.
export { organisationNamespace, SILO_NAMESPACE, sourceIdentifierHash, uuidv5 };

/** The derived id of an object first resolved with these key hashes; attempt > 0 when an earlier one is taken. */
export const deriveSiloObjectId = siloObjectIdOf;

// ----------------------------------------------------------------------------- normalisation

const BOUNDS = { steps: 2_000, timeMs: 5 };
const compiled = new Map<string, CompiledCel>();

/** A normalisation expression, compiled once per process. Throws validation when it does not check. */
export function normaliser(cel: string): CompiledCel {
  let found = compiled.get(cel);
  if (found === undefined) {
    found = compileCel(cel, { value: 'string' });
    if (compiled.size > 1_000) compiled.clear();
    compiled.set(cel, found);
  }
  return found;
}

/** A raw source value as key text: strings as they are, numbers and booleans as text, anything else is no key. */
export function keyText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'bigint') return raw.toString();
  return undefined;
}

/** Applies the expressions in order. Undefined when a step fails or yields something other than non-empty text. */
export function applyNormalisations(value: string, expressions: readonly CompiledCel[]): string | undefined {
  let current = value;
  for (const expression of expressions) {
    let out: unknown;
    try {
      out = expression.evaluate({ value: current }, BOUNDS);
    } catch {
      return undefined;
    }
    if (typeof out !== 'string') return undefined;
    current = out;
  }
  return current.length === 0 ? undefined : current;
}

export interface KeyPlan {
  /** Per match key, in order: the property identity and its own normalisation. */
  components: { propertyIdentityId: string; normalise: CompiledCel[] }[];
}

/** The key plan of a type: each component's declared normalisation, then the confirmed rules. */
export function keyPlan(matchKeys: readonly { propertyIdentityId: string; normalisation: string | null }[], rules: readonly string[]): KeyPlan {
  const ruleSteps = rules.map((cel) => normaliser(cel));
  return {
    components: matchKeys.map((k) => ({
      propertyIdentityId: k.propertyIdentityId,
      normalise: [...(k.normalisation === null ? [] : [normaliser(k.normalisation)]), ...ruleSteps],
    })),
  };
}

/** The normalised components of a record, or undefined when it cannot be keyed. */
export function normalisedComponents(plan: KeyPlan, values: Readonly<Record<string, unknown>>): string[] | undefined {
  const out: string[] = [];
  for (const component of plan.components) {
    const text = keyText(values[component.propertyIdentityId]);
    if (text === undefined) return undefined;
    const normalised = applyNormalisations(text, component.normalise);
    if (normalised === undefined) return undefined;
    out.push(normalised);
  }
  return out;
}

/** The text that is hashed for a composite key. */
export const compositeKey = (components: readonly string[]): string => JSON.stringify(components);

/** The text hashed for a record keyed by its source identifier (single-source types, unkeyed records). Never equals a composite. */
export const sourceKey = sourceKeyText;

/** A source identifier as text, the form that is hashed. */
export function identifierText(raw: unknown): string {
  const text = keyedIdentifier(raw);
  if (text === undefined) {
    throw new AppError('validation', 'a row has no source identifier', { code: 'resolution.identifier_missing' });
  }
  return text;
}

// ----------------------------------------------------------------------------- shapes

const SEPARATORS = new Set([' ', '-', '.', '/', '_', ':', ',']);

/** The shape of a key: class runs with counts, separators as themselves. "U2-D9" for a two-letter, nine-digit key. */
export function keyShape(value: string): string {
  let shape = '';
  let run = '';
  let count = 0;
  const flush = () => {
    if (count > 0) shape += `${run}${count}`;
    run = '';
    count = 0;
  };
  for (const ch of value) {
    if (SEPARATORS.has(ch)) {
      flush();
      shape += ch === ' ' ? '␣' : ch;
      continue;
    }
    const cls = ch >= 'A' && ch <= 'Z' ? 'U' : ch >= 'a' && ch <= 'z' ? 'L' : ch >= '0' && ch <= '9' ? 'D' : 'X';
    if (cls !== run) flush();
    run = cls;
    count += 1;
  }
  flush();
  return shape;
}
