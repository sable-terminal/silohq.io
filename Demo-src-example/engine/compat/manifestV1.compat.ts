import { z } from 'zod';
import { authStrategy } from './connectorAuthV1.compat';

/**
 * The connector manifest.
 *
 * THE MOST IMPORTANT OBJECT IN THE SUBSYSTEM. If the schema cannot express a
 * system, no route can connect to it; if it can, every route can. It is also the
 * boundary between anything a model produced and anything the engine executes —
 * a draft that fails validation is rejected, never repaired.
 *
 * NOTHING HERE NAMES A PROVIDER, because nothing in the engine does. Adding
 * Salesforce means writing a document; it never means writing code.
 *
 * ── Why so many discriminated unions ────────────────────────────────────────
 *
 * The visual builder's form is generated from this schema: pick a pagination
 * strategy and the form asks for exactly that strategy's parameters. Every axis
 * where the fields depend on a choice is a `discriminatedUnion` for that reason,
 * and `z.enum` rather than a validated string everywhere the interface needs a
 * dropdown — the enum's values ARE the options.
 *
 * The same shape makes the engine exhaustive: a `switch` with no default fails
 * to compile when a strategy is added, which is what stops a strategy being
 * enumerated here and silently unimplemented in the executor.
 */

/* ── Transport ──────────────────────────────────────────────────────────── */

/**
 * How the bytes arrive, separated from everything above it.
 *
 * Discovery, capabilities, mapping and pushdown do not care which of these is
 * underneath. New transports are Silo-authored plugins — this enum is a closed
 * set of eight, not an extension point.
 */
export const transport = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('https_rest'),
      baseUrl: z.string().url(),
      // A provider that only speaks TLS 1.2 exists; declaring it beats
      // discovering it as an opaque handshake failure.
      minTlsVersion: z.enum(['1.2', '1.3']).default('1.2'),
      /*
       * WHAT THIS API DEMANDS ON EVERY REQUEST AND WILL NOT WORK WITHOUT.
       *
       * `Notion-Version: 2022-06-28`. `Accept: application/vnd.github+json`.
       * `Xero-tenant-id`. `Stripe-Version`. None of them is a credential and
       * none of them is optional, and with nowhere to declare one the only
       * connectors that worked were the ones that wanted nothing but a token —
       * which is why every real app tried here failed at the first request.
       *
       * NOT A PLACE FOR A SECRET. §4.2 holds: the manifest says where values
       * belong, the credential arrives sealed and separately. A header whose
       * value is the key is `api_key_header`, which is auth and is declared
       * there. Anything written here travels with the connector, including to
       * whoever it is exported to.
       */
      headers: z
        .record(z.string().min(1).max(128), z.string().max(512))
        .default({})
        .describe('Constant headers this API requires'),
    })
    .strict(),
  z.object({ kind: z.literal('graphql'), endpoint: z.string().url() }).strict(),
  z.object({ kind: z.literal('soap'), wsdlUrl: z.string().url() }).strict(),
  z
    .object({
      /*
       * TWO SQL TRANSPORTS, ONE SQL PROTOCOL. ODBC and JDBC are different ways
       * of carrying the same thing, and collapsing them loses the distinction
       * that lets the engine pick a driver independently of how it reads the
       * result. `connector_transports` says the same in the database.
       */
      kind: z.literal('sql_odbc'),
      driver: z.enum(['postgres', 'mysql', 'mssql', 'oracle', 'odbc']),
      // Host and database are credential-adjacent but not secret, so they live
      // in the manifest; the password does not.
      host: z.string().min(1),
      port: z.number().int().min(1).max(65_535),
      database: z.string().min(1),
      schema: z.string().min(1).default('public'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sftp_file'),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65_535).default(22),
      path: z.string().min(1),
    })
    .strict(),
  /*
   * The two inbound transports. Silo does not reach out for these — it hands the
   * customer an address to put into their own system, which is why neither has a
   * base URL and both are identified by the connection they belong to.
   */
  z.object({ kind: z.literal('inbound_webhook') }).strict(),
  z.object({ kind: z.literal('email_fallback') }).strict(),
  /*
   * A SILO IMPORT. Files Silo holds a copy of, structured by a definition, read
   * from Silo's own row store. Identified by the import source it belongs to;
   * never built in the connector builder, always published from a definition.
   */
  z.object({ kind: z.literal('silo_import'), sourceId: z.string().uuid() }).strict(),
]);

