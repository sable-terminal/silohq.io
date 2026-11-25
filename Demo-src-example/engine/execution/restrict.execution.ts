/** Any object with named fields — a v1 or a v2 document's. */
type ManifestObject = { fields: Array<{ name: string }>; identifier: string[] };
import type { Query } from './query.execution';

/**
 * Field policy, applied to a query before it is sent.
 *
 * ── Before, not after ──────────────────────────────────────────────────────
 *
 * A hidden field is taken out of what is asked for, and a query that filters or
 * sorts on one is refused — as a field that does not exist, because to this
 * reader it does not. A source that selects fields never sends it.
 *
 * ── And once more on the way back ──────────────────────────────────────────
 *
 * A source that cannot select fields returns whole records whatever was asked
 * for. The hidden field reaches this process then, and goes no further: it is
 * removed from every row before any caller sees one. That is the one place a
 * value is removed after the fact, and it exists because the source gave no
 * way to avoid receiving it, not as the mechanism.
 */

export function restrictQuery(
  object: ManifestObject,
  query: Query,
  hidden: ReadonlySet<string>,
): { ok: true; query: Query } | { ok: false; field: string } {
  if (hidden.size === 0) return { ok: true, query };

  const named = [
    ...query.filters.map((one) => one.field),
    ...query.sort.map((one) => one.field),
    ...query.fields,
  ];
  const refused = named.find((field) => hidden.has(field));
  if (refused) return { ok: false, field: refused };

  /* "Every field" means every field this reader may see, spelled out. */
  const fields =
    query.fields.length > 0 ? query.fields : object.fields.map((field) => field.name).filter((name) => !hidden.has(name));

  return { ok: true, query: { ...query, fields } };
}

export function stripRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  hidden: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  if (hidden.size === 0) return [...rows];

  return rows.map((row) => {
    const copy = structuredClone(row);
    for (const path of hidden) removePath(copy, path.split('.'));
    return copy;
  });
}

function removePath(target: Record<string, unknown>, parts: string[]): void {
  const [head, ...rest] = parts;
  if (head === undefined) return;
  if (rest.length === 0) {
    delete target[head];
    return;
  }
  const next = target[head];
  if (next !== null && typeof next === 'object') removePath(next as Record<string, unknown>, rest);
}
