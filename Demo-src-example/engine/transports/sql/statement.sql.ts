import { refusal } from '../../../utils/error.util';
import type { Grammar } from './grammar.sql';

/**
 * A SELECT, an INSERT, an UPDATE or a DELETE, as text and bound values.
 *
 * NAMED COLUMNS RATHER THAN `*`, ALWAYS. `SELECT *` returns whatever the table
 * has today, so a column added upstream silently enters every answer — the
 * change self-heal exists to notice rather than to have happen behind it.
 *
 * A `statement` — a read-only view the connecting admin confirmed — is wrapped
 * as a subquery, so a filter, an order and a limit apply to it exactly as they
 * would to a table.
 */

export interface Where {
  column: string;
  operator: string;
  value: unknown;
}

export interface Statement {
  text: string;
  values: unknown[];
}

const COMPARE: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

export interface AggregateSql {
  kind: 'count' | 'sum' | 'group_by';
  /** The column summed, for `sum` and a `group_by` that sums. */
  column: string | null;
  /** The column grouped by, for `group_by`. */
  by: string | null;
}

export function buildSelect(
  g: Grammar,
  input: {
    schema: string | null;
    table: string | null;
    statement: string | null;
    columns: string[];
    where: Where[];
    order: Array<{ field: string; direction: 'asc' | 'desc' }>;
    limit: number;
    /** A total instead of rows: the database does the counting, past any read ceiling. */
    aggregate?: AggregateSql | null;
  },
): Statement {
  if (input.columns.length === 0 && !input.aggregate) {
    throw refusal({ message: 'Silo will not read a table without naming its columns.', code: 'refusal.request_unbuildable' });
  }
  const values: unknown[] = [];
  const bind = (value: unknown) => g.placeholder(values.push(value));

  let source: string;
  if (input.statement) {
    const inner = input.statement.trim().replace(/;+\s*$/, '');
    if (inner.includes(';')) {
      throw refusal({ message: 'A view statement is one SELECT, with no second statement after it.', code: 'refusal.statement_multiple' });
    }
    source = `(${inner}) ${g.name === 'oracle' ? '' : 'AS '}${g.quoteIdent('silo_view')}`;
  } else if (input.table) {
    source = input.schema ? `${g.quoteIdent(input.schema)}.${g.quoteIdent(input.table)}` : g.quoteIdent(input.table);
  } else {
    throw refusal({ message: 'Say which table, or give a statement.', code: 'refusal.request_unbuildable' });
  }

  const clauses: string[] = [];
  for (const w of input.where) {
    const column = g.quoteIdent(w.column);
    switch (w.operator) {
      case 'is_null':
        clauses.push(w.value === false ? `${column} IS NOT NULL` : `${column} IS NULL`);
        break;
      case 'in':
        clauses.push(g.inList(column, bind, Array.isArray(w.value) ? w.value : [w.value]));
        break;
      case 'contains':
        clauses.push(g.contains(column, bind(`%${String(w.value ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`)));
        break;
      default: {
        const op = COMPARE[w.operator];
        if (!op) throw refusal({ message: `SQL has no operator called ${w.operator}.`, code: 'refusal.request_unbuildable' });
        clauses.push(`${column} ${op} ${bind(w.value)}`);
      }
    }
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const a = input.aggregate;
  if (a) {
    const measure = a.kind === 'count' || !a.column ? 'COUNT(*)' : `SUM(${g.quoteIdent(a.column)})`;
    if (a.kind === 'group_by') {
      if (!a.by) throw refusal({ message: 'A grouped total needs a field to group by.', code: 'refusal.request_unbuildable' });
      const by = g.quoteIdent(a.by);
      return {
        text: g.limit({ head: `SELECT ${by} AS ${g.quoteIdent('key')}, ${measure} AS ${g.quoteIdent('value')}`, rest: ` FROM ${source}${where} GROUP BY ${by}` }, 10_001),
        values,
      };
    }
    return { text: `SELECT ${measure} AS ${g.quoteIdent('value')} FROM ${source}${where}`, values };
  }
  const head = `SELECT ${input.columns.map(g.quoteIdent).join(', ')}`;
  const order = input.order.length > 0 ? ` ORDER BY ${input.order.map((o) => `${g.quoteIdent(o.field)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}` : '';
  return { text: g.limit({ head, rest: ` FROM ${source}${where}${order}` }, input.limit), values };
}

export type WriteKind = 'create' | 'update' | 'delete' | 'upsert';

/**
 * A write, parameterised throughout, returning what the database stored where
 * the dialect can say so — defaults, triggers and coercion all apply between
 * what was sent and what was kept, and verify-writes compares against the
 * latter.
 */
export function buildWrite(
  g: Grammar,
  input: {
    schema: string | null;
    table: string;
    identifier: string[];
    kind: WriteKind;
    values: Record<string, unknown>;
    key: Record<string, unknown>;
  },
): Statement {
  const values: unknown[] = [];
  const bind = (value: unknown) => g.placeholder(values.push(value));
  const table = input.schema ? `${g.quoteIdent(input.schema)}.${g.quoteIdent(input.table)}` : g.quoteIdent(input.table);
  const where = () =>
    input.identifier
      .map((field) => {
        if (!(field in input.key)) throw refusal({ message: `A write needs ${field} to find the record.`, code: 'refusal.identifier_missing' });
        return `${g.quoteIdent(field)} = ${bind(input.key[field])}`;
      })
      .join(' AND ');
  const columns = Object.keys(input.values);
  const returning = g.returning === 'returning' ? ' RETURNING *' : '';

  switch (input.kind) {
    case 'create': {
      const output = g.returning === 'output' ? ' OUTPUT INSERTED.*' : '';
      return {
        text: `INSERT INTO ${table} (${columns.map(g.quoteIdent).join(', ')})${output} VALUES (${columns.map((c) => bind(input.values[c])).join(', ')})${returning}`,
        values,
      };
    }
    case 'update': {
      const output = g.returning === 'output' ? ' OUTPUT INSERTED.*' : '';
      const set = columns.map((c) => `${g.quoteIdent(c)} = ${bind(input.values[c])}`).join(', ');
      return { text: `UPDATE ${table} SET ${set}${output} WHERE ${where()}${returning}`, values };
    }
    case 'delete': {
      const output = g.returning === 'output' ? ' OUTPUT DELETED.*' : '';
      return { text: `DELETE FROM ${table}${output} WHERE ${where()}${returning}`, values };
    }
    case 'upsert': {
      if (g.name === 'postgres') {
        const updates = columns.filter((c) => !input.identifier.includes(c)).map((c) => `${g.quoteIdent(c)} = EXCLUDED.${g.quoteIdent(c)}`);
        return {
          text:
            `INSERT INTO ${table} (${columns.map(g.quoteIdent).join(', ')}) VALUES (${columns.map((c) => bind(input.values[c])).join(', ')}) ` +
            `ON CONFLICT (${input.identifier.map(g.quoteIdent).join(', ')}) ${updates.length > 0 ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING'} RETURNING *`,
          values,
        };
      }
      if (g.name === 'mysql') {
        const updates = columns.filter((c) => !input.identifier.includes(c)).map((c) => `${g.quoteIdent(c)} = VALUES(${g.quoteIdent(c)})`);
        return {
          text: `INSERT INTO ${table} (${columns.map(g.quoteIdent).join(', ')}) VALUES (${columns.map((c) => bind(input.values[c])).join(', ')})${updates.length > 0 ? ` ON DUPLICATE KEY UPDATE ${updates.join(', ')}` : ''}`,
          values,
        };
      }
      /* MERGE: the standard's upsert, which T-SQL, Oracle, DB2 and Teradata all speak. */
      const source = columns.map((c) => `${bind(input.values[c])} AS ${g.quoteIdent(c)}`).join(', ');
      const on = input.identifier.map((c) => `t.${g.quoteIdent(c)} = s.${g.quoteIdent(c)}`).join(' AND ');
      const set = columns.filter((c) => !input.identifier.includes(c)).map((c) => `t.${g.quoteIdent(c)} = s.${g.quoteIdent(c)}`).join(', ');
      const dual = g.name === 'oracle' ? ' FROM DUAL' : g.name === 'db2' ? ' FROM SYSIBM.SYSDUMMY1' : '';
      return {
        text:
          `MERGE INTO ${table} t USING (SELECT ${source}${dual}) s ON (${on})` +
          (set ? ` WHEN MATCHED THEN UPDATE SET ${set}` : '') +
          ` WHEN NOT MATCHED THEN INSERT (${columns.map(g.quoteIdent).join(', ')}) VALUES (${columns.map((c) => `s.${g.quoteIdent(c)}`).join(', ')})${g.name === 'tsql' ? ';' : ''}`,
        values,
      };
    }
  }
}
