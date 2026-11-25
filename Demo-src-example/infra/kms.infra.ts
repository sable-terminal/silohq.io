import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env, isProd } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import { accessToken } from './googleAuth.infra';
import type { KeyWrapper } from '../utils/envelope.util';

const log = childLogger('kms');

/**
 * The key that wraps every data key.
 *
 * IT NEVER RETURNS THE KEK AND THE KEK NEVER LEAVES GOOGLE. This wraps and
 * unwraps; the key material is not reachable from this process, which is the
 * whole point of using KMS rather than a secret in the environment. A dump of
 * this container's memory contains data keys for whatever was in flight, and
 * nothing that opens the rest.
 *
 * PRODUCTION REFUSES TO START WHEN THE KEK IS UNREACHABLE. Not degrading: a
 * process that cannot open credentials cannot run a connector, and one that
 * cannot seal them would accept a new credential and lose it. Starting anyway
 * means discovering this on the first customer action instead of at deploy.
 */

const SCOPE = 'https://www.googleapis.com/auth/cloudkms';
const TIMEOUT_MS = 10_000;

function keyPath(): string | null {
  if (!env.GCP_PROJECT_ID || !env.KMS_KEY_RING || !env.KMS_KEY_NAME) return null;
  return (
    `projects/${env.GCP_PROJECT_ID}/locations/${env.KMS_LOCATION}` +
    `/keyRings/${env.KMS_KEY_RING}/cryptoKeys/${env.KMS_KEY_NAME}`
  );
}

async function call(method: 'encrypt' | 'decrypt', body: unknown): Promise<Record<string, unknown>> {
  const path = keyPath();
  if (!path) throw new Error('KMS is not configured: set GCP_PROJECT_ID, KMS_KEY_RING and KMS_KEY_NAME.');

  const token = await accessToken();
  if (!token) throw new Error('No Google credentials available for KMS.');

  const response = await fetch(`https://cloudkms.googleapis.com/v1/${path}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text();
    /*
     * THE DETAIL IS LOGGED AND NOT THROWN. A KMS error body can echo the
     * ciphertext back, and the caller's error handler may well put a thrown
     * message into a response or a log that is not redacted.
     */
    log.error({ status: response.status, detail: detail.slice(0, 300) }, `KMS ${method} failed`);
    throw new Error(`KMS ${method} failed with status ${response.status}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * The wrapper `utils/envelope.util.ts` takes.
 *
 * THE SCHEME IS IN UTILS AND THE SOCKET IS HERE, which is what lets the envelope
 * be tested exhaustively with an in-memory wrapper — nonce reuse, tampering,
 * cross-row substitution — none of which needs a network.
 */
export const kmsWrapper: KeyWrapper = {
  async wrap(dek: Buffer) {
    const result = await call('encrypt', { plaintext: dek.toString('base64') });
    return {
      wrapped: Buffer.from(String(result.ciphertext), 'base64'),
      /*
       * THE VERSION IS RECORDED, NOT THE KEY. Rotation creates a new version and
       * KMS decrypts under whichever one sealed it, so old data keeps working
       * without a migration. `needsRewrap` uses this to find what to move.
       */
      keyReference: String(result.name ?? keyPath()),
    };
  },

  async unwrap(wrapped: Buffer) {
    const result = await call('decrypt', { ciphertext: wrapped.toString('base64') });
    return Buffer.from(String(result.plaintext), 'base64');
  },
};

export function isConfigured(): boolean {
  return keyPath() !== null;
}

/**
 * A KEK for development, derived from the session secret.
 *
 * IT EXISTS BECAUSE THE ALTERNATIVE WAS WORSE. Without a KEK, everything that
 * seals a credential — MFA enrolment, an SSO client secret, a connector's
 * password — returns 500 on every machine that has no Google credentials. That
 * is every developer's laptop and every CI run, which meant the sealing paths
 * were the least-exercised code in the product and the enrolment flow had never
 * once completed end to end anywhere.
 *
 * IT IS NOT A KMS AND DOES NOT PRETEND TO BE. The key is derived from a value
 * that also lives in a `.env` file, so the ciphertext is protected by exactly as
 * much as that file is. That is fine for fixture data and worthless for
 * anything real, which is why:
 *
 *   - it refuses to exist when `NODE_ENV` is production, and
 *   - `assertProductionReady` already refuses to boot production without
 *     `KMS_KEY_NAME`, so there is no configuration in which this is silently
 *     load-bearing.
 *
 * The `keyReference` is deliberately conspicuous: anything sealed by it is
 * marked as such forever, so a row that somehow reached production carrying it
 * is identifiable rather than merely wrong.
 */
const DEV_KEY_REFERENCE = 'development-insecure-local-kek';

const localWrapper: KeyWrapper = {
  async wrap(dek: Buffer) {
    const kek = createHash('sha256').update(`silo-dev-kek:${env.SESSION_SECRET}`).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    const sealed = Buffer.concat([cipher.update(dek), cipher.final()]);
    return {
      wrapped: Buffer.concat([iv, cipher.getAuthTag(), sealed]),
      keyReference: DEV_KEY_REFERENCE,
    };
  },

  async unwrap(wrapped: Buffer) {
    const kek = createHash('sha256').update(`silo-dev-kek:${env.SESSION_SECRET}`).digest();
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const body = wrapped.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  },
};

let announced = false;

/**
 * The wrapper to actually use.
 *
 * EVERY CALLER SHOULD REACH FOR THIS RATHER THAN `kmsWrapper`, so that the
 * choice between real and local is made in one place instead of at each call
 * site with its own idea of when a fallback is acceptable.
 */
export function wrapper(): KeyWrapper {
  if (isConfigured()) return kmsWrapper;

  if (isProd) {
    // Unreachable in practice — `assertProductionReady` refuses the boot — but
    // this is the line that makes that a guarantee rather than a convention.
    throw new Error('KMS is not configured. Production will not seal with a local key.');
  }

  if (!announced) {
    announced = true;
    log.warn(
      'No KMS configured: sealing with a key derived from SESSION_SECRET. Development only.',
    );
  }
  return localWrapper;
}

/**
 * Prove the KEK is reachable, by using it.
 *
 * A ROUND TRIP, NOT A `GET` ON THE KEY. Reading the key's metadata proves the
 * key exists and this identity may list it; it does not prove this identity may
 * encrypt and decrypt with it, which is the permission that actually matters and
 * the one most likely to be missing.
 */
export async function verify(): Promise<{ ok: boolean; reason?: string }> {
  if (!isConfigured()) {
    return { ok: false, reason: 'KMS is not configured' };
  }

  try {
    const probe = Buffer.from('silo-kms-probe');
    const { wrapped } = await kmsWrapper.wrap(probe);
    const returned = await kmsWrapper.unwrap(wrapped, '');
    if (!returned.equals(probe)) return { ok: false, reason: 'KMS round trip returned different bytes' };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'unknown' };
  }
}

export async function assertReady(): Promise<void> {
  if (!isProd) return;
  const { ok, reason } = await verify();
  if (!ok) {
    throw new Error(
      `KMS is unreachable (${reason}). Refusing to start: no credential could be opened, ` +
        `and any credential accepted would be lost.`,
    );
  }
}
