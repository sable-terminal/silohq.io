import { plainRow, type Driver, type SqlConnection } from './driver.sql';

/**
 * ODBC, inside the agent: DB2, Informix, Teradata, and anything else a
 * customer has an ODBC driver for.
 *
 * ── LOADED ONLY WHERE IT IS INSTALLED ─────────────────────────────────────
 *
 * The `odbc` package is native and needs the unixODBC or Windows driver
 * manager beside it. Silo never loads it — ODBC on Silo refuses by name — and
 * the agent loads it only if the person who installed the agent installed it
 * too. Where it is missing, an ODBC connection says so rather than failing
 * obscurely.
 *
 * ── THE CONNECTION STRING IS BUILT, NEVER CONCATENATED FROM A DOCUMENT ────
 *
 * A DSN, or the driver's keywords from `options`, with the host, port and
 * database the manifest names and the credential auth placed. A value holding
 * `;` or `}` is braced the way the ODBC specification says, so a password can
 * never add a keyword.
 */

interface OdbcConnection {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  query(sql: string, parameters?: unknown[]): Promise<Array<Record<string, unknown>> & { count?: number }>;
  close(): Promise<void>;
}
interface OdbcModule {
  pool(connectionString: string | { connectionString: string; connectionTimeout?: number; loginTimeout?: number; maxSize?: number }): Promise<{ connect(): Promise<OdbcConnection>; close(): Promise<void> }>;
}

const quote = (value: string): string => (/[;{}]/.test(value) || /^\s|\s$/.test(value) ? `{${value.replace(/}/g, '}}')}}` : value);

export function connectionStringOf(connection: SqlConnection): string {
  const parts: Array<[string, string]> = [];
  const options = { ...connection.options };
  if (connection.connectString) return [connection.connectString.replace(/;?\s*$/, ''), ...credentialPairs(connection).map(([k, v]) => `${k}=${quote(v)}`)].join(';');
  if (options.dsn) {
    parts.push(['DSN', options.dsn]);
    delete options.dsn;
  } else {
    if (options.driver) parts.push(['DRIVER', options.driver]);
    if (connection.host) parts.push([options.hostKeyword ?? 'HOSTNAME', connection.host]);
    if (connection.port) parts.push([options.portKeyword ?? 'PORT', String(connection.port)]);
    if (connection.database) parts.push([options.databaseKeyword ?? 'DATABASE', connection.database]);
  }
  for (const key of ['driver', 'hostKeyword', 'portKeyword', 'databaseKeyword']) delete options[key];
  for (const [key, value] of Object.entries(options)) {
    if (!/^[A-Za-z][A-Za-z0-9_ ]{0,63}$/.test(key)) throw new Error(`"${key}" is not an ODBC keyword.`);
    parts.push([key, value]);
  }
  parts.push(...credentialPairs(connection));
  return parts.map(([k, v]) => `${k}=${quote(v)}`).join(';');
}

const credentialPairs = (connection: SqlConnection): Array<[string, string]> => [
  ...(connection.username ? ([['UID', connection.username]] as Array<[string, string]>) : []),
  ...(connection.password ? ([['PWD', connection.password]] as Array<[string, string]>) : []),
];

export function odbcDriver(odbc: OdbcModule): Driver {
  const pools = new Map<string, Awaited<ReturnType<OdbcModule['pool']>>>();
  return {
    async run(connection, statement, options) {
      const text = connectionStringOf(connection);
      const key = `${options.connectionId ?? 'anon'}:${text}`;
      let pool = pools.get(key);
      if (!pool) {
        pool = await odbc.pool({ connectionString: text, connectionTimeout: Math.ceil(options.timeoutMs / 1_000), loginTimeout: 15, maxSize: 4 });
        pools.set(key, pool);
      }
      const conn = await pool.connect();
      try {
        await conn.beginTransaction();
        const result = await conn.query(statement.text, statement.values);
        /* A read is rolled back, so nothing it touched — a temp table, a sequence — outlives it. */
        if (options.mode === 'read') await conn.rollback();
        else await conn.commit();
        const rows = [...result].slice(0, options.maxRows + 1).map((row) => plainRow({ ...row }));
        return { rows, affected: typeof result.count === 'number' && result.count >= 0 ? result.count : null };
      } catch (error) {
        await conn.rollback().catch(() => {});
        throw error;
      } finally {
        await conn.close().catch(() => {});
      }
    },
    codeOf(error) {
      const first = (error as { odbcErrors?: Array<{ state?: string; code?: number }> })?.odbcErrors?.[0];
      return first?.state ?? (first?.code !== undefined ? String(first.code) : null);
    },
  };
}

/** The ODBC driver, if this machine has the package. Null otherwise. */
export async function loadOdbc(): Promise<Driver | null> {
  try {
    const name = 'odbc';
    const odbc = (await import(name)) as OdbcModule & { default?: OdbcModule };
    return odbcDriver(odbc.default ?? odbc);
  } catch {
    return null;
  }
}
