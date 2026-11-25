// What the auth services share.

import type { TxtResolver } from '../../infra/dns.infra.ts';
import type { Config } from '../../config/index.config.ts';
import type { BreachList } from '../../infra/breachList.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { PasswordHasher } from '../../utils/password.util.ts';
import type { DirectoryRegistrar } from './directory.service.ts';
import type { Guard } from './guard.service.ts';
import type { Sessions } from './sessions.service.ts';

/** Hands a reset link's token to whatever sends the email (the notify service), with the request's correlation id. */
export interface ResetDelivery {
  deliver(reset: { organisationId: string; userId: string; email: string; token: string; expiresAt: string; correlationId: string }): Promise<void>;
}

/** Hands an invitation link's token to whatever sends the email (the notify service), with the request's correlation id. */
export interface InvitationDelivery {
  deliver(invitation: {
    organisationId: string; invitationId: string; email: string; token: string; expiresAt: string; correlationId: string;
  }): Promise<void>;
}

/** Hands a sign-up's verification link to whatever sends the email (the notify service). */
export interface SignupDelivery {
  deliver(signup: { email: string; organisationName: string; token: string; expiresAt: string; correlationId: string }): Promise<void>;
}

export interface AuthDeps {
  config: Config;
  databases: Databases;
  logger: Logger;
  hasher: PasswordHasher;
  /** An Argon2id hash with the current parameters, verified when there is no user, so timing does not reveal one. */
  decoyHash: string;
  breachList: BreachList;
  guard: Guard;
  sessions: Sessions;
  /** Calls the credential service as auth. */
  services: ServiceClient;
  resetDelivery: ResetDelivery;
  invitationDelivery: InvitationDelivery;
  signupDelivery: SignupDelivery;
  /** TXT lookups for domain verification. */
  dns: TxtResolver;
  /** redis-data: SSO flows, SAML tickets, WebAuthn challenges. */
  flows: RedisStore;
  /** Tells the directory of each person this cell now holds; a no-op without a directory. */
  directory: DirectoryRegistrar;
}
