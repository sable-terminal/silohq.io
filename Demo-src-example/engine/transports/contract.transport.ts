import type {
  Meaning,
  ObjectV2,
  OperationV2,
  TransportKindV2,
  TransportV2,
  WriteOperationV2,
} from '../../schemas/manifest.schema';

/**
 * A transport: how bytes reach a system and come back.
 *
 * ── THREE HALVES, AND THE MIDDLE ONE IS THE ONLY I/O ──────────────────────
 *
 * `prepare` is pure and runs on Silo after every expression has run: it turns
 * the evaluated request into the wire shape this protocol sends. `send` opens
 * the socket, and is the half the customer's agent runs when a connection is
 * reached through one — the agent is this package with only `send` wired, so
 * there is one implementation of each protocol and not two. `floor` says what a
 * response means when the manifest says nothing.
 *
 * ── A TRANSPORT KNOWS NOTHING ABOVE THE PROTOCOL ──────────────────────────
 *
 * It never evaluates an expression and never sees paging, pushdown or records.
 * It receives a request whose values are already text and trees, and hands back
 * bytes. That is what keeps a new protocol one file, and keeps `records`,
 * `page` and `pushdown` meaning the same thing on every protocol there is.
 */

/** A query value: one string, or several for a repeated parameter (`fields[]=a&fields[]=b`). */
export type QueryValue = string | string[];

/** The request after every expression has run. Values are plain. */
export interface EvaluatedRequest {
  method: string;
  /** The absolute URL for HTTP-shaped transports; null otherwise. */
  url: URL | null;
  headers: Record<string, string>;
  query: Record<string, QueryValue>;
  body: unknown;
  contentType: 'json' | 'form' | 'xml' | 'text';
  /** `none` sends no credential at all — a presigned download on another host. */
  auth: 'connection' | 'none';
  /**
   * The transport's own settings with their expressions worked out — a host, a
   * database, a directory, brokers. Never a secret: those arrive on the socket.
   */
  connection: Record<string, unknown>;

  /* SQL */
  table?: string;
  schema?: string;
  columns?: string[];
  statement?: string;
  where: Array<{ column: string; operator: string; value: unknown }>;
  order: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit: number | null;
  fields: string[] | null;
  /** A total rather than rows, for a transport that computes one itself. Column names, already mapped. */
  aggregate?: { kind: 'count' | 'sum' | 'group_by'; column: string | null; by: string | null } | null;

  /* Files */
  path?: string;
  pick?: 'newest' | 'oldest' | 'all';

  /* IMAP */
  mailbox?: string;
  search?: unknown;
  parts?: string[];

  /* gRPC */
  service?: string;
  rpc?: string;

  /* SOAP */
  action?: string;
  soapHeaders?: unknown;

  /* Kafka */
  topic?: string;
  fromTime?: string;
}

/** Whatever this protocol sends. Serialisable, because it may cross to an agent. */
export interface WireRequest {
  kind: TransportKindV2;
}

/** Response headers, names lowercased. Multi-valued ones — `set-cookie`, `link` — are arrays. */
export type Headers = Record<string, string | string[]>;

/** Whatever came back, before any parser. */
export interface WireResponse {
  status: number | null;
  /** SQLSTATE, a vendor code, an SFTP code, a gRPC status name, an IMAP response code. */
  code: string | null;
  message: string | null;
  headers: Headers;
  body: Buffer;
  contentType: string | null;
  durationMs: number;
}

/** TLS as the socket needs it: the manifest's `tls` with the credential's certificate resolved in. */
export interface ResolvedTls {
  minVersion: 'TLSv1.2' | 'TLSv1.3';
  ca?: string;
  cert?: string;
  key?: string;
  servername?: string;
  /** `SHA256:…` — pin the leaf instead of trusting the chain. */
  fingerprint?: string;
  /** Verify against the host's own trust store; only meaningful inside an agent. */
  systemTrust?: boolean;
}

/**
 * What belongs to the socket rather than the request: a login on the protocol
 * itself, a client certificate, a challenge-response bound to one connection.
 *
 * ONE OBJECT FROM AUTH TO `send`. Auth writes it through the surface; `send`
 * reads it through its options. It holds secrets, so it is never logged and
 * crosses to an agent only inside a sealed frame.
 */
export interface SocketAuth {
  username?: string;
  password?: string;
  /** A schema registry beside a Kafka cluster, which has its own key. */
  registryUsername?: string;
  registryPassword?: string;
  privateKey?: string;
  passphrase?: string;
  /** XOAUTH2 / OAUTHBEARER, for a mailbox that refuses passwords. */
  accessToken?: string;
  /** NTLM and Negotiate are handshakes on the connection; only an agent's `send` performs them. */
  handshake?:
    | { kind: 'ntlm'; domain: string | null; workstation: string | null }
    | { kind: 'negotiate'; useAgentIdentity: boolean; servicePrincipal: string | null };
  tls: ResolvedTls;
}

