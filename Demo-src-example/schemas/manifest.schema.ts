import { z } from 'zod';
import {
  authStrategy,
  SPEC_SIGNING,
  TRANSPORT_CLAIMS,
  type AuthStrategyV2,
  type SingleStrategyV2,
} from './connectorAuth.schema';
import {
  expression,
  identifierName,
  name,
  PATTERN_INPUT_MAX,
  place,
  stringMap,
  stringsIn,
  tree,
  unsafePattern,
} from './manifestPrimitives.schema';
import { readsOutside, unquotedValue } from '../engine/expression/lint.expression';
import { knownCharset } from '../engine/formats/charset.format';

/**
 * The connector manifest, second shape.
 *
 * NOTHING ABOVE THE PROTOCOL IS ENUMERATED. CONNECTORS.md §1 records how the
 * first shape failed: seven pagination strategies, four filter encodings, six
 * response shapes, all closed sets, and the first two real systems anybody
 * connected each needed a code change. Here the discriminated unions are
 * `transport.kind` and `auth[].strategy` — the protocol and the proof of
 * identity — and every behaviour above them is an expression over the request
 * and the response. MANIFEST-V2.md is the design; §9 of it is the review that
 * shaped this file, and the comments below cite its findings by number.
 *
 * THE SCHEMA IS STILL THE BOUNDARY. A document a model produced, a form filled
 * in, or a file somebody pasted is rejected here or executed as written; it is
 * never repaired. Every `{{ … }}` is parsed here, and the checks that keep a
 * credential where it belongs and a filter value quoted run here too, so a
 * manifest that would leak or inject never reaches the engine at all.
 */

/* ── What the connect form asks for ─────────────────────────────────────── */

/**
 * A credential field: sealed, and never in an expression's scope.
 *
 * `fixed` IS FOR THE HALF OF A CREDENTIAL THAT IS ALWAYS THE SAME. Freshdesk's
 * Basic password is the letter X; asking somebody to type it is how a product
 * that promises no data team looks like it needs one (finding F43).
 *
 * `exposeAsParam` IS ONLY FOR A FIELD THAT IS NOT SECRET. Twilio's account SID
 * is both the Basic username and a segment of every path; exposing it saves
 * typing it twice. The manifest refuses it on a secret field, and a standing
 * test holds that.
 */
const credentialField = z
  .object({
    label: z.string().min(1).max(80),
    help: z.string().max(300).optional(),
    secret: z.boolean().default(true),
    multiline: z.boolean().default(false).describe('A PEM block, a private key'),
    looksLike: z.string().max(120).optional(),
    expiresAfterDays: z.number().int().min(1).max(3_650).optional(),
    fixed: z.string().max(512).optional(),
    exposeAsParam: z.boolean().default(false),
  })
  .strict();

/**
 * A connection parameter: NOT secret, asked for beside the credentials, and bound
 * as `params.<name>` in every expression.
 *
 * WHAT LETS ONE DOCUMENT SERVE EVERY INSTANCE OF A SYSTEM — a shop's host, a
 * tenant id, an instance URL, a region, an on-prem system's certificate
 * authority. `multiline` raises the value bound so a PEM fits (finding F7).
 *
 * A VALUE THAT LOOKS LIKE A SECRET IS REFUSED AT CONNECT TIME, and a parameter
 * whose label asks for one is refused here above the private tier (finding
 * F27): labelling a key a "parameter" must not be a way round the sealing.
 */
const parameter = z
  .object({
    label: z.string().min(1).max(80),
    help: z.string().max(300).optional(),
    looksLike: z.string().max(120).optional(),
    default: z.string().max(65_536).optional(),
    pattern: z.string().max(200).optional().describe('A regular expression the value must match'),
    multiline: z.boolean().default(false),
  })
  .strict();

/* ── Transport ──────────────────────────────────────────────────────────── */

/**
 * TLS, as the transport opens it.
 *
 * THERE IS DELIBERATELY NO "SKIP VERIFICATION". A private or self-signed
 * endpoint is declared by its `ca` (an expression, so a prebuilt on-prem
 * connector reads each site's CA from a parameter), by pinning the server's
 * certificate fingerprint, or — through the agent — by the customer's own
 * operating-system trust store, where the corporate root already lives (F7).
 */
const tls = z
  .object({
    minVersion: z.enum(['1.2', '1.3']).default('1.2'),
    ca: expression.optional().describe('PEM, or {{ params.ca }}'),
    clientCertificate: z.boolean().default(false).describe('Present the credential fields certificate and private_key'),
    serverName: expression.optional().describe('SNI, when the address is an IP or a tunnel'),
    serverCertificateFingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/)
      .optional()
      .describe('Pin the server certificate instead of the chain; recorded on first sight when absent'),
    trustStore: z.enum(['manifest', 'agent']).default('manifest'),
  })
  .strict();
const tlsDefault = () => tls.parse({});

/**
 * Reached through the customer's agent rather than from Silo.
 *
 * THE MANIFEST NAMES NO ADDRESS INSIDE ANYBODY'S NETWORK. Which agent, and which
 * hosts it may contact, are confirmed by the organisation's admin at connect
 * time (MANIFEST-V2 §9.2). `alsoReaches` only pre-fills that confirmation for the
 * drivers that hop to other addresses — Oracle SCAN, SQL Server's browser, DFS.
 */
const via = z
  .object({
    agent: z.literal(true),
    alsoReaches: z.array(expression).max(16).default([]),
  })
  .strict();

const hostExpression = expression.describe('A hostname, or {{ params.host }}');
const portExpression = z.union([z.number().int().min(1).max(65_535), expression]);
const constantHeaders = stringMap.default({}).describe('Headers this API requires on every request');

/** The driver options a SQL transport accepts, per driver. Nothing else reaches a driver (F20). */
export const SQL_DRIVER_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pg: new Set(['applicationName', 'connectTimeoutSeconds']),
  mysql2: new Set(['charset', 'timezone', 'connectTimeoutSeconds']),
  mssql: new Set(['instanceName', 'encrypt', 'applicationName', 'connectTimeoutSeconds']),
  oracledb: new Set(['connectTimeoutSeconds']),
  odbc: new Set(['dsn']),
};