/* ── Discovery ──────────────────────────────────────────────────────────── */

const field = z
  .object({
    name: z.string().min(1),
    /** The system's own type, not ours. Normalisation happens above. */
    type: z.enum(['string', 'number', 'boolean', 'date', 'datetime', 'json', 'unknown']),
    nullable: z.boolean().default(true),
    description: z.string().max(500).optional(),
  })
  .strict();

const relationship = z
  .object({
    /*
     * FOREIGN KEYS ARE THE POINT. Catalogue introspection gives these directly,
     * which is what the ontology mapping needs and what the simulation
     * dependency graph later requires and cannot otherwise obtain.
     */
    field: z.string().min(1),
    targetObject: z.string().min(1),
    targetField: z.string().min(1),
  })
  .strict();

/**
 * What this object's records can tell you about the past.
 *
 * §3 — THE THREE HISTORY DETECTORS ARE GATED ON CAPABILITY, NOT ON STORAGE.
 * Timing deviation, drift and recurrence need historical data; they do not need
 * a Silo. In many cases the source system already holds the history and a
 * federated query can reach it — an order table with created and completed
 * timestamps answers timing deviation directly, with nothing stored anywhere.
 *
 * ── Why two fields and not one ─────────────────────────────────────────────
 *
 * WHETHER RECORDS ARE DATED IS INFERRED, not declared: a `date` or `datetime`
 * field is visible in `fields` already, and asking somebody to restate it is
 * asking them to get it wrong.
 *
 * THE TWO THINGS THAT CANNOT BE INFERRED ARE HERE. Whether a row is appended or
 * overwritten in place is invisible in a schema — a status column that went from
 * "in transit" to "delivered" looks identical to one that was always
 * "delivered", and the difference decides whether drift can be computed at all.
 * And how far back the source keeps rows is a retention policy, which no amount
 * of introspection reveals; asking for six months of history from a system that
 * keeps ninety days produces a confident answer about the wrong period.
 */
const history = z
  .object({
    /*
     * FALSE IS THE SAFE DEFAULT AND THE COMMON CASE. Most business objects are
     * mutated in place. Defaulting true would make every existing manifest claim
     * a capability it does not have, and the failure would be a drift finding
     * computed from a table that silently forgot its own past.
     */
    appendOnly: z.boolean().default(false),

    /**
     * How far back this object keeps rows, in days. Absent means unbounded or
     * unknown — which are treated the same, because a resolver cannot tell them
     * apart and both mean "ask and find out".
     */
    retentionDays: z.number().int().min(1).optional(),
  })
  .strict();

/* ── Pagination ─────────────────────────────────────────────────────────── */

export const pagination = z.discriminatedUnion('strategy', [
  z
    .object({
      strategy: z.literal('offset_limit'),
      offsetParam: z.string().min(1).default('offset'),
      limitParam: z.string().min(1).default('limit'),
      pageSize: z.number().int().min(1).max(1000).default(100),
    })
    .strict(),
  z
    .object({
      strategy: z.literal('page_number'),
      pageParam: z.string().min(1).default('page'),
      sizeParam: z.string().min(1).default('per_page'),
      pageSize: z.number().int().min(1).max(1000).default(100),
      firstPage: z.number().int().min(0).default(1),
    })
    .strict(),
  z
    .object({
      strategy: z.literal('cursor'),
      cursorParam: z.string().min(1),
      /** Where the next cursor is found in the response. */
      cursorPath: z.string().min(1),
      limitParam: z.string().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).default(100),
      /*
       * A CURSOR SENT BACK THE WAY IT CAME. A read that is a POST carries its
       * cursor in the body — Notion's `start_cursor`, Elasticsearch's
       * `search_after` — and putting it in the query string of a POST is a
       * request the source ignores, which reads as "the first page, for ever".
       */
      where: z.enum(['query', 'body']).default('query'),
    })
    .strict(),
  // RFC 5988. Nothing to configure: the header names itself.
  z.object({ strategy: z.literal('link_header') }).strict(),
  z
    .object({
      strategy: z.literal('body_token'),
      tokenPath: z.string().min(1),
      tokenParam: z.string().min(1),
    })
    .strict(),
  z
    .object({
      strategy: z.literal('scroll'),
      scrollParam: z.string().min(1),
      scrollPath: z.string().min(1),
      keepAlive: z.string().min(1).default('1m'),
    })
    .strict(),
  z.object({ strategy: z.literal('none') }).strict(),
]);

