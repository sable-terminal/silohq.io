import type { ObjectV2, OperationV2 } from '../../schemas/manifest.schema';
import { isPipeline, isVariants } from '../../schemas/manifest.schema';
import { extract, type ExtractionRule, type ParsedEmail } from '../../utils/emailParser.util';
import { value } from '../expression/evaluate.expression';

/**
 * What arrives: a posted webhook body, or a forwarded email, as the records the
 * object describes.
 *
 * ── FOR A SOURCE THAT PUSHES, `records` IS APPLIED ON THE WAY IN ──────────
 *
 * A webhook wraps the thing that changed in an event envelope — `{ type,
 * created, data: { object } }` — and storing the envelope would put every field
 * one level too deep. So the object's `records` expression runs over the posted
 * body at intake, and what is stored is the record. A read then takes stored
 * records as they are and applies only `fields`.
 */

function readOperation(object: ObjectV2): OperationV2 | null {
  const read = object.read;
  const one = isVariants(read) ? read[read.length - 1]! : read;
  return isPipeline(one as never) ? null : (one as OperationV2);
}

export async function recordsFromWebhook(object: ObjectV2, body: unknown): Promise<Array<Record<string, unknown>>> {
  const op = readOperation(object);
  const found = op ? await value(op.records, { response: body }) : body;
  const list = Array.isArray(found) ? found : found === null || found === undefined ? [body] : [found];
  return list.filter((one): one is Record<string, unknown> => one !== null && typeof one === 'object' && !Array.isArray(one));
}

/**
 * A forwarded email as a record, using the object's fields as the rules.
 *
 * EVERY VALUE IS LOW CONFIDENCE AND SAYS SO. This is pattern matching against a
 * layout somebody else may change without notice; the confidence per field is
 * carried in the record, beside the figure, where whoever reads it will see it.
 */
export function recordFromEmail(object: ObjectV2, email: ParsedEmail): Record<string, unknown> {
  const rules: ExtractionRule[] = object.fields.map((field) => ({
    field: field.name,
    pattern: new RegExp(`${field.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _]?')}\\s*[:=]?\\s*([^\\n\\r]{1,120})`, 'i'),
    transform: field.type === 'number' || field.type === 'money' ? 'number' : field.type === 'date' ? 'date' : 'text',
  }));
  const record: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  for (const entry of extract(email, rules)) {
    record[entry.field] = entry.value;
    confidence[entry.field] = entry.confidence;
  }
  record._confidence = confidence;
  record._receivedAt = email.receivedAt.toISOString();
  return record;
}
