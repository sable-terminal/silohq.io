// Concept templates in the global tier (spec 22.7; D210), run by Silo staff in the fleet-control
// pod: author a template (a name and field names), have a second person review it, withdraw
// one. Only reviewed and withdrawn templates reach the cells, signed, through each cell's
// Fleet agent; a template is never applied by itself and never edited once reviewed.
//
// Usage:
//   node src/scripts/conceptTemplates.script.ts author <operator id> <name> <field,field,...>
//   node src/scripts/conceptTemplates.script.ts review <template id> <reviewer id>   (not the author)
//   node src/scripts/conceptTemplates.script.ts withdraw <template id> <operator id>
//   node src/scripts/conceptTemplates.script.ts list
//   (the fleet-control configuration: PG_DIRECTORY_URL, FLEET_ARTEFACT_DIR, FLEET_SIGNING_KEY)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.config.ts';
import { createLogger } from '../infra/logger.infra.ts';
import { openDatabases } from '../infra/postgres.infra.ts';
import { openFleetControl } from '../services/fleet-control/control.service.ts';

const USAGE = 'usage: conceptTemplates.script.ts author <operator> <name> <fields> | review <template> <reviewer> | withdraw <template> <operator> | list\n';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, a, b, c] = process.argv.slice(2);
  const valid = command === 'list' || (command === 'author' && a !== undefined && uuid.test(a) && b !== undefined && c !== undefined)
    || ((command === 'review' || command === 'withdraw') && a !== undefined && uuid.test(a) && b !== undefined && uuid.test(b));
  if (!valid) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const config = loadConfig({ ...process.env, SILO_SERVICE: 'fleet-control' });
  const logger = createLogger({ service: 'fleet-control', cell: config.cell.id, release: config.release, level: 'info' });
  const databases = openDatabases(config.postgres, 'fleet-control', ['directory']);
  try {
    const { fleet } = await openFleetControl(config, databases, logger);
    const out = command === 'author' ? await fleet.authorTemplate({ operatorId: a!, name: b!, fieldNames: c!.split(',').map((f) => f.trim()).filter(Boolean) })
      : command === 'review' ? await fleet.reviewTemplate(a!, b!)
        : command === 'withdraw' ? await fleet.withdrawTemplate(a!, b!)
          : await fleet.listTemplates();
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (error) {
    process.stderr.write(`refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await databases.close(5_000);
  }
}