/* ── Response ───────────────────────────────────────────────────────────── */

/**
 * WHERE A VALUE IS INSIDE A RECORD, as a path a person or a model can write.
 *
 * `properties.Status.select.name`, `properties.Name.title[0].plain_text`. Dots
 * walk into objects, `[n]` takes an element, and that is the whole language —
 * it cannot loop, cannot call out and cannot be anything other than a reading
 * of the record in front of it.
 *
 * A LIST OF PATHS IS TRIED IN ORDER, first one present wins. The same field is
 * spelled differently by different record types in the same collection — a
 * Notion title is `title[0].plain_text` and a rich text field is
 * `rich_text[0].plain_text` — and the alternative to candidates is a connector
 * per record type.
 */
const valuePath = z.string().min(1).max(512);

export const response = z
  .object({
    shape: z.enum(['array', 'enveloped', 'jsonapi', 'hal', 'xml', 'csv']),
    /** Where the records are, for anything that is not a bare array. */
    recordPath: z.string().optional(),
    /*
     * ── HOW A RECORD BECOMES FIELDS ───────────────────────────────────────
     *
     * THE FIELDS AN API RETURNS ARE USUALLY NOT THE FIELDS ANYBODY ASKS ABOUT.
     * A Notion page's status is at `properties.Status.select.name`, a Jira
     * issue's summary is at `fields.summary`, a HubSpot company's name is at
     * `properties.name`. Without a way to say so, the rows arrive technically
     * correct and useless: nothing downstream can name a field, so nothing can
     * filter, compare or resolve on one.
     *
     * DECLARED, NOT INFERRED, and read as data rather than executed. Absent, a
     * record is taken as it comes — which is what a flat API already gives.
     */
    fields: z
      .record(z.string().min(1).max(128), z.union([valuePath, z.array(valuePath).min(1).max(8)]))
      .optional()
      .describe('Field name to where its value sits in a record'),
    /*
     * RESHAPING IS AN EXPRESSION, NOT CODE. JSONata cannot loop and cannot call
     * out, so it needs no sandbox — which is the whole reason the customer-
     * authored code path could be dropped.
     */
    transform: z.string().max(2000).optional().describe('JSONata expression'),
  })
  .strict();

/**
 * ── HOW THIS OBJECT IS READ ────────────────────────────────────────────────
 *
 * THE ENGINE USED TO ASSUME THE ANSWER: a GET, at a literal path, with the
 * records wherever the manifest said they were for every object at once. That
 * assumption is the reason a connector could be built for a test API and not
 * for Notion, Shopify, Jira or Xero — not because anything was hard, but
 * because the document had no words for what those APIs do.
 *
 *   · Notion lists pages with `POST /v1/search` and a query document, and pages
 *     a cursor through the body.
 *   · Shopify returns `{ orders: [...] }` and `{ products: [...] }`, so one
 *     envelope for the whole connector is one object per connector.
 *   · Anything with a parent in its URL — `/databases/{id}/query`,
 *     `/repos/{owner}/{repo}/issues` — needs a path that is not a constant.
 *
 * SO THE DOCUMENT SAYS, AND THE ENGINE FOLLOWS. Every field here is optional
 * and falls back to what the manifest already said, so a connector that was a
 * plain GET stays exactly one line of document long.
 *
 * STILL DATA, NOT CODE. A method, a path with named holes, headers, constant
 * query parameters and a body — a request that can be read off the page and
 * audited, written by whoever read the API's documentation or by a model that
 * read it for them.
 */
const readOperation = z
  .object({
    /*
     * A READ THAT IS A POST IS NOT A WRITE. `/v1/search` and `_search` change
     * nothing; the verb says how the question is carried, and `mutation` is
     * still the only thing that says a connector may change anything.
     */
    method: z.enum(['GET', 'POST']).default('GET'),

    /**
     * Where to send it, when that is not the object's own path.
     *
     * `{name}` IS FILLED FROM `params`, and from nowhere else — never from a
     * value in somebody's data, which is how a path becomes an injection.
     */
    path: z.string().min(1).max(512).optional(),
    params: z
      .record(z.string().min(1).max(64), z.string().max(512))
      .default({})
      .describe('Values for the {holes} in the path'),

    /** Headers this operation needs on top of the transport's own. */
    headers: z.record(z.string().min(1).max(128), z.string().max(512)).default({}),

    /** Query parameters this operation always sends. */
    query: z.record(z.string().min(1).max(128), z.string().max(512)).default({}),

    /*
     * THE QUESTION, FOR AN API THAT TAKES ONE AS A DOCUMENT. Notion's
     * `{"filter":{"property":"object","value":"page"}}`, Elasticsearch's query
     * body. Sent only on a POST, and merged with the cursor when paging puts
     * one in the body.
     */
    body: z.record(z.string(), z.unknown()).optional(),

    /** Where the records are in THIS response, when it differs from the rest. */
    response: response.optional(),

    /** How THIS operation pages, when it differs from the rest. */
    pagination: pagination.optional(),
  })
  .strict();

