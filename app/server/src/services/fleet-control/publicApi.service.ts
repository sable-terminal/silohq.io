// The cell's public API as the Fleet agent's synthetic tests use it (spec 11.2): through the
// gateway's public listener (FLEET_GATEWAY_URL), as the synthetic organisation's members, the
// way the web client does: the session cookie, the public Origin and the x-silo-csrf header on
// every change, an idempotency key on each, and every answer checked against its route's
// schema. Nothing here reaches past the gateway: the tests see the cell as a customer does.

import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { API_PREFIX } from '../../contracts/gateway/publicRoute.contract.ts';
import { AppError, ERROR_CATEGORIES, type ErrorCategory } from '../../utils/errors.util.ts';

const SESSION_COOKIE = '__Host-silo_session';
const TIMEOUT_MS = 60_000;

/** A public route as the client needs it: its method and path, and the shape of its answer. */
export interface CallableRoute {
  readonly method: string;
  readonly path: string;
  readonly response: z.ZodType;
}

export interface PublicApi {
  readonly origin: string;
  /** The answer, checked against the route's schema at run time (the route type does not carry it). */
  call(route: CallableRoute, sessionToken: string, input?: {
    params?: Record<string, string>; query?: Record<string, string>; body?: unknown;
  }): Promise<any>;
}

export function createPublicApi(gatewayUrl: string, publicOrigin: string): PublicApi {
  const base = new URL(gatewayUrl);
  return {
    origin: publicOrigin,
    async call(route, sessionToken, input = {}) {
      const path = route.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
        const value = input.params?.[name];
        if (value === undefined) throw new TypeError(`the ${name} parameter is missing`);
        return encodeURIComponent(value);
      });
      // A built route's path carries the API prefix already.
      const url = new URL(path.startsWith(API_PREFIX) ? path : `${API_PREFIX}${path}`, base);
      for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);
      const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${sessionToken}`, accept: 'application/json' };
      if (route.method !== 'GET' && route.method !== 'HEAD') {
        Object.assign(headers, { origin: publicOrigin, 'x-silo-csrf': '1', 'idempotency-key': randomUUID() });
        if (input.body !== undefined) headers['content-type'] = 'application/json';
      }
      const reply = await fetch(url, {
        method: route.method, headers, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await reply.text();
      const parsed: unknown = text === '' ? undefined : JSON.parse(text);
      if (!reply.ok) {
        const error = (parsed as { error?: { code?: string; message?: string; category?: string; details?: Record<string, unknown> } } | undefined)?.error;
        const category = (ERROR_CATEGORIES as readonly string[]).includes(error?.category ?? '') ? error!.category as ErrorCategory : 'upstream';
        const first = error?.details?.['first'] === undefined ? '' : `: ${JSON.stringify(error.details['first']).slice(0, 300)}`;
        throw new AppError(category, `${error?.message ?? `the gateway answered ${reply.status}`} (${route.method} ${route.path})${first}`, {
          code: error?.code ?? `gateway.status_${reply.status}`,
        });
      }
      const checked = route.response.safeParse(parsed);
      if (!checked.success) throw new AppError('upstream', `the gateway's answer to ${route.method} ${route.path} does not match its route`, { code: 'synthetic.answer_invalid' });
      return checked.data;
    },
  };
}
