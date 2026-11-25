import type { ForeignKey, Table } from '../transports/sql/catalogue.sql';
import { slug, type Compiled } from './shared.compile';

/**
 * A database's catalogue — its tables, columns, keys and references — as a
 * version 2 draft.
 *
 * A DATABASE NEEDS THE LEAST WRITTEN. Every filter, sort, limit and total is
 * derived from the columns by the SQL transport itself, so an object is a
 * table, its fields its columns and its identifier its primary key; a foreign
 * key is a relationship the ontology can walk. The host and database are
 * parameters, asked for when connecting.
 */

type Driver = 'pg' | 'mysql2' | 'mssql' | 'oracledb' | 'odbc';
type Grammar = 'postgres' | 'mysql' | 'tsql' | 'oracle' | 'db2' | 'informix' | 'teradata' | 'ansi';

const PORTS: Partial<Record<Driver, number>> = { pg: 5432, mysql2: 3306, mssql: 1433, oracledb: 1521 };

export function compileCatalogue(
  catalogue: { tables: Table[]; foreignKeys?: ForeignKey[] | null },
  options: { name: string; driver: Driver; grammar: Grammar; schema?: string; viaAgent?: boolean },
): Compiled {
  const notes: string[] = [];
  const objects = catalogue.tables.map((table) => {
    let identifier = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
    if (identifier.length === 0) {
      /* Every column together identifies a row of a table that allows no duplicates; the person narrows it. */
      identifier = table.columns.slice(0, 8).map((c) => c.name);
      notes.push(`${table.name} has no primary key, so all its columns together identify a row until you choose which do.`);
    }
    const relationships = (catalogue.foreignKeys ?? [])
      .filter((fk) => fk.fromTable === table.name)
      .map((fk) => ({ field: fk.fromColumn, targetObject: fk.toTable, targetField: fk.toColumn }));
    return {
      name: table.name,
      identifier,
      fields: table.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable })),
      relationships,
      read: { request: { table: table.name } },
    };
  });
  if (objects.length === 0) notes.push('The schema holds no tables this account can see.');
  return {
    document: {
      schemaVersion: 2,
      identity: { name: options.name.slice(0, 128), provider: slug(options.name), version: 1 },
      transport: {
        kind: 'sql',
        driver: options.driver,
        grammar: options.grammar,
        host: '{{ params.host }}',
        port: '{{ params.port }}',
        database: '{{ params.database }}',
        schema: options.schema ?? (options.grammar === 'postgres' ? 'public' : '{{ params.schema }}'),
        ...(options.viaAgent ? { via: { agent: true } } : {}),
      },
      parameters: {
        host: { label: 'Database host' },
        port: { label: 'Port', ...(PORTS[options.driver] ? { default: String(PORTS[options.driver]) } : {}) },
        database: { label: 'Database name' },
        ...(options.schema || options.grammar === 'postgres' ? {} : { schema: { label: 'Schema' } }),
      },
      auth: [{ strategy: 'basic' }],
      objects,
    },
    notes,
  };
}
