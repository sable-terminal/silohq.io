// Record values: a customer's data as it sits in a source system. They may exist only in
// the places listed in spec 8.5 and never in logs, traces, metrics, the durable bus,
// audit events, model calls or error reports. A value found anywhere else is a SEV1.
//
// Two markers make that checkable rather than a convention:
// - RecordValue<T>, a type brand. Typed logging (src/infra/logger.infra.ts) accepts only
//   SafeString and plain numbers, and a branded value does not satisfy SafeString, so
//   logging one fails to compile (spec 13.1: "typed logging that cannot accept
//   record-value types").
// - recordValue(schema), a Zod marker. The bus schema registry (src/infra/bus.infra.ts)
//   refuses a bus-durable schema containing a marked field (spec 9.1).

import { z } from 'zod';

declare const recordValueBrand: unique symbol;

/** A value read from or written to a customer system. */
export type RecordValue<T> = T & { readonly [recordValueBrand]: true };

/** A string that is not a record value. RecordValue<string> is not assignable to it. */
export type SafeString = string & { readonly [recordValueBrand]?: never };

export function asRecordValue<T>(value: T): RecordValue<T> {
  return value as RecordValue<T>;
}

const recordValueSchemas = z.registry<{ recordValue: true }>();

/** Marks a schema as carrying record values. */
export function recordValue<T extends z.ZodType>(schema: T): T {
  recordValueSchemas.add(schema, { recordValue: true });
  return schema;
}

type AnySchema = { _zod: { def: Record<string, unknown>; innerType?: unknown } };
const isSchema = (value: unknown): value is AnySchema =>
  typeof value === 'object' && value !== null && '_zod' in value;

// Whether any part of the schema (object fields, array elements, union members, wrapped
// optional and nullable types, records, tuples, pipes, lazies) is marked.
export function containsRecordValue(schema: z.ZodType): boolean {
  const seen = new Set<unknown>();
  const visit = (node: unknown): boolean => {
    if (!isSchema(node) || seen.has(node)) return false;
    seen.add(node);
    if (recordValueSchemas.has(node as unknown as z.ZodType)) return true;
    const children: unknown[] = [];
    const collect = (value: unknown): void => {
      if (isSchema(value)) children.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
        Object.values(value).forEach((v) => { if (isSchema(v)) children.push(v); });
      }
    };
    for (const value of Object.values(node._zod.def)) collect(value);
    if (node._zod.def['type'] === 'lazy') collect(node._zod.innerType);
    return children.some(visit);
  };
  return visit(schema);
}