/** The grammar each native driver speaks. `odbc` may speak any of them. */
export const NATIVE_GRAMMAR: Readonly<Record<string, string>> = {
  pg: 'postgres',
  mysql2: 'mysql',
  mssql: 'tsql',
  oracledb: 'oracle',
};

/**
 * How the bytes arrive.
 *
 * ONE ENTRY PER PROTOCOL, AND THIS IS THE ONLY LIST IN THE DOCUMENT THAT GROWS BY
 * WRITING CODE. A new system on any of these is a document. A new protocol is a
 * transport, Silo-authored, one file, shared by every connector on it.
 */
export const transport = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('https_rest'),
      baseUrl: expression.describe('https://… — may be {{ params.… }}'),
      headers: constantHeaders,
      tls: tls.default(tlsDefault),
      via: via.optional(),
    })
    .strict(),

  z
    .object({
      kind: z.literal('graphql'),
      endpoint: expression,
      headers: constantHeaders,
      tls: tls.default(tlsDefault),
      via: via.optional(),
    })
    .strict(),

  z
    .object({
      kind: z.literal('soap'),
      endpoint: expression,
      /** Read by derivation only. Nothing is fetched from it at query time. */
      wsdlUrl: z.string().url().optional(),
      soapVersion: z.enum(['1.1', '1.2']).default('1.1'),
      headers: constantHeaders,
      tls: tls.default(tlsDefault),
      via: via.optional(),
    })
    .strict(),

  z
    .object({
      kind: z.literal('sql'),
      /*
       * HOW TO CONNECT AND WHAT TO WRITE ARE TWO QUESTIONS (finding F8). An ODBC
       * bridge reaches DB2, Informix and Teradata, each speaking its own SQL; one
       * `dialect` could not say "connect through ODBC, write DB2". Each grammar is
       * one file of protocol code; `ansi` is the degrade mode that emits no LIMIT
       * and stops reading the cursor at the ceiling instead.
       */
      driver: z.enum(['pg', 'mysql2', 'mssql', 'oracledb', 'odbc']),
      grammar: z.enum(['postgres', 'mysql', 'tsql', 'oracle', 'db2', 'informix', 'teradata', 'ansi']),
      host: hostExpression.optional(),
      port: portExpression.optional(),
      database: expression.optional(),
      schema: expression.default('public'),
      /* Oracle's three ways of naming a database, and the descriptor RAC wants (finding F6). */
      serviceName: expression.optional(),
      sid: expression.optional(),
      connectString: expression.optional(),
      options: z.record(z.string().min(1).max(64), expression).default({}),
      tls: tls.default(tlsDefault),
      via: via.optional(),
    })
    .strict(),

  z
    .object({
      kind: z.literal('sftp'),
      host: hostExpression,
      port: portExpression.default(22),
      directory: expression,
      hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/).optional(),
      via: via.optional(),
    })
    .strict(),

  /*
   * FTP IS STILL HOW MOST AS/400 AND BANK DROPS ARRIVE (finding F9). Explicit
   * TLS by default; an unencrypted FTP server is only reachable through an agent,
   * where the plaintext never crosses the internet.
   */
  z
    .object({
      kind: z.literal('ftp'),
      host: hostExpression,
      port: portExpression.default(21),
      directory: expression,
      secure: z.enum(['explicit', 'implicit', 'none']).default('explicit'),
      tls: tls.default(tlsDefault),
      via: via.optional(),
    })
    .strict(),

  z
    .object({
      kind: z.literal('smb'),
      host: hostExpression,
      port: portExpression.default(445),
      share: expression,
      directory: expression.default('/'),
      domain: expression.optional(),
      via,
    })
    .strict(),

  z
    .object({
      kind: z.literal('imap'),
      host: hostExpression,
      port: portExpression.default(993),
      /* TLS from the first byte on 993, STARTTLS elsewhere; plaintext only inside the customer's network. */
      security: z.enum(['implicit', 'starttls', 'none']).optional(),
      tls: tls.default(tlsDefault),
      via: via.optional(),
    })
    .strict(),

  z
    .object({
      kind: z.literal('grpc'),
      address: expression.describe('host:port'),
      descriptor: z.string().max(4_000_000).optional().describe('A serialised FileDescriptorSet, base64'),
      reflection: z.boolean().default(false),
      metadata: constantHeaders,
      /* Plaintext (h2c) only inside the customer's network. */
      security: z.enum(['tls', 'none']).default('tls'),
      tls: tls.default(tlsDefault),
      via: via.optional(),
    })
    .strict(),

  /*
   * A LOG YOU READ, NOT A QUEUE YOU DRAIN (MANIFEST-V2 §9.11). A topic read from
   * an offset to the high-water mark captured at the start is bounded and
   * repeatable; a compacted topic read that way is its current state.
   */
  z
    .object({
      kind: z.literal('kafka'),
      brokers: z.array(expression).min(1).max(32),
      clientId: expression.optional(),
      /* How the credential is presented. OAUTHBEARER takes the token an OAuth strategy obtained. */
      sasl: z.enum(['plain', 'scram-sha-256', 'scram-sha-512', 'oauthbearer']).optional(),
      /* Plaintext only inside the customer's network. */
      security: z.enum(['tls', 'none']).default('tls'),
      /* Reading joins a throwaway consumer group under this prefix, for clusters whose ACLs name groups. */
      groupPrefix: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('silo-read'),
      /* Where Avro and Protocol Buffers values in the Confluent wire format find their schema. */
      schemaRegistry: expression.optional(),
      tls: tls.default(tlsDefault),
      via: via.optional(),
    })
    .strict(),

  /*
   * A QUEUE IS NOT READ, BECAUSE READING DESTROYS IT (§9.11). Consuming an AMQP
   * or MQTT message removes it; a question that drained a customer's queue would
   * lose their data. The agent subscribes and forwards into the inbound store
   * under the retention constraint, and questions read that.
   */
  z
    .object({
      kind: z.literal('queue_tap'),
      protocol: z.enum(['amqp', 'mqtt']),
      url: expression,
      source: expression.describe('The queue, or the MQTT topic filter'),
      tls: tls.default(tlsDefault),
      via,
    })
    .strict(),

  z.object({ kind: z.literal('inbound_webhook') }).strict(),
  z.object({ kind: z.literal('email_fallback') }).strict(),
  z.object({ kind: z.literal('silo_import'), sourceId: z.string().uuid() }).strict(),
]);

