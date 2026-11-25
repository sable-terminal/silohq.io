/**
 * Values that are decisions, not settings.
 *
 * THE LINE FROM `env.config` IS WHETHER IT VARIES BY DEPLOYMENT. A database URL
 * differs per environment; the number of failed logins before a lockout does not
 * — it is a security decision, and making it an environment variable means it can
 * be weakened in production by editing a deployment manifest, with no code review
 * and nothing in the history to say who did it.
 *
 * Anything here that later genuinely needs to differ per customer becomes a
 * column on `organisations`, not an environment variable.
 */

// ── Sessions and authentication ─────────────────────────────────────────────

/**
 * Eight hours. Long enough for a working day, short enough that a session
 * captured in the evening is dead by morning.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * How long Redis holds the hot copy.
 *
 * SHORTER THAN THE SESSION ITSELF, DELIBERATELY. Postgres is the record of truth
 * and the revocation list; Redis is a cache in front of it. A short TTL means a
 * revocation that somehow missed the cache still takes effect within the minute,
 * rather than surviving until the session's natural expiry.
 */
export const SESSION_CACHE_TTL_SECONDS = 60;

/** Failed attempts before a lockout, and how long it lasts. */
export const MAX_FAILED_ATTEMPTS = 8;
export const LOCKOUT_SECONDS = 15 * 60;

export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

/**
 * How many reset emails one account may be sent while a token is still live.
 *
 * ── A DIFFERENT DEFENCE FROM THE RATE LIMITER, NOT A DUPLICATE ─────────────
 *
 * `credentialLimit` is keyed on the ADDRESS, deliberately: keying it on the
 * email would let an attacker spread guesses across accounts for free, and
 * would let anyone lock a known address out of its own reset flow by exhausting
 * its bucket. That reasoning is sound and this does not change it.
 *
 * What per-address limiting cannot stop is a DISTRIBUTED sender pointing many
 * addresses at ONE mailbox. Nothing there is being guessed — every request is
 * perfectly valid — and the damage is the flood itself: a person's inbox filled
 * with genuine reset links, among which a phishing copy is very hard to spot.
 *
 * IT IS NOT A LOCKOUT. Tokens already issued stay valid for the hour, so the
 * person can still complete the reset they asked for; only further mail stops.
 */
export const PASSWORD_RESETS_PER_TTL = 5;
export const INVITATION_TTL_DAYS = 14;

/**
 * How many seats a new organisation starts with, by plan.
 *
 * SEATS EXIST FROM REGISTRATION SO THE LIMIT IS REAL FROM DAY ONE. The
 * alternative — an empty pool that means "unlimited until somebody buys some" —
 * makes the whole mechanism dead code until billing exists, and then turns it on
 * for every existing customer at once, which is the worst possible moment to
 * discover an off-by-one in the counting.
 *
 * These are the preview numbers and they are generous on purpose. They are not
 * the pricing tiers; `docs/pricing.md` owns those, and a plan change will set
 * this properly rather than these being quietly treated as the contract.
 */
export const INCLUDED_SEATS: Record<'standard' | 'business' | 'enterprise', number> = {
  standard: 10,
  business: 50,
  enterprise: 250,
};

/** How long an approval chain may wait before the mutation is discarded. */
export const APPROVAL_TTL_HOURS = 72;

// ── Scopes ──────────────────────────────────────────────────────────────────

/**
 * A cap on nesting.
 *
 * NOT A TECHNICAL LIMIT — ltree would take far more. It is a guard against a
 * runaway import creating a thousand-deep chain, and a hint that a tree this deep
 * is a modelling problem rather than a legitimate hierarchy.
 */
export const MAX_SCOPE_DEPTH = 12;

// ── Approvals ───────────────────────────────────────────────────────────────

/**
 * Row thresholds at which the default policy hardens.
 *
 * THE ORGANISATION DEFAULT, NOT A HARD RULE. A customer's own approval policies
 * override these; these are what applies when nobody has configured anything, and
 * they exist so the safe behaviour is the one you get by doing nothing.
 */
export const APPROVAL_SECOND_APPROVER_ROWS = 100;
export const APPROVAL_CANARY_ROWS = 10_000;

// ── Uploads ─────────────────────────────────────────────────────────────────

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_PIXELS = 1024;
/*
 * The largest file the importer will take, wherever it arrives from: an upload
 * through Files, an upload through Silo import, a watched drop, or SFTP.
 *
 * ONE NUMBER, BECAUSE IT IS ONE POLICY. It was four copies of 64MB in four
 * files, and a dead 25MB constant here that nothing read — which is how a
 * caller ends up enforcing a limit nobody else agrees with while a comment
 * claims they share one.
 */
export const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;

export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
] as const;

/**
 * How long a replaced logo is retained.
 *
 * A BAD UPLOAD IS RECOVERABLE FOR A WEEK. Overwriting the key in place means a
 * mistaken upload is unrecoverable the moment it happens, and the person who did
 * it is the least equipped to notice.
 */
export const REPLACED_OBJECT_RETENTION_DAYS = 7;

// ── Query execution ─────────────────────────────────────────────────────────

export const QUERY_TIMEOUT_MS = 60_000;
export const CONNECTOR_TIMEOUT_MS = 30_000;
export const CONNECTOR_MAX_ATTEMPTS = 3;

