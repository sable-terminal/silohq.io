/**
 * Turning what discovery saw into the start of a manifest.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * §9.3 has the agent report structure — schema, columns, types, foreign keys,
 * row counts — and `discovery_candidates.structure` stores it. Promotion then
 * created a draft containing `{ schemaVersion: 1 }` and nothing else, so
 * everything the agent went to the customer's network to learn was thrown away
 * at the one moment it could have been used.
 *
 * FOREIGN KEYS ARE WHAT WAS BEING LOST, and §2.2 calls them the highest-value
 * input to ontology derivation — "the primary reason agent discovery matters
 * beyond convenience". A draft carrying them lets derivation propose concepts
 * the moment the connector is finished; a draft without them means somebody
 * retypes a data model that was already read once.
 *
 * ── It fills a form in; it does not finish one ─────────────────────────────
 *
 * What comes out is a PARTIAL manifest and is never valid on its own: there is
 * no transport here, no auth, no base URL, no pagination. Discovery saw a shape
 * on a network. It did not see a credential, an address that works from Silo's
 * side, or whether any of it is what somebody wants queried — so this opens in
 * the builder, exactly as promotion already intended.
 *
 * ── Forgiving about names, strict about meaning ────────────────────────────
 *
 * `structureOnly` in the discovery service admits several spellings of the same
 * idea — `tables` or `schemas`, `columns` or `fields`, `foreignKeys` or
 * `relationships` — because different agent versions and different catalogues
 * phrase it differently. Reading all of them here is cheaper than a migration
 * every time one changes, and the allow-list has already guaranteed the one
 * thing that matters: none of these can carry a value out of a customer's data.
 */

/**
 * Keys that describe shape, and nothing that could carry a value.
 *
 * AN ALLOW-LIST, NEVER A DENY-LIST. A deny-list works until an agent version
 * sends a key nobody thought of, and the failure mode of a forgotten deny-list
 * entry is customer data silently stored — while the failure mode of a
 * forgotten allow-list entry is a missing detail somebody notices.
 *
 * IT LIVES BESIDE THE READER RATHER THAN INSIDE THE DISCOVERY SERVICE, because
 * a key this list drops is a key `objectsFrom` can never see. They were in two
 * files and the foreign-key target names were missing from this one, so every
 * relationship an agent reported arrived holding its local column and nothing
 * to point it at — read one way the list is a privacy control, read the other
 * it is the schema of what discovery is allowed to know.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'schema', 'schemas', 'table', 'tables', 'column', 'columns', 'type', 'types',
  'nullable', 'primaryKey', 'foreignKeys', 'indexes', 'rowCount', 'rowCounts',
  'endpoint', 'endpoints', 'paths', 'operations', 'version', 'product', 'edition',
  'driver', 'database', 'databases', 'name', 'port', 'protocol', 'tlsVersion',
  'fields', 'relationships', 'objectCount', 'sizeBytes',
  /*
   * The far side of a foreign key. Every one of these is the NAME of a table or
   * a column — the same kind of thing as `table` and `column`, which were
   * already here, and no more capable of carrying a row than they are.
   *
   * Generic phrasings like `from`, `to` and `target` are deliberately absent:
   * an allow-list is only worth having while every entry is obviously a name,
   * and those three are not.
   */
  'field', 'references', 'referencedTable', 'referencedColumn',
  'targetObject', 'targetField', 'targetTable', 'targetColumn',
]);

/**
 * Strip anything that is not shape.
 *
 * DEPTH AND WIDTH ARE BOUNDED. An agent is a program on somebody else's network
 * and the server must not depend on it behaving — a deeply nested or enormous
 * report is refused its tail rather than allowed to exhaust this process.
 */
export function structureOnly(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.slice(0, 500).map((v) => structureOnly(v, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => STRUCTURAL_KEYS.has(key))
      .map(([key, v]) => [key, structureOnly(v, depth + 1)]),
  );
}

type Bag = Record<string, unknown>;

const isBag = (value: unknown): value is Bag =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): Bag[] =>
  Array.isArray(value) ? value.filter(isBag) : [];

/** The first of these keys that holds an array of objects. */
function pick(bag: Bag, keys: string[]): Bag[] {
  for (const key of keys) {
    const found = asArray(bag[key]);
    if (found.length > 0) return found;
  }
  return [];
}

