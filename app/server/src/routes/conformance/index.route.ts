// conformance (catalogue): the fixed suite against every connector on every route (spec 17).
// Reads through connect-runtime; decisions through the policy service; runs recorded in
// connect.conformance_runs.

import { getConformanceRun, listConformanceRuns, startConformanceRun } from '../../contracts/conformance/conformance.contract.ts';
import { getWriteClassStatus, runWriteClass, setConnectionWrites } from '../../contracts/conformance/writeClass.contract.ts';
import { startChangeStreamClass } from '../../contracts/conformance/changeStreamClass.contract.ts';
import { conformanceController } from '../../controllers/conformance/conformance.controller.ts';
import { writeClassController } from '../../controllers/conformance/writeClass.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createConformance } from '../../services/conformance/conformance.service.ts';
import { createWriteClass } from '../../services/conformance/writeClass.service.ts';

export const service = defineService({
  name: 'conformance',
  // redis-data holds the idempotency keys of started runs.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const conformance = createConformance({
      databases: deps.databases, services: deps.services, logger: deps.logger,
      readTimeoutMs: deps.config.executorBounds.wallTimeMs + 15_000,
      stream: { waitMs: deps.config.conformance.streamWaitMs, pollMs: deps.config.conformance.streamPollMs },
    });
    const c = conformanceController(conformance);
    // The write-verify-undo class and writes_enabled (spec 17.1), through connect-runtime's sandbox.
    const w = writeClassController(createWriteClass({ databases: deps.databases, services: deps.services }));
    return {
      routes: [
        route(startConformanceRun, c.start), route(getConformanceRun, c.get), route(listConformanceRuns, c.list),
        // The change-stream class: what makes a stream subscribable (decision 2026-11-15).
        route(startChangeStreamClass, c.streamClass),
        route(getWriteClassStatus, w.status), route(runWriteClass, w.run), route(setConnectionWrites, w.set),
      ],
      close: () => conformance.close(),
    };
  },
});