const object = z
  .object({
    name: z.string().min(1),
    /** Where the records live: a path, a table, a GraphQL type. */
    path: z.string().min(1),
    /**
     * How this object is read, where a plain GET at that path is not it.
     *
     * ABSENT IS THE COMMON CASE AND MEANS WHAT IT ALWAYS MEANT. Everything in
     * it falls back to the manifest, so adding this to the schema changed no
     * existing connector and no existing behaviour.
     */
    read: readOperation.optional(),
    fields: z.array(field),
    /**
     * The fields that identify a record. Without them nothing can be fetched
     * singly.
     *
     * AN ARRAY FROM THE START, AND USUALLY LENGTH ONE. Almost every real ERP and
     * finance system has composite keys — company plus document number, tenant
     * plus id — and a single field cannot express one. Deferring this until a
     * system needed it would mean rewriting every manifest already written, and
     * the change touches IDENTITY, which is what the ontology resolves against:
     * a record whose key was truncated to its first column is a record that
     * merges with its siblings.
     */
    identifier: z.array(z.string().min(1)).min(1),
    relationships: z.array(relationship).default([]),

    /*
     * PARTIAL SUCCESS IS SUCCESS. An object discovery found but mapping could
     * not place is created unavailable rather than blocking the connector. Eight
     * objects answering questions today beats eleven nobody finished.
     */
    available: z.boolean().default(true),

    /*
     * ADDITIVE WITH A DEFAULT, so every manifest already written stays valid and
     * parses to "not append-only, retention unknown" — which is the honest
     * reading of a manifest whose author was never asked.
     */
    history: history.default({ appendOnly: false }),
  })
  .strict();

/* ── Capabilities and pushdown ──────────────────────────────────────────── */

/**
 * The four ways an HTTP API takes a filter.
 *
 * ENUMERATED, NOT EXPRESSED AS A TEMPLATE LANGUAGE. A template general enough to
 * cover all four would be a small programming language in the manifest, which is
 * the thing §1 exists to avoid — and these four cover what real APIs do.
 */
const filterEncoding = z.discriminatedUnion('style', [
  z
    .object({
      style: z.literal('query_param'),
      /*
       * WHAT AN OPERATOR LOOKS LIKE ON THE WIRE. Django writes `created__gte`,
       * others write `created_min` or `minCreated`, and plenty support only
       * equality. A field left out of this map is an operator this API cannot
       * express, so the engine keeps that filter and applies it here instead.
       */
      operatorSuffix: z
        .record(z.string(), z.string())
        .default({ eq: '' })
        .describe('Operator to parameter suffix, e.g. { gte: "__gte" }'),
    })
    .strict(),
  // ?filter[status]=paid
  z.object({ style: z.literal('jsonapi') }).strict(),
  // ?$filter=status eq 'paid'
  z.object({ style: z.literal('odata'), param: z.string().min(1).default('$filter') }).strict(),
  // ?filter=status==paid
  z.object({ style: z.literal('rsql'), param: z.string().min(1).default('filter') }).strict(),
]);

