// The cell's half of a backup and a restore (spec 8.2, 12.5; D251), run by the deployment's
// backup and recovery jobs in the maintenance pod (docs/siloOperations.doc.md, recovery):
//
//   node src/scripts/restore.script.ts manifest
//     with each backup: every pg-control table's row count, kept in object-backup; prints its key.
//   node src/scripts/restore.script.ts check <manifest key>
//     against a restored database: each table's count compared with the manifest it was restored
//     to; exits 1 if any differs.
//   node src/scripts/restore.script.ts replay <restore point, ISO 8601>
//     before the restored cell opens to traffic: every purge made since the restore point done
//     again, by the service that owns it; exits 1 if any service refuses.
//
// Configuration: the maintenance service's (SILO_SERVICE=maintenance): MAINTENANCE_DATABASE_URL
// (the migration login), object storage (OBJECT_STORE and its backup bucket), and the service
// URLs and certificates it calls the owning services with.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.config.ts';
import { createLogger } from '../infra/logger.infra.ts';
import { createObjectStore } from '../infra/objectStorage.infra.ts';
import { createPool } from '../infra/postgres.infra.ts';
import { createServiceClient } from '../infra/serviceClient.infra.ts';
import { checkAgainst, ledgerSince, replayLedger, takeManifest } from '../services/maintenance/restore.service.ts';
import { uuidv7 } from '../utils/id.util.ts';

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  const usage = 'usage: node src/scripts/restore.script.ts manifest | check <manifest key> | replay <restore point>\n';
  if (command === undefined || !['manifest', 'check', 'replay'].includes(command) || (command !== 'manifest' && argument === undefined)) {
    process.stderr.write(usage);
    process.exit(2);
  }
  const config = loadConfig({ ...process.env, SILO_SERVICE: 'maintenance' });
  const logger = createLogger({ service: 'maintenance', cell: config.cell.id, release: config.release, level: 'info' });
  if (config.maintenance?.databaseUrl === undefined || config.objectStorage === undefined) {
    process.stderr.write('the restore tool needs MAINTENANCE_DATABASE_URL and object storage\n');
    process.exit(2);
  }
  const migrate = createPool({ ...config.postgres, controlUrl: config.maintenance.databaseUrl, poolMax: 2, statementTimeoutMs: config.maintenance.statementTimeoutMs },
    'control', 'maintenance', { logger });
  const store = await createObjectStore(config.objectStorage);
  const services = createServiceClient({ caller: 'maintenance', cell: config.cell.id, http: config.http });
  try {
    if (command === 'manifest') {
      process.stdout.write(`${JSON.stringify(await takeManifest(migrate, store))}\n`);
    } else if (command === 'check') {
      const result = await checkAgainst(migrate, store, argument!);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.differing.length > 0) process.exitCode = 1;
    } else {
      const entries = await ledgerSince(store, argument!);
      const replayed = await replayLedger(services, entries, uuidv7());
      logger.info('the purge ledger was replayed', { event: 'restore.ledger_replayed', count: entries.length });
      process.stdout.write(`${JSON.stringify({ since: argument, entries: entries.length, replayed })}\n`);
    }
  } catch (error) {
    process.stderr.write(`the restore tool stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await services.close();
    await migrate.end();
  }
}
