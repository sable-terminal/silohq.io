// What the gateway refuses before anything is sent (spec 7.8, 62.2, 62.3). Each refusal is
// recorded in platform.model_calls with its category and never reaches a model.
//
// - record_value_field: something shaped to carry a record value. A findings summary
//   figure from a field the summary does not name (spec 62.3: "a customer's figures cannot
//   reach the model by omission"), or an output schema with examples or defaults, the
//   JSON Schema keywords that exist to hold sample values.
// - redaction_match: the second pass. Every string in the request, keys included, is
//   checked against the value patterns (utils/redaction.util.ts). A match is refused,
//   not stripped, "so an upstream defect is found rather than hidden". A document in the
//   extraction carve-out is the one thing not scanned: it is record values by design.
//
// The refusal names where the match was (a path of schema field names and indices) and
// which kinds matched, never the text.

import { findValuePatterns } from '../../utils/redaction.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { RefusalCategory } from '../../contracts/model-gateway/events.contract.ts';

export interface Refusal {
  category: RefusalCategory;
  error: AppError;
}

// Keywords whose purpose is to hold sample values.
const VALUE_KEYWORDS = new Set(['examples', 'default']);
// Keywords whose members are keyed by the caller's names.
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$|^\d{1,6}$/;

// A path segment as it may appear in an error: a key the caller chose shows as [key].
const segment = (key: string | number): string => (typeof key === 'number' || SAFE_SEGMENT.test(key) ? String(key) : '[key]');

function walk(value: unknown, path: string, visit: (text: string, where: string) => boolean, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === 'string') return visit(value, path);
  if (Array.isArray(value)) return value.some((item, i) => walk(item, `${path}.${i}`, visit, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, child]) =>
      visit(key, `${path}.${segment(key)}`) || walk(child, `${path}.${segment(key)}`, visit, depth + 1));
  }
  return false;
}

/** The first string under parts that matches a value pattern. */
export function redactionRefusal(parts: Readonly<Record<string, unknown>>): Refusal | undefined {
  let found: { where: string; kinds: string[] } | undefined;
  for (const [name, value] of Object.entries(parts)) {
    if (value === undefined) continue;
    walk(value, name, (text, where) => {
      const kinds = findValuePatterns(text);
      if (kinds.length > 0) found = { where, kinds };
      return found !== undefined;
    });
    if (found) break;
  }
  if (!found) return undefined;
  return {
    category: 'redaction_match',
    error: new AppError('validation', `refused: ${found.where} matches a value pattern (${found.kinds.join(', ')}); nothing was sent`, {
      code: 'model.value_pattern', details: { where: found.where, kinds: found.kinds.join(',') },
    }),
  };
}

const recordValueField = (where: string, why: string): Refusal => ({
  category: 'record_value_field',
  error: new AppError('validation', `refused: ${where} ${why}; nothing was sent`, { code: 'model.record_value_field', details: { where } }),
});

/** An output schema keyword that exists to carry sample values. */
export function outputSchemaRefusal(schema: Record<string, unknown>): Refusal | undefined {
  let where: string | undefined;
  const visit = (value: unknown, path: string, depth: number, namesHere: boolean): void => {
    if (where !== undefined || depth > 64 || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}.${i}`, depth + 1, false));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      // Under properties and the like, keys are the caller's names, not keywords.
      if (!namesHere && VALUE_KEYWORDS.has(key)) {
        where = `${path}.${key}`;
        return;
      }
      visit(child, `${path}.${segment(key)}`, depth + 1, !namesHere && NAME_MAPS.has(key));
    }
  };
  visit(schema, 'output.schema', 0, false);
  return where === undefined ? undefined : recordValueField(where, 'is a JSON Schema keyword that carries sample values');
}

/** A findings summary figure from a field the summary does not name. */
export function findingsRefusal(summary: {
  copiedFields: readonly { objectType: string; property: string }[];
  findings: readonly { metrics?: Readonly<Record<string, number>> | undefined }[];
} | undefined): Refusal | undefined {
  if (summary === undefined) return undefined;
  const named = new Set(summary.copiedFields.map((f) => `${f.objectType}.${f.property}`));
  for (const [i, finding] of summary.findings.entries()) {
    for (const key of Object.keys(finding.metrics ?? {})) {
      if (!named.has(key)) return recordValueField(`findingsSummary.findings.${i}.metrics`, 'copies a figure from a field the summary does not name');
    }
  }
  return undefined;
}
