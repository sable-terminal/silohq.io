// Reading a resolvable type's contributing objects for keys (spec 23.2): through
// connect-runtime, as the person or principal acting, the identifier field and the match key
// fields only. Bounded: a contributing object larger than the executor's bound is refused by
// the runtime, never truncated, and the run says so.

import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import type { ObjectTypeView } from '../../contracts/ontology/manifest.contract.ts';
import { isAppError } from '../../utils/errors.util.ts';
import type { Context, ResolutionDeps } from './deps.service.ts';
import { keyText } from './identity.service.ts';

export interface SourceRecord {
  /** Index of the contributing object in the type. */
  source: number;
  identifier: string;
  /** Raw values by property identity id: the match key properties. */
  values: Record<string, unknown>;
}

export interface SourceRead {
  records: SourceRecord[];
  /** False when the read failed or was refused: what is missing cannot count as gone. */
  complete: boolean;
  note?: string;
}

const FIELD = /^[a-z][a-z0-9_]{0,62}$/;

export async function readContributing(deps: ResolutionDeps, ctx: Context, type: ObjectTypeView, source: number,
  /** Inference only (D74): properties to compare, read beside the keys where this system maps them. */
  compare: readonly string[] = []): Promise<SourceRead> {
  const co = type.contributingObjects[source]!;
  const keyFields: { propertyIdentityId: string; field: string }[] = [];
  for (const key of type.resolutionClass === 'resolvable' ? type.matchKeys : []) {
    const mapping = type.properties.find((p) => p.identityId === key.propertyIdentityId)?.mappings
      .find((m) => m.connectionId === co.connectionId && m.sourceObject === co.sourceObject);
    if (mapping === undefined) return { records: [], complete: false, note: 'match_key_unmapped' };
    keyFields.push({ propertyIdentityId: key.propertyIdentityId, field: mapping.fieldPath });
  }
  for (const propertyIdentityId of compare) {
    const mapping = type.properties.find((p) => p.identityId === propertyIdentityId)?.mappings
      .find((m) => m.connectionId === co.connectionId && m.sourceObject === co.sourceObject);
    if (mapping !== undefined && FIELD.test(mapping.fieldPath) && !keyFields.some((k) => k.propertyIdentityId === propertyIdentityId)) {
      keyFields.push({ propertyIdentityId, field: mapping.fieldPath });
    }
  }
  const fields = [...new Set([co.identifierFieldPath, ...keyFields.map((k) => k.field)])];
  if (!fields.every((f) => FIELD.test(f))) return { records: [], complete: false, note: 'field_not_readable' };
  let rows: Record<string, unknown>[];
  try {
    const out = await deps.services.call(readObject, {
      body: { connectionId: co.connectionId, reason: 'query', step: { object: co.sourceObject, fields } },
    }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 120_000 });
    rows = out.rows;
  } catch (error) {
    return { records: [], complete: false, note: `read_failed:${isAppError(error) ? error.code : 'unknown'}` };
  }
  const records: SourceRecord[] = [];
  let missing = 0;
  for (const row of rows) {
    const identifier = keyText(row[co.identifierFieldPath]);
    if (identifier === undefined || identifier.length === 0) {
      missing += 1;
      continue;
    }
    const values: Record<string, unknown> = {};
    for (const k of keyFields) values[k.propertyIdentityId] = row[k.field];
    records.push({ source, identifier, values });
  }
  return { records, complete: missing === 0, ...(missing > 0 ? { note: 'identifier_missing' } : {}) };
}
