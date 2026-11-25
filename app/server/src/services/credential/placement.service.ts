// Where a secret goes in a request, by the manifest's auth strategy (spec 15.1). Runs only
// inside the mediator callback, on values that are zeroed when it returns. Generic over
// every provider: the manifest names the fields, their roles and where each is placed;
// anything outside the named strategies is the manifest's own CEL signing expression.

import { usernameToken } from './wsSecurity.service.ts';
import type { PreparedRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import type { ManifestAuth } from '../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';

/** The opened values of a connection, by field name. Buffers: the caller zeroes them. */
export type OpenedValues = ReadonlyMap<string, Buffer>;

export interface Placed {
  headers: Record<string, string>;
  query: Record<string, string>;
  /** ws_security: the SOAP header the envelope carries (the UsernameToken). */
  soapHeader?: string | undefined;
}

const missing = (field: string) => new AppError('unauthenticated', 'the connection has no value for a field its auth needs; reconnect it', {
  code: 'credential.missing', details: { field },
});

function value(values: OpenedValues, name: string): string {
  const v = values.get(name);
  if (v === undefined) throw missing(name);
  return v.toString('utf8');
}

function byRole(auth: ManifestAuth, values: OpenedValues, role: string): string {
  const field = auth.fields.find((f) => f.role === role);
  if (field === undefined) {
    throw new AppError('configuration', `the strategy needs a field with role ${role}`, { code: 'manifest.auth_role_missing', details: { role } });
  }
  return value(values, field.name);
}

/** Fields the manifest places in a header or query parameter, with their prefixes. */
function placeFields(auth: ManifestAuth, values: OpenedValues, into: Placed): void {
  for (const field of auth.fields) {
    if (field.location === 'none' || field.key === undefined) continue;
    const text = `${field.prefix ?? ''}${value(values, field.name)}`;
    if (field.location === 'header') into.headers[field.key] = text;
    else into.query[field.key] = text;
  }
}

/**
 * The headers and query parameters the strategy adds to the request. OAuth strategies
 * read the access token the OAuth engine sealed under field access_token.
 */
export async function place(auth: ManifestAuth, values: OpenedValues, request: PreparedRequest, now: Date): Promise<Placed> {
  const placed: Placed = { headers: {}, query: {} };
  switch (auth.strategy) {
    case 'none':
      return placed;
    case 'api_key':
      placeFields(auth, values, placed);
      return placed;
    case 'bearer':
      placeFields(auth, values, placed);
      placed.headers['authorization'] = `Bearer ${byRole(auth, values, 'token')}`;
      return placed;
    case 'basic': {
      placeFields(auth, values, placed);
      const pair = `${byRole(auth, values, 'username')}:${byRole(auth, values, 'password')}`;
      placed.headers['authorization'] = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
      return placed;
    }
    case 'oauth2_code':
    case 'oauth2_code_pkce':
    case 'oauth2_client_credentials':
    case 'oauth2_refresh':
      placeFields(auth, values, placed);
      placed.headers['authorization'] = `Bearer ${value(values, 'access_token')}`;
      return placed;
    case 'expression': {
      // spec 15.1: secret.<field> is in scope here and nowhere else.
      const secret: Record<string, string> = {};
      const pub: Record<string, string> = {};
      for (const field of auth.fields) {
        const v = values.get(field.name);
        if (v === undefined) continue;
        (field.kind === 'secret' ? secret : pub)[field.name] = v.toString('utf8');
      }
      const body = request.xml !== undefined ? request.xml.text : request.body === undefined ? '' : JSON.stringify(request.body);
      const signed = await compileExpression('auth.sign', 'cel', auth.sign!.cel).evaluate({
        request: {
          method: request.method, path: request.path, query: request.query, headers: request.headers,
          body_sha256: sha256(body).toString('hex'),
        },
        public: pub, secret,
      }, now) as { headers?: Record<string, string>; query?: Record<string, string> };
      placeFields(auth, values, placed);
      Object.assign(placed.headers, signed.headers ?? {});
      Object.assign(placed.query, signed.query ?? {});
      return placed;
    }
    case 'ws_security': {
      if (request.xml === undefined) throw new AppError('integrity', 'WS-Security travels in a SOAP envelope', { code: 'credential.ws_security_not_soap' });
      placeFields(auth, values, placed);
      placed.soapHeader = usernameToken(byRole(auth, values, 'username'), byRole(auth, values, 'password'), auth.wsSecurity?.password ?? 'text', now);
      return placed;
    }
    default:
      throw new AppError('configuration', `the ${auth.strategy} strategy is not run by the cell in this release`, {
        code: 'manifest.strategy_unsupported', details: { strategy: auth.strategy },
      });
  }
}
