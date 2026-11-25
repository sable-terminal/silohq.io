import { z } from 'zod';

/**
 * §4 — the structuring definition.
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 *
 * The objects a set of files holds, their fields and types, the fields that
 * identify a record, and — per field — how the value is extracted. It is the
 * import's equivalent of a connector manifest, and publishing one produces a
 * manifest: the query layer only ever sees that.
 *
 * ── Validated on the way in, rejected rather than repaired ─────────────────
 *
 * Exactly as a manifest is. A definition patched into validity here would be a
 * structure its author did not write, extracting values nobody asked for.
 *
 * ── Names are identifiers ───────────────────────────────────────────────────
 *
 * Object and field names become column names in the row store, and BigQuery
 * accepts letters, digits and underscores. The file's own header — "Invoice
 * No." — lives in `extraction.column`, where it can say anything.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const name = z
  .string()
  .regex(NAME, 'Use letters, digits and underscores, starting with a letter, at most 63 characters.');

/**
 * How one field's value is got out of a file.
 *
 * §5 — EVERY METHOD HAS A CERTAINTY, AND THIS IS WHERE IT COMES FROM. A column
 * read from a spreadsheet is `certain`. The document methods are added with the
 * phases that implement them, so no definition can describe an extraction the
 * engine does not perform.
 */
export const extraction = z.discriminatedUnion('method', [
  /* A spreadsheet's column, or a column of a table in a PDF, by its heading. */
  z.object({ method: z.literal('column'), column: z.string().min(1).max(256) }).strict(),
  /*
   * §3 — a document's labelled field: the text beside the label, or beneath it.
   * `page` pins it to one page, for documents that repeat a label on each.
   */
  z
    .object({
      method: z.literal('labelled'),
      label: z.string().trim().min(1).max(200),
      direction: z.enum(['right', 'below']).default('right'),
      page: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  /*
   * §3 — prose: a question the model answers from a document's text. Only read
   * where the organisation has chosen to send documents to a model (§8).
   */
  z.object({ method: z.literal('prose'), question: z.string().trim().min(1).max(500) }).strict(),
]);

export const DATE_FORMATS = ['iso', 'dd/mm/yyyy', 'mm/dd/yyyy', 'yyyymmdd'] as const;

const field = z
  .object({
    name,
    type: z.enum(['string', 'number', 'boolean', 'date', 'datetime', 'json']),
    nullable: z.boolean().default(true),
    /*
     * HOW THE FILE WRITES A DATE, SAID RATHER THAN GUESSED. 03/04/2021 is the
     * third of April in Leeds and the fourth of March in Boston, and a guess is
     * right for exactly one of them while looking right to both.
     */
    format: z.enum(DATE_FORMATS).default('iso'),
    description: z.string().max(500).optional(),
    extraction,
  })
  .strict();

const files = z
  .object({
    /** Which of the source's files this object is read from. `*` for all of them. */
    pattern: z.string().min(1).max(200).default('*'),
    /** Spreadsheets: which sheet. The first, if not said. */
    sheet: z.string().min(1).max(128).optional(),
    /** Which row holds the column names. Exports often start with a title block. */
    headerRow: z.number().int().min(1).max(1000).default(1),
    /** Text files: the separator. Detected from the header row when not said. */
    delimiter: z.enum([',', ';', '\t', '|']).optional(),
  })
  .strict();

const relationship = z
  .object({ field: name, targetObject: name, targetField: name })
  .strict();

const object = z
  .object({
    name,
    description: z.string().min(1).max(500).optional(),
    files: files.default(() => files.parse({})),
    fields: z.array(field).min(1).max(200),
    /** An array from the start, like a manifest's: composite keys are normal. */
    identifier: z.array(name).min(1),
    relationships: z.array(relationship).default([]),
  })
  .strict();

export const siloDefinition = z
  .object({
    schemaVersion: z.literal(1),
    identity: z
      .object({
        name: z.string().min(1).max(128),
        description: z.string().min(1).max(2000).optional(),
      })
      .strict(),
    objects: z.array(object).min(1).max(50),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const objects = new Map<string, Set<string>>();

    doc.objects.forEach((one, at) => {
      if (objects.has(one.name)) {
        ctx.addIssue({ code: 'custom', path: ['objects', at, 'name'], message: `${one.name} is declared twice.` });
      }

      const fields = new Set<string>();
      one.fields.forEach((f, index) => {
        if (fields.has(f.name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['objects', at, 'fields', index, 'name'],
            message: `${one.name} has two fields called ${f.name}.`,
          });
        }
        fields.add(f.name);
      });
      objects.set(one.name, fields);

      /*
       * ONE WAY OF READING PER OBJECT. Columns are a table's, labels a form's,
       * and an object mixing them would be two records pretending to be one.
       */
      if (new Set(one.fields.map((f) => f.extraction.method)).size > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['objects', at, 'fields'],
          message: `${one.name} reads some fields by column and some by label. Make them separate objects.`,
        });
      }

      /* An identifier that is not a field identifies nothing. */
      one.identifier.forEach((id, index) => {
        if (!fields.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['objects', at, 'identifier', index],
            message: `${id} is not a field of ${one.name}.`,
          });
        }
      });

      one.relationships.forEach((rel, index) => {
        if (!fields.has(rel.field)) {
          ctx.addIssue({
            code: 'custom',
            path: ['objects', at, 'relationships', index, 'field'],
            message: `${rel.field} is not a field of ${one.name}.`,
          });
        }
      });
    });

    /* A relationship into nothing is checked once every object is known. */
    doc.objects.forEach((one, at) => {
      one.relationships.forEach((rel, index) => {
        const target = objects.get(rel.targetObject);
        if (!target || !target.has(rel.targetField)) {
          ctx.addIssue({
            code: 'custom',
            path: ['objects', at, 'relationships', index, 'targetField'],
            message: `${rel.targetObject}.${rel.targetField} is not declared in this definition.`,
          });
        }
      });
    });
  });

export type SiloDefinition = z.infer<typeof siloDefinition>;
export type DefinitionObject = SiloDefinition['objects'][number];
export type DefinitionField = DefinitionObject['fields'][number];
