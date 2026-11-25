// model-gateway (spec 7.8, 62): the only service that holds model credentials or reaches
// a model endpoint. It opens one endpoint per route in MODEL_ROUTES_FILE and refuses to
// start when a route could outlive the request that carries it.
//
// Its database login is a member of silo_audit_writer (platform.model_calls) and
// silo_app (the outbox, and the Siloes rows the extraction carve-out checks).

import { embedTexts } from '../../contracts/model-gateway/embedding.contract.ts';
import type { ModelRole } from '../../config/model.config.ts';
import { AUDIT_EVENT_CATALOGUE } from '../../contracts/audit/auditEvent.contract.ts';
import { callModel } from '../../contracts/model-gateway/call.contract.ts';
import { extractDocument } from '../../contracts/model-gateway/extraction.contract.ts';
import { callController } from '../../controllers/model-gateway/call.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { createModelProvider, type ModelProvider } from '../../infra/modelProvider.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createModelGateway } from '../../services/model-gateway/gateway.service.ts';
import { createSlots } from '../../services/model-gateway/slots.service.ts';
import { AppError } from '../../utils/errors.util.ts';

// Roles with no endpoint here yet: embeddings use a different API (metadata only, spec 62.7).
const NOT_SERVED: readonly ModelRole[] = [];
// The audit events every call writes (spec 62.8). A gateway that could not record them
// would send what it cannot account for, so it does not start.
const EVENTS = ['model_call_made', 'model_call_refused', 'extraction_carveout_used'];

export const service = defineService({
  name: 'model-gateway',
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const config = deps.config.model;
    if (config === undefined) throw new AppError('configuration', 'model-gateway needs MODEL_ROUTES_FILE', { code: 'config.model' });
    const unlisted = EVENTS.filter((event) => !AUDIT_EVENT_CATALOGUE.has(event));
    if (unlisted.length > 0) {
      throw new AppError('configuration', `the audit catalogue does not list ${unlisted.join(', ')}`, { code: 'config.model.audit_events' });
    }
    const providers = new Map<ModelRole, ModelProvider>();
    for (const modelRoute of config.routes) {
      if (NOT_SERVED.includes(modelRoute.role)) {
        deps.logger.warn('a model route is configured for a role not served yet', { event: 'model.route_unused', reason: modelRoute.role });
        continue;
      }
      // The HTTP layer stops waiting at HTTP_REQUEST_TIMEOUT_MS; the endpoint must answer first.
      if (modelRoute.timeoutMs >= deps.config.http.requestTimeoutMs) {
        throw new AppError('configuration', `model route ${modelRoute.name}: timeoutMs must be below HTTP_REQUEST_TIMEOUT_MS`, {
          code: 'config.model.timeout', details: { limit: deps.config.http.requestTimeoutMs },
        });
      }
      providers.set(modelRoute.role, createModelProvider(modelRoute, { metadataHost: config.metadataHost }));
    }
    const slots = createSlots(deps.redis.data!, {
      cellId: deps.config.cell.id, perOrganisation: config.perOrganisationConcurrency, perCell: config.cellConcurrency,
    });
    const gateway = createModelGateway({ databases: deps.databases, slots, providers, config, logger: deps.logger });
    const handlers = callController(gateway);
    return { routes: [route(callModel, handlers.callModel), route(extractDocument, handlers.extractDocument), route(embedTexts, handlers.embedTexts)] };
  },
});
