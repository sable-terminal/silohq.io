import type { Executor } from '../infra/db.infra';
import type { Sealed } from '../utils/envelope.util';
import type {
  IdentityProvider,
  IdentityProviderSummary,
  SsoAttempt,
} from '../models/sso.model';

/**
 * Identity providers, the domains they may assert, the attempts in flight, and
 * the links between a directory's subjects and Silo users.
 *
 * THE SIGN-IN READS GO THROUGH `SECURITY DEFINER` FUNCTIONS, NOT THE TABLES.
 * Everything up to the moment a session exists runs untenanted: when an address
 * is turned into a redirect there is no `app.org_id` yet for
 * `identity_providers_tenant` to match, and a direct SELECT would return nothing
 * and read as "no directory configured" — indistinguishable from an address
 * nobody has set up. 010 defines `identity_provider_for_domain`,
 * `identity_provider_by_id`, `consume_sso_attempt`, `create_sso_attempt`,
 * `link_federated_identity` and `user_for_federated_subject` for exactly these
 * steps.
 *
 * WHICH IS ALSO WHY THERE IS NO SHARED `COLUMNS` LIST FOR THE PROVIDER READS.
 * The column list is fixed by each function's `RETURNS TABLE`, in the migration;
 * a constant here would be a second copy of it that nothing keeps in step. The
 * INSERT names its columns because it is the one statement that writes the table
 * directly.
 */

interface ProviderRow {
  id: string;
  organisation_id: string;
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  client_id: string;
  client_secret_sealed: Buffer;
  client_secret_key: string;
  client_secret_wrapped: Buffer;
}

function map(row: ProviderRow): IdentityProvider {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    issuer: row.issuer,
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    jwksUri: row.jwks_uri,
    clientId: row.client_id,
    clientSecret: {
      ciphertext: row.client_secret_sealed,
      wrappedKey: row.client_secret_wrapped,
      keyReference: row.client_secret_key,
    },
  };
}

/* ── Configuration ──────────────────────────────────────────────────────── */

/**
 * Write a provider.
 *
 * THE SECRET ARRIVES SEALED. Nothing in this file can open one and nothing here
 * should be able to: the envelope is made by the caller, against a purpose bound
 * to the id it is about to be stored under.
 */
export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    name: string;
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
    clientId: string;
    clientSecret: Sealed;
    createdBy: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO identity_providers
       (id, organisation_id, name, issuer, authorization_endpoint, token_endpoint,
        jwks_uri, client_id, client_secret_sealed, client_secret_key,
        client_secret_wrapped, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.id, input.organisationId, input.name, input.issuer,
      input.authorizationEndpoint, input.tokenEndpoint, input.jwksUri,
      input.clientId, input.clientSecret.ciphertext, input.clientSecret.keyReference,
      input.clientSecret.wrappedKey, input.createdBy,
    ],
  );
}

/**
 * Claim a domain for a provider.
 *
 * ONE AT A TIME, AND THE CONSTRAINT IS THE POINT. `domain` is the primary key
 * across the whole installation, so a second organisation claiming `acme.com`
 * fails here rather than being resolved at sign-in time. Nothing is caught: the
 * violation is what tells the service which domain was already taken.
 */
export async function addDomain(
  db: Executor,
  input: { providerId: string; domain: string },
): Promise<void> {
  await db.query(
    `INSERT INTO identity_provider_domains (domain, provider_id) VALUES ($1, $2)`,
    [input.domain, input.providerId],
  );
}

interface SummaryRow {
  id: string;
  name: string;
  issuer: string;
  enabled: boolean;
  domains: string[];
}

function mapSummary(row: SummaryRow): IdentityProviderSummary {
  return {
    id: row.id,
    name: row.name,
    issuer: row.issuer,
    enabled: row.enabled,
    domains: row.domains,
  };
}

/**
 * Every provider this tenant has configured, with its domains.
 *
 * THE SECRET COLUMNS ARE NOT SELECTED. There is nowhere for them to go — the
 * summary has no field for one — and a listing is the easiest place for a
 * credential to end up in a log.
 *
 * The `FILTER` is not a filter on what the caller may see: `array_agg` over a
 * LEFT JOIN with no match yields `{NULL}`, and a provider with no domains
 * configured would otherwise report one called null.
 */
export async function listSummaries(db: Executor): Promise<IdentityProviderSummary[]> {
  const { rows } = await db.query<SummaryRow>(
    `SELECT p.id, p.name, p.issuer, p.enabled,
            COALESCE(array_agg(d.domain::text) FILTER (WHERE d.domain IS NOT NULL), '{}') AS domains
       FROM identity_providers p
       LEFT JOIN identity_provider_domains d ON d.provider_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at`,
  );
  return rows.map(mapSummary);
}

/* ── The lookups that happen before anybody is signed in ────────────────── */

