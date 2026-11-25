// Silo staff sign in to the admin portal through the staff identity provider only (spec 7.2:
// "Staff identity provider only"; platform.operators holds no email or password).
//
// - One OIDC issuer, client and secret per deployment. openid-client does discovery, the
//   PKCE code exchange and the ID token's checks (signature by the provider's published
//   keys, issuer, audience, nonce, expiry), through the cell's egress, as customer SSO does.
// - Strong authentication is the provider's to perform and ours to require: the token's amr
//   names every method in ADMIN_PORTAL_IDP_REQUIRED_AMR (default hwk, a hardware key), and
//   every ADMIN_PORTAL_DEVICE_CLAIMS claim holds its value (the sovereign cell's managed UK
//   device, 13.3).
// - The member of staff is the row of platform.operators whose idp_subject is the token's
//   sub, active. In the sovereign cell they must be on the sovereign access list.
// - What they may do comes from the groups claim, mapped to capabilities at sign-in. Roles
//   are managed, reviewed and removed in the provider (13.4); a suspension or removal here
//   ends every session at its next request.
// - A staff session is a random token in an HttpOnly cookie; redis-session holds its hash,
//   sliding over the idle window and never past the absolute one.

import * as oidc from 'openid-client';
import { STAFF_CAPABILITIES, type StaffCapability } from '../../contracts/admin-portal/capability.contract.ts';
import { oidcFetch } from '../../infra/egress.infra.ts';
import { staffFlowKeys, staffSessionKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Operator } from '../../models/platform/operator.model.ts';
import { operatorRepo } from '../../repos/platform/index.repo.ts';
import { base64url, constantTimeEqual, hmacSha256, randomBytes, sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { nowOf, type AdminPortalDeps, type Staff } from './deps.service.ts';

const hex = (b: Buffer): string => b.toString('hex');
const DISCOVERY_TTL_MS = 10 * 60_000;

const expired = (): AppError =>
  new AppError('unauthenticated', 'this sign-in has expired or was already used; start again', { code: 'staff.sign_in_invalid' });
const refused = (reason: string): AppError =>
  new AppError('unauthenticated', 'the staff identity provider\'s answer does not let you in', { code: 'staff.sign_in_refused', details: { reason } });
export const sessionRequired = (): AppError =>
  new AppError('unauthenticated', 'sign in to the admin portal', { code: 'staff.session_required' });

/** The PKCE verifier: an HMAC of the state under the browser's binding, so only that browser can finish the flow. */
const verifierOf = (binding: string, state: string): string =>
  base64url(hmacSha256(Buffer.from(binding, 'utf8'), Buffer.from(`silo.staff.pkce.v1\u0000${state}`, 'utf8')));
const challengeOf = (verifier: string): string => base64url(sha256(Buffer.from(verifier, 'ascii')));
export const tokenKeyOf = (token: string): string => hex(sha256(Buffer.from(`silo.staff.session.v1\u0000${token}`, 'utf8')));

/** The capabilities a token's groups grant, by the configured map. Unknown groups grant nothing. */
export function capabilitiesOf(groupsClaim: unknown, map: Record<string, readonly StaffCapability[]>): StaffCapability[] {
  const groups = Array.isArray(groupsClaim) ? groupsClaim.filter((g): g is string => typeof g === 'string')
    : typeof groupsClaim === 'string' ? [groupsClaim] : [];
  const granted = new Set<StaffCapability>();
  for (const group of groups) for (const capability of map[group] ?? []) granted.add(capability);
  return STAFF_CAPABILITIES.filter((c) => granted.has(c));
}

export interface SignedIn { token: string; staff: Staff }

export function createStaffAuth(deps: AdminPortalDeps) {
  const { config } = deps;
  const idp = config.idp;
  const fetch = oidcFetch(deps.egress);
  let discovered: { at: number; server: oidc.ServerMetadata } | undefined;

  const issuer = (): string => {
    if (idp.issuer === undefined || idp.clientId === undefined || idp.clientSecret === undefined || idp.redirectUri === undefined) {
      throw new AppError('configuration', 'the staff identity provider is not configured', { code: 'staff.idp_unconfigured' });
    }
    return idp.issuer;
  };

  const configuration = async (): Promise<oidc.Configuration> => {
    const at = Date.now();
    const auth = oidc.ClientSecretBasic(idp.clientSecret!);
    if (discovered === undefined || at - discovered.at >= DISCOVERY_TTL_MS) {
      try {
        const found = await oidc.discovery(new URL(issuer()), idp.clientId!, undefined, auth, {
          [oidc.customFetch]: fetch, execute: idp.allowInsecure ? [oidc.allowInsecureRequests] : [],
        });
        discovered = { at, server: { ...found.serverMetadata() } as oidc.ServerMetadata };
      } catch (error) {
        throw isAppError(error) ? error : new AppError('unavailable', 'the staff identity provider could not be reached', {
          code: 'staff.idp_unavailable', retryable: true,
        });
      }
    }
    const config_ = new oidc.Configuration(discovered.server, idp.clientId!, undefined, auth);
    config_[oidc.customFetch] = fetch;
    if (idp.allowInsecure) oidc.allowInsecureRequests(config_);
    // As customer SSO: the ID token's signature is checked against the provider's keys, not
    // trusted from the token endpoint's TLS alone.
    oidc.enableNonRepudiationChecks(config_);
    return config_;
  };

  /** The operator a verified identity names, if they may sign in to this cell's portal now. */
  const admissible = (operator: Operator | undefined): Operator => {
    if (operator === undefined) throw refused('unknown_operator');
    if (operator.status !== 'active') throw refused(`operator_${operator.status}`);
    if (deps.cell.sovereign && !(operator.sovereignAccessListed && operator.ukResident)) throw refused('not_on_sovereign_access_list');
    return operator;
  };

  const staffOf = (operator: Operator, record: { capabilities: string[]; absoluteExpiresAt: string }, sessionKey: string): Staff => ({
    operator, capabilities: new Set(record.capabilities as StaffCapability[]), sessionKey, absoluteExpiresAt: record.absoluteExpiresAt,
  });

  return {
    async start(): Promise<{ redirectUrl: string; binding: string; expiresAt: string }> {
      issuer();
      const state = base64url(randomBytes(32));
      const binding = base64url(randomBytes(32));
      const nonce = base64url(randomBytes(32));
      await deps.data.put(staffFlowKeys, staffFlowKeys.key({ stateHash: hex(sha256(Buffer.from(state, 'utf8'))) }),
        { bindingHash: hex(sha256(Buffer.from(binding, 'utf8'))), nonce }, { ttlSeconds: config.session.flowSeconds });
      const url = oidc.buildAuthorizationUrl(await configuration(), {
        redirect_uri: idp.redirectUri!, scope: 'openid profile', state, nonce,
        code_challenge: challengeOf(verifierOf(binding, state)), code_challenge_method: 'S256',
      });
      return { redirectUrl: url.href, binding, expiresAt: new Date(nowOf(deps).getTime() + config.session.flowSeconds * 1000).toISOString() };
    },

    async complete(input: { callbackQuery: string; binding: string }, correlationId: string): Promise<SignedIn> {
      const query = new URLSearchParams(input.callbackQuery.startsWith('?') ? input.callbackQuery.slice(1) : input.callbackQuery);
      const state = query.get('state');
      if (state === null || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw expired();
      const key = staffFlowKeys.key({ stateHash: hex(sha256(Buffer.from(state, 'utf8'))) });
      const flow = await deps.data.read(staffFlowKeys, key);
      // Used once: only the caller whose removal took it goes on.
      if (flow === undefined || await deps.data.remove(staffFlowKeys, key) !== 1) throw expired();
      if (!constantTimeEqual(sha256(Buffer.from(input.binding, 'utf8')), Buffer.from(flow.bindingHash, 'hex'))) throw expired();

      const current = new URL(idp.redirectUri!);
      current.search = query.toString();
      let claims: Record<string, unknown>;
      try {
        const tokens = await oidc.authorizationCodeGrant(await configuration(), current, {
          expectedState: state, expectedNonce: flow.nonce, pkceCodeVerifier: verifierOf(input.binding, state), idTokenExpected: true,
        });
        claims = (tokens.claims() ?? {}) as Record<string, unknown>;
      } catch (error) {
        if (isAppError(error)) throw error;
        if (error instanceof oidc.AuthorizationResponseError) throw refused('provider_refused');
        deps.logger.warn('a staff sign-in answer was refused', { event: 'staff.sign_in_refused', correlationId });
        throw refused('answer_invalid');
      }

      const amr = Array.isArray(claims['amr']) ? claims['amr'].filter((m): m is string => typeof m === 'string') : [];
      if (!idp.requiredAmr.every((method) => amr.includes(method))) throw refused('authentication_too_weak');
      for (const [claim, expected] of Object.entries(idp.deviceClaims)) {
        if (claims[claim] !== expected) throw refused('device_not_permitted');
      }
      const subject = typeof claims['sub'] === 'string' ? claims['sub'] : '';
      const operator = admissible(await inTransaction(deps.databases.pool('control'), {}, (db) => operatorRepo.findByIdpSubject(db, subject),
        { readOnly: true }));

      const now = nowOf(deps);
      const capabilities = capabilitiesOf(claims[idp.groupsClaim], idp.groupCapabilities);
      const absoluteExpiresAt = new Date(now.getTime() + config.session.absoluteMinutes * 60_000).toISOString();
      const token = base64url(randomBytes(32));
      const sessionKey = tokenKeyOf(token);
      const record = { operatorId: operator.id, capabilities, issuedAt: now.toISOString(), absoluteExpiresAt };
      await deps.sessions.put(staffSessionKeys, staffSessionKeys.key({ tokenHash: sessionKey }), record,
        { ttlSeconds: Math.min(config.session.idleMinutes, config.session.absoluteMinutes) * 60 });
      deps.logger.info('staff signed in', { event: 'staff.signed_in', resourceType: 'operator', resourceId: operator.id, count: capabilities.length, correlationId });
      return { token, staff: staffOf(operator, record, sessionKey) };
    },

    /** The member of staff a session token names, now; slides the idle window. */
    async resolve(token: string | undefined): Promise<Staff> {
      if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw sessionRequired();
      const sessionKey = tokenKeyOf(token);
      const key = staffSessionKeys.key({ tokenHash: sessionKey });
      const record = await deps.sessions.read(staffSessionKeys, key);
      if (record === undefined) throw sessionRequired();
      const remainingMs = Date.parse(record.absoluteExpiresAt) - nowOf(deps).getTime();
      if (remainingMs <= 0) {
        await deps.sessions.remove(staffSessionKeys, key);
        throw sessionRequired();
      }
      let operator: Operator;
      try {
        operator = admissible(await inTransaction(deps.databases.pool('control'), {}, (db) => operatorRepo.findById(db, record.operatorId),
          { readOnly: true }));
      } catch (error) {
        await deps.sessions.remove(staffSessionKeys, key);
        throw isAppError(error) && error.code === 'staff.sign_in_refused'
          ? new AppError('unauthenticated', 'your staff access has changed; sign in again', { code: 'staff.session_revoked' }) : error;
      }
      await deps.sessions.touch(staffSessionKeys, key, Math.max(1, Math.min(config.session.idleMinutes * 60, Math.floor(remainingMs / 1000))));
      return staffOf(operator, record, sessionKey);
    },

    async end(token: string | undefined): Promise<void> {
      if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
      await deps.sessions.remove(staffSessionKeys, staffSessionKeys.key({ tokenHash: tokenKeyOf(token) }));
    },
  };
}

export type StaffAuth = ReturnType<typeof createStaffAuth>;
