import { z } from 'zod';

/**
 * What the OAuth screens are allowed to send.
 *
 * THE ISSUER URL IS THE ONE TO BE CAREFUL WITH. It is typed by a customer and
 * ends up as the host this server makes a request to, so it is bounded here and
 * guarded again in `httpClient` — the length cap stops a URL long enough to be
 * an attack on the parser, and `https` is required because everything downstream
 * comes out of the document it fetches.
 */
export const issuer = z
  .object({ issuerUrl: z.string().url().max(2048).startsWith('https://') })
  .strict();

export const connectionId = z.object({ id: z.string().uuid() }).strict();

/** The paths that list records, for a system that publishes no specification. */
export const deriveConnector = z
  .object({ paths: z.array(z.string().min(1).max(512).regex(/^\//, 'A path begins with /')).max(20).default([]) })
  .strict();

export const connectionVersion = z.object({ id: z.string().uuid(), manifestId: z.string().uuid() }).strict();

/** Exactly what the adoption preview showed, echoed back: the confirmation (MANIFEST-V2 §9.2). */
export const adoptVersion = z
  .object({
    origins: z.array(z.string().max(2048)).max(64),
    statements: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(256),
  })
  .strict();

/**
 * Path 2 and path 3 arrive at the same endpoint, because which one applies is
 * something the server works out — the screen offers "register it for me" and
 * "I have one already", and sends whichever the person chose.
 */
export const provisionClient = z
  .object({
    clientName: z.string().min(1).max(120).default('Silo'),
    issuerUrl: z.string().url().max(2048).startsWith('https://').optional(),
    clientId: z.string().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine((v) => (v.clientId === undefined) === (v.clientSecret === undefined), {
    message: 'Supply both the client ID and the client secret, or neither.',
    path: ['clientSecret'],
  })
  .refine((v) => v.clientId !== undefined || v.issuerUrl !== undefined, {
    message: 'Supply an OAuth application, or an issuer URL to register one against.',
    path: ['issuerUrl'],
  });

/**
 * The callback is a navigation from the provider, so everything here is
 * attacker-controlled and none of it is trusted. `state` is the only field that
 * decides anything, and it is looked up rather than read.
 */
export const callback = z
  .object({
    state: z.string().min(20).max(500).optional(),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(1000).optional(),
  })
  .passthrough();

/* ── The builder ────────────────────────────────────────────────────────── */

/**
 * A draft document is `unknown` on purpose.
 *
 * VALIDATING IT HERE WOULD DEFEAT THE POINT OF DRAFTS. The builder saves after
 * every field and §5 requires a failed AI build to open here rather than be
 * discarded, so a half-finished document has to be storable — what the manifest
 * schema says about it is reported back as field errors, not enforced at the
 * door. The size cap is the one real limit, because this lands in a jsonb column.
 */
const document = z.record(z.string(), z.unknown());

export const createDraft = z
  .object({
    name: z.string().min(1).max(128),
    document: document.optional(),
    sourceRoute: z.enum(['ai', 'visual']).optional(),
    failedStage: z.enum(['parse', 'probe', 'reconcile', 'map', 'verify']).nullable().optional(),
  })
  .strict();

export const saveDraft = z
  .object({
    name: z.string().min(1).max(128).optional(),
    document: document.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.document !== undefined, {
    message: 'Nothing to save.',
  });

export const validateDocument = z.object({ document }).strict();

export const draftId = z.object({ id: z.string().uuid() }).strict();

export const route = z.object({ route: z.enum(['ai', 'visual']).default('visual') }).strict();

/** A builder preset filled in. The values are what the form asked for; what it writes comes back. */
export const expandPreset = z
  .object({
    kind: z.enum(['page', 'records', 'filters']),
    id: z.string().min(1).max(64),
    values: z.record(z.string().min(1).max(64), z.string().max(512)).default({}),
    fields: z.array(z.string().min(1).max(128)).max(200).optional(),
    ops: z.array(z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null'])).max(9).optional(),
  })
  .strict();

/**
 * A test run against a live connection.
 *
 * THE LIMIT IS SMALL AND CAPPED. §5's point is that somebody recognises their
 * own data, and twenty rows does that as well as a thousand — this pulls real
 * records over a real connection every time somebody presses it, so the cap is
 * what stops a test panel becoming an export.
 */
export const probe = z
  .object({
    connectionId: z.string().uuid(),
    object: z.string().min(1).max(128),
    limit: z.number().int().min(1).max(20).default(10),
    /** Read at most two pages and say whether the second is really the next one (MANIFEST-V2 WP10). */
    checkPaging: z.boolean().default(false),
  })
  .strict();

/* ── Connections ────────────────────────────────────────────────────────── */

export const createConnection = z
  .object({
    manifestId: z.string().uuid(),
    name: z.string().min(1).max(128),
    owningScopeId: z.string().uuid().nullable().optional(),
  })
  .strict();

/**
 * NO HEADER NAME, NO QUERY PARAMETER, NO BASE URL. Where the value belongs is
 * the connector's business — §4.2, "the manifest never contains a secret. It
 * declares which fields are required and where they belong in a request." Asking
 * for them here would let two connections using one connector disagree about how
 * that connector works.
 */
export const setCredential = z
  .object({
    strategy: z.string().min(1).max(64),
    /** One value, for a strategy that takes one: a key, a token, `user:password`. */
    secret: z.string().min(1).max(8192).optional(),
    /**
     * Named values, for a strategy that takes several — an access key and its
     * secret, a certificate and its private key, a gateway key beside a token.
     * Sealed together as one credential.
     */
    fields: z.record(z.string().min(1).max(64), z.string().max(16_384)).optional(),
  })
  .strict()
  .refine((v) => (v.secret === undefined) !== (v.fields === undefined), {
    message: 'Give either one secret or named fields.',
  });

/**
 * A connection's parameters: not secret, bound into the connector's
 * expressions — a host, a tenant, a region, a certificate authority.
 */
export const setParameters = z
  .object({ parameters: z.record(z.string().min(1).max(64), z.string().max(65_536)) })
  .strict();

export const manifestId = z.object({ manifestId: z.string().uuid() }).strict();

/* ── Verification and writing ───────────────────────────────────────────── */

/**
 * §7.4's test record.
 *
 * IT IS THE CALLER'S JOB TO CHOOSE ONE THAT IS SAFE, and there is nothing this
 * schema can do about that beyond keeping it small. A verification writes to the
 * customer's real system — the sandbox is theirs to nominate, not ours to
 * detect.
 */
export const verifyWrites = z
  .object({
    object: z.string().min(1).max(128),
    testRecord: z.record(z.string(), z.unknown()),
  })
  .strict();

/* ── Route 2 ────────────────────────────────────────────────────────────── */

/**
 * §5's inputs, in descending order of fidelity: a specification URL, then
 * documentation, then a description with a base URL.
 *
 * THE PASTED FORM EXISTS BECAUSE MOST SPECIFICATIONS ARE NOT PUBLIC. An
 * enterprise system's OpenAPI document usually sits behind the same
 * authentication as the system, so "give us a link" would exclude the customers
 * this route is for.
 */
export const aiDraft = z
  .object({
    name: z.string().min(1).max(128),
    sourceKind: z.enum(['openapi', 'graphql', 'wsdl', 'documentation', 'description']),
    /** What it reads, in the builder's words. Lands on the manifest. */
    description: z.string().min(1).max(2000).optional(),
    sourceUrl: z.string().url().max(2048).optional(),
    sourceText: z.string().min(1).max(400_000).optional(),
    baseUrl: z.string().url().max(2048).optional(),
    transportHint: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.sourceUrl) !== Boolean(v.sourceText), {
    message: 'Give a link to the specification, or paste it — not both.',
    path: ['sourceText'],
  });

/* ── A build: the AI finishes and tests the connector ───────────────────── */

export const buildId = z.object({ id: z.string().uuid() }).strict();

/** The credential for a build, and the settings that say which instance of the system it is. */
export const buildCredential = z
  .object({
    strategy: z.string().min(1).max(64),
    fields: z.record(z.string().min(1).max(64), z.string().max(16_384)),
    parameters: z.record(z.string().min(1).max(64), z.string().max(65_536)).optional(),
  })
  .strict();

/** What the person says is wrong, in their own words. */
export const buildFeedback = z.object({ text: z.string().trim().min(3).max(1_000) }).strict();

export const buildConnect = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    /** Objects the key may not read, connected switched off. */
    without: z.array(z.string().min(1).max(128)).max(200).optional(),
  })
  .strict();

/* ── Inbound ────────────────────────────────────────────────────────────── */

export const mintIntake = z
  .object({
    /*
     * BOUNDED HERE AND IN THE DATABASE. 025's CHECK is what makes a permanent
     * row impossible; this is what makes the refusal say something useful rather
     * than surfacing a constraint violation.
     */
    retentionHours: z.number().int().min(1).max(720).optional(),
  })
  .strict();

export const intakeToken = z.object({ token: z.string().min(20).max(200) }).strict();

/**
 * What a webhook may send.
 *
 * `passthrough` ON THE ENVELOPE, because the payload is a customer's own system
 * talking and Silo has no business dictating its shape. What is NOT open is the
 * size, which the service checks.
 */
export const webhookBody = z.record(z.string(), z.unknown());

export const emailBody = z
  .object({
    from: z.string().min(3).max(320),
    subject: z.string().max(998).default(''),
    body: z.string().max(1024 * 1024).default(''),
  })
  .strict();

/* ── Grants ─────────────────────────────────────────────────────────────── */

/**
 * Exactly one grantee, which the database also insists on.
 *
 * A DISCRIMINATED UNION RATHER THAN FOUR NULLABLE FIELDS. Four optional ids is
 * how a request arrives naming two grantees and the server picks whichever it
 * checks first — 016's CHECK exists for the same reason at the other end.
 */
const grantee = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('organisation') }).strict(),
  z
    .object({
      kind: z.literal('scope'),
      scopeId: z.string().uuid(),
      includeDescendants: z.boolean().default(true),
    })
    .strict(),
  z.object({ kind: z.literal('membership'), membershipId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('principal'), principalId: z.string().uuid() }).strict(),
]);

export const grantConnection = z
  .object({
    grantee,
    canRead: z.boolean().default(true),
    canWrite: z.boolean().default(false),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();

export const grantId = z.object({ id: z.string().uuid(), grantId: z.string().uuid() }).strict();

/**
 * What the credential is at the source, and how far it reaches.
 *
 * A REVIEWER'S FIRST QUESTION ABOUT A SHARED SERVICE ACCOUNT. Recording it
 * enforces nothing; it makes the blast radius of a shared credential a fact Silo
 * can show rather than one somebody has to log into Salesforce to find out.
 */
export const credentialProvenance = z
  .object({
    actsAs: z.string().min(1).max(256).nullable().optional(),
    rights: z.enum(['broad', 'scoped', 'unknown']).optional(),
  })
  .strict()
  .refine((v) => v.actsAs !== undefined || v.rights !== undefined, {
    message: 'Nothing to record.',
  });

export const retire = z
  .object({ reason: z.string().min(1).max(500) })
  .strict();

export const decideProposal = z
  .object({ decision: z.enum(['accepted', 'rejected']) })
  .strict();

export const proposalId = z.object({ id: z.string().uuid(), proposalId: z.string().uuid() }).strict();
