// Inbound change webhooks (spec 18.1, 18.8): POST /api/v1/hooks/changes/:organisationId/:token.
//
// A provider's server posts here, never a browser: no session, no Origin or x-silo-csrf
// rule, any content type, and a request carrying browser fetch metadata is refused. The
// path names the organisation and an unguessable token, which routes and does not
// authenticate; the body is read as raw bytes (UTF-8), and it and the headers are forwarded
// unparsed to change-stream, which has the credential service verify the signature before
// anything is decoded. Unlike the payment webhook, which names one signature header, the
// headers a connector's verify expression reads are its own (a signature, a timestamp, an
// event id), so all are forwarded except cookies, routing and proxy headers. The provider
// learns only that the delivery was taken (202), refused (401) or not found (404).

import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/index.config.ts';
import { receiveChangeWebhook } from '../../contracts/change-stream/stream.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { checkNotBrowser } from '../../middleware/crossSite.middleware.ts';
import { publicError } from '../../middleware/errors.middleware.ts';
import type { EdgeLimiter } from '../../middleware/rateLimit.middleware.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { edgeClientOf } from '../../middleware/clientAddress.middleware.ts';

export const CHANGE_HOOK_PATH = '/api/v1/hooks/changes/:organisationId/:token';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HEADERS = 100;

const params = z.strictObject({ organisationId: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

// Never forwarded: the browser's, the connection's framing, and the proxies'.
const DROPPED = /^(cookie|host|connection|content-length|transfer-encoding|te|trailer|upgrade|keep-alive|expect|forwarded|x-forwarded-.*|x-real-ip|proxy-.*)$/;
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

export interface ChangeHookDeps {
  config: Config;
  logger: Logger;
  services: ServiceClient;
  limiter: EdgeLimiter;
}

export function forwardedHeaders(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED.test(name) || !HEADER_NAME.test(name)) continue;
    if (Object.keys(out).length >= MAX_HEADERS) break;
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (text.length <= 8_192) out[name] = text;
  }
  return out;
}

export function mountChangeHooks(app: express.Express, deps: ChangeHookDeps): void {
  const raw = express.raw({ limit: Math.min(MAX_BODY_BYTES, deps.config.http.maxBodyBytes), type: () => true });
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  app.post(CHANGE_HOOK_PATH, (req: Request, res: Response) => {
    const correlationId = res.locals['correlationId'] as string;
    const log = deps.logger.child({ correlationId, route: 'gateway.changeHook', method: 'POST' });
    const started = performance.now();
    res.on('finish', () => log.info('request', { event: 'gateway.request', status: res.statusCode, durationMs: Math.round(performance.now() - started) }));
    void (async () => {
      try {
        checkNotBrowser(req.headers);
        await deps.limiter.perAddress(edgeClientOf(req, deps.config.http.trustProxyHops).address);
        const path = params.safeParse(req.params);
        if (!path.success) throw new AppError('not_found', 'no such endpoint', { code: 'route.not_found' });
        await new Promise<void>((resolve, reject) => {
          raw(req, res, (error?: unknown) => {
            if (error === undefined) resolve();
            else reject((error as { type?: unknown }).type === 'entity.too.large'
              ? new AppError('bounds', 'the delivery is too large', { code: 'bound.request_body_bytes', details: { bound: 'request_body_bytes', limit: MAX_BODY_BYTES } })
              : new AppError('validation', 'the body could not be read', { code: 'request.unreadable' }));
          });
        });
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          throw new AppError('unauthenticated', 'a signed body is required', { code: 'gateway.webhook_unsigned' });
        }
        let payload: string;
        try {
          payload = utf8.decode(req.body);
        } catch {
          throw new AppError('validation', 'the body is not UTF-8', { code: 'request.encoding' });
        }
        await deps.services.call(receiveChangeWebhook, {
          body: { organisationId: path.data.organisationId, token: path.data.token, payload, headers: forwardedHeaders(req.headers) },
        }, { correlationId });
        res.status(202).json({ received: true });
      } catch (error) {
        const { status, body, retryAfterSeconds } = publicError(error);
        if (status >= 500 && !(isAppError(error) && error.refusal)) log.failure('a change webhook failed', error, { event: 'gateway.failed' });
        if (res.headersSent) return;
        if (retryAfterSeconds !== undefined) res.setHeader('retry-after', String(retryAfterSeconds));
        res.status(status).json(body);
      }
    })();
  });
}
