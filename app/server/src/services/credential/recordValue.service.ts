// Record values at rest (contracts/credential/recordValue.contract.ts): sealing and opening
// the values a service stores in its record-value columns, under the organisation's data
// key (organisationKeyStore.service.ts, purpose data), which never leaves this process.
//
// Not a secret: a record value is already in the calling service's memory, so opening one
// is not recorded in iam.credential_unwraps (whose reasons are for credentials). The
// binding (table and natural key) is the associated data, with the organisation and the key
// version, so a value moved to another row, tenant or key version fails to open.
//
// Envelope: format byte (0x01), the data key version (4 bytes, big-endian), the nonce, then
// the AES-256-GCM ciphertext and tag.

import type { ValueBinding } from '../../contracts/credential/recordValue.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { aesGcmOpen, aesGcmSeal, NONCE_BYTES } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { OrganisationKeyStore } from './organisationKeyStore.service.ts';

const FORMAT = 0x01;
const HEADER = 1 + 4 + NONCE_BYTES;

export interface RecordValueCipher {
  seal(organisationId: string, items: readonly { binding: ValueBinding; value: Buffer }[]): Promise<Buffer[]>;
  open(organisationId: string, items: readonly { binding: ValueBinding; sealed: Buffer }[]): Promise<Buffer[]>;
}

const valueAad = (organisationId: string, version: number, binding: ValueBinding): Buffer =>
  canonicalJsonBytes({ v: 1, aad: 'record_value', organisation_id: organisationId, key_version: version, binding });

export function createRecordValueCipher(store: OrganisationKeyStore): RecordValueCipher {
  return {
    async seal(organisationId, items) {
      const { version, key } = await store.active(organisationId, 'data');
      return items.map(({ binding, value }) => {
        const sealed = aesGcmSeal(key, value, valueAad(organisationId, version, binding));
        const header = Buffer.alloc(5);
        header.writeUInt8(FORMAT, 0);
        header.writeUInt32BE(version, 1);
        return Buffer.concat([header, sealed.nonce, sealed.ciphertext]);
      });
    },

    async open(organisationId, items) {
      const out: Buffer[] = [];
      for (const { binding, sealed } of items) {
        if (sealed.length < HEADER + 16 || sealed.readUInt8(0) !== FORMAT) {
          throw new AppError('integrity', 'the sealed value is malformed', { code: 'crypto.malformed' });
        }
        const version = sealed.readUInt32BE(1);
        const key = await store.atVersion(organisationId, 'data', version);
        out.push(aesGcmOpen(key, { nonce: sealed.subarray(5, HEADER), ciphertext: sealed.subarray(HEADER) }, valueAad(organisationId, version, binding)));
      }
      return out;
    },
  };
}
