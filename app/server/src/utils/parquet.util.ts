// Rows as an Apache Parquet file (spec 2.6: Siloes contents "in their original formats plus
// Parquet"), through hyparquet-writer. A column is BOOLEAN, DOUBLE or STRING by its values;
// an object or array is written as JSON text, so nothing is lost. Columns are the union of
// the rows' keys, in the order first seen.

import { parquetWriteBuffer } from 'hyparquet-writer';

type Row = Readonly<Record<string, unknown>>;

export function rowsToParquet(rows: readonly Row[]): Buffer {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  if (names.length === 0) names.push('empty');
  const columnData = names.map((name) => {
    const values = rows.map((row) => row[name] ?? null);
    const present = values.filter((v) => v !== null);
    if (present.length > 0 && present.every((v) => typeof v === 'boolean')) return { name, data: values as (boolean | null)[], type: 'BOOLEAN' as const };
    if (present.length > 0 && present.every((v) => typeof v === 'number')) return { name, data: values as (number | null)[], type: 'DOUBLE' as const };
    return {
      name, type: 'STRING' as const,
      data: values.map((v) => (v === null ? null : typeof v === 'string' ? v : JSON.stringify(v))),
    };
  });
  return Buffer.from(parquetWriteBuffer({ columnData }));
}
