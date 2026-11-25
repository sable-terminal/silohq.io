import { randomBytes as cryptoRandomBytes, createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import type { AuthStrategyV2, SingleStrategyV2 } from '../../schemas/connectorAuth.schema';
import type { TransportKindV2 } from '../../schemas/manifest.schema';
import { denial, refusal, upstream } from '../../utils/error.util';
import type { HttpWire } from '../../infra/network.infra';
import { deep, every, text, type Scope } from '../expression/evaluate.expression';
import { parseBody } from '../formats/index.format';
import { serialiseXml } from '../formats/xml.format';
import { joinPath } from '../read/address.read';
import { getPath, setPath } from '../expression/paths.expression';
import type { AuthSurface, CanonicalRequest, Headers, Route, SocketAuth, WireResponse } from '../transports/contract.transport';
import { field, type Credential } from './credential.auth';
import { place } from './place.auth';
import { amzDate, oauth1, sigv4, signWith, stamp } from './sign.auth';

/**
 * Putting a connection's credential onto one request.
 *
 * ── RUNS AFTER EVERY EXPRESSION, AND NO EXPRESSION RUNS AFTER IT ──────────
 *
 * The runner evaluates the whole request, the transport prepares the wire
 * shape, and only then does this file touch it. The expressions that belong to
 * auth — an OAuth endpoint, a JWT's claims, a login body, a canonical string —
 * are evaluated here over `params` (and, for a canonical string, the request),
 * never over the credential. What they produce is text; the secret is applied to
 * that text by code in this directory.
 *
 * ── A TOKEN SILO OBTAINS ITSELF IS OBTAINED ONCE ──────────────────────────
 *
 * A client-credentials token, a password grant, an exchanged JWT, a login
 * session: each is obtained through `deps.cached`, which the runner backs with
 * a sealed store shared by every Silo instance (MANIFEST-V2 §9.1) — so a
 * system that allows one session per user is not logged in and out by two
 * instances in turn, and a token endpoint is not asked once per page.
 *
 * ── SIGNATURES GO LAST ────────────────────────────────────────────────────
 *
 * In an `all_of`, every part that places something runs in the order written,
 * and every part that signs runs after them all, whatever its position. A
 * signature over a request that is then changed is a signature over a
 * different request.
 */

export interface Obtained {
  /** What to place on each request, in order. */
  placements: Array<{ place: string; value: string }>;
  /** How long this may be reused. */
  expiresInSeconds: number;
}

export interface AuthDeps {
  /** The access token of an OAuth connection the OAuth service holds and refreshes. */
  oauthAccessToken(strategy: SingleStrategyV2): Promise<string>;
  /**
   * A value obtained once and reused until it expires. `key` already names the
   * connection; `exclusive` means only one instance may hold a live one.
   */
  cached(key: string, obtain: () => Promise<Obtained>, options: { exclusive: boolean }): Promise<Obtained>;
  /** Send a token or login request by the connection's own route. */
  sendHttp(wire: HttpWire, socket: SocketAuth): Promise<WireResponse>;
  /** Whether a credential may be sent to this origin — the connection's pinned origins. */
  mayReceiveCredential(url: URL): boolean;
  now(): Date;
  randomBytes(count: number): Buffer;
}

export interface ApplyInput<Req> {
  strategy: AuthStrategyV2;
  credential: Credential | null;
  params: Record<string, string>;
  kind: TransportKindV2;
  req: Req;
  surface: AuthSurface;
  canonicalView?: (req: Req, stamp: { timestamp: string; nonce: string }) => CanonicalRequest;
  isWrite: boolean;
  route: Route;
  /** Connection id and manifest version: what a cached token belongs to. */
  cacheKey: string;
  /** The transport's own origin, for a JWT's audience. */
  origin: URL | null;
  /**
   * A REST connection's base address: a login path joins under it, as every
   * other request path does. Absent for a transport whose address is an
   * endpoint rather than a base — GraphQL, SOAP — where a login path is from
   * the origin.
   */
  base?: URL | null;
  deps: AuthDeps;
}

/* gRPC metadata is HTTP/2 headers: a bearer token or an API key rides there exactly as on REST. */
const HTTP_SHAPED = new Set<TransportKindV2>(['https_rest', 'graphql', 'soap', 'grpc']);

export const defaultDeps = (): Pick<AuthDeps, 'now' | 'randomBytes'> => ({
  now: () => new Date(),
  randomBytes: (count) => cryptoRandomBytes(count),
});

/** Apply the chosen alternative to one request. */
export async function applyAuth<Req>(input: ApplyInput<Req>): Promise<void> {
  const parts = input.strategy.strategy === 'all_of' ? input.strategy.parts : [input.strategy];
  const signing = parts.filter((part) => part.strategy === 'signed');
  const placing = parts.filter((part) => part.strategy !== 'signed');

  for (const [index, part] of placing.entries()) await applyOne(part, index, input);
  for (const [index, part] of signing.entries()) await applyOne(part, placing.length + index, input);
}

/* ── One strategy ───────────────────────────────────────────────────────── */

async function applyOne<Req>(part: SingleStrategyV2, index: number, input: ApplyInput<Req>): Promise<void> {
  const { surface, credential, deps } = input;
  const http = HTTP_SHAPED.has(input.kind);
  const need = (name: string): string => required(credential, part, name);
  const may = (name: string): string | undefined => field(credential, part, name);
  const key = `${input.cacheKey}:${index}:${part.strategy}`;

  switch (part.strategy) {
    case 'none':
      return;

    case 'api_key_header':
      return surface.setHeader(part.name, `${part.prefix ?? ''}${need('key')}`);

    case 'api_key_query':
      return surface.setQuery(part.name, need('key'));

    case 'bearer':
      if (!http) {
        surface.socket.accessToken = need('token');
        return;
      }
      return surface.setHeader(part.header, `${part.prefix}${need('token')}`);

    case 'basic': {
      const username = need('username');
      const password = may('password') ?? '';
      if (!http) {
        surface.socket.username = username;
        surface.socket.password = password;
        return;
      }
      return surface.setHeader('authorization', `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`);
    }

    case 'ssh_key':
      surface.socket.username = need('username');
      surface.socket.privateKey = may('private_key');
      surface.socket.passphrase = may('passphrase');
      surface.socket.password = may('password');
      if (!surface.socket.privateKey && !surface.socket.password) throw missing(['private_key', 'password']);
      return;

    case 'mtls':
      surface.socket.tls.cert = need('certificate');
      surface.socket.tls.key = need('private_key');
      return;

    case 'placed':
      for (const [name, where] of Object.entries(part.places)) {
        const value = credential?.fields[name];
        if (value === undefined) throw missing([name]);
        place(surface, where, value);
      }
      return;

    case 'oauth2_authorization_code':
    case 'oauth2_pkce': {
      const token = await deps.oauthAccessToken(part);
      if (!http) {
        surface.socket.accessToken = token;
        surface.socket.username = may('username') ?? surface.socket.username;
        return;
      }
      return place(surface, part.token.place, `${part.token.prefix}${token}`);
    }

    case 'oauth2_client_credentials':
    case 'oauth2_password': {
      /*
       * A CLIENT-CREDENTIALS CONNECTION WITH NO CLIENT ON ITS CREDENTIAL is one
       * the OAuth service holds the token for — how v1 connected them — and is
       * read from there, refreshed by that service as before.
       */
      if (part.strategy === 'oauth2_client_credentials' && may('client_id') === undefined) {
        const token = await deps.oauthAccessToken(part);
        return http ? place(surface, part.token.place, `${part.token.prefix}${token}`) : void (surface.socket.accessToken = token);
      }
      const obtained = await deps.cached(key, () => grant(part, input), { exclusive: false });
      return placeAll(surface, obtained, http);
    }

    case 'jwt_assertion': {
      const obtained = await deps.cached(key, () => assertion(part, input), { exclusive: false });
      return placeAll(surface, obtained, http);
    }

    case 'session': {
      if (part.appliesTo === 'writes' && !input.isWrite) return;
      const obtained = await deps.cached(key, () => login(part, input), { exclusive: part.singleSession });
      return placeAll(surface, obtained, http);
    }

    case 'signed':
      return sign(part, input);

    case 'ws_security':
      return wsSecurity(part, input);

    case 'ntlm':
    case 'negotiate': {
      if (input.route.via !== 'agent') {
        throw refusal({
          message: `${part.strategy === 'ntlm' ? 'NTLM' : 'Kerberos'} is a handshake on the connection itself, so it can only run inside your network, through the Silo agent.`,
          code: 'refusal.agent_only',
        });
      }
      surface.socket.username = may('username');
      surface.socket.password = may('password');
      surface.socket.handshake =
        part.strategy === 'ntlm'
          ? {
              kind: 'ntlm',
              domain: await text(part.domain, { params: input.params }),
              workstation: await text(part.workstation, { params: input.params }),
            }
          : {
              kind: 'negotiate',
              useAgentIdentity: part.useAgentIdentity,
              servicePrincipal: await text(part.servicePrincipal, { params: input.params }),
            };
      if (part.strategy === 'ntlm' && !surface.socket.username) throw missing(['username']);
      return;
    }
  }
}

function placeAll(surface: AuthSurface, obtained: Obtained, http: boolean): void {
  for (const one of obtained.placements) {
    if (!http && one.place === 'header:authorization') {
      surface.socket.accessToken = one.value.replace(/^Bearer /, '');
      continue;
    }
    place(surface, one.place, one.value);
  }
}

/* ── Credentials ────────────────────────────────────────────────────────── */

function required(credential: Credential | null, part: SingleStrategyV2, name: string): string {
  const value = field(credential, part, name);
  if (value === undefined || value === '') throw missing([part.fields?.[name] ?? name]);
  return value;
}

const missing = (names: string[]) =>
  refusal({
    message: `This connection is missing ${names.join(' or ')}. Reconnect it and fill that in.`,
    code: 'refusal.credential_missing',
    detail: { fields: names },
  });

/* ── Token endpoints ────────────────────────────────────────────────────── */

async function endpoint<Req>(source: string, input: ApplyInput<Req>, what: string): Promise<URL> {
  const worked = await text(source, { params: input.params });
  let url: URL;
  try {
    url = new URL(worked ?? '');
  } catch {
    throw refusal({ message: `The ${what} this connector names is not an address: ${worked ?? 'nothing'}.`, code: 'refusal.auth_endpoint' });
  }
  if (url.protocol !== 'https:' && input.route.via !== 'agent') {
    throw refusal({ message: `The ${what} is not HTTPS, and a credential is never sent in the clear.`, code: 'refusal.plaintext' });
  }
  if (!input.deps.mayReceiveCredential(url)) {
    throw refusal({
      message: `The ${what} is on ${url.origin}, which this connection was not confirmed to send credentials to.`,
      code: 'refusal.origin_unpinned',
      detail: { origin: url.origin },
    });
  }
  return url;
}

/** POST a form to a token endpoint and read the JSON it answers with. */
async function tokenRequest<Req>(
  url: URL,
  form: Record<string, string>,
  headers: Record<string, string>,
  input: ApplyInput<Req>,
): Promise<unknown> {
  const response = await input.deps.sendHttp(
    {
      url: url.toString(),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
      body: new URLSearchParams(form).toString(),
    },
    { tls: input.surface.socket.tls },
  );
  const body = await parseBody({ bytes: response.body, format: 'auto', charset: 'auto', contentType: response.contentType, options: {} }).catch(
    () => null,
  );
  if (response.status === null || response.status >= 400) {
    const reason = (getPath(body, 'error_description') ?? getPath(body, 'error') ?? `status ${response.status}`) as string;
    throw denial({
      message: `The token endpoint refused this connection's credentials: ${String(reason).slice(0, 200)}. Check them and reconnect.`,
      code: 'denial.source_credentials',
      detail: { status: response.status, at: 'token' },
    });
  }
  return body;
}

function tokenFrom(body: unknown, tokenPath = 'access_token', expiresPath = 'expires_in'): { token: string; expiresIn: number } {
  const token = getPath(body, tokenPath);
  if (typeof token !== 'string' || token === '') {
    throw upstream({ message: 'The token endpoint answered without a token.', code: 'upstream.malformed_response' });
  }
  const expires = Number(getPath(body, expiresPath));
  return { token, expiresIn: Number.isFinite(expires) && expires > 0 ? expires : 3_600 };
}

async function grant<Req>(
  part: Extract<SingleStrategyV2, { strategy: 'oauth2_client_credentials' | 'oauth2_password' }>,
  input: ApplyInput<Req>,
): Promise<Obtained> {
  const url = await endpoint(part.endpoints.tokenUrl, input, 'token endpoint');
  const clientId = field(input.credential, part, 'client_id');
  const clientSecret = field(input.credential, part, 'client_secret');

  const form: Record<string, string> = {
    grant_type: part.strategy === 'oauth2_client_credentials' ? 'client_credentials' : 'password',
  };
  if (part.strategy === 'oauth2_password') {
    form.username = required(input.credential, part, 'username');
    form.password = required(input.credential, part, 'password');
  }
  if (part.scopes.length > 0) form.scope = part.scopes.join(' ');
  for (const [name, value] of Object.entries(await every(part.tokenParams, { params: input.params }))) form[name] = String(value);

  const headers: Record<string, string> = {};
  if (clientId !== undefined) {
    if (part.clientAuth === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret ?? '')}`).toString('base64')}`;
    } else {
      form.client_id = clientId;
      if (clientSecret !== undefined) form.client_secret = clientSecret;
    }
  } else if (part.strategy === 'oauth2_client_credentials') {
    throw missing([part.fields?.client_id ?? 'client_id']);
  }

  const { token, expiresIn } = tokenFrom(await tokenRequest(url, form, headers, input));
  return {
    placements: [{ place: part.token.place, value: `${part.token.prefix}${token}` }],
    expiresInSeconds: Math.max(0, expiresIn - part.refresh.refreshSkewSeconds),
  };
}

