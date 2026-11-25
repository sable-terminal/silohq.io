/**
 * Cloudflare Turnstile, verified where verification means something.
 *
 * THE WIDGET IS NOT THE CONTROL. A token minted in the browser proves nothing
 * until Cloudflare confirms it, and a client that "passed the challenge" is
 * simply a client that says it did. This is the half that counts, and the reason
 * it lives in utils rather than infra: it is an authorisation decision about
 * whether a request is a person, and it happens to make an HTTP call.
 *
 * A TOKEN IS SINGLE-USE AND SHORT-LIVED. Cloudflare rejects a replay, so there
 * is nothing to cache and caching would defeat the point.
 *
 * ON `configured`: this returns `skipped` when no secret is set, and the caller
 * decides what that means. That is the same distinction `rateLimiter` draws
 * between "never configured" and "configured and not answering" — collapsing
 * them either makes the product undevelopable or makes the control silently
 * absent, and there is no third option that is honest.
 */

import { env } from '../config/env.config';
import { childLogger } from '../config/logger.config';

const log = childLogger('turnstile');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult =
  | { outcome: 'passed' }
  | { outcome: 'failed'; codes: string[] }
  | { outcome: 'skipped'; reason: 'not-configured' }
  /** Cloudflare was unreachable. Not the caller's fault; the caller decides. */
  | { outcome: 'unavailable' };

export function isConfigured(): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

export async function verify(
  token: string | undefined | null,
  remoteIp?: string | null,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET_KEY) return { outcome: 'skipped', reason: 'not-configured' };

  /*
   * A MISSING TOKEN IS A FAILURE, NOT AN ERROR. It is what a scripted client
   * sends — the widget is the only thing that produces one — so it is the
   * common case this exists to catch, and it must not cost a round trip.
   */
  if (!token) return { outcome: 'failed', codes: ['missing-input-response'] };

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      // Bounded: a sign-in form must not hang because Cloudflare is slow.
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      log.warn({ status: response.status }, 'Turnstile verification endpoint refused');
      return { outcome: 'unavailable' };
    }

    const result = (await response.json()) as { success?: boolean; 'error-codes'?: string[] };
    return result.success
      ? { outcome: 'passed' }
      : { outcome: 'failed', codes: result['error-codes'] ?? [] };
  } catch (error) {
    log.warn({ err: error }, 'Could not reach Turnstile');
    return { outcome: 'unavailable' };
  }
}
