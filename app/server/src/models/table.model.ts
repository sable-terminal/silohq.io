// Shapes shared by the generated models in this folder. Each table has one model file,
// src/models/<schema>/<name>.model.ts, generated from the migrated database by
// npm run db:models.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// How a repo reaches a table. Generated with each model, so SQL text is only ever built
// from these names, never from caller input.
export interface TableSpec<Row> {
  /** schema.table, for messages. */
  readonly table: string;
  /** The quoted table name. */
  readonly sql: string;
  /** The quoted column behind each model property. */
  readonly columns: { readonly [K in keyof Row]-?: string };
  /** Properties stored as jsonb. They are sent as JSON text, so an array stays JSON. */
  readonly json: readonly string[];
  /** The select list, each column aliased to its property. */
  readonly select: string;
}