function nameOf(bag: Bag): string | null {
  for (const key of ['name', 'table', 'column', 'endpoint']) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * A source's own type name, mapped onto the seven the manifest knows.
 *
 * UNKNOWN IS A REAL ANSWER AND THE DEFAULT. The manifest has an `unknown` type
 * precisely so a draft does not have to lie; guessing `string` because nothing
 * matched would put a wrong answer in a field nobody will look at again.
 */
function typeOf(raw: unknown): 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'unknown' {
  if (typeof raw !== 'string') return 'unknown';
  const type = raw.toLowerCase();

  if (/bool/.test(type)) return 'boolean';
  if (/timestamp|datetime/.test(type)) return 'datetime';
  if (/date/.test(type)) return 'date';
  if (/json|jsonb|object|record/.test(type)) return 'json';
  if (/int|serial|numeric|decimal|float|double|real|money|number/.test(type)) return 'number';
  if (/char|text|string|uuid|enum|clob/.test(type)) return 'string';

  return 'unknown';
}

type DraftRelationship = { field: string; targetObject: string; targetField: string };

/**
 * Foreign keys, however the catalogue phrased them.
 *
 * BOTH SIDES OR NOTHING. A relationship missing its target field cannot be
 * followed, and a manifest carrying half of one would fail validation in the
 * builder with an error about a field the person never typed.
 */
function relationshipsOf(table: Bag): DraftRelationship[] {
  const raw = [...asArray(table.foreignKeys), ...asArray(table.relationships)];
  const links: DraftRelationship[] = [];

  for (const link of raw) {
    const field = firstString(link, ['field', 'column', 'name']);
    const targetObject = firstString(link, [
      'targetObject', 'targetTable', 'referencedTable', 'references', 'table',
    ]);
    /*
     * `column` IS NOT A CANDIDATE FOR THE TARGET, and that is not a detail. It
     * is the name of the LOCAL column in every catalogue that uses it, so
     * falling back to it produces a relationship pointing a field at itself —
     * which derivation would then read as structural agreement between two
     * objects that share nothing. A key nobody named is better missing.
     */
    const targetField = firstString(link, [
      'targetField', 'targetColumn', 'referencedColumn', 'primaryKey',
    ]);

    if (!field || !targetObject || !targetField) continue;

    links.push({ field, targetObject, targetField });
  }

  /* Deduplicated on the whole triple: a composite key reported once per column
     is one relationship per column, not the same one three times. */
  return [...new Map(links.map((link) => [JSON.stringify(link), link])).values()];
}

function firstString(bag: Bag, keys: string[]): string | null {
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

export type DraftObject = {
  name: string;
  /** How it is read: the table for a database, the path for an API. */
  read: { request: { table: string } | { path: string } };
  fields: Array<{ name: string; type: ReturnType<typeof typeOf>; nullable: boolean }>;
  identifier: string[];
  relationships: DraftRelationship[];
  available: boolean;
};

/**
 * The objects discovery saw, as far as a manifest can express them.
 *
 * AN OBJECT WITH NO IDENTIFIER IS STILL WORTH CARRYING. The manifest requires
 * one and the builder will ask for it; dropping the table here because the
 * catalogue did not report a primary key would hide the table instead of asking
 * the one question somebody can answer in a second. `identifier` comes out
 * empty, the draft is invalid, and the form says which field it needs — which
 * is what a draft is for.
 */
export function objectsFrom(structure: unknown): DraftObject[] {
  if (!isBag(structure)) return [];

  const tables = [
    ...pick(structure, ['tables', 'objects']),
    /* A catalogue that nested tables under schemas. */
    ...pick(structure, ['schemas']).flatMap((schema) => pick(schema, ['tables', 'objects'])),
    /* An HTTP surface, where the endpoints are the objects. */
    ...pick(structure, ['endpoints', 'paths', 'operations']),
  ];

  const objects: DraftObject[] = [];

  for (const table of tables) {
    const name = nameOf(table);
    if (!name) continue;

    const columns = pick(table, ['columns', 'fields']);

    const fields = columns
      .map((column) => ({
        name: nameOf(column),
        type: typeOf(column.type),
        nullable: column.nullable === undefined ? true : Boolean(column.nullable),
        primary: Boolean(column.primaryKey),
      }))
      .filter((field): field is typeof field & { name: string } => field.name !== null);

    /* The catalogue's own path where it gave one — an API — and the table name where it did not. */
    const path = firstString(table, ['endpoint', 'path']);
    objects.push({
      name,
      read: { request: path ? { path: path.startsWith('/') ? path : `/${path}` } : { table: name } },
      fields: fields.map(({ name: field, type, nullable }) => ({ name: field, type, nullable })),
      identifier: fields.filter((field) => field.primary).map((field) => field.name),
      relationships: relationshipsOf(table),
      /*
       * NOTHING PROMOTED FROM DISCOVERY IS AVAILABLE YET. Nobody has run a query
       * against it, and `available` means "this can be queried" rather than
       * "this was seen". The builder flips it when verification passes.
       */
      available: false,
    });
  }

  return [...new Map(objects.map((object) => [object.name, object])).values()];
}

/**
 * The draft document a promoted finding opens as.
 *
 * `schemaVersion` IS THE CALLER'S, NOT A CONSTANT HERE. The service knows which
 * version this process writes; a second copy of that number in the engine is a
 * second thing to remember when it changes.
 */
/** Kinds a discovery agent may still propose by their version 1 names. */
const V2_KIND: Record<string, string> = { sql_odbc: 'sql', sql_jdbc: 'sql', sftp_file: 'sftp' };

export function draftFrom(
  structure: unknown,
  input: { schemaVersion: number; transport?: string | null },
): Record<string, unknown> {
  const objects = objectsFrom(structure);

  return {
    schemaVersion: input.schemaVersion,
    /*
     * THE PROPOSED TRANSPORT IS A KIND AND NOTHING ELSE, because everything a
     * transport needs beyond its kind — a host, a URL, a driver — is either a
     * credential or a decision, and discovery made neither. The builder's form
     * is generated from the kind, so naming it is what turns a blank page into
     * the right set of questions.
     */
    ...(input.transport ? { transport: { kind: V2_KIND[input.transport] ?? input.transport } } : {}),
    ...(objects.length > 0 ? { objects } : {}),
  };
}
