// Identifiers the state plane makes. The Silo object identifier (spec 24.7) is the one
// derivation every service shares (utils/siloObjectId.util.ts): a single-source record's id
// is UUIDv5 under the organisation's namespace of its type and source identifier hash.
// Resolvable types' ids come from the entity graph (the resolution service).

import { createHash } from 'node:crypto';

export { singleSourceObjectId } from '../../utils/siloObjectId.util.ts';

/** A deterministic UUID-shaped identifier from a hash (version 8, custom), for group and row ids. */
export function uuidFromHash(...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('\u0000'), 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The hashed source key a delta's entity resolves by (st:{org}:m:<connection>:<hash>). */
export const sourceKeyHash = (sourceObject: string, entityRef: string): string =>
  createHash('sha256').update(`${sourceObject}\u0000${entityRef}`, 'utf8').digest('hex').slice(0, 40);
