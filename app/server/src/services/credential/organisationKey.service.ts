// The entity graph's keyed hashes (spec 23.3): HMAC-SHA-256 of source identifiers and
// match keys under the organisation's HMAC key (organisationKeyStore.service.ts, purpose
// hmac). The key never leaves this process; callers receive hashes only.

import type { EntityHashPurpose } from '../../contracts/credential/entityHash.contract.ts';
import { keyedHash } from '../../utils/crypto.util.ts';
import type { OrganisationKeyStore } from './organisationKeyStore.service.ts';

export interface OrganisationKeys {
  /** HMAC-SHA-256 of each value under the organisation's active HMAC key, hex, in order. */
  hash(organisationId: string, purpose: EntityHashPurpose, values: readonly string[]): Promise<{ keyVersionId: string; hashes: string[] }>;
}

export function createOrganisationKeys(store: OrganisationKeyStore): OrganisationKeys {
  return {
    async hash(organisationId, purpose, values) {
      const { id, key } = await store.active(organisationId, 'hmac');
      return { keyVersionId: id, hashes: values.map((value) => keyedHash(key, `entity_graph.${purpose}`, value).toString('hex')) };
    },
  };
}
