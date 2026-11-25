import { createHash, createHmac, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { refusal } from '../../utils/error.util';
import type { CanonicalRequest, QueryValue } from '../transports/contract.transport';

/**
 * Signatures, as specifications and as primitives.
 *
 * ── THE KEY NEVER MEETS AN EXPRESSION ─────────────────────────────────────
 *
 * For `hmac_*`, `rsa_sha256` and `ed25519` the connector's expression builds the
 * string to sign from the request actually being sent, and this file applies the
 * key to that string. The expression sees the request — which, inside an
 * `all_of`, may include a header an earlier part placed — but its output goes
 * only into a MAC or a signature, which reveals nothing of its input. It never
 * sees the signing key.
 *
 * ── SIGV4 AND OAUTH 1.0a ARE SPECIFICATIONS, SO THEY ARE CODE ─────────────
 *
 * Each has a canonicalisation, a derived key and a header layout nobody should
 * be asked to transcribe into an expression (MANIFEST-V2 §9.1, finding F41).
 * SigV4 is the signing scheme every S3-compatible store speaks — MinIO, Ceph,
 * R2, Wasabi — not one company's; OAuth 1.0a is RFC 5849.
 */

export type Encoding = 'hex' | 'base64' | 'base64url';

const HMAC_HASH = { hmac_sha1: 'sha1', hmac_sha256: 'sha256', hmac_sha512: 'sha512' } as const;

/** Sign `data` with the credential's key, by the named primitive. */
export function signWith(
  algorithm: 'hmac_sha1' | 'hmac_sha256' | 'hmac_sha512' | 'rsa_sha256' | 'ed25519',
  key: string,
  data: string,
  encoding: Encoding,
): string {
  let signature: Buffer;
  if (algorithm === 'rsa_sha256') {
    signature = cryptoSign('sha256', Buffer.from(data, 'utf8'), privateKey(key));
  } else if (algorithm === 'ed25519') {
    signature = cryptoSign(null, Buffer.from(data, 'utf8'), privateKey(key));
  } else {
    signature = createHmac(HMAC_HASH[algorithm], key).update(data, 'utf8').digest();
  }
  return signature.toString(encoding);
}

function privateKey(pem: string) {
  try {
    return createPrivateKey(pem);
  } catch {
    throw refusal({
      message: 'The private key on this connection could not be read. Paste the whole PEM block, including its BEGIN and END lines.',
      code: 'refusal.credential_unreadable',
    });
  }
}

/* ── RFC 3986 ───────────────────────────────────────────────────────────── */

/** Percent-encode everything but the unreserved set — what both specifications mean by "encode". */
export const rfc3986 = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const pairsOf = (query: Record<string, QueryValue>): Array<[string, string]> =>
  Object.entries(query).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map((one): [string, string] => [name, one]) : [[name, value] as [string, string]],
  );

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/* ── SigV4 ──────────────────────────────────────────────────────────────── */

/** Headers a proxy may change or the client library sets, so a signature over them breaks in transit. */
const UNSIGNED = new Set(['authorization', 'user-agent', 'expect', 'connection', 'transfer-encoding', 'content-length', 'accept-encoding']);

export interface SigV4Input {
  view: CanonicalRequest;
  /** The request's host, as it will be sent. */
  host: string;
  /** The raw body bytes, hashed as the specification requires. */
  body: Buffer;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** `YYYYMMDD'T'HHMMSS'Z'`. */
  amzDate: string;
}

/**
 * The headers SigV4 adds to a request.
 *
 * THE PATH IS ENCODED ONCE MORE EXCEPT FOR THE OBJECT STORE. The specification
 * double-encodes the canonical URI for every service but one, whose keys are
 * arbitrary bytes and are signed as sent; the service name is the connector's
 * `service` expression, so which rule applies is decided by the document.
 */
export function sigv4(input: SigV4Input): Record<string, string> {
  const date = input.amzDate.slice(0, 8);
  const objectStore = input.service === 's3';
  const payloadHash = sha256Hex(input.body);

  /* What is added to the request, and then everything it already carries but the unsignable. */
  const added: Record<string, string> = { 'x-amz-date': input.amzDate };
  if (objectStore) added['x-amz-content-sha256'] = payloadHash;
  if (input.sessionToken) added['x-amz-security-token'] = input.sessionToken;

  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.view.headers)) {
    const lower = name.toLowerCase();
    if (!UNSIGNED.has(lower)) headers[lower] = value;
  }
  Object.assign(headers, added);

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}\n`).join('');

  const path = input.view.path || '/';
  const canonicalUri =
    objectStore
      ? path
      : path
          .split('/')
          .map((segment) => rfc3986(segment))
          .join('/');

  const canonicalQuery = pairsOf(input.view.query)
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    input.view.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = createHmac('sha256', `AWS4${input.secretAccessKey}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update(input.region).digest();
  const kService = createHmac('sha256', kRegion).update(input.service).digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...added,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`,
  };
}

/** SigV4's timestamp format. */
export const amzDate = (at: Date): string => at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/* ── OAuth 1.0a (RFC 5849) ──────────────────────────────────────────────── */

export interface OAuth1Input {
  method: string;
  /** Scheme, host and path — no query, no fragment. */
  baseUrl: string;
  query: Record<string, QueryValue>;
  /** Form parameters, when the body is `application/x-www-form-urlencoded`. */
  form: Record<string, QueryValue>;
  hash: 'sha1' | 'sha256';
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  realm?: string | null;
  timestamp: string;
  nonce: string;
}

/** The `Authorization` header for an OAuth 1.0a request. */
export function oauth1(input: OAuth1Input): string {
  const protocol: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce,
    oauth_signature_method: input.hash === 'sha1' ? 'HMAC-SHA1' : 'HMAC-SHA256',
    oauth_timestamp: input.timestamp,
    oauth_version: '1.0',
  };
  if (input.token) protocol.oauth_token = input.token;

  const parameters = [...pairsOf(input.query), ...pairsOf(input.form), ...Object.entries(protocol)]
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const base = [input.method.toUpperCase(), rfc3986(normaliseBase(input.baseUrl)), rfc3986(parameters)].join('&');
  const key = `${rfc3986(input.consumerSecret)}&${rfc3986(input.tokenSecret ?? '')}`;
  const signature = createHmac(input.hash, key).update(base).digest('base64');

  const header = { ...protocol, oauth_signature: signature };
  const realm = input.realm ? `realm="${rfc3986(input.realm)}", ` : '';
  return `OAuth ${realm}${Object.entries(header)
    .map(([name, value]) => `${rfc3986(name)}="${rfc3986(value)}"`)
    .join(', ')}`;
}

/** RFC 5849 §3.4.1.2: lowercase scheme and host, default ports dropped. */
function normaliseBase(url: string): string {
  const parsed = new URL(url);
  const port =
    (parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80') || !parsed.port
      ? ''
      : `:${parsed.port}`;
  return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${port}${parsed.pathname}`;
}

/* ── Timestamps ─────────────────────────────────────────────────────────── */

export function stamp(at: Date, format: 'unix_seconds' | 'unix_millis' | 'iso8601' | 'rfc7231'): string {
  switch (format) {
    case 'unix_seconds':
      return String(Math.floor(at.getTime() / 1_000));
    case 'unix_millis':
      return String(at.getTime());
    case 'iso8601':
      return at.toISOString();
    case 'rfc7231':
      return at.toUTCString();
  }
}
