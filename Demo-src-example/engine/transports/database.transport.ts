import type { TransportV2 } from '../../schemas/manifest.schema';
import { bounds, isAppError, refusal } from '../../utils/error.util';
import type { AuthSurface, SocketAuth, Transport, WireRequest, WireResponse } from './contract.transport';
import { driverFor, type SqlConnection } from './sql/driver.sql';
import { GRAMMARS, type GrammarName } from './sql/grammar.sql';
import { buildSelect, buildWrite, type Statement, type WriteKind } from './sql/statement.sql';

/**
 * SQL, on every database with a driver and a grammar (MANIFEST-V2 §9.5).
 *
 * THE RUNNER SUPPLIES THE QUESTION AND THIS WRITES IT. A read arrives as a table
 * or a confirmed view statement, the columns to name, and the filters, order
 * and limit already planned; `prepare` turns them into text and bound values in
 * the connection's grammar. The wire carries no credential — the username and
 * password travel on the socket, which auth fills — so the prepared statement
 * can be logged, shown in a preview and pinned by hash.
 *
 * THE ROWS COME BACK AS JSON BYTES, like every other transport's body, so the
 * runner, the error rules and the agent relay see one shape whatever the
 * protocol. Dates are ISO 8601, bytes base64, big integers text.
 */

export interface SqlWire extends WireRequest {
  kind: 'sql';
  grammar: GrammarName;
  connection: Omit<SqlConnection, 'username' | 'password' | 'tls'>;
  statement: Statement;
  mode: 'read' | 'write';
  maxRows: number;
}

type SqlTransport = Extract<TransportV2, { kind: 'sql' }>;

const str = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));

/** A write, prepared by the write executor rather than from a read request. */
export function prepareWrite(
  transport: SqlTransport,
  connection: Record<string, unknown>,
  input: { table: string; schema: string | null; identifier: string[]; kind: WriteKind; values: Record<string, unknown>; key: Record<string, unknown> },
): SqlWire {
  const grammar = GRAMMARS[transport.grammar];
  return {
    kind: 'sql',
    grammar: transport.grammar,
    connection: connectionOf(transport, connection),
    statement: buildWrite(grammar, input),
    mode: 'write',
    maxRows: 1_000,
  };
}

function connectionOf(transport: SqlTransport, evaluated: Record<string, unknown>): SqlWire['connection'] {
  const port = evaluated.port;
  const options: Record<string, string> = {};
  for (const [name, value] of Object.entries((evaluated.options as Record<string, unknown>) ?? {})) {
    if (value !== null && value !== undefined) options[name] = String(value);
  }
  return {
    driver: transport.driver,
    host: str(evaluated.host),
    port: port === null || port === undefined || port === '' ? null : Number(port),
    database: str(evaluated.database),
    serviceName: str(evaluated.serviceName),
    sid: str(evaluated.sid),
    connectString: str(evaluated.connectString),
    options,
  };
}

function socketOnly(where: string): never {
  throw refusal({
    message: `A database takes its credential on the connection, not at ${where}.`,
    code: 'refusal.auth_place_unsupported',
  });
}

export const sql: Transport<SqlWire> = {
  kind: 'sql',
  writes: true,

  prepare({ transport, request }) {
    const t = transport as SqlTransport;
    const grammar = GRAMMARS[t.grammar];
    const schema = str(request.schema) ?? str(request.connection.schema);
    const limit = request.limit ?? 5_001;
    return {
      kind: 'sql',
      grammar: t.grammar,
      connection: connectionOf(t, request.connection),
      statement: buildSelect(grammar, {
        schema: request.statement ? null : schema,
        table: str(request.table),
        statement: request.statement ?? null,
        columns: request.fields && request.fields.length > 0 ? request.fields : request.columns ?? [],
        where: request.where,
        order: request.order,
        limit,
        aggregate: request.aggregate ?? null,
      }),
      mode: 'read',
      maxRows: limit,
    };
  },

  authSurface(_wire, socket: SocketAuth): AuthSurface {
    return {
      setHeader: (name) => socketOnly(`header:${name}`),
      setQuery: (name) => socketOnly(`query:${name}`),
      setBodyPath: (path) => socketOnly(`body:${path}`),
      setCookie: (name) => socketOnly(`cookie:${name}`),
      setForm: (name) => socketOnly(`form:${name}`),
      setSoapHeader: (path) => socketOnly(`soap:${path}`),
      socket,
    };
  },

  async send(wire, options): Promise<WireResponse> {
    const started = Date.now();
    const driver = driverFor(wire.connection.driver);
    try {
      const result = await driver.run(
        { ...wire.connection, username: options.socket.username ?? null, password: options.socket.password ?? null, tls: options.socket.tls },
        wire.statement,
        {
          mode: options.mode ?? wire.mode,
          grammar: GRAMMARS[wire.grammar],
          timeoutMs: options.timeoutMs,
          maxRows: wire.maxRows,
          inAgent: options.inAgent === true,
          connectionId: options.connectionId,
        },
      );
      /* A read's body is its rows; a write's says how many rows it touched as well. */
      const body = Buffer.from(JSON.stringify((options.mode ?? wire.mode) === 'write' ? result : result.rows));
      if (body.length > options.maxBytes) {
        throw bounds({ message: 'The database returned more data than one question may read.', code: 'bounds.bytes', detail: { observed: body.length, limit: options.maxBytes } });
      }
      return { status: null, code: null, message: null, headers: {}, body, contentType: 'application/json', durationMs: Date.now() - started };
    } catch (error) {
      /* Silo's own refusals — a blocked address, an ODBC request on Silo — pass through as themselves. */
      if (isAppError(error)) throw error;
      return {
        status: null,
        code: driver.codeOf(error) ?? 'UNKNOWN',
        message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        headers: {},
        body: Buffer.alloc(0),
        contentType: null,
        durationMs: Date.now() - started,
      };
    }
  },

  floor(res, wire) {
    if (res.code === null) return null;
    return { means: GRAMMARS[wire.grammar].floor[res.code] ?? 'upstream' };
  },
};
