import 'dotenv/config';
import { z } from 'zod';

/**
 * The environment, validated once, before anything else runs.
 *
 * FAILS AT STARTUP OR NOT AT ALL. A variable read lazily surfaces as `undefined`
 * somewhere far from the cause — a connection string that is the literal word
 * "undefined", a mailer that silently drops everything, a KMS client that throws
 * on the first credential six hours in. Parsing the whole environment before the
 * server binds turns every one of those into one message naming the variable.
 *
 * ONE FILE FOR THE VARIABLES, SEVERAL FOR THE MEANING. This validates and nothing
 * else; `auth.config`, `billing.config` and the rest read from it and expose
 * shapes that mean something. A single 600-line config module where every concern
 * reaches for raw strings is how two subsystems end up disagreeing about what a
 * timeout is measured in.
 *
 * OPTIONAL HERE, REQUIRED IN PRODUCTION. Most integrations are absent in
 * development and their absence is a legitimate state — mail is printed, the
 * model is stubbed. `assertProductionReady` is where "absent" stops being
 * acceptable, and it lists what each missing value would silently break.
 */

const url = z.string().url();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4002),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ── Cell identity ─────────────────────────────────────────────────────────
  /**
   * WHICH CELL THIS PROCESS IS. The directory tier routes a login to a cell and
   * nothing in a cell may reach another one, so a process that does not know its
   * own identity cannot enforce that. It is not optional even in development,
   * because code that only has a cell id in production is code where the
   * cell-boundary checks are never exercised.
   */
  CELL_ID: z.string().min(1).default('local'),

  /**
   * DEVELOPMENT ONLY: let Silo itself connect to a source on a private address —
   * the demo database on localhost, an API on the laptop. In production a
   * private source is reached through the customer's agent and never from
   * Silo, and `assertProductionReady` refuses to start with this set.
   */
  ALLOW_PRIVATE_SOURCES: z.enum(['true', 'false']).default('false'),
  CELL_REGION: z.string().min(1).default('europe-west2'),

  /**
   * The directory tier: which cell a person belongs to.
   *
   * GLOBAL BY DEFINITION, so it cannot be a table inside a cell. It answers
   * "where do I send this login" before any cell has been chosen, which a
   * per-cell copy cannot do. Unset in development, where it falls back to the
   * product database — standing up a second Postgres to run the tests is a cost
   * with no lesson in it, and the separation that matters is the connection.
   */
  DIRECTORY_DATABASE_URL: z.string().optional(),

  /**
   * A secret keying the directory's address hashes.
   *
   * A BARE SHA-256 OF AN EMAIL IS REVERSIBLE IN PRACTICE: the space of real
   * addresses is small enough to enumerate, so an unkeyed digest would make the
   * directory a customer list with extra steps. It is the one component every
   * cell can reach, so it is the one whose compromise would be global.
   */
  DIRECTORY_HASH_SECRET: z.string().min(32).optional(),

  /**
   * Where each cell answers, as `id=https://host` pairs.
   *
   * READ AT THE EDGE OF A LOGIN, to send somebody to the cell that actually
   * holds their data. Without it a person whose account lives elsewhere is told
   * their password is wrong, which is both untrue and unfixable by them.
   */
  CELL_URLS: z.string().optional(),

  // ── Data ──────────────────────────────────────────────────────────────────
  /** Connects as `silo_app`, which cannot bypass row level security. */
  DATABASE_URL: z.string().min(1),
  /** The migrator. Read by scripts, never by the server. */
  DATABASE_MIGRATION_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // ── Secrets and identity ──────────────────────────────────────────────────
  SESSION_SECRET: z.string().min(32),
  /**
   * Keys the HMAC over IP addresses and user agents in audit rows.
   *
   * SEPARATE FROM `SESSION_SECRET`, because they have different lifetimes.
   * Rotating a session secret logs everybody out and is a routine operation;
   * rotating this one makes every historical audit row unlinkable to any future
   * one, which is a decision with a different owner.
   */
  IP_HASH_SECRET: z.string().min(32).optional(),
  /** Signs pagination cursors. See `utils/cursor.util.ts`. */
  CURSOR_SECRET: z.string().min(32).optional(),

  // ── Google Cloud ──────────────────────────────────────────────────────────
  GCP_PROJECT_ID: z.string().optional(),
  KMS_LOCATION: z.string().default('europe-west2'),
  KMS_KEY_RING: z.string().optional(),
  /** The KEK that wraps every data key. See `utils/envelope.util.ts`. */
  KMS_KEY_NAME: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),

  // ── Model ─────────────────────────────────────────────────────────────────
  VERTEX_PROJECT_ID: z.string().optional(),
  /**
   * `global`, not a region. Gemini 3 is only served there, and a regional
   * endpoint fails with a model-not-found that reads like a wrong model name.
   */
  VERTEX_LOCATION: z.string().default('global'),
  VERTEX_MODEL: z.string().default('gemini-3-flash-preview'),
  /**
   * THE MODEL A CONNECTOR BUILD REPAIRS WITH. Every repair is read against the
   * real system in the next round, so a fast model's mistake is caught and
   * corrected — while a slow one makes somebody watch a spinner for minutes a
   * round. Separate from VERTEX_MODEL so a deployment answering questions on a
   * large model does not build connectors on it too.
   */
  VERTEX_BUILD_MODEL: z.string().default('gemini-3-flash-preview'),
  /**
   * THE MODEL THAT SEARCHES THE WEB, with its thinking switched off. A lookup
   * finds and summarises; it does not reason. Measured on the same lookup:
   * Gemini 3.1 Pro took 31s and cited 2 pages, Gemini 3 Flash 11s and cited
   * none — often answering from memory, which cannot be cited and so is not
   * used — and Gemini 2.5 Flash without thinking 5s, citing about ten.
   */
  VERTEX_SEARCH_MODEL: z.string().default('gemini-2.5-flash'),
  /**
   * THE MODEL THAT WRITES AN ANSWER UP, at low thinking. The write-up is where
   * a person waits after the rows are on screen. Measured on the same answer
   * and web context: Gemini 3.1 Pro took 39s at its default thinking and 28s
   * at low; Gemini 3 Flash took 125s at its default and 4s at low, with a
   * write-up as good and every figure checked.
   */
  VERTEX_READING_MODEL: z.string().default('gemini-3-flash-preview'),
  /**
   * A LARGE CEILING ON PURPOSE. Gemini's thinking models spend tokens before
   * they emit any, so a conventional small cap truncates the answer to nothing
   * and returns an empty string rather than an error.
   */
  VERTEX_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).default(65_536),
  /**
   * Import §8 — "Vertex zero-retention", SAID BY THE OPERATOR, NOT ASSUMED.
   *
   * Whether Google keeps a prompt is a setting on the Google Cloud project, not
   * something a request can ask for. So no document's text is sent to the model
   * until whoever runs this deployment has arranged zero data retention for its
   * project and says so here. Off by default: the disclosure's promise is kept
   * by refusing, not by hoping.
   */
  VERTEX_ZERO_RETENTION_CONFIRMED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ── Mail ──────────────────────────────────────────────────────────────────
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('Silo <noreply@silohq.io>'),

  /**
   * Where a raised ticket is sent.
   *
   * CONFIGURED RATHER THAN WRITTEN INTO THE SERVICE, because a sovereign
   * deployment's support desk is not ours: the customer running it answers its
   * own people, and a hard-coded address would forward their security reports
   * to us. It has a default because every deployment needs somewhere, and an
   * unset one would mean tickets stored and never read by anybody.
   */
  SUPPORT_EMAIL: z.string().email().default('support@silohq.io'),

  // ── Billing ───────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // ── Web ───────────────────────────────────────────────────────────────────
  /** The only origin CORS admits, and where links in email point. */
  APP_URL: url.default('http://localhost:3002'),

  /**
   * This API's own public address.
   *
   * NEEDED BECAUSE AN SSO REDIRECT URI IS NOT THE APP'S. The customer's
   * directory sends the browser back to a URL that must hit THIS service — it
   * carries a code that has to be exchanged with a client secret, and it sets
   * the session cookie — and only then does it forward to the app. Using
   * `APP_URL` here sends the browser to a page that does not exist, which is
   * what the first version did.
   *
   * It must also match the redirect URI registered with each provider exactly,
   * character for character, or the provider refuses before anything reaches
   * this code.
   */
  API_URL: url.default('http://localhost:4002'),

  /**
   * The domain the session cookie is scoped to.
   *
   * UNSET IN DEVELOPMENT AND REQUIRED IN PRODUCTION, because the two are not
   * the same shape. Locally the API is `localhost:4002` and the app is
   * `localhost:3002` — cookies ignore the port, so a host-only cookie set by
   * one is sent to the other and everything works. In production they are
   * `api.silohq.io` and `app.silohq.io`, and a host-only cookie set by the API
   * is NOT sent to the app: the browser holds a perfectly valid session that
   * the app can never see, and every page renders signed out. Nothing errors.
   *
   * `.silohq.io` is what makes it cross the subdomain. It is deliberately not
   * defaulted, because a wrong value here is a cookie sent to hosts that should
   * not receive it.
   */
  COOKIE_DOMAIN: z.string().optional(),

  // ── Bot protection ────────────────────────────────────────────────────────
  /** Cloudflare Turnstile. Verified server-side; the site key lives in the app. */
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // ── Inbound connectors ────────────────────────────────────────────────────
  /**
   * The domain forwarded notifications are addressed to.
   *
   * MINTED ADDRESSES ARE RANDOM AT THE LOCAL PART, so this is only the half
   * after the @. Unset means the email connector cannot mint an address, which
   * is the right failure for a deployment that has no inbound mail set up —
   * offering an address nothing delivers to would look like it worked.
   */
  INBOUND_EMAIL_DOMAIN: z.string().min(3).optional(),

  /**
   * MANIFEST-V2 §3.4 — the address(es) Silo's requests to customers' systems
   * come from, comma-separated, when the deployment sends through a reserved
   * NAT address. Shown where somebody connects a system that only accepts
   * known addresses. Unset says nothing, rather than an address that is wrong.
   */
  EGRESS_IPS: z.string().max(512).optional(),

  // ── Agent discovery ───────────────────────────────────────────────────────
  /**
   * §9 — "Off by default. Compiled out of the sovereign build entirely."
   *
   * A BUILD SWITCH, NOT A SETTING. The per-organisation `discovery_enabled` flag
   * is the customer's choice; this is whether the capability exists in this
   * deployment at all. A sovereign build sets it false and the routes are never
   * mounted, so "off means unreachable, not idle" is true of the HTTP surface
   * rather than being a check inside a handler somebody could later skip.
   */
  DISCOVERY_AVAILABLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ── Siloes ────────────────────────────────────────────────────────────────
  /**
   * §6.1 and §3 — whether retained storage exists in this deployment at all.
   *
   * A BUILD SWITCH, LIKE DISCOVERY'S. A sovereign deployment compiles storage
   * out, and the difference matters to what the product SAYS: where storage is
   * merely off, a detector that cannot run offers to turn it on; where it is
   * compiled out, offering a switch that does not exist is worse than useless.
   *
   * AVAILABLE IS NOT ON. A deployment that has storage sets this true, and every
   * organisation in it still stores nothing until a super admin reads the
   * disclosure and switches storage on.
   *
   * THE HISTORY DETECTORS DO NOT DEPEND ON IT. That is the whole point of
   * resolving history by capability: a source system with dated records answers
   * timing deviation, drift and recurrence today, with this flag false.
   */
  SILOES_AVAILABLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ── Siloes: import ────────────────────────────────────────────────────────
  /**
   * Import §7 — where extracted rows are held.
   *
   * UNSET CHOOSES, AND NEVER CHOOSES A FALLBACK IN PRODUCTION. Outside
   * production the Postgres stand-in is used. In production it is BigQuery when
   * a project and a location are configured, and otherwise import refuses: rows
   * quietly landing somewhere the disclosure does not describe is the failure
   * this exists to prevent.
   */
  SILO_ROW_STORE: z.enum(['postgres', 'bigquery']).optional(),
  BIGQUERY_PROJECT_ID: z.string().optional(),
  /**
   * The dataset location. CONFIGURATION RATHER THAN ASSUMPTION: checked against
   * `SILO_RESIDENCY` when a dataset is created, and against the dataset's actual
   * location every time one is used.
   */
  BIGQUERY_LOCATION: z.string().optional(),
  /** Where this cell's imported data may sit. `uk` is London and nowhere else. */
  SILO_RESIDENCY: z.enum(['uk', 'eu', 'unrestricted']).default('uk'),
  /** Outside production, with no bucket, objects are written under this directory. */
  LOCAL_OBJECT_STORE_DIR: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  // Not the logger: the logger reads this module, so it does not exist yet.
  process.stderr.write(`\nThe environment is not valid:\n${lines.join('\n')}\n\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDev = env.NODE_ENV === 'development';

/**
 * Refuse a production boot that is missing something production needs.
 *
 * EACH OF THESE IS SILENT WHEN ABSENT, which is why they are asserted rather
 * than left to fail where they are used. A missing KMS key does not error at
 * startup — it errors on the first credential unseal, hours later, on a
 * connector nobody is watching.
 *
 * THE FIRST CHECK IS THE ONE THAT MATTERS MOST. If the application connects with
 * the migration role, every row level security policy in the schema is
 * decorative: the tables exist, the policies exist, the tests of the SQL pass,
 * and every tenant can read every other. Nothing else would notice.
 */
export function assertProductionReady(): void {
  if (!isProd) return;

  const fatal: string[] = [];

  if (env.DATABASE_MIGRATION_URL && env.DATABASE_URL === env.DATABASE_MIGRATION_URL) {
    fatal.push(
      'DATABASE_URL and DATABASE_MIGRATION_URL are identical. The application would connect ' +
        'as the migration role, which bypasses row level security, and every tenant would be ' +
        'able to read every other.',
    );
  }

  if (env.ALLOW_PRIVATE_SOURCES === 'true') {
    fatal.push(
      'ALLOW_PRIVATE_SOURCES is set. Silo would connect to private addresses directly — the cloud ' +
        'metadata server, its own database, anything on the VPC — on behalf of any connector.',
    );
  }

  const missing: string[] = [];
  if (!env.KMS_KEY_NAME) missing.push('KMS_KEY_NAME (no credential could be sealed or opened)');
  if (!env.GCP_PROJECT_ID) missing.push('GCP_PROJECT_ID (KMS and object storage would be unreachable)');
  if (!env.STORAGE_BUCKET) missing.push('STORAGE_BUCKET (uploads would have nowhere to go)');
  if (!env.REDIS_URL) missing.push('REDIS_URL (sessions would have no hot path and rate limits no state)');
  if (!env.IP_HASH_SECRET) missing.push('IP_HASH_SECRET (audit rows could not record where an event came from)');
  if (!env.CURSOR_SECRET) missing.push('CURSOR_SECRET (pagination cursors would be unsigned and forgeable)');
  if (!env.DIRECTORY_HASH_SECRET) {
    missing.push(
      'DIRECTORY_HASH_SECRET (the directory would key its address hashes with the session ' +
        'secret, and a bare hash of an email is reversible in practice)',
    );
  }
  if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY (no invitation or reset email would be sent)');
  if (!env.VERTEX_PROJECT_ID) missing.push('VERTEX_PROJECT_ID (no question could be compiled)');
  if (!env.COOKIE_DOMAIN) {
    missing.push(
      'COOKIE_DOMAIN (the session cookie would be host-only, so a session set by the API ' +
        'would never be sent to the app, and every page would render signed out)',
    );
  }

  if (missing.length > 0) {
    fatal.push(`Not configured:\n    ${missing.join('\n    ')}`);
  }

  if (fatal.length > 0) {
    throw new Error(`Production is not configured:\n\n  ${fatal.join('\n\n  ')}\n`);
  }
}