/* ── JWT assertion ──────────────────────────────────────────────────────── */

async function assertion<Req>(part: Extract<SingleStrategyV2, { strategy: 'jwt_assertion' }>, input: ApplyInput<Req>): Promise<Obtained> {
  const scope: Scope = { params: input.params };
  const claims = await every(part.claims, scope);
  const exchangeUrl = part.exchange ? await endpoint(part.exchange.tokenUrl, input, 'token endpoint') : null;

  if (!part.audienceIsOpaque && claims.aud !== undefined) {
    const audience = String(claims.aud);
    const expected = exchangeUrl?.origin ?? input.origin?.origin;
    let origin: string | null = null;
    try {
      origin = new URL(audience).origin;
    } catch {
      origin = null;
    }
    if (!expected || origin !== expected) {
      throw refusal({
        message: `This connector's JWT names an audience (${audience}) that is not where it is sent. If the audience is an identifier rather than an address, declare it opaque.`,
        code: 'refusal.jwt_audience',
      });
    }
  }

  const now = Math.floor(input.deps.now().getTime() / 1_000);
  const secret = required(input.credential, part, 'private_key');
  const keyId = field(input.credential, part, 'key_id');
  const key =
    part.algorithm === 'HS256'
      ? new TextEncoder().encode(secret)
      : await importPKCS8(secret, part.algorithm).catch(() => {
          throw refusal({
            message: 'The private key on this connection could not be read as PKCS#8. Paste the whole PEM block, including its BEGIN and END lines.',
            code: 'refusal.credential_unreadable',
          });
        });

  const jwt = await new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: part.algorithm, typ: 'JWT', ...(keyId ? { kid: keyId } : {}) })
    .setIssuedAt(now)
    .setNotBefore(now - 30)
    .setExpirationTime(now + part.lifetimeSeconds)
    .setJti(input.deps.randomBytes(16).toString('hex'))
    .sign(key);

  if (!part.exchange || !exchangeUrl) {
    return {
      placements: [{ place: part.token.place, value: `${part.token.prefix}${jwt}` }],
      expiresInSeconds: Math.max(0, part.lifetimeSeconds - 30),
    };
  }

  const form: Record<string, string> = { grant_type: part.exchange.grantType, [part.exchange.assertionParam]: jwt };
  for (const [name, value] of Object.entries(await every(part.exchange.extra, scope))) form[name] = String(value);
  const { token, expiresIn } = tokenFrom(
    await tokenRequest(exchangeUrl, form, {}, input),
    part.exchange.accessTokenPath,
    part.exchange.expiresInPath,
  );
  return {
    placements: [{ place: part.token.place, value: `${part.token.prefix}${token}` }],
    expiresInSeconds: Math.max(0, expiresIn - 60),
  };
}

