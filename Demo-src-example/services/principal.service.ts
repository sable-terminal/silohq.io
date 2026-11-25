import { withoutTenant, withTransaction } from '../infra/db.infra';
import { runUntenanted, runWithTenant } from '../utils/tenantContext.util';
import { bounds, denial, notFound } from '../utils/error.util';
import { hashToken } from '../utils/hash.util';
import { generatePrefixedToken } from '../utils/tokens.util';
import { lastFour } from '../utils/lastFour.util';
import * as principalRepo from '../repos/principal.repo';
import { assertCan, authorityOf, authorityOfPrincipal, type Authority } from './authorisation.service';
import type { Actor } from './scope.service';
import { log } from './audit.service';

/**
 * Identities that are not people.
 *
 * `connection.create` IS THE PERMISSION THAT GOVERNS THESE, not a new one. A
 * service principal exists to drive an integration, and the person trusted to
 * connect a system is the person trusted to give that connection an identity.
 * Minting a permission per feature produces a catalogue nobody can hold in their
 * head, and an administrator who cannot answer "what does this let them do".
 *
 * A KEY IS SHOWN EXACTLY ONCE. There is no endpoint that returns it again,
 * deliberately — a "show me the key" call makes every administrator's session a
 * way to take one, and there is nobody to notice a machine credential being
 * used by the wrong machine.
 */

const MAX_KEY_LIFETIME_DAYS = 365;

async function withAuthority<T>(
  actor: Actor,
  fn: (
    db: Parameters<Parameters<typeof withTransaction>[0]>[0],
    authority: Authority,
  ) => Promise<T>,
): Promise<T> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () =>
      withTransaction(async (db) =>
        fn(db, await authorityOf(db, actor.membershipId, actor.organisationId)),
      ),
  );
}

export async function list(actor: Actor) {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'connection.create');
    const principals = await principalRepo.listPrincipals(db);
    return Promise.all(
      principals.map(async (principal) => ({
        principal,
        keys: await principalRepo.listKeys(db, principal.id),
      })),
    );
  });
}

export async function create(
  actor: Actor,
  input: { name: string; description?: string | null },
) {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'connection.create');

    const principal = await principalRepo.createPrincipal(db, {
      organisationId: actor.organisationId,
      name: input.name,
      description: input.description ?? null,
      createdBy: actor.membershipId,
    });

    await log(db, {
      event: 'principal_created',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { principalId: principal.id, name: principal.name },
    });

    return principal;
  });
}

export async function setDisabled(actor: Actor, principalId: string, disabled: boolean) {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'connection.create');

    const principal = await principalRepo.setPrincipalDisabled(db, {
      id: principalId,
      disabled,
      by: actor.membershipId,
    });
    if (!principal) throw notFound({ message: 'No such identity.', code: 'missing.principal' });

    await log(db, {
      event: disabled ? 'principal_disabled' : 'principal_enabled',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { principalId, disabled },
    });

    return principal;
  });
}

/**
 * Issue a key.
 *
 * THE PLAINTEXT IS RETURNED HERE AND NOWHERE ELSE, EVER. Only its hash is
 * stored, so this really is the single moment it exists outside the caller's
 * process — which is why the caller is told so plainly enough that they save it.
 */
export async function issueKey(
  actor: Actor,
  input: { principalId: string; name: string; expiresInDays: number },
): Promise<{ key: principalRepo.ApiKey; token: string }> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'connection.create');

    if (input.expiresInDays < 1 || input.expiresInDays > MAX_KEY_LIFETIME_DAYS) {
      throw bounds({
        message: `A key may last between 1 and ${MAX_KEY_LIFETIME_DAYS} days.`,
        code: 'bounds.key_lifetime',
      });
    }

    const principal = await principalRepo.findPrincipal(db, input.principalId);
    if (!principal) throw notFound({ message: 'No such identity.', code: 'missing.principal' });

    const token = generatePrefixedToken('sk');
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);

    const key = await principalRepo.createKey(db, {
      principalId: principal.id,
      name: input.name,
      tokenHash: hashToken(token),
      // Recognition, never authentication. Four characters of a 32-byte secret
      // narrows nothing, and "the one ending 8f2c" is how people actually
      // identify which key is in which deployment.
      lastFour: lastFour(token) ?? '0000',
      createdBy: actor.membershipId,
      expiresAt,
    });

    await log(db, {
      event: 'api_key_issued',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { principalId: principal.id, keyId: key.id, expiresAt: expiresAt.toISOString() },
    });

    return { key, token };
  });
}

export async function revokeKey(actor: Actor, keyId: string): Promise<void> {
  await withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'connection.create');

    const key = await principalRepo.revokeKey(db, { keyId, by: actor.membershipId });
    if (!key) throw notFound({ message: 'No such key.', code: 'missing.api_key' });

    await log(db, {
      event: 'api_key_revoked',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { keyId, principalId: key.principalId },
    });
  });
}

/** What a request authenticated by a key gets to be. */
export interface PrincipalRequest {
  principalId: string;
  organisationId: string;
  authority: Authority;
}

/**
 * Turn a key into an authority, or into nothing.
 *
 * ONE ANSWER FOR EVERY FAILURE — unknown, expired, revoked, or belonging to a
 * disabled identity. Telling them apart tells whoever is holding a stolen key
 * whether it was ever real and which thing to try next.
 *
 * `last_used_at` IS WRITTEN ONLY ON SUCCESS. Touching it on a failed attempt
 * turns the column into a record of guesses, and it exists to answer "is
 * anything still using this key" — which is the question that lets somebody
 * retire one with confidence.
 */
export async function authenticateKey(token: string): Promise<PrincipalRequest | null> {
  const found = await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const lookup = await principalRepo.findByToken(db, hashToken(token));
      if (!lookup) return null;
      if (lookup.revokedAt) return null;
      if (lookup.principalDisabledAt) return null;
      if (lookup.expiresAt.getTime() <= Date.now()) return null;

      await principalRepo.touch(db, lookup.keyId);
      return lookup;
    }),
  );

  if (!found) return null;

  return runWithTenant({ organisationId: found.organisationId }, async () =>
    withTransaction(async (db) => ({
      principalId: found.principalId,
      organisationId: found.organisationId,
      authority: await authorityOfPrincipal(db, found.principalId, found.organisationId),
    })),
  );
}

/** Whether a token even looks like one of ours, so the session path is skipped. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith('silo_sk_');
}

/**
 * Granting a role to a machine identity.
 *
 * REFUSES SUPER ADMIN, ALWAYS. An organisation-wide grant to a credential
 * sitting in a config file is the single worst thing in this model: it cannot be
 * scoped, it cannot satisfy a second factor, and nobody is notified when it is
 * used. Anything a script genuinely needs everywhere is a sign the scope model
 * is wrong rather than a reason for this to be allowed.
 */
export function assertGrantableToPrincipal(scopeId: string | null): void {
  if (scopeId === null) {
    throw denial({
      message:
        'A service principal cannot be granted organisation-wide authority. Grant it at a scope.',
      code: 'denial.principal_org_wide',
    });
  }
}