/**
 * How long a compiled result may be served from cache.
 *
 * SHORT, BECAUSE A CACHED ANSWER IS A STALE ANSWER. The product's claim is that a
 * saved view re-runs against live data; a long cache would quietly break that
 * while making the numbers look impressive.
 */
export const RESULT_CACHE_TTL_SECONDS = 30;

// ── Metering ────────────────────────────────────────────────────────────────

/** The window in which a restatement of a question charges once. */
export const REPHRASE_WINDOW_MS = 10 * 60 * 1000;

/** Tokens granted on first sign-up, before any subscription. */
export const ONBOARDING_TOKEN_GRANT = 50;

// ── Rate limits ─────────────────────────────────────────────────────────────

/**
 * Per membership, per minute.
 *
 * COMPILES ARE LIMITED SEPARATELY FROM READS because they cost real money and a
 * loop that re-compiles is the expensive kind of bug. Reads are cheap and
 * limiting them the same way would break a dashboard with twelve panels.
 */
export const RATE_LIMIT_COMPILES_PER_MINUTE = 20;
export const RATE_LIMIT_REQUESTS_PER_MINUTE = 600;
export const RATE_LIMIT_LOGIN_PER_MINUTE = 10;

// ── Dashboards ──────────────────────────────────────────────────────────────

/**
 * Rendering §8 — how many dashboards one person keeps, and views one holds.
 *
 * THE WIDGET CEILING IS THE ONE THAT MATTERS. Opening a dashboard re-runs every
 * view on it against the customer's own systems, one after another; twenty-four
 * is a full screen and more, and past it the grid takes longer to open than it
 * saves. The dashboard ceiling only stops a runaway client making thousands.
 */
export const MAX_DASHBOARDS_PER_MEMBER = 20;
export const MAX_WIDGETS_PER_DASHBOARD = 24;

// ── Conversations ───────────────────────────────────────────────────────────

/**
 * How long a kept conversation lives past its last use, and how many one
 * person keeps.
 *
 * THE DAYS ARE A CEILING IN THE SCHEMA TOO (migration 110). The product claim
 * is that nothing is stored permanently, so the bound is a CHECK constraint and
 * this constant is only what the application writes inside it.
 */
export const CONVERSATION_DAYS = 30;

/**
 * How long a notification lives.
 *
 * ITS WORDS CAN NAME A CUSTOMER'S RECORDS, so this is storage of customer data
 * and the same rule applies: bounded by a CHECK in migration 113, not by a
 * sweep's good intentions.
 */
export const NOTIFICATION_DAYS = 30;
export const MAX_CONVERSATIONS_PER_MEMBER = 200;

/**
 * How long a raised ticket stays readable in the app.
 *
 * ITS BODY IS FREE TEXT TYPED BESIDE A SCREEN OF SOMEBODY'S CUSTOMERS, so the
 * same rule reaches it: bounded by a CHECK in migration 115. What makes the
 * bound cheap is that the words also go to the support address, and that inbox
 * is where the correspondence actually lives — this copy is only what the panel
 * lists and what the person can reopen.
 *
 * LONGER THAN THE THIRTY EVERYWHERE ELSE, because a ticket is answered by a
 * person over a week or a month rather than read within days. Thirty would
 * delete a partnership thread mid-conversation.
 */
export const TICKET_DAYS = 90;

/**
 * The pages an emailed link lands on.
 *
 * NAMED HERE BECAUSE THEY ARE A CONTRACT WITH A DIFFERENT CODEBASE. These
 * strings have to match routes in `app/client`, and nothing in either project
 * fails when they stop matching — the email sends, the link opens, and the
 * person gets a 404 for an invitation that is perfectly valid. It was already
 * wrong once: the emails pointed at `/accept` and `/reset` while the client
 * served `/accept-invitation` and `/reset-password`.
 *
 * Changing one of these means changing the corresponding directory under
 * `app/client/src/app/(auth)/`.
 */
export const CLIENT_ROUTES = {
  acceptInvitation: '/accept-invitation',
  resetPassword: '/reset-password',
} as const;

/**
 * Simulation §5 — how long an answer is kept.
 *
 * "Re-running uses the current data and the current graph." A result is a
 * statement about the data on one day, so it has a shelf life by nature, and
 * the question outlives it: the scenario is kept, the answer expires.
 *
 * THE SCHEMA CAPS THIS INDEPENDENTLY. `simulation_results` has a CHECK refusing
 * an expiry more than thirty days out, so a value edited here past the ceiling
 * fails at the insert rather than quietly extending retention. That is the same
 * arrangement every other bounded store in the product uses, and it is what
 * makes the storage disclosure a fact rather than an intention.
 */
export const SIMULATION_RESULT_DAYS = 30;

/**
 * Simulation §2.2 — how much history one edge's distribution is drawn from.
 *
 * A CEILING RATHER THAN EVERYTHING, because a Silo's retention window can hold
 * months of transitions for a busy concept and an observation sweep that read
 * all of them would be a table scan per edge. Five thousand events is far more
 * than the thirty §2.2's "enough" needs and still a bounded read.
 *
 * THE OLDEST FIRST, deliberately: `eventTimes` orders by `observed_at`, so a
 * sweep that hits this ceiling measures a contiguous window and reports its two
 * ends, rather than a sample skimmed off whichever rows came back first.
 */
export const OBSERVATION_EVENT_LIMIT = 5_000;
