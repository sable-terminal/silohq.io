// The directory's routing hash of an address (spec 55.1; design: directory.identity_routing),
// computed here because this service alone holds the KMS: HMAC-SHA-256 inside the KMS
// under KMS_DIRECTORY_KEY_URI, over a fixed label and the address's normal form
// (utils/email.util.ts), so the directory can route a login without the address.

import type { KeyManagement } from '../../infra/kms.infra.ts';
import { base64url } from '../../utils/crypto.util.ts';
import { emailRoutingInput } from '../../utils/email.util.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface DirectoryHasher {
  hash(email: string): Promise<{ emailHash: string; keyVersion: number }>;
}

export function createDirectoryHasher(kms: KeyManagement, keyUri: string | undefined, keyVersion: number): DirectoryHasher {
  return {
    async hash(email) {
      if (keyUri === undefined) {
        throw new AppError('configuration', 'this cell has no directory key (KMS_DIRECTORY_KEY_URI)', { code: 'directory.key_missing' });
      }
      return { emailHash: base64url(await kms.mac(keyUri, emailRoutingInput(email))), keyVersion };
    },
  };
}