const capabilities = z
  .object({
    list: z.boolean().default(true),
    get: z.boolean().default(true),
    /*
     * DECLARED PER CONNECTOR, NEVER ASSUMED. What cannot be pushed down comes
     * back and is bounded in memory; assuming a filter works when it does not
     * means the system silently returns everything and the bound fires on a
     * question that should have been cheap.
     */
    filters: z
      .array(z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null']))
      .default([]),
    sort: z.boolean().default(false),
    fieldSelection: z.boolean().default(false),
    aggregates: z.array(z.enum(['count', 'sum', 'group_by'])).default([]),

    /*
     * ── HOW MANY VALUES ONE `in` MAY CARRY ────────────────────────────────
     *
     * A join executes as a sequence rather than as a join: query the first
     * concept, take the identifiers that came back, and push them down to the
     * second as an `in`. That only works if the source will accept the list.
     *
     * SQL WILL TAKE THOUSANDS. An HTTP API frequently will not — a hundred is
     * a common cap, and a few are lower. Exceeding it is the worst kind of
     * failure this product has: the request usually succeeds and returns
     * something, because the parameter is truncated or ignored rather than
     * rejected, so the answer is short and confident.
     *
     * SO IT IS DECLARED, NOT PROBED, like every other capability here. A list
     * longer than this becomes several requests; this is the number that says
     * how many. Zero means the source declares no limit, which SQL transports
     * leave as the default rather than each restating a meaningless one.
     */
    maxFilterValues: z.number().int().min(0).max(100_000).default(0),

    /*
     * HOW A FILTER IS WRITTEN DOWN, as against which ones are supported.
     *
     * `filters` SAYS `eq` WORKS AND SAYS NOTHING ABOUT WHAT TO SEND. For SQL
     * that gap does not exist — a filter is `WHERE col = $1` and there is only
     * one way to write it. Over HTTP there are four common ones and they share
     * nothing: `?status=paid`, `?filter[status]=paid`, `?$filter=status eq
     * 'paid'`, `?filter=status==paid`. A generic engine cannot guess, and
     * guessing wrong is worse than not pushing down, because the parameter is
     * usually IGNORED rather than rejected — the source returns everything, the
     * filter is silently dropped, and the answer is wrong rather than absent.
     *
     * IGNORED BY THE SQL TRANSPORTS, which is why it has a default rather than
     * being required: making every database manifest declare an HTTP encoding
     * would be a field with one meaningless right answer.
     */
    filterEncoding: filterEncoding.default(() => filterEncoding.parse({ style: 'query_param' })),
  })
  .strict();

const mutation = z
  .object({
    create: z.boolean().default(false),
    updateFull: z.boolean().default(false),
    updatePartial: z.boolean().default(false),
    delete: z.boolean().default(false),
    upsert: z.boolean().default(false),
    batch: z.boolean().default(false),
    /*
     * Convert lead, close case. Common in CRMs and not expressible as CRUD, so
     * enumerating only the four verbs would put a whole category of real
     * operations outside the manifest.
     */
    customActions: z
      .array(z.object({ name: z.string().min(1), path: z.string().min(1) }).strict())
      .default([]),
  })
  .strict();

/* ── Mapping ────────────────────────────────────────────────────────────── */

const mapping = z
  .object({
    fieldPath: z.string().min(1),
    concept: z.string().min(1),
    /*
     * SURFACED, NOT HIDDEN. High confidence collapses to a skimmable line and
     * low confidence expands and asks — forty equally weighted decisions is an
     * interface a non-technical user abandons.
     */
    confidence: z.number().min(0).max(1),
    confirmedBy: z.string().uuid().optional(),
  })
  .strict();

/* ── Errors and rate limits ─────────────────────────────────────────────── */

/**
 * What a source's own failure means to us.
 *
 * GETTING THIS WRONG MAKES SELF-HEAL FIRE ON THE WRONG CONDITION. A provider
 * returning 404 for "no permission" would be read as a deleted object, and §8
 * would halt a connection over an access problem.
 *
 * PER TRANSPORT, BECAUSE ONLY ONE FAMILY HAS HTTP STATUSES. The first version
 * was a single table of `status: 100..599`, which SQLSTATE will not fit into and
 * neither will an SFTP failure or an SMTP bounce. A SQL connector had nowhere to
 * say that `28P01` means auth and `57014` means bounds, so it said nothing and
 * the transport hard-coded its own translation — which is exactly the
 * per-provider code path this design exists to avoid.
 *
 * `superRefine` BELOW TIES THE FAMILY TO THE TRANSPORT, so a SQL connector
 * cannot declare HTTP statuses. Without it the union is expressible nonsense
 * that validates.
 */
const meaning = z.enum(['auth', 'rate_limit', 'not_found', 'upstream', 'bounds']);

const errorSemantics = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http'), status: z.number().int().min(100).max(599), means: meaning }).strict(),
  // Five characters, `08006`, `28P01`, `57014`. A regex rather than an enum
  // because the set is defined by the SQL standard and every vendor's additions.
  z.object({ kind: z.literal('sqlstate'), code: z.string().regex(/^[0-9A-Z]{5}$/), means: meaning }).strict(),
  z.object({ kind: z.literal('sftp'), code: z.string().min(1).max(64), means: meaning }).strict(),
  z.object({ kind: z.literal('smtp'), code: z.number().int().min(200).max(599), means: meaning }).strict(),
]);

