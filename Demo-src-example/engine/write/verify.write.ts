import { refusal } from '../../utils/error.util';
import type { ReadContext } from '../read/context.read';
import { executeRead } from '../read/execute.read';
import { runOperation } from '../read/operation.read';
import { withDefaults } from '../read/run.read';

/**
 * Reading a written record back, as verify-writes does (MANIFEST-V2 §7.4).
 *
 * By the connector's own `write.verify.read` when it declares one — the record
 * fetched by its identifier — and otherwise by an ordinary read filtered on the
 * identifier. A record the source accepted and does not return is refused by
 * name: a connector that cannot see what it wrote cannot be trusted to write.
 */
export async function readBack(
  ctx: ReadContext,
  object: ReadContext['object'],
  identifier: Record<string, unknown>,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const declared = object.write?.verify.read;
  let rows: Array<Record<string, unknown>>;
  if (declared && declared !== 'by_identifier') {
    const operation = withDefaults(ctx.manifest.defaults, declared);
    const out = await runOperation({
      ctx,
      operation,
      scope: { identifier, values },
      query: { object: object.name, filters: [], sort: [], fields: [], limit: 2 },
      plan: { filters: [], sort: false, limit: false, fields: false },
      want: 2,
      project: { object, fields: operation.fields, strict: operation.strictFields },
      fallbackErrors: [...ctx.manifest.defaults.errors, ...ctx.manifest.errors],
    });
    rows = out.records as Array<Record<string, unknown>>;
  } else {
    const result = await executeRead(ctx, {
      object: object.name,
      filters: object.identifier.map((field) => ({ field, op: 'eq' as const, value: identifier[field] })),
      sort: [],
      fields: [],
      limit: 2,
    });
    rows = result.rows;
  }
  if (rows.length === 0) {
    throw refusal({
      message: 'The source accepted the test record and then did not return it. The connector cannot be trusted to write.',
      code: 'refusal.write_not_visible',
    });
  }
  return rows[0]!;
}
