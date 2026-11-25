// The Silo object identifier (spec 24.7), one derivation for every service. Pure.
//
//   silo_object_id = UUIDv5(organisation_namespace(organisation_id),
//                           object_type_id ":" canonical(resolved match key set))
//   organisation_namespace(organisation_id) = UUIDv5(SILO_NAMESPACE, organisation_id)
//
// - A resolvable type: the set is the sorted match key hashes at first resolution, which the
//   entity graph (the resolution service) records and never recomputes; later changes remap
//   and merges redirect, so only resolution answers for those ids.
// - A single-source type, and a record that cannot be keyed: the set is the source
//   identifier hash, the hex SHA-256 of the record's source key (connection, source object,
//   identifier). It needs no organisation key, so the executor, the state plane and
//   write-back derive the same id without a lookup (spec 24.7: "the same object resolves to
//   the same identifier on every request without a lookup").

import { createHash } from 'node:crypto';

/** Silo's namespace for organisation namespaces. Fixed forever: changing it renames every object. */
export const SILO_NAMESPACE = '5110a7c3-2b1e-4d4f-9a6b-0e7c3d2f1a23';

/** RFC 9562 version 5 (SHA-1, name-based). */
export function uuidv5(namespace: string, name: string): string {
  const hash = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name, 'utf8').digest().subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const organisationNamespace = (organisationId: string): string => uuidv5(SILO_NAMESPACE, organisationId);

/**
 * The id derived from a resolved key set (hex hashes, any order); attempt > 0 appends a
 * counter, for when an earlier derivation already belongs to another object.
 */
export function siloObjectIdOf(organisationId: string, objectTypeId: string, keyHashes: readonly string[], attempt = 0): string {
  const canonical = [...keyHashes].sort().join(',');
  return uuidv5(organisationNamespace(organisationId), `${objectTypeId}:${canonical}${attempt === 0 ? '' : `#${attempt}`}`);
}

/** A source identifier as the text that is keyed: strings as they are, finite numbers as text; anything else has none. */
export function identifierText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.length === 0 ? undefined : raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'bigint') return raw.toString();
  return undefined;
}

/** The text a record's source key is made of. Never equal to a composite match key (a JSON array). */
export const sourceKeyText = (connectionId: string, sourceObject: string, identifier: string): string =>
  `\u0000source\u0000${connectionId}\u0000${sourceObject}\u0000${identifier}`;

/** The source identifier hash (spec 24.7): hex SHA-256 of the source key. */
export const sourceIdentifierHash = (connectionId: string, sourceObject: string, identifier: string): string =>
  createHash('sha256').update(sourceKeyText(connectionId, sourceObject, identifier), 'utf8').digest('hex');

/** The id of a single-source record: the same in every service, without a lookup. */
export function singleSourceObjectId(organisationId: string, objectTypeId: string, connectionId: string, sourceObject: string, identifier: string): string {
  return siloObjectIdOf(organisationId, objectTypeId, [sourceIdentifierHash(connectionId, sourceObject, identifier)]);
}
