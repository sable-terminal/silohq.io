// What a dialect means by a catalogue type, where it is not what the type's name says (spec
// 19.4: a promoted finding's fields are typed from its catalogue). Dialects are the SQL
// engine's to tell apart; discovery asks here and types everything else by the name alone.

import type { Dialect } from '../../../../utils/sqlBuilder.util.ts';

export type CatalogueFieldType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'date-time' | 'json';

/**
 * The dialect's own reading of a catalogue type, or undefined to read it by name: Oracle's
 * NUMBER with no scale is an integer and its DATE carries a time; MySQL's tinyint(1) is its
 * boolean.
 */
export function dialectFieldType(sourceType: string, dialect: Dialect): CatalogueFieldType | undefined {
  const t = sourceType.toLowerCase();
  switch (dialect) {
    case 'oracle':
      if (/^number\(\d+(,0)?\)$/.test(t)) return 'integer';
      return t === 'date' ? 'date-time' : undefined;
    case 'mysql':
      return t === 'tinyint(1)' ? 'boolean' : undefined;
    default:
      return undefined;
  }
}
