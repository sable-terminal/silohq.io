// The two public surfaces that are not the browser's JSON API (spec 55.5):
//
// - The SAML assertion consumer, POST /api/v1/sso/saml/acs. The identity provider has the
//   browser post a form here, cross-site, so neither the Origin rule nor a SameSite cookie
//   can apply, and no browser binding can be read. It does one thing: hands the response
//   and relay state to auth, which verifies it (through the credential service) for the
//   flow the relay state names, once, and returns a ticket. The browser is sent on (303)
//   to the app's completion page with the ticket in the fragment, which no server or
//   Referer sees; the app redeems it with the binding it kept, by a normal JSON call that
//   sets the session cookie. A forged or replayed post yields at most a ticket that no
//   browser holding the binding asked for. Errors go to the same page as #error=<code>.
//
// - The SAML SP metadata, GET /api/v1/sso/saml/metadata (with ?organisationId=&providerId=,
//   that provider's single logout address too), and the single logout address,
//   /api/v1/sso/saml/slo/<organisation>/<provider>: the provider sends the browser here with a
//   LogoutRequest (Silo ends that person's sessions from it and sends the browser back with a
//   LogoutResponse) or with the LogoutResponse to Silo's own request (on to the sign-in page).
//   Cross-site, like the ACS: verification is the credential service's (spec 55.5).
//
// - SCIM 2.0 provisioning, /scim/v2 (RFC 7643, 7644). A provisioning client is a server
//   with a bearer token (iam.scim_tokens: <organisation_id>.<random>), not a browser: no
//   cookie, so cross-site request forgery does not apply, and the token itself is checked
//   by auth on every request. Requests and responses are application/scim+json, errors in
//   SCIM's own shape.

import express, { type Request, type Response } from 'express';
import type { Config } from '../../config/index.config.ts';
import { readSamlMetadata, receiveSamlLogoutMessage, receiveSamlResponse } from '../../contracts/auth/sso.contract.ts';
import { scimRequest } from '../../contracts/auth/scim.contract.ts';
import { flowHandle } from '../../contracts/auth/sso.contract.ts';
import { samlPost, SSO_PAGES } from '../../contracts/gateway/ssoRoutes.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { EdgeLimiter } from '../../middleware/rateLimit.middleware.ts';
import { clientAddress } from '../../middleware/clientAddress.middleware.ts';
import { publicError } from '../../middleware/errors.middleware.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';

export interface FederationDeps {
  config: Config;
  publicOrigin: string;
  logger: Logger;
  services: ServiceClient;
  limiter: EdgeLimiter;
}

export const SAML_ACS_PATH = '/api/v1/sso/saml/acs';
export const SAML_METADATA_PATH = '/api/v1/sso/saml/metadata';
export const SCIM_PREFIX = '/scim/v2';
const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_MAX_BYTES = 256 * 1024;

