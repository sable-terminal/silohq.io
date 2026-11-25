// schema-inference (catalogue; spec 14.6, 16.3): a connection's objects read as probes
// through connect-runtime, their structure inferred with confidence and counted evidence,
// recorded in connect.probe_runs. Never a record value kept.

import { inferConnection } from '../../contracts/schema-inference/inference.contract.ts';
import { inferenceController } from '../../controllers/schema-inference/inference.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createSchemaInference } from '../../services/schema-inference/schemaInference.service.ts';

export const service = defineService({
  name: 'schema-inference',
  needs: { postgres: ['control'] },
  create(deps) {
    const c = inferenceController(createSchemaInference({ databases: deps.databases, services: deps.services, logger: deps.logger }));
    return { routes: [route(inferConnection, c.inferConnection)] };
  },
});
