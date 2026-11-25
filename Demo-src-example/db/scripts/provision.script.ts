import 'dotenv/config';
import { Client } from 'pg';

/**
 * Provision the cluster: the two database roles, and the extensions the schema
 * is typed against.
 *
 * OUTSIDE THE MIGRATION LEDGER, ON PURPOSE. A role is a CLUSTER-level object, not
 * a database one. A migration that creates a role runs once per database, so the
 * second database in the same cluster fails on "role already exists" — and the
 * ledger then records a migration as unapplied that in fact did its work. Roles
 * are provisioning, not schema.
 *
 * IT IS IDEMPOTENT AND IT NEVER CHANGES A PASSWORD IT DID NOT SET. Re-running
 * against a cluster where the roles exist alters nothing unless a password was
 * supplied, so this can be run before every deploy without rotating credentials
 * out from under a running service.
 *
 *   silo_app        NOBYPASSRLS. What the server connects as. Row level security
 *                   applies, so a query missing its tenant predicate returns
 *                   nothing.
 *   silo_migrator   BYPASSRLS, owns the tables, runs DDL. Its credentials are
 *                   never given to the server.
 *
 * THE APPLICATION ROLE HAS NO CREATE ON THE SCHEMA. It cannot add a table, and
 * more to the point it cannot add one whose policies it wrote itself.
 *
 * EXTENSIONS ARE CREATED HERE RATHER THAN IN A MIGRATION, and finding that out
 * cost a failed migration. `CREATE EXTENSION` needs superuser on a stock
 * Postgres, which `silo_migrator` deliberately is not. On Cloud SQL it would
 * have worked, because roles there inherit `cloudsqlsuperuser` — so the
 * migration would have passed in production and failed on every developer
 * machine, which is the worse way round. Provisioning runs as the cluster owner
 * in both places, so it behaves the same in both.
 */

const APP_ROLE = 'silo_app';
const MIGRATOR_ROLE = 'silo_migrator';

async function main(): Promise<void> {
  /*
   * Connects as whoever owns the cluster — a superuser locally, the Cloud SQL
   * admin user in production. This is the one script that needs that, which is
   * why it is a script and not something the server can reach.
   */
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error('Set DATABASE_ADMIN_URL to a role that may CREATE ROLE.');
  }

  const appPassword = process.env.SILO_APP_PASSWORD;
  const migratorPassword = process.env.SILO_MIGRATOR_PASSWORD;

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    for (const [role, password, bypass] of [
      [APP_ROLE, appPassword, false],
      [MIGRATOR_ROLE, migratorPassword, true],
    ] as const) {
      const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);

      /*
       * THE SERVER ESCAPES ITS OWN IDENTIFIERS AND LITERALS.
       *
       * `CREATE ROLE` and `ALTER ROLE` cannot take bind parameters — they are
       * utility statements, not queries — and neither can a `DO` block, where
       * `$1` is dollar-quoting rather than a placeholder. That leaves building
       * the statement as text, and a password from the environment must not be
       * concatenated into it by hand.
       *
       * So `quote_ident` and `quote_literal` are called as an ordinary
       * parameterised query first, and their results are pasted in. The escaping
       * is done by the same parser that will read the statement back, which is
       * the only version that cannot disagree with itself.
       */
      const { rows: quoted } = await client.query<{ ident: string; lit: string | null }>(
        'SELECT quote_ident($1) AS ident, quote_literal($2) AS lit',
        [role, password ?? null],
      );
      const ident = quoted[0]!.ident;
      const lit = quoted[0]!.lit;

      if (rowCount === 0) {
        const bypassClause = bypass ? 'BYPASSRLS' : 'NOBYPASSRLS';
        const passwordClause = lit ? ` PASSWORD ${lit}` : '';
        await client.query(`CREATE ROLE ${ident} LOGIN ${bypassClause}${passwordClause}`);
        process.stdout.write(`  created ${role}${bypass ? ' (BYPASSRLS)' : ''}\n`);
      } else if (lit) {
        // Never silently reset a password that was not supplied.
        await client.query(`ALTER ROLE ${ident} PASSWORD ${lit}`);
        process.stdout.write(`  ${role} exists, password updated\n`);
      } else {
        process.stdout.write(`  ${role} exists, left alone\n`);
      }
    }

    /*
     * ASSERTED RATHER THAN ASSUMED. A `silo_app` that has picked up BYPASSRLS —
     * because somebody granted it superuser to fix something at 2am — makes every
     * policy in this schema decorative, and nothing else would notice. The whole
     * model is one boolean, so the boolean is checked.
     */
    const { rows } = await client.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ANY($1)',
      [[APP_ROLE, MIGRATOR_ROLE]],
    );

    const app = rows.find((r) => r.rolname === APP_ROLE);
    if (app?.rolbypassrls || app?.rolsuper) {
      throw new Error(
        `${APP_ROLE} can bypass row level security (bypassrls=${app.rolbypassrls}, ` +
          `superuser=${app.rolsuper}). Every policy in this database is doing nothing. ` +
          `Fix with: ALTER ROLE ${APP_ROLE} NOBYPASSRLS NOSUPERUSER;`,
      );
    }

    process.stdout.write(`  verified ${APP_ROLE} cannot bypass row level security\n`);

    /*
     * `IF NOT EXISTS` so this is safe to re-run, and listed explicitly rather
     * than looped over a config so that adding one is a visible change to a file
     * somebody reviews.
     */
    for (const extension of ['citext', 'pgcrypto', 'ltree']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    }
    process.stdout.write('  extensions: citext, pgcrypto, ltree\n');

    /*
     * The migrator owns the schema and creates the tables; the application only
     * ever gets the DML grants each migration hands out. Granted here because
     * `public` belongs to the cluster owner, not to the migrator.
     */
    await client.query(`GRANT ALL ON SCHEMA public TO ${MIGRATOR_ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    process.stdout.write('  schema grants applied\n');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
