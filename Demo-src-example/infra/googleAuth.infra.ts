import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childLogger } from '../config/logger.config';

const log = childLogger('google-auth');

/**
 * An access token for Google APIs, from whichever credential exists.
 *
 * A RAW TOKEN EXCHANGE RATHER THAN `google-auth-library`. Everything this process
 * needs from Google — KMS, storage, Vertex — is a REST call with a bearer token.
 * The official libraries bring the whole gRPC client stack, tens of megabytes,
 * for a token this obtains in one POST against an endpoint whose shape has not
 * changed in a decade. The same decision the console made for GA4.
 *
 * TWO SOURCES, IN THE ORDER THEY SHOULD BE TRIED. The metadata server is how a
 * Cloud Run revision gets one, with no key material anywhere and no file to leak.
 * Application default credentials are the local path. A downloaded service
 * account key is deliberately unsupported: it is a long-lived secret in a file
 * somebody eventually commits.
 */

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * The metadata server answers in milliseconds on Cloud Run and not at all
 * anywhere else, so this is short. Ten seconds would make every local call wait
 * ten seconds to discover it is not on Cloud Run.
 */
const METADATA_TIMEOUT_MS = 1_000;
const EXCHANGE_TIMEOUT_MS = 10_000;

let cached: { token: string; expiresAt: number } | null = null;

async function fromMetadataServer(): Promise<{ token: string; ttl: number } | null> {
  try {
    const response = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    return body.access_token ? { token: body.access_token, ttl: body.expires_in ?? 3600 } : null;
  } catch {
    // Not on Cloud Run, which is not an error. See `accessToken`.
    return null;
  }
}

async function fromApplicationDefault(): Promise<{ token: string; ttl: number } | null> {
  const path =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ??
    join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');

  let creds: { type?: string; client_id?: string; client_secret?: string; refresh_token?: string };
  try {
    creds = JSON.parse(await readFile(path, 'utf8')) as typeof creds;
  } catch {
    return null;
  }

  if (creds.type !== 'authorized_user' || !creds.refresh_token) return null;

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.client_id ?? '',
        client_secret: creds.client_secret ?? '',
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });

    if (!response.ok) {
      /*
       * SAYS WHICH, BECAUSE "NO CREDENTIALS" AND "CREDENTIALS REFUSED" SEND YOU
       * TO DIFFERENT PLACES. `invalid_rapt` means Google wants reauthentication —
       * a stale login rather than a missing one — and you would not know to run
       * the login command from a message saying the file is absent.
       */
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      log.warn(
        { status: response.status, reason: detail.error ?? 'unknown' },
        'Application default credentials refused. Run `gcloud auth application-default login`.',
      );
      return null;
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    return body.access_token ? { token: body.access_token, ttl: body.expires_in ?? 3600 } : null;
  } catch (error) {
    log.warn({ err: error }, 'Could not exchange application default credentials');
    return null;
  }
}

export async function accessToken(): Promise<string | null> {
  // A minute of headroom: a token expiring between being fetched and being used
  // produces a 401 that looks like a permissions problem.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const obtained = (await fromMetadataServer()) ?? (await fromApplicationDefault());

  if (!obtained) {
    log.warn(
      'No Google credentials: not on Cloud Run, and no application default credentials. ' +
        'Locally, run `gcloud auth application-default login`.',
    );
    return null;
  }

  cached = { token: obtained.token, expiresAt: Date.now() + obtained.ttl * 1000 };
  return cached.token;
}

/** For the readiness probe. Forces a fetch rather than reading the cache. */
export async function verify(): Promise<boolean> {
  cached = null;
  return (await accessToken()) !== null;
}
