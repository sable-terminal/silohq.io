import type { FieldV2, ObjectV2 } from '../../schemas/manifest.schema';
import { value, type Scope } from '../expression/evaluate.expression';

/**
 * Every field a system holds.
 *
 * ── NOTHING HERE KNOWS ANY SYSTEM ─────────────────────────────────────────
 *
 * An object's `fieldList` is an ordinary read of the system's field list and
 * one expression for reading any field from a record. This file turns the
 * rows of that read into declared fields, offers the declared fields to
 * requests as `listed`, and reads each declared field the object does not map
 * with that expression. Where the system wants the fields named, how is the
 * connector's to say in its own expressions — a query parameter, a SOQL
 * statement, a GraphQL document — and nothing here assumes which.
 *
 * ── TYPED ON THE WAY IN ────────────────────────────────────────────────────
 *
 * Nothing converts a value after it is read, and many systems send numbers
 * and booleans as text and an empty field as "". A field read through its
 * list is converted to the type the list gave it, or to nothing, so a total or
 * a filter over it is not quietly wrong.
 */

export type FieldType = FieldV2['type'];

/** One row of a field list, as a declared field will hold it. */
export type ListedField = { name: string; key?: string; type: FieldType; label?: string };

/** A system's own type name, as one of Silo's. Anything unrecognised is text, which is never wrong. */
export function typeOf(system: unknown): FieldType {
  const word = String(system ?? '').trim().toLowerCase();
  if (/^(bool|boolean|booleancheckbox|checkbox|bit|yes_?no)$/.test(word)) return 'boolean';
  if (/^(date|dateonly)$/.test(word)) return 'date';
  if (/(datetime|date_time|timestamp|instant)/.test(word)) return 'datetime';
  if (/^(number|int|int32|int64|integer|long|double|decimal|float|real|numeric|percent|bigint|smallint|short|currency|money)$/.test(word)) {
    return 'number';
  }
  return 'string';
}

/** The name the read of an object's field list runs under. */
export const listingName = (objectName: string) => `${objectName}__fields`;

/**
 * The field list as an object of its own. Its read is the connector's, whatever
 * shape it has; its rows are fields, each with a name and, where the system
 * says, a type and a label.
 */
export function listingObject(objectName: string, list: { read: unknown; most?: number }): Record<string, unknown> {
  return {
    name: listingName(objectName),
    identifier: ['name'],
    fields: [
      { name: 'name', type: 'string', nullable: false },
      { name: 'key', type: 'string', nullable: true },
      { name: 'type', type: 'string', nullable: true },
      { name: 'label', type: 'string', nullable: true },
    ],
    read: list.read,
  };
}

/** The object's declared fields, as requests see them in `listed`. */
export function listedOf(object: ObjectV2): NonNullable<Scope['listed']> {
  return object.fields.map((field) => ({
    name: field.name,
    key: field.key ?? field.name,
    type: field.type,
    ...(field.description ? { description: field.description } : {}),
  }));
}

/** A value as the declared type holds it; text that is not one is nothing. */
export function converted(read: unknown, type: FieldType): unknown {
  if (read === undefined || read === null || read === '') return null;
  if (type === 'number' || type === 'money') {
    if (typeof read === 'number') return Number.isFinite(read) ? read : null;
    return typeof read === 'string' && /^-?\d+(\.\d+)?$/.test(read.trim()) ? Number(read) : null;
  }
  if (type === 'boolean') {
    if (typeof read === 'boolean') return read;
    return read === 'true' ? true : read === 'false' ? false : null;
  }
  return read;
}

const WHOLE = /^\s*\{\{([\s\S]*)\}\}\s*$/;

/**
 * One declared field, read from one record with the field list's `value`
 * expression, `$field` bound to the field. The binding is a JSONata variable
 * block, so the connector's expression is used exactly as written.
 */
export async function listedValue(expression: string, field: FieldV2, scope: Scope): Promise<unknown> {
  const inner = WHOLE.exec(expression)?.[1];
  if (inner === undefined) return null;
  const bound = JSON.stringify({
    name: field.name,
    key: field.key ?? field.name,
    type: field.type,
    ...(field.description ? { description: field.description } : {}),
  });
  const read = await value(`{{ ( $field := ${bound}; ${inner} ) }}`, scope);
  return converted(read, field.type);
}

/**
 * The document with every listed field declared on the object.
 *
 * DECLARING IS ALL THAT CHANGES. A field the object already declares keeps its
 * own mapping; one it lacks is read by the field list's `value`; and a request
 * that names fields through `listed` now names every one. Any read shape —
 * one request, a pipeline, variants — is widened the same way.
 */
export function withEveryField(
  document: { objects: Array<Record<string, unknown>> },
  objectName: string,
  listed: readonly ListedField[],
): { document: { objects: Array<Record<string, unknown>> }; added: string[]; problem?: string } {
  const copy = JSON.parse(JSON.stringify(document)) as { objects: Array<Record<string, unknown>> };
  const object = copy.objects.find((one) => one.name === objectName);
  if (!object) return { document, added: [], problem: `There is no object called ${objectName}.` };
  if (!object.fieldList) return { document, added: [], problem: `${objectName} does not say how to list its fields.` };

  const fields = object.fields as Array<Record<string, unknown>>;
  const known = new Set(fields.map((one) => String(one.name)));
  const keys = new Set(fields.map((one) => String(one.key ?? one.name)));
  const added: string[] = [];

  for (const field of listed) {
    const name = field.name.trim();
    const key = field.key?.trim() || name;
    /* Already declared — by the same name, or under another name for the same key. */
    if (!name || name.length > 128 || known.has(name) || keys.has(key) || name === listingName(objectName)) continue;
    if (fields.length >= 1_000) break;
    fields.push({
      name,
      ...(key !== name ? { key: key.slice(0, 200) } : {}),
      type: field.type,
      nullable: true,
      ...(field.label ? { description: field.label.slice(0, 500) } : {}),
    });
    known.add(name);
    keys.add(key);
    added.push(name);
  }

  return { document: copy, added };
}