export type TransportV2 = z.infer<typeof transport>;
export type TransportKindV2 = TransportV2['kind'];

/* ── Fields ─────────────────────────────────────────────────────────────── */

/**
 * A field the object exposes, after its `fields` expression has run.
 *
 * `unit`, `currency` AND `format` DESCRIBE THE SOURCE, NOT THE OUTPUT. The output
 * is canonical by rule (MANIFEST-V2 §3.6): money in major units, dates in ISO
 * 8601, booleans as booleans. These say what the source had, so derivation
 * writes the normalising expression and the builder can warn when one is
 * missing — `1250` here is £12.50 and `1250` there is £1,250.
 */
const field = z
  .object({
    name,
    /**
     * The system's own key for the field, where it is not its name: Zendesk's
     * `360001`, Jira's `customfield_10010`. Expressions reach it as `$field.key`
     * and `listed.key`, which are the name when this is absent.
     */
    key: z.string().min(1).max(200).optional(),
    type: z.enum(['string', 'number', 'boolean', 'date', 'datetime', 'money', 'json', 'unknown']),
    nullable: z.boolean().default(true),
    description: z.string().max(500).optional(),
    unit: z.enum(['minor', 'major']).optional(),
    currency: expression.optional(),
    format: z.string().max(64).optional(),
  })
  .strict();

const relationship = z.object({ field: name, targetObject: name, targetField: name }).strict();

const history = z
  .object({
    appendOnly: z.boolean().default(false),
    retentionDays: z.number().int().min(1).optional(),
  })
  .strict();

/* ── The request ────────────────────────────────────────────────────────── */

/**
 * What is sent, before the transport encodes it and before auth touches it.
 *
 * ONE BAG FOR EVERY TRANSPORT, VALIDATED PER TRANSPORT. A request type per
 * transport would be a discriminated union above the protocol, which is the
 * thing this schema has none of. `REQUEST_FIELDS` says which keys each transport
 * reads and the manifest refuses the rest.
 */
const request = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
    path: expression.optional(),
    /**
     * AN ABSOLUTE ADDRESS, for the presigned download at the end of an async
     * export (findings F5, F38). A `url` on an origin the admin did not pin is
     * sent with NO auth at all, through the public-address guard.
     */
    url: expression.optional(),
    auth: z.enum(['connection', 'none']).default('connection'),
    params: z.record(identifierName, z.string().max(512)).default({}),
    headers: stringMap.default({}),
    /** A value may yield an array: one `key=value` per element (finding F39). */
    query: stringMap.default({}),
    body: tree.optional(),
    contentType: z.enum(['json', 'form', 'xml', 'text']).default('json'),
    /** No request: parse this — usually a blob handle a previous step fetched. */
    source: expression.optional(),

    /* SOAP (finding F3). */
    soapHeaders: tree.optional(),
    action: expression.optional(),

    /* SQL. */
    table: expression.optional(),
    schema: expression.optional(),
    columns: z.array(name).max(500).optional(),
    /**
     * A READ-ONLY VIEW, WITH NO HOLES. Wrapped as a subquery, run inside a
     * read-only transaction, and pinned by the connecting admin (finding F20).
     */
    statement: z.string().max(8_000).optional(),

    /* Files. */
    pick: z.enum(['newest', 'oldest', 'all']).default('newest'),

    /* IMAP. */
    mailbox: expression.optional(),
    search: tree.optional(),
    parts: z.array(z.enum(['envelope', 'text', 'html', 'attachments'])).default(['envelope', 'text']),

    /* gRPC. */
    service: expression.optional(),
    rpc: expression.optional(),

    /* Kafka. */
    topic: expression.optional(),
    fromTime: expression.optional().describe('ISO 8601 — read from the offsets at this time'),
  })
  .strict();

const REQUEST_DEFAULTS: Readonly<Record<string, unknown>> = {
  method: 'GET',
  auth: 'connection',
  params: {},
  headers: {},
  query: {},
  contentType: 'json',
  pick: 'newest',
  parts: ['envelope', 'text'],
};

/** Which request keys each transport reads. Everything else is refused for it. */
export const REQUEST_FIELDS: Record<TransportKindV2, ReadonlySet<string>> = {
  https_rest: new Set(['method', 'path', 'url', 'auth', 'params', 'headers', 'query', 'body', 'contentType', 'source']),
  graphql: new Set(['method', 'url', 'auth', 'params', 'headers', 'body', 'source']),
  soap: new Set(['url', 'auth', 'params', 'headers', 'body', 'source', 'soapHeaders', 'action']),
  sql: new Set(['params', 'table', 'schema', 'columns', 'statement', 'source']),
  sftp: new Set(['params', 'path', 'pick', 'source']),
  ftp: new Set(['params', 'path', 'pick', 'source']),
  smb: new Set(['params', 'path', 'pick', 'source']),
  /* For IMAP and Kafka, `body` is where to resume — what `x-silo-next` said on the page before. */
  imap: new Set(['params', 'mailbox', 'search', 'parts', 'body', 'source']),
  grpc: new Set(['params', 'headers', 'body', 'service', 'rpc', 'source']),
  kafka: new Set(['params', 'topic', 'fromTime', 'body', 'source']),
  queue_tap: new Set(['params']),
  inbound_webhook: new Set(['params']),
  email_fallback: new Set(['params']),
  silo_import: new Set(['params', 'table']),
};

/* ── Formats ────────────────────────────────────────────────────────────── */

/**
 * The parser that turns bytes into the value expressions run on.
 *
 * A SMALL FINITE LIST, SILO-AUTHORED, LIKE TRANSPORTS. A new file format is a
 * parser, written once; a new system never is.
 */
export const format = z.enum([
  'auto', 'json', 'ndjson', 'xml', 'csv', 'fixed_width', 'excel', 'parquet', 'protobuf',
  'avro', 'edi', 'hl7', 'pdf', 'multipart', 'text', 'binary',
]);

