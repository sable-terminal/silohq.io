// Email fallback's inbound route (spec 14.4): POST /api/v1/hooks/email.
//
// The cell's mail relay posts here, never a browser: the provider's inbound route or the
// self-managed SMTP relay forwards each message for an address under the cell's inbound domain
// whole (message/rfc822), naming its envelope recipient in x-silo-recipient and signing it in
// x-silo-signature (HMAC-SHA256 under the cell's inbound secret over the recipient, a dot and
// the message). The body is read as raw bytes and forwarded to change-stream, which checks the
// signature before anything is parsed. The relay learns only taken (202), refused (401) or
// not found (404).

import express, { type Request, type Response } from 'express';
import { receiveChangeEmail } from '../../contracts/change-stream/stream.contract.ts';
import { checkNotBrowser } from '../../middleware/crossSite.middleware.ts';
import { publicError } from '../../middleware/errors.middleware.ts';
import { edgeClientOf } from '../../middleware/clientAddress.middleware.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import type { ChangeHookDeps } from './changeHooks.controller.ts';

export const EMAIL_HOOK_PATH = '/api/v1/hooks/email';
const MAX_BODY_BYTES = 1024 * 1024;

export function mountEmailHooks(app: express.Express, deps: ChangeHookDeps): void {
  const raw = express.raw({ limit: Math.min(MAX_BODY_BYTES, deps.config.http.maxBodyBytes), type: () => true });
  app.post(EMAIL_HOOK_PATH, (req: Request, res: Response) => {
    const correlationId = res.locals['correlationId'] as string;
    const log = deps.logger.child({ correlationId, route: 'gateway.emailHook', method: 'POST' });
    void (async () => {
      try {
        checkNotBrowser(req.headers);
        await deps.limiter.perAddress(edgeClientOf(req, deps.config.http.trustProxyHops).address);
        await new Promise<void>((resolve, reject) => {
          raw(req, res, (error?: unknown) => {
            if (error === undefined) resolve();
            else reject((error as { type?: unknown }).type === 'entity.too.large'
              ? new AppError('bounds', 'the message is too large', { code: 'bound.request_body_bytes', details: { bound: 'request_body_bytes', limit: MAX_BODY_BYTES } })
              : new AppError('validation', 'the body could not be read', { code: 'request.unreadable' }));
          });
        });
        const recipient = req.headers['x-silo-recipient'];
        const signature = req.headers['x-silo-signature'];
        if (!Buffer.isBuffer(req.body) || req.body.length === 0 || typeof recipient !== 'string' || typeof signature !== 'string') {
          throw new AppError('unauthenticated', 'a signed message and its recipient are required', { code: 'gateway.email_unsigned' });
        }
        // A message's bytes are usually ASCII with encoded words; anything else is read as UTF-8, replacing what does not decode.
        const message = new TextDecoder('utf-8', { fatal: false }).decode(req.body);
        const out = await deps.services.call(receiveChangeEmail, { body: { recipient: recipient.slice(0, 320), message, signature: signature.slice(0, 200) } }, { correlationId });
        res.status(202).json({ received: true, setAside: out.setAside });
      } catch (error) {
        const { status, body, retryAfterSeconds } = publicError(error);
        if (status >= 500 && !(isAppError(error) && error.refusal)) log.failure('an inbound email failed', error, { event: 'gateway.failed' });
        if (res.headersSent) return;
        if (retryAfterSeconds !== undefined) res.setHeader('retry-after', String(retryAfterSeconds));
        res.status(status).json(body);
      }
    })();
  });
}
