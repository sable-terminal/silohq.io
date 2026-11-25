import { manifestV2, type Manifest } from '../../schemas/manifest.schema';
import type { SiloDefinition } from '../../schemas/siloDefinition.schema';
import { DATE_FORMATS } from '../../schemas/siloDefinition.schema';
import { coerce } from './tabular.extraction';

/**
 * A definition, as a connector manifest; and a first definition, from a file.
 */

/**
 * §1 — the manifest a published definition becomes.
 *
 * THE QUERY LAYER NEVER SEES A DEFINITION. It sees this: objects, fields,
 * identifiers and relationships, a transport that happens to be `silo_import`,
 * and capabilities stating what the row store can push down. Everything the
 * definition says about extraction stays behind, because a query does not care
 * how a value was read — only, later, how certain it is.
 *
 * APPEND-ONLY, AND RETENTION IS THE SILO'S. Imported rows are never updated in
 * place — a file is a record of what was true when it was exported — and the
 * history detectors are told how far back the rows go, which is the window.
 */
export function manifestFor(
  definition: SiloDefinition,
  input: { sourceId: string; version: number; retentionDays: number },
): Manifest {
  return manifestV2.parse({
    schemaVersion: 2,
    identity: {
      name: definition.identity.name,
      provider: `silo-import-${input.sourceId}`,
      version: input.version,
      ...(definition.identity.description ? { description: definition.identity.description } : {}),
      trustTier: 'private',
    },
    transport: { kind: 'silo_import', sourceId: input.sourceId },
    auth: [],
    credentialSharing: 'shareable',
    objects: definition.objects.map((object) => ({
      name: object.name,
      fields: object.fields.map((f) => ({
        name: f.name,
        type: f.type,
        nullable: f.nullable,
        ...(f.description ? { description: f.description } : {}),
      })),
      identifier: object.identifier,
      relationships: object.relationships,
      available: true,
      history: { appendOnly: true, retentionDays: input.retentionDays },
      /*
       * THE ROW STORE TAKES THE WHOLE QUESTION, so nothing is declared here: a
       * Silo import's pushdown is derived, like a database's. Rows keep their
       * provenance and certainty keys beside the declared fields.
       */
      read: { request: {}, records: '{{ response }}', strictFields: false, pushdown: { maxFilterValues: 10_000 } },
    })),
  });
}

/**
 * A first definition, proposed from a table's header and a sample of its rows.
 *
 * ── No model, and that is the point ────────────────────────────────────────
 *
 * §8: "Tabular import never invokes a model." A spreadsheet's structure is in
 * its header and its cells, so the proposal is inference over those — types
 * from values, an identifier from the first column whose sampled values are all
 * present and all distinct. The person confirms or corrects it in the builder;
 * nothing is published from a proposal nobody looked at.
 *
 * ── Every guess is conservative ─────────────────────────────────────────────
 *
 * A column becomes a number only when every sampled value is one, and a date
 * only when every value parses under one format. A single stray cell makes it a
 * string, which imports and can be corrected; a wrong number type would reject
 * rows at the first exception.
 */
export function inferDefinition(input: {
  name: string;
  objectName: string;
  headers: string[];
  sample: string[][];
  headerRow?: number;
  sheet?: string;
  delimiter?: ',' | ';' | '\t' | '|';
}): SiloDefinition {
  const taken = new Set<string>();
  const columns = input.headers
    .map((header, at) => ({ header, at }))
    .filter(({ header }) => header.trim() !== '');

  const fields = columns.map(({ header, at }) => {
    const values = input.sample.map((row) => row[at] ?? '');
    const present = values.filter((value) => value.trim() !== '');
    const inferred = inferType(present);

    return {
      name: uniqueName(fieldName(header), taken),
      type: inferred.type,
      nullable: present.length < values.length,
      format: inferred.format,
      extraction: { method: 'column' as const, column: header.trim() },
      distinct: new Set(present).size === present.length && present.length === values.length && present.length > 0,
    };
  });

  const identifier = fields.find((f) => f.distinct) ?? fields[0];

  return {
    schemaVersion: 1,
    identity: { name: input.name },
    objects: [
      {
        name: uniqueName(fieldName(input.objectName), new Set()),
        files: {
          pattern: '*',
          headerRow: input.headerRow ?? 1,
          ...(input.sheet ? { sheet: input.sheet } : {}),
          ...(input.delimiter ? { delimiter: input.delimiter } : {}),
        },
        fields: fields.map(({ distinct: _distinct, ...f }) =>
          f.name === identifier?.name ? { ...f, nullable: false } : f,
        ),
        identifier: identifier ? [identifier.name] : [],
        relationships: [],
      },
    ],
  };
}

/**
 * A first definition from a document's labels.
 *
 * STRINGS, NULLABLE, READ TO THE RIGHT OF EACH LABEL. Nothing about a layout
 * says what type a value is, and a guessed number that rejects the next
 * document is worse than a string somebody changes on purpose. The first label
 * is the identifier, because a definition needs one and a person picks the
 * right one in the builder.
 */
export function inferDocumentDefinition(input: { name: string; objectName: string; labels: string[] }): SiloDefinition {
  const taken = new Set<string>();
  const fields = input.labels.map((label, index) => ({
    name: uniqueName(fieldName(label), taken),
    type: 'string' as const,
    nullable: index !== 0,
    format: 'iso' as const,
    extraction: { method: 'labelled' as const, label, direction: 'right' as const },
  }));

  return {
    schemaVersion: 1,
    identity: { name: input.name },
    objects: [
      {
        name: uniqueName(fieldName(input.objectName), new Set()),
        files: { pattern: '*', headerRow: 1 },
        fields,
        identifier: [fields[0]!.name],
        relationships: [],
      },
    ],
  };
}

function inferType(values: string[]): {
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  format: (typeof DATE_FORMATS)[number];
} {
  if (values.length === 0) return { type: 'string', format: 'iso' };

  const all = (type: 'number' | 'boolean' | 'datetime', format: (typeof DATE_FORMATS)[number] = 'iso') =>
    values.every((value) => coerce(value, { type, format }).ok);

  /* Only words make a flag. A column of 1s and 0s stays a number, because it is
     as often a count as a flag, and a count read as a flag loses every 2. */
  if (values.every((value) => /^(true|false|yes|no)$/i.test(value.trim()))) {
    return { type: 'boolean', format: 'iso' };
  }
  if (all('number')) return { type: 'number', format: 'iso' };
  if (all('datetime')) return { type: 'datetime', format: 'iso' };

  /*
   * DAY-FIRST AND MONTH-FIRST ARE ONLY TOLD APART BY A VALUE ABOVE TWELVE. Where
   * both formats parse every value, the column is ambiguous and stays a string
   * for a person to declare — a guess here would be right for one locale and
   * wrong, silently, for the other.
   */
  const dateFormats = DATE_FORMATS.filter((format) =>
    values.every((value) => coerce(value, { type: 'date', format }).ok),
  );
  if (dateFormats.length === 1) return { type: 'date', format: dateFormats[0]! };

  return { type: 'string', format: 'iso' };
}

/** A name the row store accepts, from anything a person called something. */
export function nameFor(text: string): string {
  return uniqueName(fieldName(text), new Set());
}

/** "Invoice No." → "invoice_no". Something a column can be called. */
function fieldName(header: string): string {
  const cleaned = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (cleaned === '') return 'field';
  return /^[a-z_]/.test(cleaned) ? cleaned : `f_${cleaned}`.slice(0, 63);
}

function uniqueName(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base.slice(0, 58)}_${n}`;
  taken.add(candidate);
  return candidate;
}