/** Which error family belongs to which transport. */
const ERROR_FAMILY: Record<string, 'http' | 'sqlstate' | 'sftp' | 'smtp'> = {
  https_rest: 'http',
  graphql: 'http',
  soap: 'http',
  sql_odbc: 'sqlstate',
  sftp_file: 'sftp',
  inbound_webhook: 'http',
  email_fallback: 'smtp',
  /* A Silo's row store is SQL-shaped in both implementations. */
  silo_import: 'sqlstate',
};

const rateLimits = z
  .object({
    strategy: z.enum(['fixed_window', 'token_bucket', 'unknown']).default('unknown'),
    requestsPerWindow: z.number().int().min(1).optional(),
    windowSeconds: z.number().int().min(1).optional(),
    /** A provider that says how long to wait is more reliable than our guess. */
    retryAfterHeader: z.string().min(1).default('retry-after'),
  })
  .strict();

/* ── The manifest ───────────────────────────────────────────────────────── */

/**
 * How somebody gets a credential for this system, in their own words.
 *
 * ── THE STEP WHERE A CONNECTION ACTUALLY DIES ─────────────────────────────
 *
 * Everything else about a connector can be right and the person in front of it
 * still stops here, because "Token" is not an instruction. Notion wants an
 * internal integration created at a URL they have never visited; Xero wants an
 * app in a developer portal; Shopify wants a custom app with scopes ticked. The
 * documentation says all of it, and the documentation is already what the model
 * reads to draft the connector — so the steps belong in the connector, not in a
 * page somebody has to go and find.
 *
 * IT TRAVELS WITH THE MANIFEST, because it is a fact about the SYSTEM rather
 * than about one organisation's account. A connector exported, shared or built
 * by Silo on the two-week service arrives knowing how to be connected.
 *
 * `afterwards` IS THE ONE THAT SAVES THE SUPPORT TICKET. A Notion token is
 * valid the moment it is made and returns nothing at all until pages are shared
 * with the integration — which reads exactly like a broken connector. Anything
 * that has to be true of the DATA, as against the credential, is said here and
 * shown when the first read comes back empty.
 *
 * NEVER A SECRET, obviously: prose and a link, written from public
 * documentation and shown to anybody who can reach the connection.
 */
export const setup = z
  .object({
    /** Where in the provider's own product the credential is made. */
    url: z.string().url().max(2048).optional(),
    /** What to do, in the order somebody does it. */
    steps: z.array(z.string().min(1).max(300)).min(1).max(10),
    /** What the value looks like, so somebody knows they copied the right thing. */
    looksLike: z.string().max(120).optional(),
    /** What must also be true of the data before anything comes back. */
    afterwards: z.string().max(300).optional(),
  })
  .strict();

