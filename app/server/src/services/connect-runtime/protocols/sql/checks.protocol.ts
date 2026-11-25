// The SQL engine's own manifest checks: the dialect is one of its grammars, and every
// identifier the manifest names can be quoted by it.

import type { Manifest } from '../../../../contracts/connect/manifest.contract.ts';
import { DIALECTS, ident, render, sql, type Dialect } from '../../../../utils/sqlBuilder.util.ts';
import type { ProtocolIssue } from '../checks.protocol.ts';

export const isDialect = (value: string): value is Dialect => (DIALECTS as readonly string[]).includes(value);

export function sqlChecks(manifest: Manifest): ProtocolIssue[] {
  if (manifest.protocol.kind !== 'sql') return [];
  const dialect = manifest.protocol.dialect;
  if (!isDialect(dialect)) {
    return [{ path: 'protocol.dialect', code: 'manifest.dialect_unknown', message: 'the SQL engine has no grammar of that name' }];
  }
  const issues: ProtocolIssue[] = [];
  const quotable = (path: string, ...parts: string[]) => {
    try {
      render(sql`${ident(...parts)}`, dialect);
    } catch {
      issues.push({ path, code: 'manifest.identifier_invalid', message: 'the identifier cannot be quoted in this dialect' });
    }
  };
  manifest.objects.forEach((o, i) => {
    if (o.source.kind !== 'sql') return;
    quotable(`objects.${i}.source.table`, ...(o.source.schema === undefined ? [o.source.table] : [o.source.schema, o.source.table]));
    o.fields.forEach((f, j) => quotable(`objects.${i}.fields.${j}.column`, f.column ?? f.name));
    // Writes are declared by operation only; the statements are generated (protocols/sql/write.protocol.ts).
  });
  return issues;
}
