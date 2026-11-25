import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How a connector proves who it is, and how an inbound webhook proves who it is.
 *
 * THE STRATEGY DECIDES WHERE THE CREDENTIAL GOES, NOTHING MORE. It never holds
 * the credential: the caller opens it through the mediator and hands the
 * plaintext in for the length of one call. A strategy that stored a key would put
 * it in a long-lived object, which is what the mediator exists to prevent.
 */

export type StrategyKind = 'static-key' | 'bearer' | 'basic' | 'hmac';

export interface RequestParts {
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface StaticKeyConfig {
  kind: 'static-key';
  /** Where the provider expects it. Some want a header, some a query parameter. */
  in: 'header' | 'query';
  name: string;
}

export interface BearerConfig {
  kind: 'bearer';
  /** Some providers use `Token` or `ApiKey` rather than `Bearer`. */
  scheme?: string;
}

export interface BasicConfig {
  kind: 'basic';
  username: string;
}

export interface HmacConfig {
  kind: 'hmac';
  headerName: string;
  algorithm: 'sha256' | 'sha1';
  /** How the string to sign is assembled. Providers differ wildly here. */
  template: string;
  encoding: 'hex' | 'base64';
}

export type StrategyConfig = StaticKeyConfig | BearerConfig | BasicConfig | HmacConfig;

export function apply(
  config: StrategyConfig,
  secret: string,
  parts: RequestParts,
  context: { method: string; path: string; body: string; timestamp: string },
): RequestParts {
  const headers = { ...parts.headers };
  const query = { ...parts.query };

  switch (config.kind) {
    case 'static-key':
      if (config.in === 'header') headers[config.name] = secret;
      else query[config.name] = secret;
      break;

    case 'bearer':
      headers.authorization = `${config.scheme ?? 'Bearer'} ${secret}`;
      break;

    case 'basic':
      headers.authorization = `Basic ${Buffer.from(`${config.username}:${secret}`).toString('base64')}`;
      break;

    case 'hmac': {
      const payload = config.template
        .replace('{method}', context.method.toUpperCase())
        .replace('{path}', context.path)
        .replace('{body}', context.body)
        .replace('{timestamp}', context.timestamp);
      headers[config.headerName] = createHmac(config.algorithm, secret)
        .update(payload)
        .digest(config.encoding);
      break;
    }
  }

  return { headers, query };
}

/**
 * Verify an inbound webhook.
 *
 * A WEBHOOK ENDPOINT WITH NO SIGNATURE CHECK IS AN UNAUTHENTICATED WRITE ENDPOINT
 * on a public URL. It will be found.
 *
 * THE TIMESTAMP IS CHECKED IN BOTH DIRECTIONS. Too old is a replay of a captured
 * request; too far in the future means the clocks disagree enough that "too old"
 * cannot be trusted either.
 *
 * EVERY SIGNATURE IN THE HEADER IS TRIED. Providers send several during a secret
 * rotation, and taking only the first breaks delivery for the rotation window.
 */
export interface WebhookVerification {
  ok: boolean;
  reason?: 'no-signature' | 'bad-signature' | 'stale-timestamp' | 'future-timestamp';
}

export function verifyWebhook(input: {
  signatures: readonly string[];
  timestamp: number;
  payload: string;
  secret: string;
  algorithm?: 'sha256' | 'sha1';
  encoding?: 'hex' | 'base64';
  toleranceSeconds?: number;
  now?: number;
}): WebhookVerification {
  const tolerance = input.toleranceSeconds ?? 300;
  const now = Math.floor((input.now ?? Date.now()) / 1000);

  if (input.signatures.length === 0) return { ok: false, reason: 'no-signature' };

  const age = now - input.timestamp;
  if (age > tolerance) return { ok: false, reason: 'stale-timestamp' };
  if (age < -tolerance) return { ok: false, reason: 'future-timestamp' };

  const expected = createHmac(input.algorithm ?? 'sha256', input.secret)
    .update(`${input.timestamp}.${input.payload}`)
    .digest(input.encoding ?? 'hex');

  const expectedBuffer = Buffer.from(expected, 'utf8');

  for (const candidate of input.signatures) {
    const given = Buffer.from(candidate.trim(), 'utf8');
    // Length-checked first: timingSafeEqual throws on a mismatch, and a throw is
    // a far louder timing signal than the comparison it protects.
    if (given.length === expectedBuffer.length && timingSafeEqual(given, expectedBuffer)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'bad-signature' };
}
