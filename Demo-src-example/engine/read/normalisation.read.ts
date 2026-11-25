import type { ManifestV2, ObjectV2 } from '../../schemas/manifest.schema';

/**
 * The normalisation rule (MANIFEST-V2 §3.6), checked.
 *
 * ── ONE SPELLING PER TYPE, OR FIELDS CANNOT BE COMPARED ───────────────────
 *
 * Derivation and the AI line fields up across systems. `1250` in one and
 * `12.50` in another are the same invoice only if something divided the
 * first, and `26/09/2026` is not a date anything downstream can sort. A read's
 * output is canonical by rule — money in major units, datetimes and dates in
 * ISO 8601, booleans as booleans — and the `fields` expression is how a
 * connector gets there.
 *
 * ── THE METADATA IS WHAT MAKES THIS CHECKABLE ─────────────────────────────
 *
 * `unit` and `format` say what the SOURCE has. A field that declares a
 * non-canonical source and has no expression turning it into the canonical
 * one is a connector that answers in two spellings, and that is what fails.
 * The builder shows these as warnings while a draft is being written; the
 * conformance suite fails on them for every connector Silo ships.
 */

export interface NormalisationIssue {
  /** Dotted path into the document, e.g. `objects.0.fields.3`, for the builder to attach it to. */
  path: string;
  object: string;
  field: string;
  message: string;
  /** `fail` breaks the rule; `warn` is a spelling that is usually, not always, wrong. */
  severity: 'fail' | 'warn';
}

/** Source spellings that are already canonical, as a `format` might write them. */
const CANONICAL_FORMATS = new Set(['iso8601', 'iso', 'iso-8601', 'rfc3339', 'yyyy-mm-dd']);

type Shape = { fields: Record<string, string> };

/** Every shape a read can take — one operation, one pipeline, or each variant. */
function shapesOf(read: ObjectV2['read']): Shape[] {
  return Array.isArray(read) ? read : [read];
}

/** The reads that produce this field without an expression, by position when there are variants. */
function unexpressed(object: ObjectV2, field: string): number[] {
  return shapesOf(object.read).flatMap((shape, i) => (shape.fields[field] ? [] : [i]));
}

function where(object: ObjectV2, missing: number[]): string {
  return Array.isArray(object.read) ? ` (read variant${missing.length === 1 ? '' : 's'} ${missing.map((i) => i + 1).join(', ')})` : '';
}

export function normalisationIssues(manifest: ManifestV2): NormalisationIssue[] {
  const issues: NormalisationIssue[] = [];

  manifest.objects.forEach((object, o) => {
    object.fields.forEach((field, f) => {
      const at = { path: `objects.${o}.fields.${f}`, object: object.name, field: field.name };
      const missing = unexpressed(object, field.name);
      const format = field.format?.trim().toLowerCase();

      if (field.type === 'money' && field.unit === 'minor' && missing.length > 0) {
        issues.push({
          ...at,
          severity: 'fail',
          message: `${field.name} is in minor units at the source and nothing converts it${where(object, missing)} — add a fields expression such as {{ ${field.name} / 100 }}.`,
        });
      }

      if ((field.type === 'datetime' || field.type === 'date') && format && !CANONICAL_FORMATS.has(format) && missing.length > 0) {
        const canonical = field.type === 'date' ? 'YYYY-MM-DD' : 'ISO 8601';
        issues.push({
          ...at,
          severity: 'fail',
          message: `${field.name} arrives as ${field.format} and nothing turns it into ${canonical}${where(object, missing)} — add a fields expression for it.`,
        });
      }

      if (field.type === 'boolean') {
        shapesOf(object.read).forEach((shape) => {
          const expression = shape.fields[field.name];
          if (expression && /\$boolean\s*\(/.test(expression)) {
            issues.push({
              ...at,
              severity: 'warn',
              message: `${field.name} uses $boolean, which is true for any non-empty text — "false" and "N" included. Compare instead, e.g. {{ ${field.name} = "true" }}.`,
            });
          }
        });
      }
    });
  });

  return issues;
}
