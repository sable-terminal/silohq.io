// The entry point of every Silo service process. SILO_SERVICE names the process, and
// SILO_SERVICES the services it hosts when several share it. Configuration problems are
// listed by variable name, never with a value, and the process exits 2.

import { loadServices } from './src/app.ts';
import { ConfigError, loadConfig, type Config } from './src/config/index.config.ts';
import { runProcess } from './src/process.ts';
import { startTelemetry } from './src/infra/telemetry.infra.ts';
import { describeError } from './src/utils/errors.util.ts';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  const problems = error instanceof ConfigError ? error.problems : ['configuration could not be read'];
  for (const problem of problems) process.stderr.write(`${JSON.stringify({ level: 'error', event: 'config.refused', problem })}\n`);
  process.exit(2);
}

try {
  const telemetry = await startTelemetry(config);
  const definitions = await loadServices(config.hosted);
  await runProcess(definitions, config, { telemetry, handleSignals: true });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'process.start_failed', ...describeError(error) })}\n`);
  process.exit(1);
}