/** An encoding name Silo can decode — iconv's whole list and the EBCDIC pages (finding F9). */
export const charset = z
  .string()
  .min(1)
  .max(64)
  .refine(knownCharset, { message: 'Silo cannot decode that encoding.' });

const fixedWidthColumn = z
  .object({
    name,
    start: z.number().int().min(0),
    length: z.number().int().min(1),
    type: z.enum(['text', 'packed', 'zoned', 'binary']).default('text'),
    scale: z.number().int().min(0).max(18).default(0),
    signed: z.boolean().default(true),
    trim: z.boolean().default(true),
  })
  .strict();

const formatOptions = z
  .object({
    /* csv */
    delimiter: z.enum(['auto', ',', ';', '\t', '|']).optional(),
    header: z.boolean().optional(),
    skipLines: z.number().int().min(0).max(100).optional(),
    quote: z.string().length(1).optional(),
    /* fixed_width — bytes, not characters, because packed decimal is bytes */
    columns: z.array(fixedWidthColumn).max(500).optional(),
    recordLength: z.number().int().min(1).max(65_535).optional(),
    recordCharset: charset.optional(),
    /* excel */
    sheet: z.union([z.string(), z.number().int().min(0)]).optional(),
    headerRow: z.number().int().min(1).optional(),
    /* xml — paths that are ALWAYS arrays, even with one child */
    arrays: z.array(z.string().max(512)).max(100).optional(),
    removeNamespaces: z.boolean().optional(),
    /* protobuf */
    message: z.string().max(512).optional(),
    descriptor: z
      .string()
      .max(1_000_000)
      .regex(/^[A-Za-z0-9+/=\s]*$/, 'A descriptor set is base64')
      .optional()
      .describe('Protocol Buffers: the base64 FileDescriptorSet the message is read against'),
    /* edi, hl7 */
    standard: z.enum(['x12', 'edifact']).optional(),
    version: z.string().max(32).optional(),
  })
  .strict();

/* ── Pushdown ───────────────────────────────────────────────────────────── */

const operator = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null']);

/**
 * How ONE filter is written into the request.
 *
 * A PATCH, NOT A STRING. `query`, `headers` and `body` land directly — a query
 * parameter's value is encoded by the transport, so a filter value there cannot
 * change the query's shape. `fragment` yields a piece of a query LANGUAGE — JQL,
 * SOQL, OData, a search string — and there a value could; so a fragment may read
 * `value` only through `$quote`, `$quoteEach`, `$escape` or `$number`, checked on
 * the syntax tree (finding F23). `where` is SQL's, and is always a bound
 * parameter.
 */
const filterTemplate = z
  .object({
    query: stringMap.optional(),
    headers: stringMap.optional(),
    body: tree.optional(),
    fragment: tree.optional(),
    where: z
      .object({
        column: name,
        operator: operator.optional(),
        value: expression.optional(),
      })
      .strict()
      .optional(),
    search: tree.optional(),
    path: expression.optional(),
  })
  .strict();

const patch = z
  .object({
    query: stringMap.optional(),
    headers: stringMap.optional(),
    body: tree.optional(),
    path: expression.optional(),
    search: tree.optional(),
  })
  .strict();

/**
 * What the source will do for us, declared per field and per operator.
 *
 * WHAT IS NOT DECLARED IS DONE HERE AND BOUNDED. Declaring `eq` for a field the
 * source ignores is worse than not declaring it: the parameter is dropped, the
 * source returns everything, and the answer is confidently wrong.
 *
 * `compose` RUNS LAST, WITH EVERYTHING BOUND (finding F33). SOQL, JQL and
 * QuickBooks put the filter, the order, the limit and the field list into ONE
 * parameter; applying sort after the filter's parameter had been written, with
 * no sight of the filter, sent every issue in the site sorted and called it the
 * filtered answer. `combine` is the first design's name and still accepted.
 */