/* ── Session ────────────────────────────────────────────────────────────── */

async function login<Req>(part: Extract<SingleStrategyV2, { strategy: 'session' }>, input: ApplyInput<Req>): Promise<Obtained> {
  const scope: Scope = { params: input.params };
  let url: URL;
  if (part.request.url) {
    url = await endpoint(part.request.url, input, 'login address');
  } else {
    if (!input.origin) throw refusal({ message: 'This connector logs in by path but has no address to log in to.', code: 'refusal.auth_endpoint' });
    const loginPath = (await text(part.request.path, scope)) ?? '/';
    url = input.base ? joinPath(input.base, loginPath) : new URL(loginPath.replace(/^\/?/, '/'), input.origin);
    if (url.origin !== input.origin.origin) {
      throw refusal({ message: 'A login path cannot leave the connection’s own address.', code: 'refusal.origin_unpinned' });
    }
  }

  for (const [name, value] of Object.entries(await every(part.request.query, scope))) url.searchParams.append(name, String(value));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(await every(part.request.headers, scope))) headers[name.toLowerCase()] = String(value);
  let body: unknown = (await deep(part.request.body, scope)) ?? (part.request.contentType === 'xml' ? '' : {});
  const form: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const surface: AuthSurface = {
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    setQuery: (name, value) => url.searchParams.set(name, value),
    setBodyPath: (path, value) => {
      body = setPath(typeof body === 'object' && body !== null ? body : {}, path, value);
    },
    setCookie: (name, value) => {
      cookies[name] = value;
    },
    setForm: (name, value) => {
      form[name] = value;
    },
    setSoapHeader: () => {
      throw refusal({ message: 'A login request has no SOAP header.', code: 'refusal.auth_place_unsupported' });
    },
    socket: input.surface.socket,
  };

  if (part.credentialPlacement === 'basic') {
    const username = required(input.credential, part, 'username');
    const password = field(input.credential, part, 'password') ?? '';
    surface.setHeader('authorization', `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  } else {
    for (const [name, where] of Object.entries(part.credentialPlacement)) {
      const value = input.credential?.fields[name];
      if (value === undefined) throw missing([name]);
      place(surface, where, value);
    }
  }

  if (Object.keys(cookies).length > 0) {
    headers.cookie = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  let encoded: string | null = null;
  if (part.request.method === 'POST') {
    if (part.request.contentType === 'form') {
      const all = { ...(typeof body === 'object' && body !== null ? flatForm(body as Record<string, unknown>) : {}), ...form };
      encoded = new URLSearchParams(all).toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (part.request.contentType === 'xml') {
      encoded = typeof body === 'string' ? body : serialiseXml(body);
      headers['content-type'] ??= 'application/xml';
    } else {
      encoded = JSON.stringify(Object.keys(form).length > 0 ? { ...(body as object), ...form } : body);
      headers['content-type'] ??= 'application/json';
    }
  }
  headers.accept ??= 'application/json, application/xml;q=0.9, */*;q=0.8';

  const response = await input.deps.sendHttp({ url: url.toString(), method: part.request.method, headers, body: encoded }, input.surface.socket);
  if (response.status === null || response.status >= 400) {
    throw denial({
      message: `The system refused the login (status ${response.status ?? 'none'}). Check the username and password on this connection.`,
      code: 'denial.source_credentials',
      detail: { status: response.status, at: 'login' },
    });
  }

  const parsed = await parseBody({ bytes: response.body, format: 'auto', charset: 'auto', contentType: response.contentType, options: {} }).catch(
    () => null,
  );
  const jar = cookiesOf(response.headers);
  const read = (from: string): string | undefined => {
    const colon = from.indexOf(':');
    const kind = from.slice(0, colon);
    const name = from.slice(colon + 1);
    const found =
      kind === 'body' ? getPath(parsed, name) : kind === 'header' ? response.headers[name.toLowerCase()] : jar[name];
    if (found === undefined || found === null) return undefined;
    return Array.isArray(found) ? String(found[0]) : String(found);
  };

  const placements: Obtained['placements'] = [];
  for (const token of part.tokens) {
    const value = read(token.from);
    if (value === undefined) {
      throw upstream({
        message: `The login succeeded but did not return ${token.from}, which this connector expects.`,
        code: 'upstream.malformed_response',
      });
    }
    placements.push({ place: token.place, value: `${token.prefix}${value}` });
  }
  const keep = part.cookies === 'none' ? [] : part.cookies === 'all' ? Object.keys(jar) : part.cookies;
  for (const name of keep) {
    if (jar[name] !== undefined) placements.push({ place: `cookie:${name}`, value: jar[name]! });
  }

  const declared = part.expiresIn ? Number(read(part.expiresIn)) : NaN;
  const expiresInSeconds = Number.isFinite(declared) && declared > 0 ? Math.min(declared - 30, part.ttlSeconds) : part.ttlSeconds;
  return { placements, expiresInSeconds: Math.max(0, expiresInSeconds) };
}

function flatForm(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    out[name] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

/** `Set-Cookie` headers as name → value. Attributes are the server's business, not ours. */
function cookiesOf(headers: Headers): Record<string, string> {
  const raw = headers['set-cookie'];
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Record<string, string> = {};
  for (const line of all) {
    const pair = line.split(';')[0]!;
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

/* ── Signatures ─────────────────────────────────────────────────────────── */

async function sign<Req>(part: Extract<SingleStrategyV2, { strategy: 'signed' }>, input: ApplyInput<Req>): Promise<void> {
  const { surface, deps } = input;
  if (!input.canonicalView) {
    throw refusal({ message: 'Only an HTTP request can be signed.', code: 'refusal.auth_place_unsupported' });
  }
  const at = deps.now();
  const scope: Scope = { params: input.params };

  if (part.algorithm === 'sigv4') {
    const view = input.canonicalView(input.req, { timestamp: amzDate(at), nonce: '' });
    const headers = sigv4({
      view,
      host: view.host,
      body: Buffer.from(view.body, 'utf8'),
      service: (await text(part.service, scope)) ?? '',
      region: (await text(part.region, scope)) ?? '',
      accessKeyId: required(input.credential, part, 'access_key_id'),
      secretAccessKey: required(input.credential, part, 'secret_access_key'),
      sessionToken: field(input.credential, part, 'session_token'),
      amzDate: amzDate(at),
    });
    for (const [name, value] of Object.entries(headers)) surface.setHeader(name, value);
    return;
  }

  const timestamp = part.timestamp ? stamp(at, part.timestamp.format) : String(Math.floor(at.getTime() / 1_000));
  const nonce = deps.randomBytes(part.nonce?.bytes ?? 16).toString('hex');

  if (part.algorithm === 'oauth1_hmac_sha1' || part.algorithm === 'oauth1_hmac_sha256') {
    const view = input.canonicalView(input.req, { timestamp, nonce });
    const isForm = Object.entries(view.headers).some(
      ([name, value]) => name.toLowerCase() === 'content-type' && value.startsWith('application/x-www-form-urlencoded'),
    );
    const form: Record<string, string[]> = {};
    if (isForm) for (const [name, value] of new URLSearchParams(view.body)) (form[name] ??= []).push(value);
    surface.setHeader(
      'authorization',
      oauth1({
        method: view.method,
        baseUrl: view.baseUrl,
        query: view.query,
        form,
        hash: part.algorithm === 'oauth1_hmac_sha1' ? 'sha1' : 'sha256',
        consumerKey: required(input.credential, part, 'consumer_key'),
        consumerSecret: required(input.credential, part, 'consumer_secret'),
        token: field(input.credential, part, 'token'),
        tokenSecret: field(input.credential, part, 'token_secret'),
        realm: await text(part.realm, scope),
        timestamp: String(Math.floor(at.getTime() / 1_000)),
        nonce,
      }),
    );
    return;
  }

  /* The connector's own canonical string. Timestamp and nonce are placed first so the view includes them. */
  if (part.timestamp) place(surface, part.timestamp.place, timestamp);
  if (part.nonce) place(surface, part.nonce.place, nonce);
  const view = input.canonicalView(input.req, { timestamp, nonce });
  const canonical = await text(part.canonical, { params: input.params, request: view });
  if (canonical === null) {
    throw refusal({ message: 'This connector’s canonical string came to nothing, so there is nothing to sign.', code: 'refusal.request_unbuildable' });
  }

  const keyName = part.algorithm === 'rsa_sha256' || part.algorithm === 'ed25519' ? 'private_key' : 'secret';
  const signature = signWith(part.algorithm, required(input.credential, part, keyName), canonical, part.encoding);
  place(surface, part.place!, `${part.prefix}${signature}`);

  if (part.keyId) {
    const keyId = required(input.credential, part, 'key_id');
    place(surface, part.keyId.place, `${part.keyId.prefix}${keyId}`);
  }
}

/* ── WS-Security ────────────────────────────────────────────────────────── */

const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const PASSWORD_TYPE = {
  text: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText',
  digest: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest',
};
const BASE64_ENCODING = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

async function wsSecurity<Req>(part: Extract<SingleStrategyV2, { strategy: 'ws_security' }>, input: ApplyInput<Req>): Promise<void> {
  const username = required(input.credential, part, 'username');
  const password = required(input.credential, part, 'password');
  const created = input.deps.now().toISOString();
  const nonce = input.deps.randomBytes(16);

  const token: Record<string, unknown> = {
    '@wsu:Id': `UsernameToken-${nonce.toString('hex').slice(0, 12)}`,
    'wsse:Username': username,
  };
  if (part.passwordType === 'digest') {
    const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)])).digest('base64');
    token['wsse:Password'] = { '@Type': PASSWORD_TYPE.digest, '#text': digest };
    token['wsse:Nonce'] = { '@EncodingType': BASE64_ENCODING, '#text': nonce.toString('base64') };
  } else {
    token['wsse:Password'] = { '@Type': PASSWORD_TYPE.text, '#text': password };
  }
  token['wsu:Created'] = created;

  input.surface.setSoapHeader('wsse:Security', {
    '@xmlns:wsse': WSSE,
    '@xmlns:wsu': WSU,
    '@soap:mustUnderstand': '1',
    'wsse:UsernameToken': token,
  });
}