/**
 * Where auth may put a value on THIS wire.
 *
 * A PLACEMENT THE WIRE HAS NO ROOM FOR IS A REFUSAL, NOT A NO-OP. Silently not
 * sending a credential produces a 401 that looks like a wrong key.
 */
export interface AuthSurface {
  setHeader(name: string, value: string): void;
  setQuery(name: string, value: string): void;
  setBodyPath(path: string, value: string): void;
  setCookie(name: string, value: string): void;
  setForm(name: string, value: string): void;
  /** `soap:<Header/element/path>` — the SOAP transport only. */
  setSoapHeader(path: string, value: unknown): void;
  socket: SocketAuth;
}

/** What `signed.canonical` may see. Built by HTTP-shaped transports only. */
export interface CanonicalRequest {
  method: string;
  /** Host and, when not the default, port — as the `Host` header will carry it. */
  host: string;
  /** Scheme, host and path: what OAuth 1.0a calls the base string URI. */
  baseUrl: string;
  path: string;
  query: Record<string, QueryValue>;
  /** The query string exactly as it will be sent. */
  queryString: string;
  headers: Record<string, string>;
  body: string;
  timestamp: string;
  nonce: string;
}

/** Where a request is sent from. The agent route is one place, so neither side has to know which it is on. */
export type Route = { via: 'silo' } | { via: 'agent'; agentId: string; connectionId: string };

export interface SendOptions {
  /** TLS and whatever auth put on the socket. */
  socket: SocketAuth;
  /** TRUE ONLY INSIDE A CUSTOMER'S AGENT, where the target is private by design. Silo never sets it. */
  inAgent?: boolean;
  /** Read or write: a write never retries and never runs in a read-only transaction. */
  mode?: 'read' | 'write';
  timeoutMs: number;
  /** A body longer than this is `bounds.bytes`, not a truncation. Counted decompressed. */
  maxBytes: number;
  /** Reads may retry; writes never do — a create run twice is two records. */
  retry: boolean;
  signal?: AbortSignal;
  connectionId: string | null;
}

/** What a SQL transport pushes down without being told. */
export interface DerivedPushdown {
  filters: Record<string, string[]>;
  sort: boolean;
  limit: boolean;
  fields: boolean;
  aggregates: Array<'count' | 'sum' | 'group_by'>;
}

/** Structure, for derivation and self-heal. Never a row. */
export interface Structure {
  objects: Array<{
    name: string;
    fields: Array<{ name: string; type: string; nullable: boolean }>;
    identifier: string[];
    relationships: Array<{ field: string; targetObject: string; targetField: string }>;
  }>;
}

export interface Transport<Req extends WireRequest = WireRequest> {
  readonly kind: TransportKindV2;
  /** Whether `send` accepts a request built from a write operation. */
  readonly writes: boolean;
  /**
   * A transport that reaches no network at all — Silo's own inbound store or
   * row store — is read in-process and never through an agent.
   */
  readonly local?: boolean;
  /**
   * A transport whose body is always Silo's own wire JSON — IMAP, Kafka, gRPC
   * — is read with that parser whatever the operation's `format` says; the
   * operation's format then describes what is INSIDE (a Kafka value, say).
   */
  readonly answersWire?: boolean;

  /** Pure. Silo side. Throws `refusal.request_unbuildable` with the reason. */
  prepare(input: {
    transport: TransportV2;
    request: EvaluatedRequest;
    operation: OperationV2 | WriteOperationV2;
    params: Record<string, string>;
  }): Req;

  /** How a placement lands on this wire. Mutates `req` and `socket`. */
  authSurface(req: Req, socket: SocketAuth): AuthSurface;

  /** For `signed`. HTTP-shaped transports only. */
  canonicalView?(req: Req, stamp: { timestamp: string; nonce: string }): CanonicalRequest;

  /** The only I/O. Runs on Silo, or inside the agent — it does not know which. */
  send(req: Req, options: SendOptions): Promise<WireResponse>;

  /** What a response means when the manifest does not say. Null means "fine". */
  floor(res: WireResponse, req: Req): { means: Meaning; retryAfterSeconds?: number } | null;

  /** SQL: what is pushed down for an object with no `pushdown` declared. */
  derivedPushdown?(object: ObjectV2, operation: OperationV2): DerivedPushdown;

  /** Catalogue introspection: SQL, GraphQL, gRPC. */
  describe?(req: Req, options: SendOptions): Promise<Structure>;
}
