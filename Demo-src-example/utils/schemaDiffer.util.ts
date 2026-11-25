/**
 * Telling a rename from a semantic change.
 *
 * THIS IS THE DIFFERENCE BETWEEN A REPAIR AND A HALT, and getting it wrong is
 * expensive in both directions. A field renamed `total` → `total_amount` is the
 * same number and the connector should heal itself. A field whose meaning changed
 * — `total` now excluding tax — is the same name carrying different data, and
 * healing silently would produce figures that are wrong and confident.
 *
 * WHEN IT CANNOT TELL, IT HALTS. An automatic repair applied to a semantic change
 * is the worst outcome available: the connector reports healthy and every figure
 * downstream is quietly incorrect.
 */

export interface FieldShape {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'null';
  nullable: boolean;
  /** A few values, used to judge whether two fields mean the same thing. */
  sample?: unknown[];
}

export type ChangeType =
  | 'added'
  | 'removed'
  | 'renamed'
  | 'type-changed'
  | 'nullability-changed'
  | 'semantics-suspected';

export interface SchemaChange {
  type: ChangeType;
  before?: FieldShape;
  after?: FieldShape;
  confidence: number;
  /** Whether a connector may repair itself, or a human must look. */
  autoRepairable: boolean;
  note: string;
}

/** How alike two field names are, ignoring separators and case. */
function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[_\-.\s]/g, '');
  const left = norm(a);
  const right = norm(b);
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.8;

  const shared = [...left].filter((c) => right.includes(c)).length;
  return shared / Math.max(left.length, right.length);
}

/** Whether two samples look like the same kind of value. */
function samplesAgree(a: unknown[] | undefined, b: unknown[] | undefined): boolean | null {
  if (!a?.length || !b?.length) return null;

  const numbersA = a.filter((v) => typeof v === 'number') as number[];
  const numbersB = b.filter((v) => typeof v === 'number') as number[];

  if (numbersA.length && numbersB.length) {
    const meanA = numbersA.reduce((s, v) => s + v, 0) / numbersA.length;
    const meanB = numbersB.reduce((s, v) => s + v, 0) / numbersB.length;
    if (meanA === 0 && meanB === 0) return true;
    /*
     * A 20% SHIFT IN THE MEAN IS THE TAX TEST. `total` becoming ex-VAT moves it
     * by about a sixth, which is exactly the change no type check would notice
     * and exactly the one that corrupts every figure downstream.
     */
    const ratio = Math.abs(meanA - meanB) / Math.max(Math.abs(meanA), Math.abs(meanB));
    return ratio < 0.2;
  }

  return null;
}

export function diff(before: readonly FieldShape[], after: readonly FieldShape[]): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const afterByPath = new Map(after.map((f) => [f.path, f]));
  const beforeByPath = new Map(before.map((f) => [f.path, f]));

  const matchedAfter = new Set<string>();

  for (const old of before) {
    const current = afterByPath.get(old.path);

    if (current) {
      matchedAfter.add(current.path);

      if (current.type !== old.type) {
        changes.push({
          type: 'type-changed',
          before: old,
          after: current,
          confidence: 1,
          autoRepairable: false,
          note: `${old.path} changed from ${old.type} to ${current.type}.`,
        });
        continue;
      }

      // Same name, same type, different distribution: the dangerous case.
      const agree = samplesAgree(old.sample, current.sample);
      if (agree === false) {
        changes.push({
          type: 'semantics-suspected',
          before: old,
          after: current,
          confidence: 0.6,
          autoRepairable: false,
          note: `${old.path} kept its name and type but its values moved. This may be a change of meaning; it needs a human.`,
        });
        continue;
      }

      if (current.nullable !== old.nullable) {
        changes.push({
          type: 'nullability-changed',
          before: old,
          after: current,
          confidence: 1,
          // Becoming nullable is safe to absorb; ceasing to be is a constraint
          // the source now enforces and we merely observe.
          autoRepairable: current.nullable,
          note: `${old.path} is now ${current.nullable ? 'nullable' : 'non-null'}.`,
        });
      }
      continue;
    }

    // Gone. A rename, or a removal.
    const candidate = after
      .filter((f) => !beforeByPath.has(f.path) && f.type === old.type)
      .map((f) => ({ field: f, score: nameSimilarity(old.path, f.path) }))
      .sort((a, b) => b.score - a.score)[0];

    const renameAgrees = candidate ? samplesAgree(old.sample, candidate.field.sample) : null;

    if (candidate && candidate.score >= 0.6 && renameAgrees !== false) {
      matchedAfter.add(candidate.field.path);
      changes.push({
        type: 'renamed',
        before: old,
        after: candidate.field,
        confidence: candidate.score,
        /*
         * §8 — "The rename-versus-meaning distinction is its own module.
         * ERRING PERMISSIVE SILENTLY CORRUPTS EVERY ANSWER DOWNSTREAM", and
         * this file's own header says "WHEN IT CANNOT TELL, IT HALTS".
         *
         * A NAME IS NOT EVIDENCE ABOUT MEANING. `nameSimilarity` scores a
         * substring match at 0.8, so a source that drops `total` and adds
         * `total_ex_vat` looks like a confident rename — and it is a change of
         * meaning that would make every figure built on `total` silently
         * ex-VAT. The value comparison is what tells the two apart, and it
         * returns `null` whenever either side has no samples.
         *
         * This required only `!== false`, so `null` — cannot tell — auto-applied
         * like agreement. Now the values have to actually AGREE. Where they
         * cannot be compared the rename is still proposed, because it is a
         * plausible one and a person should see it; it is not applied on
         * nobody's authority.
         */
        autoRepairable: candidate.score >= 0.75 && renameAgrees === true,
        note:
          `${old.path} appears to have been renamed to ${candidate.field.path}.` +
          (renameAgrees === true ? '' : ' Its values could not be compared, so this needs a human.'),
      });
    } else {
      changes.push({
        type: 'removed',
        before: old,
        confidence: 1,
        autoRepairable: false,
        note: `${old.path} is gone and nothing resembles it.`,
      });
    }
  }

  for (const field of after) {
    if (!beforeByPath.has(field.path) && !matchedAfter.has(field.path)) {
      changes.push({
        type: 'added',
        after: field,
        confidence: 1,
        // A new field breaks nothing that was already mapped.
        autoRepairable: true,
        note: `${field.path} is new.`,
      });
    }
  }

  return changes;
}

/** Whether the whole diff can be absorbed without asking anybody. */
export function canSelfRepair(changes: readonly SchemaChange[]): boolean {
  return changes.every((c) => c.autoRepairable);
}

/**
 * A field's shape with its samples removed.
 *
 * THE SAMPLES ARE EVIDENCE, NOT A RECORD. They exist so `samplesAgree` can
 * judge whether two fields still mean the same thing, and that judgement is
 * made and finished inside a single comparison. What outlives it is the
 * verdict.
 *
 * ANYTHING PERSISTED OR SENT ANYWHERE GOES THROUGH THIS. `heal_proposals`
 * stored the raw shape for a type change, so up to twenty live values from the
 * drifted column were written into a jsonb column with no expiry and no sweep —
 * the one place the no-data-stored claim was actually false. 046 scrubs what
 * was written and adds a CHECK; this is what stops it being written again, and
 * the CHECK is what stops somebody routing around this.
 */
export function withoutSamples(shape: FieldShape | undefined): Omit<FieldShape, 'sample'> | undefined {
  if (!shape) return undefined;

  const { sample: _judged, ...kept } = shape;
  return kept;
}