/** The directory for an address's domain, or null when nobody has claimed it. */
export async function findForDomain(
  db: Executor,
  domain: string,
): Promise<IdentityProvider | null> {
  const { rows } = await db.query<ProviderRow>(
    `SELECT * FROM identity_provider_for_domain($1)`,
    [domain],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function findById(db: Executor, id: string): Promise<IdentityProvider | null> {
  const { rows } = await db.query<ProviderRow>(
    `SELECT * FROM identity_provider_by_id($1)`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

/* ── The attempt ────────────────────────────────────────────────────────── */

export async function createAttempt(
  db: Executor,
  input: {
    state: string;
    providerId: string;
    nonce: string;
    codeVerifier: string;
    returnTo: string | null;
    expiresAt: Date;
  },
): Promise<void> {
  await db.query(`SELECT create_sso_attempt($1, $2, $3, $4, $5, $6)`, [
    input.state,
    input.providerId,
    input.nonce,
    input.codeVerifier,
    input.returnTo,
    input.expiresAt,
  ]);
}

interface AttemptRow {
  provider_id: string;
  nonce: string;
  code_verifier: string;
  return_to: string | null;
}

/**
 * Read an attempt and spend it, in one statement.
 *
 * THE CHECK AND THE MARK ARE THE SAME UPDATE, inside `consume_sso_attempt`.
 * Reading first and marking after leaves a window in which a replayed callback
 * mints a second session by racing the first.
 *
 * NULL COVERS UNKNOWN, EXPIRED AND ALREADY-SPENT, because the statement cannot
 * tell them apart and should not: the caller answers all three the same way, and
 * telling them apart tells whoever captured a callback which it was.
 */
export async function consumeAttempt(db: Executor, state: string): Promise<SsoAttempt | null> {
  const { rows } = await db.query<AttemptRow>(`SELECT * FROM consume_sso_attempt($1)`, [state]);
  const row = rows[0];
  return row
    ? {
        providerId: row.provider_id,
        nonce: row.nonce,
        codeVerifier: row.code_verifier,
        returnTo: row.return_to,
      }
    : null;
}

/* ── Turning a verified token into a person ─────────────────────────────── */

/**
 * Whether this provider was configured to assert addresses at this domain.
 *
 * REPORTS, DOES NOT REFUSE. What a false means — a misconfigured directory or an
 * attempt to mint a token for somebody else's address — is the service's to say.
 *
 * The domain may be null: an address the caller could not split has no domain,
 * and comparing against null is the same statement and the same answer.
 */
export async function domainIsAllowed(
  db: Executor,
  input: { providerId: string; domain: string | null },
): Promise<boolean> {
  /*
   * THROUGH THE FUNCTION, LIKE EVERY OTHER PRE-SESSION LOOKUP ON THIS PATH.
   * This was a plain query against `identity_provider_domains`, which has FORCE
   * row level security and a policy keyed on `app_org_id()` — and an SSO
   * callback has no tenant context, by design, because the organisation is what
   * the lookup establishes. So the policy matched nothing, this returned false
   * for every provider and every address, and every SSO sign-in was refused.
   *
   * 010 already made `identity_provider_for_domain` and `identity_provider_by_id`
   * SECURITY DEFINER for exactly this reason. 047 adds the one that was missing.
   */
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT sso_domain_is_allowed($1, $2) AS ok`,
    [input.providerId, input.domain],
  );
  return rows[0]?.ok === true;
}

/**
 * The user already linked to this directory subject.
 *
 * THE `sub` IS THE JOIN, NOT THE EMAIL — people get married, companies rename
 * domains, and `finance@` is reassigned to a new joiner. Only the id is taken:
 * the full user is read afterwards, under the policy, by the repo that owns that
 * table.
 */
export async function findUserIdForSubject(
  db: Executor,
  input: { providerId: string; subject: string },
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM user_for_federated_subject($1, $2)`,
    [input.providerId, input.subject],
  );
  return rows[0]?.id ?? null;
}

/**
 * Record that this directory subject is this user, and what it last called them.
 *
 * UPSERT, BECAUSE EVERY SIGN-IN ARRIVES HERE. The first one creates the link and
 * the rest refresh `last_email` and `last_seen_at`, which is what a support
 * question about "which account is this" is answered from.
 */
export async function linkIdentity(
  db: Executor,
  input: {
    id: string;
    userId: string;
    providerId: string;
    subject: string;
    email: string;
  },
): Promise<void> {
  await db.query(`SELECT link_federated_identity($1, $2, $3, $4, $5)`, [
    input.id,
    input.userId,
    input.providerId,
    input.subject,
    input.email,
  ]);
}

/* ── Tenant context ─────────────────────────────────────────────────────── */

/**
 * Adopt an organisation for the rest of this transaction.
 *
 * THE SIBLING OF `actAsUser`, AND IT BELONGS BESIDE IT IN `infra/db`. It is here
 * because a service may hold no SQL and this domain's untenanted sign-in has to
 * establish a tenant partway through: the person is discovered without one, and
 * the audit row written afterwards is an ordinary tenanted write.
 *
 * `set_config(..., true)` IS `SET LOCAL`. A plain `SET` would outlive the
 * transaction on a pooled connection and hand the next request this
 * organisation's context.
 */
export async function actAsOrganisation(db: Executor, organisationId: string): Promise<void> {
  await db.query('SELECT set_config($1, $2, true)', ['app.org_id', organisationId]);
}
