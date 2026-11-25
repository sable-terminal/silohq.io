// connector-builder (catalogue; spec 16.3): the AI route to a connector. Documentation to a
// draft (OpenAPI compiled; pasted documentation through the model gateway), then probe,
// reconcile, conform and propose in the background, each stage recorded in
// connect.probe_runs; the person confirms, and a holder of connector.verify verifies.

import {
  confirmBuild, draftConnector, getBuild, previewBuild, probeBuild,
} from '../../contracts/connector-builder/build.contract.ts';
import { buildController } from '../../controllers/connector-builder/build.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createConnectorBuilder } from '../../services/connector-builder/builder.service.ts';

export const service = defineService({
  name: 'connector-builder',
  // redis-data holds the idempotency keys of drafts, probes and confirmations.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const builder = createConnectorBuilder({ databases: deps.databases, services: deps.services, logger: deps.logger });
    const c = buildController(builder);
    return {
      routes: [
        route(draftConnector, c.draftConnector), route(probeBuild, c.probeBuild), route(getBuild, c.getBuild),
        route(previewBuild, c.previewBuild), route(confirmBuild, c.confirmBuild),
      ],
      close: () => builder.close(),
    };
  },
});