const pushdown = z
  .object({
    filters: z.record(name, z.partialRecord(operator, filterTemplate)).default({}),
    sort: patch.optional(),
    limit: patch.optional(),
    fields: patch.optional(),
    compose: patch.optional(),
    combine: patch.optional(),
    /**
     * TOTALS WITHOUT THE ROWS — the door past the read ceiling. Applied AFTER
     * compose, with `fragments` bound, so a count is of the filtered set.
     */
    aggregates: z
      .object({
        count: z.object({ request: patch, value: expression }).strict().optional(),
        sum: z.object({ request: patch, value: expression }).strict().optional(),
        group_by: z.object({ request: patch, records: expression, key: expression, value: expression }).strict().optional(),
      })
      .strict()
      .optional(),
    maxFilterValues: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

/* ── Paging ─────────────────────────────────────────────────────────────── */

/**
 * How the next request is built from the last response, and when to stop.
 *
 * THE NEXT REQUEST IS THE PREVIOUS ONE WITH THESE PATCHES APPLIED, and the
 * paging scope can see that previous request and the filter fragments (finding
 * F34) — so a paging clause that lives inside a filtered query parameter can
 * re-render the filter rather than drop it.
 *
 * `emptyPageEnds` IS FALSE UNLESS SOMETHING SAYS OTHERWISE (finding F26). A
 * `records` expression that filters a page can empty it while later pages still
 * hold answers; ending the read there was a silent truncation. The v1 offset and
 * page-number presets set it, because a short page was how they knew they were
 * done.
 */
const page = z
  .object({
    next: z
      .object({
        url: expression.optional(),
        path: expression.optional(),
        query: stringMap.default({}),
        headers: stringMap.default({}),
        body: tree.optional(),
        state: z.record(identifierName, expression).default({}),
      })
      .strict(),
    until: expression,
    state: z.record(identifierName, tree).default({}),
    maxPages: z.number().int().min(1).max(500).default(50),
    emptyPageEnds: z.boolean().default(false),
  })
  .strict();

/* ── Errors ─────────────────────────────────────────────────────────────── */

/**
 * What a response MEANS, as a condition rather than a status code.
 *
 * Slack answers 200 with `{"ok": false}`; GraphQL answers 200 with `errors`; a
 * SQLSTATE is five characters and an SFTP failure is a sentence. `when` reads
 * `{ status, code, message, headers, response, raw }` and `means` is the closed
 * set the rest of the product understands. `retryAfter` may read an epoch reset
 * header, converted against the transport's clock (finding F42).
 */
export const meaning = z.enum(['auth', 'rate_limit', 'not_found', 'upstream', 'bounds', 'empty']);

const errorRule = z
  .object({
    when: expression,
    means: meaning,
    retryAfter: z
      .union([
        expression,
        z
          .object({
            value: expression,
            format: z.enum(['seconds', 'epoch_seconds', 'epoch_millis', 'http_date']),
          })
          .strict(),
      ])
      .optional(),
    message: z.string().max(300).optional(),
  })
  .strict();

/* ── Operation, pipeline, variants ──────────────────────────────────────── */

/**
 * ONE REQUEST, FOLLOWED THROUGH ITS PAGES, TURNED INTO RECORDS.
 *
 * `strictFields` DEFAULTS TO TRUE (finding F31). A field derived from a source
 * key — `amount` from `amount_pence` — left the source key in the row, where a
 * field policy hiding `amount` could not see it. v1 documents compile with
 * `false`, which is what they did.
 */
const operation = z
  .object({
    request,
    format: format.default('auto'),
    charset: charset.default('auto'),
    formatOptions: formatOptions.default({}),
    records: expression.default('{{ response }}'),
    fields: z.record(name, expression).default({}),
    strictFields: z.boolean().default(true),
    page: page.optional(),
    pushdown: pushdown.optional(),
    errors: z.array(errorRule).max(50).default([]),
    maxRecords: z.number().int().min(1).max(50_000).default(5_000),
  })
  .strict();

/**
 * A step in a pipeline: an operation, possibly once per item, possibly polled.
 *
 * `forEach` FANS OUT, BOUNDED, AND THE BOUND IS A REFUSAL — more items than
 * `maxItems` is not "the first hundred", it is an answer that would be wrong.
 * `poll` repeats until `until` holds, bounded by the PIPELINE's clock, which is
 * counted across the sleeps (finding F4).
 */
const step = z
  .object({
    name: identifierName,
    operation,
    forEach: expression.optional(),
    concurrency: z.number().int().min(1).max(8).default(4),
    maxItems: z.number().int().min(1).max(1_000).default(100),
    poll: z
      .object({
        everySeconds: z.union([z.number().min(1).max(60), expression]),
        until: expression,
        timeoutSeconds: z.number().int().min(1).max(900).default(300),
      })
      .strict()
      .optional(),
    when: expression.optional(),
  })
  .strict();

const pipeline = z
  .object({
    steps: z.array(step).min(1).max(8),
    records: expression,
    fields: z.record(name, expression).default({}),
    strictFields: z.boolean().default(true),
    maxRecords: z.number().int().min(1).max(50_000).default(5_000),
    maxSeconds: z.number().int().min(1).max(900).default(600),
  })
  .strict();

/**
 * A read that depends on the question (finding F35).
 *
 * Zendesk reads `/tickets` for everything and `/search` when a filter is asked
 * for — different URL, envelope, paging and caps. The first variant whose
 * `when` holds over `{ filters, order, limit, fields }` runs; the last has no
 * `when` and is the default.
 */
const readVariant = z.union([
  operation.extend({ when: expression.optional() }),
  pipeline.extend({ when: expression.optional() }),
]);

const read = z.union([operation, pipeline, z.array(readVariant).min(2).max(8)]);

/* ── Writes ─────────────────────────────────────────────────────────────── */

/**
 * A write, built from expressions and the record.
 *
 * SCOPE: `values`, `identifier`, `prior`, `params`. The inverse of `fields` is
 * written out explicitly, because nobody can invert an expression and guessing
 * would corrupt records quietly. `source` is refused here (finding F22): a write
 * that parses a literal instead of sending a request would let verify-writes
 * pass without the source ever being touched.
 */
const writeOperation = z
  .object({
    request: request.optional(),
    format: format.default('auto'),
    charset: charset.default('auto'),
    formatOptions: formatOptions.default({}),
    result: expression.default('{{ response }}'),
    identifier: z.record(name, expression).default({}),
    errors: z.array(errorRule).max(50).default([]),
    idempotency: z.object({ place }).strict().optional(),
  })
  .strict();

/** Names with a CRUD meaning. Any other name is a custom action invoked by name. */
export const WRITE_ROLES = ['create', 'update', 'update_full', 'update_partial', 'delete', 'upsert'] as const;

const write = z
  .object({
    operations: z.record(identifierName, writeOperation),
    /**
     * HOW A WRITTEN RECORD IS READ BACK, AND HOW IT IS UNDONE. `undo` names a
     * compensating operation for systems that reverse rather than delete — a
     * voided invoice, a reversed journal (finding F17).
     */
    verify: z
      .object({
        read: z.union([z.literal('by_identifier'), operation]).default('by_identifier'),
        undo: identifierName.optional(),
        testRecord: tree.optional(),
      })
      .strict()
      .default({ read: 'by_identifier' }),
    batch: z.object({ operation: identifierName, maxRecords: z.number().int().min(2).max(1_000) }).strict().optional(),
  })
  .strict();

/* ── Every field a system holds ─────────────────────────────────────────── */

/**
 * How to ask the system which fields an object has, and how to read any one of
 * them from a record.
 *
 * ── BUILT FROM WHAT THE FORMAT ALREADY HAS ────────────────────────────────
 *
 * The list is read like any object is read — one request, a paged list, a
 * pipeline, variants, any format — one record per field, whose `fields` give
 * its `name`, and its `key`, `type` and `label` where the system says. HubSpot's
 * properties API, Salesforce's describe, Jira's /field, Zendesk's paged
 * ticket_fields and a GraphQL introspection are each just a read.
 *
 * `value` reads ONE field from ONE record of the object, with `$field` the
 * field being read (`name`, `key`, `type`, `description`; `key` is the
 * system's own key, the name unless the list gave one): `$lookup(properties,
 * $field.key)` for HubSpot, `$lookup(fields, $field.key)` for Jira,
 * `custom_fields[id = $number($field.key)].value` for Zendesk. It is applied
 * to every declared field the read does not map itself.
 *
 * WHERE A SYSTEM MUST BE TOLD WHICH FIELDS TO RETURN, the read says so with
 * `listed` — the object's declared fields — in whatever the request is: a
 * query parameter, a SOQL statement, a GraphQL document, a body. Once Silo has
 * read the list, the declared fields are every field the system holds, so the
 * request asks for all of them without anything being rewritten.
 *
 * NOTHING HERE KNOWS ANY SYSTEM. That is the point of it: an earlier version
 * had a path and a joined query parameter, which were HubSpot's two shapes,
 * and a SOQL statement, a paged list or a list of custom fields could not be
 * said at all.
 */
export const fieldList = z
  .object({
    read,
    value: expression.refine((source) => /^\s*\{\{[\s\S]*\}\}\s*$/.test(source), 'value is one expression: {{ … }}'),
    most: z.number().int().min(1).max(1_000).default(500),
  })
  .strict();

/* ── Object ─────────────────────────────────────────────────────────────── */

const object = z
  .object({
    name,
    description: z.string().max(500).optional(),
    identifier: z.array(name).min(1).max(8),
    fields: z.array(field).min(1).max(1_000),
    relationships: z.array(relationship).max(100).default([]),
    available: z.boolean().default(true),
    history: history.default(() => history.parse({})),
    read,
    write: write.optional(),
    fieldList: fieldList.optional(),
  })
  .strict();

/* ── Defaults, mapping, rate limits, setup ──────────────────────────────── */

/**
 * What every object's read says unless it says otherwise. Merged UNDER each
 * operation, including every step of a pipeline and every read variant.
 */
const defaults = z
  .object({
    params: z.record(identifierName, z.string().max(512)).default({}),
    headers: stringMap.default({}),
    format: format.optional(),
    charset: charset.optional(),
    formatOptions: formatOptions.optional(),
    page: page.optional(),
    pushdown: pushdown.optional(),
    errors: z.array(errorRule).max(50).default([]),
    maxRecords: z.number().int().min(1).max(50_000).optional(),
  })
  .strict();

const mapping = z
  .object({
    fieldPath: name,
    concept: name,
    confidence: z.number().min(0).max(1),
    confirmedBy: z.string().uuid().optional(),
  })
  .strict();

const rateLimits = z
  .object({
    strategy: z.enum(['fixed_window', 'token_bucket', 'unknown']).default('unknown'),
    requestsPerWindow: z.number().int().min(1).optional(),
    windowSeconds: z.number().int().min(1).optional(),
    retryAfterHeader: z.string().min(1).default('retry-after'),
    concurrency: z.number().int().min(1).max(16).default(4),
  })
  .strict();

export const setup = z
  .object({
    url: z.string().url().max(2_048).optional(),
    steps: z.array(z.string().min(1).max(300)).min(1).max(10),
    looksLike: z.string().max(120).optional(),
    afterwards: z.string().max(300).optional(),
    rotation: z.string().max(300).optional(),
  })
  .strict();

/**
 * Where a draft came from and what its author could not tell — a compiled
 * specification's notes, what derivation observed. Provenance for the builder;
 * the engine never reads it.
 */
const authoring = z
  .object({
    from: z.enum(['openapi', 'graphql', 'wsdl', 'catalogue', 'derived', 'model', 'hand', 'v1']),
    notes: z.array(z.string().max(500)).max(100).default([]),
  })
  .strict();

/** The builder's memory of which preset wrote which expressions. Provenance; the engine never reads it. */
const presetHints = z
  .object({
    page: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict().optional(),
    records: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict().optional(),
    filters: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict().optional(),
  })
  .strict();

/* ── The document ───────────────────────────────────────────────────────── */

const SECRET_WORDS = /\b(key|secret|token|password|passphrase|credential|private)\b/i;

export const manifestV2 = z
  .object({
    schemaVersion: z.literal(2),
    identity: z
      .object({
        name: z.string().min(1).max(128),
        provider: z.string().min(1).max(128),
        version: z.number().int().min(1),
        description: z.string().min(1).max(2_000).optional(),
        trustTier: z.enum(['private', 'community', 'verified', 'certified']).default('private'),
      })
      .strict(),
    setup: setup.optional(),
    transport,
    auth: z.array(authStrategy).max(8).default([]),
    credentials: z.record(identifierName, credentialField).default({}),
    parameters: z.record(identifierName, parameter).default({}),
    credentialSharing: z.enum(['shareable', 'per_user']).default('shareable'),
    defaults: defaults.default(() => defaults.parse({})),
    objects: z.array(object).max(200).default([]),
    errors: z.array(errorRule).max(50).default([]),
    rateLimits: rateLimits.default(() => rateLimits.parse({})),
    mappings: z.array(mapping).default([]),
    presets: presetHints.optional(),
    authoring: authoring.optional(),
  })
  .strict()
  .superRefine((doc, ctx) => checkDocument(doc as ManifestV2, ctx));

export type ManifestV2 = z.infer<typeof manifestV2>;

/** The names the rest of the product has always used: a manifest is a v2 manifest. */
export const manifest = manifestV2;
export type Manifest = ManifestV2;
export type ObjectV2 = ManifestV2['objects'][number];
export type ManifestObject = ObjectV2;
export type ReadV2 = ObjectV2['read'];
export type OperationV2 = z.infer<typeof operation>;
export type PipelineV2 = z.infer<typeof pipeline>;
export type StepV2 = z.infer<typeof step>;
export type ReadVariantV2 = z.infer<typeof readVariant>;
export type RequestV2 = z.infer<typeof request>;
export type PageV2 = z.infer<typeof page>;
export type PushdownV2 = z.infer<typeof pushdown>;
export type PatchV2 = z.infer<typeof patch>;
export type FilterTemplateV2 = z.infer<typeof filterTemplate>;
export type ErrorRuleV2 = z.infer<typeof errorRule>;
export type WriteOperationV2 = z.infer<typeof writeOperation>;
export type WriteV2 = z.infer<typeof write>;
export type FormatV2 = z.infer<typeof format>;
export type FieldV2 = z.infer<typeof field>;
export type Meaning = z.infer<typeof meaning>;

export const isPipeline = (read: OperationV2 | PipelineV2): read is PipelineV2 => 'steps' in read;
export const isVariants = (read: ReadV2): read is ReadVariantV2[] => Array.isArray(read);

/** Every operation a read can run, wherever it sits — for checks and for capability questions. */
export function operationsOf(read: ReadV2): OperationV2[] {
  const one = (r: OperationV2 | PipelineV2): OperationV2[] =>
    isPipeline(r) ? r.steps.map((s) => s.operation) : [r];
  return isVariants(read) ? read.flatMap((variant) => one(variant as OperationV2 | PipelineV2)) : one(read);
}

/** The protocol a transport carries. Derived, never asked for. */
export const PROTOCOL_OF: Record<TransportKindV2, string> = {
  https_rest: 'rest',
  graphql: 'graphql',
  soap: 'soap',
  sql: 'sql',
  sftp: 'file',
  ftp: 'file',
  smb: 'file',
  imap: 'email',
  grpc: 'grpc',
  kafka: 'stream',
  queue_tap: 'queue',
  inbound_webhook: 'webhook',
  email_fallback: 'email',
  silo_import: 'silo',
};

/* ── The whole-document checks ──────────────────────────────────────────── */

type Path = (string | number)[];

const allParts = (strategy: AuthStrategyV2): SingleStrategyV2[] =>
  strategy.strategy === 'all_of' ? strategy.parts : [strategy];

/**
 * Everything shape alone cannot know.
 *
 * EVERY CHECK HERE IS A GUARANTEE SOMETHING ELSE RELIES ON — that a credential
 * goes only where the admin confirmed, that a filter value cannot rewrite a
 * query, that a write is really verified against the source — and each names
 * the finding that made it necessary.
 */
function checkDocument(doc: ManifestV2, ctx: z.RefinementCtx): void {
  const issue = (path: Path, message: string) => ctx.addIssue({ code: 'custom', path, message });
  const t = doc.transport;
  const kind = t.kind;
  const inbound = kind === 'inbound_webhook' || kind === 'email_fallback' || kind === 'silo_import' || kind === 'queue_tap';
  const hasVia = 'via' in t && t.via !== undefined;

  /* Auth. */
  if (!inbound && doc.auth.length === 0) issue(['auth'], 'Say how this system is authenticated to, or say none.');

  const clientCertificate = 'tls' in t && t.tls?.clientCertificate === true;
  doc.auth.forEach((strategy, a) => {
    const parts = allParts(strategy);
    const mtls = parts.some((p) => p.strategy === 'mtls');
    if (mtls && !clientCertificate) issue(['auth', a], 'mtls needs transport.tls.clientCertificate: true.');

    parts.forEach((part) => {
      if ((part.strategy === 'ntlm' || part.strategy === 'negotiate') && !hasVia) {
        issue(['auth', a], `${part.strategy} runs inside the customer's network, so the transport must be reached through an agent.`);
      }
      if (part.strategy === 'signed') {
        if (part.algorithm === 'sigv4' && (!part.service || !part.region)) {
          issue(['auth', a], 'sigv4 needs service and region.');
        } else if (!SPEC_SIGNING.has(part.algorithm)) {
          if (!part.canonical || !part.place) issue(['auth', a], `${part.algorithm} needs canonical and place.`);
          if (part.canonical) {
            const outside = readsOutside(part.canonical, ['request', 'params']);
            if (outside.length > 0) {
              issue(['auth', a, 'canonical'], `A canonical string may read only request and params, not ${outside.join(', ')} — the key must sign a description of the request being sent.`);
            }
          }
        }
      }
      if (part.strategy === 'jwt_assertion') {
        for (const claim of Object.keys(part.claims)) {
          if ((TRANSPORT_CLAIMS as readonly string[]).includes(claim)) {
            issue(['auth', a, 'claims', claim], `${claim} is set by the transport; a manifest that set it could make an assertion that never expires.`);
          }
        }
      }
      if (part.strategy === 'session') {
        const text = JSON.stringify(part.request.body ?? {});
        for (const match of text.matchAll(/\{\{([\s\S]+?)\}\}/g)) {
          if (!/^\s*\$?params\.[a-z_][a-z0-9_]*\s*$/.test(match[1]!)) {
            issue(['auth', a, 'request', 'body'], 'A login body may only read params; credentials are placed by credentialPlacement.');
          }
        }
        if (!part.request.path && !part.request.url) issue(['auth', a, 'request'], 'Say where the login request goes.');
      }
    });
  });

  /* Transport. */
  if (kind === 'ftp' && t.secure === 'none' && !hasVia) {
    issue(['transport', 'secure'], 'Unencrypted FTP is only reachable through an agent, so the plaintext never crosses the internet.');
  }
  if (kind === 'sql') {
    const allowed = SQL_DRIVER_OPTIONS[t.driver]!;
    for (const [option, value] of Object.entries(t.options)) {
      if (!allowed.has(option)) issue(['transport', 'options', option], `${t.driver} does not accept the option ${option}.`);
      if (option === 'dsn' && !/^[A-Za-z0-9_ .-]{1,128}$/.test(value)) {
        issue(['transport', 'options', 'dsn'], 'An ODBC DSN is a name, never a connection string.');
      }
    }
    const native = NATIVE_GRAMMAR[t.driver];
    if (native && native !== t.grammar) issue(['transport', 'grammar'], `The ${t.driver} driver speaks ${native}.`);
    if (t.driver === 'odbc' && !hasVia) issue(['transport', 'via'], 'The ODBC bridge runs in the agent, where the drivers are.');
    if (!t.host && !t.connectString && t.driver !== 'odbc') issue(['transport', 'host'], 'Say which host.');
  }

  /* Parameters and credentials (findings F7, F27, F32, F43). */
  for (const [pname, p] of Object.entries(doc.parameters)) {
    if (p.default && !p.multiline && p.default.length > 512) issue(['parameters', pname, 'default'], 'A single-line parameter is at most 512 characters.');
    if (p.pattern) {
      const unsafe = unsafePattern(p.pattern);
      if (unsafe) issue(['parameters', pname, 'pattern'], `Pattern refused: ${unsafe}.`);
    }
    const words = `${pname} ${p.label} ${p.help ?? ''} ${p.looksLike ?? ''}`;
    if (SECRET_WORDS.test(words) && doc.identity.trustTier !== 'private') {
      issue(['parameters', pname], 'This parameter asks for something secret. Declare it under credentials, where it is sealed.');
    }
  }
  void PATTERN_INPUT_MAX;
  for (const [cname, c] of Object.entries(doc.credentials)) {
    if (c.exposeAsParam && c.secret) issue(['credentials', cname, 'exposeAsParam'], 'Only a field that is not secret may be exposed to expressions.');
  }

  /* Objects. */
  const allowedKeys = REQUEST_FIELDS[kind];
  const checkRequest = (req: RequestV2 | undefined, path: Path, isRead: boolean, isWrite: boolean) => {
    if (!req) return;
    for (const [key, v] of Object.entries(req)) {
      if (v === undefined) continue;
      if (key in REQUEST_DEFAULTS && JSON.stringify(v) === JSON.stringify(REQUEST_DEFAULTS[key])) continue;
      if (!allowedKeys.has(key)) issue([...path, key], `A ${kind} request does not take ${key}.`);
    }
    if (isRead && !['GET', 'POST', 'HEAD'].includes(req.method)) issue([...path, 'method'], 'A read may GET, POST or HEAD. Anything else is a write.');
    if (req.statement?.includes('{{')) issue([...path, 'statement'], 'A statement takes no expressions.');
    if (isWrite && req.source !== undefined) issue([...path, 'source'], 'A write must be sent to the source; it cannot parse a value instead.');
    if (req.path && req.url) issue([...path, 'url'], 'Say path or url, not both.');
    if (kind === 'graphql') {
      const query = (req.body as { query?: unknown } | undefined)?.query;
      if (req.source === undefined && (typeof query !== 'string' || query.includes('{{'))) {
        issue([...path, 'body', 'query'], 'A GraphQL document is a literal; values go in variables.');
      }
    }
    if (kind === 'https_rest' && !req.path && !req.url && req.source === undefined) issue([...path, 'path'], 'Say where to send it.');
    if (kind === 'sql' && !req.table && !req.statement && req.source === undefined && !isWrite) issue([...path, 'table'], 'Say which table, or give a statement.');
  };

  const checkPage = (p: PageV2 | undefined, path: Path) => {
    if (!p) return;
    const n = p.next;
    const says = n.url || n.path || Object.keys(n.query).length || Object.keys(n.headers).length || n.body !== undefined || Object.keys(n.state).length;
    if (!says) issue([...path, 'next'], 'next has to change something, or the same page is asked for again.');
  };

  const checkPushdown = (pd: PushdownV2 | undefined, fields: Set<string>, path: Path) => {
    if (!pd) return;
    for (const [fname, byOp] of Object.entries(pd.filters)) {
      if (!fields.has(fname)) issue([...path, 'filters', fname], `${fname} is not a field of this object.`);
      for (const [op, template] of Object.entries(byOp ?? {})) {
        for (const source of stringsIn(template?.fragment)) {
          for (const problem of unquotedValue(source)) issue([...path, 'filters', fname, op, 'fragment'], problem);
        }
      }
    }
  };

  const checkOperation = (op: OperationV2, fields: Set<string>, path: Path) => {
    checkRequest(op.request, [...path, 'request'], true, false);
    checkPage(op.page, [...path, 'page']);
    checkPushdown(op.pushdown, fields, [...path, 'pushdown']);
  };

  const checkPipeline = (pl: PipelineV2, fields: Set<string>, path: Path) => {
    const names = new Set<string>();
    pl.steps.forEach((s, i) => {
      if (names.has(s.name)) issue([...path, 'steps', i, 'name'], 'Step names are unique.');
      names.add(s.name);
      checkOperation(s.operation, fields, [...path, 'steps', i, 'operation']);
      if (s.poll && s.poll.timeoutSeconds > pl.maxSeconds) {
        issue([...path, 'steps', i, 'poll', 'timeoutSeconds'], `A poll cannot outlast its pipeline's ${pl.maxSeconds} seconds.`);
      }
    });
  };

  const checkOne = (r: OperationV2 | PipelineV2, fields: Set<string>, path: Path) =>
    isPipeline(r) ? checkPipeline(r, fields, path) : checkOperation(r, fields, path);

  checkPushdown(doc.defaults.pushdown, new Set(doc.objects.flatMap((o) => o.fields.map((f) => f.name))), ['defaults', 'pushdown']);

  doc.objects.forEach((obj, o) => {
    const fields = new Set(obj.fields.map((f) => f.name));
    for (const id of obj.identifier) {
      if (!fields.has(id)) issue(['objects', o, 'identifier'], `${id} is not a field of ${obj.name}.`);
    }

    if (isVariants(obj.read)) {
      obj.read.forEach((variant, v) => {
        const last = v === (obj.read as unknown[]).length - 1;
        if (last && variant.when !== undefined) issue(['objects', o, 'read', v, 'when'], 'The last read variant is the default and has no when.');
        if (!last && variant.when === undefined) issue(['objects', o, 'read', v, 'when'], 'Every variant but the last says when it applies.');
        checkOne(variant as OperationV2 | PipelineV2, fields, ['objects', o, 'read', v]);
      });
    } else {
      checkOne(obj.read, fields, ['objects', o, 'read']);
    }

    const w = obj.write;
    if (w) {
      for (const [wname, wop] of Object.entries(w.operations)) {
        if (kind !== 'sql' && !wop.request) issue(['objects', o, 'write', 'operations', wname, 'request'], 'A write needs a request.');
        checkRequest(wop.request, ['objects', o, 'write', 'operations', wname, 'request'], false, true);
      }
      if (w.batch && !w.operations[w.batch.operation]) {
        issue(['objects', o, 'write', 'batch', 'operation'], 'batch names an operation that is not declared.');
      }
      if (w.verify.undo && !w.operations[w.verify.undo]) {
        issue(['objects', o, 'write', 'verify', 'undo'], 'undo names an operation that is not declared.');
      }
      if (w.verify.read !== 'by_identifier') {
        const vr = w.verify.read;
        if (vr.request.source !== undefined) {
          issue(['objects', o, 'write', 'verify', 'read', 'request', 'source'], 'A read-back must ask the source; it cannot parse a value instead.');
        }
        checkOperation(vr, fields, ['objects', o, 'write', 'verify', 'read']);
      }
    }
  });
}