export const manifest = z
  .object({
    /*
     * WHICH SHAPE OF MANIFEST THIS IS, carried in the document itself and
     * mirrored into a column. The first time this schema changes, a five-year-
     * old manifest has to be distinguishable from a malformed one — and a
     * version that lives only in the table cannot travel with a document
     * exported, pasted into the builder, or handed to a model.
     */
    schemaVersion: z.literal(1),

    identity: z
      .object({
        name: z.string().min(1).max(128),
        provider: z.string().min(1).max(128),
        version: z.number().int().min(1),
        /*
         * WHAT THIS CONNECTOR READS, IN WORDS.
         *
         * THE AUDIENCE IS THE QUERY COMPILER. Choosing between two connectors
         * is otherwise a guess over two names — and a name is the one thing
         * that does not say whether a system holds invoices or engineering
         * tickets. A sentence written by whoever built or imported it is the
         * cheapest thing that makes the choice answerable.
         *
         * ON THE MANIFEST, so it travels: a connector Silo builds for a
         * customer arrives describing itself, rather than arriving anonymous
         * and needing somebody to remember what it was for. The instance-level
         * fact — that THIS Salesforce is the UK book — is `connections.notes`,
         * which is a different sentence about a different thing.
         *
         * OPTIONAL, AND NEVER INVENTED. A description generated to fill the
         * field would be indistinguishable from one somebody wrote and meant.
         */
        description: z.string().min(1).max(2000).optional(),
        /*
         * THE SCHEMA PERMITS ANY TIER AND PROMOTION REFUSES ONE. A document
         * arriving from a model can say `certified`; what stops it being
         * certified is the ladder trigger on `connections`, which allows one
         * rung at a time. Validating it here would put the check in the one
         * place a hand-edited YAML could route around.
         */
        trustTier: z.enum(['private', 'community', 'verified', 'certified']).default('private'),
      })
      .strict(),

    /*
     * TRANSPORT AND PROTOCOL ARE SEPARATE, and `protocol` is derived rather than
     * asked for — every transport carries exactly one, so making the author
     * state both is asking a question with one right answer and inviting them to
     * get it wrong.
     */
    /*
     * HOW TO GET A CREDENTIAL. Optional because a connector built before this
     * existed says nothing, and a form that cannot be left blank is a form
     * somebody fills with a guess.
     */
    setup: setup.optional(),

    transport,
    /*
     * AT LEAST ONE, EXCEPT FOR A SILO. Every other transport reaches a system
     * that has to be authenticated to; a Silo import reads Silo's own store, and
     * declaring a strategy it never uses would be a false statement in the one
     * document meant to describe it exactly. Checked in `superRefine`.
     */
    auth: z.array(authStrategy).describe('Strategies this system accepts'),

    /*
     * WHETHER ONE CREDENTIAL MAY SERVE EVERYBODY.
     *
     * `shareable` IS THE DEFAULT AND THE NORMAL CASE. The organisation registers
     * the source once with a service account, users never see a credential, and
     * Silo decides who sees what. That is how every enterprise data platform
     * works, and it is what field policies exist to make safe.
     *
     * `per_user` IS THE EXCEPTION, and it has exactly two causes: a system that
     * only issues personal tokens and has no service account concept, and a
     * customer whose security posture requires the SOURCE to do its own
     * enforcement rather than trusting ours — which some regulated buyers will
     * insist on.
     *
     * A PROPERTY OF THE SYSTEM, NOT OF THE ORGANISATION. This says what the
     * source supports, which is why it belongs on the manifest: a connector must
     * be identical in a permissive organisation and a locked-down one. Who may
     * see what is auth's business and appears nowhere in this document.
     */
    credentialSharing: z
      .enum(['shareable', 'per_user'])
      .default('shareable')
      .describe('Whether one credential may serve the whole organisation'),
    objects: z.array(object).default([]),
    capabilities,
    /*
     * `() => schema.parse({})` RATHER THAN A LITERAL. Zod 4 wants a default of
     * the OUTPUT type, and the output has every field because every field has a
     * default of its own — so `.default({})` will not compile. Writing the
     * literal out instead works and creates a second copy of every default that
     * drifts the first time one changes. Letting the schema produce its own is
     * the only version with one source of truth.
     */
    mutation: mutation.default(() => mutation.parse({})),
    mappings: z.array(mapping).default([]),
    pagination,
    response,
    rateLimits: rateLimits.default(() => rateLimits.parse({})),
    errors: z.array(errorSemantics).default([]),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.transport.kind !== 'silo_import' && doc.auth.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth'],
        message: 'Say how this system is authenticated to.',
      });
    }

    /*
     * A SQL CONNECTOR CANNOT DECLARE HTTP STATUSES. The union alone permits it —
     * every variant parses on its own — so this is what makes the pairing mean
     * something rather than being a shape that merely typechecks.
     */
    const family = ERROR_FAMILY[doc.transport.kind];

    doc.errors.forEach((entry, index) => {
      if (entry.kind !== family) {
        ctx.addIssue({
          code: 'custom',
          path: ['errors', index, 'kind'],
          message: `A ${doc.transport.kind} connector reports ${family} errors, not ${entry.kind}.`,
        });
      }
    });
  });

export type Manifest = z.infer<typeof manifest>;

/**
 * The protocol a transport carries.
 *
 * DERIVED, NOT STORED IN THE DOCUMENT. `sql_odbc` and `sql_jdbc` both carry
 * `sql`; `https_rest` carries `rest`. Two transports may share a protocol and
 * none has two, so asking the author for both is asking a question whose answer
 * is already known — and letting them disagree.
 *
 * The same mapping is in `connector_transports`, which is the version the
 * database can join on.
 */
export type ManifestObject = z.infer<typeof object>;