export function mountFederation(app: express.Express, deps: FederationDeps): void {
  const { config, logger, services, limiter } = deps;
  const addressOf = (req: Request): string | undefined =>
    clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.http.trustProxyHops);

  // --------------------------------------------------------------------- SAML ACS
  const form = express.urlencoded({ extended: false, limit: 600_000, parameterLimit: 10 });
  app.post(SAML_ACS_PATH, (req: Request, res: Response) => {
    const correlationId = res.locals['correlationId'] as string;
    const page = `${deps.publicOrigin}${SSO_PAGES.samlComplete}`;
    void (async () => {
      try {
        await limiter.perAddress(addressOf(req));
        await new Promise<void>((resolve, reject) => {
          form(req, res, (error?: unknown) => (error === undefined ? resolve()
            : reject(new AppError('validation', 'the form could not be read', { code: 'sso.acs_unreadable' }))));
        });
        const fields = samlPost.safeParse(req.body);
        if (!fields.success || !flowHandle.safeParse(fields.data.RelayState).success) {
          throw new AppError('validation', 'the form is not a SAML response', { code: 'sso.acs_unreadable' });
        }
        const { ticket } = await services.call(receiveSamlResponse, {
          body: { samlResponse: fields.data.SAMLResponse, relayState: fields.data.RelayState },
        }, { correlationId });
        res.redirect(303, `${page}#ticket=${encodeURIComponent(ticket)}`);
      } catch (error) {
        const code = isAppError(error) ? error.code : 'internal';
        if (!isAppError(error) || error.httpStatus >= 500) logger.failure('a SAML post failed', error, { event: 'gateway.saml_acs_failed' });
        if (!res.headersSent) res.redirect(303, `${page}#error=${encodeURIComponent(code)}`);
      }
    })();
  });

  // --------------------------------------------------------------------- SAML metadata and single logout
  app.get(SAML_METADATA_PATH, (req: Request, res: Response) => {
    const correlationId = res.locals['correlationId'] as string;
    void (async () => {
      try {
        await limiter.perAddress(addressOf(req));
        const pick = (name: string) => (typeof req.query[name] === 'string' && /^[0-9a-f-]{36}$/.test(req.query[name] as string) ? req.query[name] as string : undefined);
        const organisationId = pick('organisationId');
        const providerId = pick('providerId');
        const { xml } = await services.call(readSamlMetadata, {
          query: { ...(organisationId === undefined ? {} : { organisationId }), ...(providerId === undefined ? {} : { providerId }) },
        }, { correlationId });
        res.status(200).type('application/samlmetadata+xml').send(xml);
      } catch (error) {
        const { status, body } = publicError(error);
        if (status >= 500) logger.failure('the SAML metadata could not be served', error, { event: 'gateway.saml_metadata_failed' });
        if (!res.headersSent) res.status(status).json(body);
      }
    })();
  });
  const slo = (req: Request, res: Response) => {
    const correlationId = res.locals['correlationId'] as string;
    const page = `${deps.publicOrigin}/sign-in`;
    void (async () => {
      try {
        await limiter.perAddress(addressOf(req));
        const ids = /^\/api\/v1\/sso\/saml\/slo\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(req.path);
        if (ids === null) throw new AppError('not_found', 'no such endpoint', { code: 'route.not_found' });
        let message: { binding: 'redirect'; query: string } | { binding: 'post'; samlRequest?: string; samlResponse?: string; relayState?: string };
        if (req.method === 'GET') {
          const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
          if (query === '') throw new AppError('validation', 'no logout message', { code: 'sso.slo_unreadable' });
          message = { binding: 'redirect', query };
        } else {
          await new Promise<void>((resolve, reject) => {
            form(req, res, (error?: unknown) => (error === undefined ? resolve()
              : reject(new AppError('validation', 'the form could not be read', { code: 'sso.slo_unreadable' }))));
          });
          const body = req.body as Record<string, unknown>;
          const text = (name: string) => (typeof body[name] === 'string' ? body[name] as string : undefined);
          message = {
            binding: 'post', ...(text('SAMLRequest') ? { samlRequest: text('SAMLRequest')! } : {}), ...(text('SAMLResponse') ? { samlResponse: text('SAMLResponse')! } : {}),
            ...(text('RelayState') ? { relayState: text('RelayState')! } : {}),
          };
        }
        const { redirectUrl } = await services.call(receiveSamlLogoutMessage, {
          body: { organisationId: ids[1]!, providerId: ids[2]!, message },
        }, { correlationId });
        res.redirect(303, redirectUrl);
      } catch (error) {
        const code = isAppError(error) ? error.code : 'internal';
        if (!isAppError(error) || error.httpStatus >= 500) logger.failure('a SAML logout failed', error, { event: 'gateway.saml_slo_failed' });
        if (!res.headersSent) res.redirect(303, `${page}#error=${encodeURIComponent(code)}`);
      }
    })();
  };
  app.get(/^\/api\/v1\/sso\/saml\/slo\/[^/]+\/[^/]+$/, slo);
  app.post(/^\/api\/v1\/sso\/saml\/slo\/[^/]+\/[^/]+$/, slo);

  // --------------------------------------------------------------------- SCIM
  const scimBody = express.raw({ limit: SCIM_MAX_BYTES, type: () => true });
  const scimError = (res: Response, error: unknown): void => {
    const { status, body } = publicError(error);
    if (status >= 500) logger.failure('a SCIM request failed', error, { event: 'gateway.scim_failed' });
    if (res.headersSent) return;
    const scimType = isAppError(error) ? error.code.replace(/^scim\./, '') : undefined;
    res.status(status).type('application/scim+json').send(JSON.stringify({
      schemas: [SCIM_ERROR], status: String(status), detail: body.error.message,
      ...(scimType && /^(invalidFilter|tooMany|uniqueness|mutability|invalidSyntax|invalidPath|noTarget|invalidValue|invalidVers|sensitive)$/.test(scimType)
        ? { scimType } : {}),
    }));
  };
  app.all(/^\/scim\/v2(\/.*)?$/, (req: Request, res: Response) => {
    const correlationId = res.locals['correlationId'] as string;
    void (async () => {
      try {
        await limiter.perAddress(addressOf(req));
        const authorization = req.headers.authorization;
        if (typeof authorization !== 'string' || !/^Bearer [^\s]{1,200}$/.test(authorization)) {
          throw new AppError('unauthenticated', 'a SCIM bearer token is required', { code: 'scim.token_required' });
        }
        const method = req.method.toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          throw new AppError('not_found', 'no such endpoint', { code: 'route.not_found' });
        }
        await new Promise<void>((resolve, reject) => {
          scimBody(req, res, (error?: unknown) => {
            if (error === undefined) resolve();
            else reject(new AppError('validation', 'the body could not be read', { code: 'scim.invalidSyntax' }));
          });
        });
        const raw = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body.toString('utf8') : undefined;
        const url = new URL(req.originalUrl, 'http://edge');
        const reply = await services.call(scimRequest, {
          body: {
            token: authorization.slice('Bearer '.length), method: method as 'GET',
            path: url.pathname.slice(SCIM_PREFIX.length) || '/', query: url.search.slice(1), ...(raw === undefined ? {} : { body: raw }),
          },
        }, { correlationId });
        if (reply.location !== undefined) res.setHeader('location', `${deps.publicOrigin}${SCIM_PREFIX}${reply.location}`);
        if (reply.body === undefined) res.status(reply.status).end();
        else res.status(reply.status).type('application/scim+json').send(reply.body);
      } catch (error) {
        scimError(res, error);
      }
    })();
  });
}
