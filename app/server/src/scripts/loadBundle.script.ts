// Loads an air-gapped bundle into an install's own fleet-control (spec 11.4; D201), run by the
// customer's operator in the fleet-control pod once the media has come in by their own procedure:
// the whole bundle is checked (signatures, every file's hash) before anything is loaded, and
// refused on any mismatch; loaded, its release becomes the head of the install's channel, and the
// install's Fleet agent applies it. Both outcomes are recorded and reach the local audit log.
//
// Usage: node src/scripts/loadBundle.script.ts <bundle dir> <operator id> <approver id> [channel]
//   (two people, as for any promotion beyond dev: one loads it, another approves the load)
//   (the fleet-control configuration: PG_DIRECTORY_URL, FLEET_ARTEFACT_DIR, FLEET_SIGNING_KEY,
//   FLEET_RELEASE_PUBLIC_KEY_FILE; channel stable by default, sovereign in a sovereign install)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.config.ts';
import { createLogger } from '../infra/logger.infra.ts';
import { openDatabases } from '../infra/postgres.infra.ts';
import { openFleetControl } from '../services/fleet-control/control.service.ts';

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, operatorId, approverId, channel] = process.argv.slice(2);
  const uuid = /^[0-9a-f-]{36}$/;
  if (dir === undefined || operatorId === undefined || approverId === undefined || !uuid.test(operatorId) || !uuid.test(approverId)) {
    process.stderr.write('usage: node src/scripts/loadBundle.script.ts <bundle dir> <operator id> <approver id> [channel]\n');
    process.exit(2);
  }
  const config = loadConfig({ ...process.env, SILO_SERVICE: 'fleet-control' });
  const logger = createLogger({ service: 'fleet-control', cell: config.cell.id, release: config.release, level: 'info' });
  const databases = openDatabases(config.postgres, 'fleet-control', ['directory']);
  try {
    const { fleet } = await openFleetControl(config, databases, logger);
    const loaded = await fleet.loadBundle(path.resolve(dir), {
      operatorId, approverId, cellId: config.cell.id, channel: (channel ?? (config.cell.kind === 'sovereign' ? 'sovereign' : 'stable')) as never,
    });
    process.stdout.write(`${JSON.stringify(loaded)}\n`);
  } catch (error) {
    process.stderr.write(`the bundle was refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await databases.close(5_000);
  }
}
