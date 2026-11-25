/**
 * What every compiler shares: turning a specification's words into a
 * document's — object names, field types, identifiers.
 *
 * ── A COMPILER WRITES A DRAFT, NEVER A CONNECTOR ──────────────────────────
 *
 * What a specification says is the system's claim about itself, and claims
 * are incomplete: an OpenAPI document with no paging parameters, a GraphQL
 * schema that says nothing about authentication. So a compiler's output is a
 * v2 document for the builder, with `notes` saying what it could not know —
 * and a probe against the live system is what turns it into a connector.
 */

export interface Compiled {
  document: Record<string, unknown>;
  /** What the compiler chose, skipped or could not tell, in the builder's words. */
  notes: string[];
}

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'money' | 'json' | 'unknown';

export interface CompiledField {
  name: string;
  type: FieldType;
  /** How the field is read from a record, when not simply by its name. */
  expression?: string;
}

/** `invoices` → `invoice`, `categories` → `category`, `Orders` → `order`. */
export function singular(word: string): string {
  const w = word.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const lower = w.charAt(0).toLowerCase() + w.slice(1);
  /* Words that are already one of themselves. */
  if (/(news|series|species|data|media|metadata|analytics|settings|status|info|stock|inventory|equipment|feedback)$/i.test(lower)) return lower;
  if (/[^aeiou]ies$/i.test(lower)) return `${lower.slice(0, -3)}y`;
  if (/(ss|us|is)$/i.test(lower)) return lower;
  /* addresses, statuses, boxes, batches, dishes — but houses, cases, licences keep their e */
  if (/(sses|[^o]uses|xes|zes|ches|shes)$/i.test(lower)) return lower.slice(0, -2);
  if (/s$/i.test(lower) && lower.length > 3) return lower.slice(0, -1);
  return lower;
}

/** An identity provider slug: `Acme Stock API` → `acme-stock-api`. */
export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'connector';

/** A parameter name the schema accepts: lower_snake_case. */
export const parameterName = (text: string): string =>
  (text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'p_$1') || 'value').slice(0, 64);

/** A key as JSONata reads it: bare when it can be, backticked when it cannot. */
export const keyPath = (key: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `\`${key.replace(/`/g, '')}\``);

/** The field most likely to identify a record. */
export function identifierOf(fields: string[], objectName: string): string[] {
  const lower = new Map(fields.map((f) => [f.toLowerCase(), f]));
  for (const candidate of ['id', `${objectName.toLowerCase()}_id`, `${objectName.toLowerCase()}id`, 'uuid', 'guid', 'key', 'code', 'number']) {
    const hit = lower.get(candidate);
    if (hit) return [hit];
  }
  const suffixed = fields.find((f) => /(^|_)id$|Id$/.test(f));
  return suffixed ? [suffixed] : fields.slice(0, 1);
}

/** Field names made unique and non-empty, as a document needs them. */
export function uniqueNames<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.name || seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

/** The fields block and the `fields` expressions a read needs for them. */
export function fieldsBlock(fields: CompiledField[]): { fields: Array<{ name: string; type: FieldType }>; expressions: Record<string, string> } {
  const unique = uniqueNames(fields);
  return {
    fields: unique.map((f) => ({ name: f.name, type: f.type })),
    expressions: Object.fromEntries(unique.filter((f) => f.expression).map((f) => [f.name, f.expression!])),
  };
}

/** Names that suggest a record's time, so filters on them are offered as ranges. */
export const looksTemporal = (name: string): boolean => /(^|_)(created|updated|modified|changed|date|time|at|on|since)(_|$)|At$|On$|Date$|Time$/.test(name);
