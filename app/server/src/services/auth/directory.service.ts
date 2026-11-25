// The directory tier (spec 55.1): the global directory routes a login to the cell holding
// the person, by a keyed hash of their address. When this cell creates a user (an
// invitation accepted, just-in-time SSO, SCIM), it registers the hash: the credential
// service computes it inside the KMS, so neither the address nor the key leaves the cell
// in a form the directory could reverse.
//
// Registration is after the commit and best effort: the person exists whether or not the
// directory heard. One that fails is kept (iam.directory_registrations, the user id only)
// and tried again by auth's worker, backing off from the retry interval to a day between
// attempts, until the directory answers (D69). A cell without a directory
// (SERVICE_URL_DIRECTORY unset, as a self-managed install may be) registers nothing.

import type { Config } from '../../config/index.config.ts';
import { directoryEmailHash } from '../../contracts/credential/identityProvider.contract.ts';
import { registerIdentity, registerOrganisation } from '../../contracts/directory/registration.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { directoryRegistrationRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';

const DAY_MS = 86_400_000;
const BATCH = 100;

export interface DirectoryRegistrar {
  readonly enabled: boolean;
  registerIdentity(person: { userId: string; email: string }, correlationId: string): Promise<void>;
  /** A signed-up organisation's slug, so it routes here (decision 2026-11-14). False where the directory could not be told. */
  registerOrganisation(organisationSlug: string, correlationId: string): Promise<boolean>;
  /** Tries the kept registrations that are due; returns how many the directory took and how many wait again. */
  retryPending(correlationId: string, now?: Date): Promise<{ registered: number; waiting: number }>;
}

export function createDirectoryRegistrar(deps: { config: Config; services: ServiceClient; logger: Logger; databases: Databases }): DirectoryRegistrar {
  if (deps.config.http.serviceUrls['directory'] === undefined) {
    return {
      enabled: false, registerIdentity: async () => undefined, registerOrganisation: async () => true,
      retryPending: async () => ({ registered: 0, waiting: 0 }),
    };
  }
  const control = deps.databases.pool('control');
  const retryMs = (deps.config.sso?.directoryRetrySeconds ?? 300) * 1000;
  const backoff = (attempts: number): number => Math.min(retryMs * 2 ** Math.max(0, attempts - 1), DAY_MS);
  const reasonOf = (error: unknown): string => (isAppError(error) ? error.code : 'directory.unreachable');

  async function send(email: string, correlationId: string): Promise<void> {
    const hashed = await deps.services.call(directoryEmailHash, { body: { email } }, { correlationId });
    await deps.services.call(registerIdentity, {
      body: { cellId: deps.config.cell.id, emailHash: hashed.emailHash, hashKeyVersion: hashed.keyVersion },
    }, { correlationId });
  }

  return {
    enabled: true,
    async registerOrganisation(organisationSlug, correlationId) {
      try {
        await deps.services.call(registerOrganisation, {
          params: { organisationSlug }, body: { cellId: deps.config.cell.id, status: 'active' },
        }, { correlationId });
        return true;
      } catch (error) {
        deps.logger.failure('the directory could not be told of a signed-up organisation', error, { event: 'directory.organisation_unregistered' });
        return false;
      }
    },

    async registerIdentity(person, correlationId) {
      try {
        await send(person.email, correlationId);
      } catch (error) {
        deps.logger.failure('the directory could not be told of a person this cell holds; it is tried again', error, { event: 'directory.registration_failed' });
        await inTransaction(control, { userId: person.userId }, (db) =>
          directoryRegistrationRepo.keep(db, person.userId, reasonOf(error), new Date(Date.now() + backoff(1)).toISOString()))
          .catch((kept: unknown) => deps.logger.failure('a missed directory registration could not be kept', kept, { event: 'directory.registration_lost' }));
      }
    },

    async retryPending(correlationId, now = new Date()) {
      const due = await inTransaction(control, {}, (db) => directoryRegistrationRepo.due(db, now.toISOString(), BATCH), { readOnly: true });
      let registered = 0;
      let waiting = 0;
      for (const pending of due) {
        const user = await inTransaction(control, { userId: pending.userId }, (db) => userRepo.findById(db, pending.userId), { readOnly: true });
        if (user === undefined || user.status === 'deprovisioned') {
          await inTransaction(control, {}, (db) => directoryRegistrationRepo.done(db, pending.userId));
          continue;
        }
        try {
          await send(user.email, correlationId);
          await inTransaction(control, {}, (db) => directoryRegistrationRepo.done(db, pending.userId));
          registered += 1;
        } catch (error) {
          const attempts = pending.attempts + 1;
          await inTransaction(control, {}, (db) => directoryRegistrationRepo.retryLater(db, pending.userId, attempts, reasonOf(error),
            new Date(now.getTime() + backoff(attempts)).toISOString()));
          waiting += 1;
        }
      }
      if (registered > 0) deps.logger.info('missed directory registrations made', { event: 'directory.registrations_retried', count: registered });
      return { registered, waiting };
    },
  };
}
