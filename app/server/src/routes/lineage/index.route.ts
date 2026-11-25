// lineage (spec 59, 58.6): the reviewer's and the reader's queries over the lineage graph,
// and the walk that carries a marking added upstream to everything derived from it.
// Producers write lineage in their own transactions through the lineage writer
// (services/lineage/writer.service.ts), not through this service.

import {
  accessOverlay, explainMarkings, getLineage, queryDownstream, queryUpstream,
} from '../../contracts/lineage/lineage.contract.ts';
import { exportLineage } from '../../contracts/lineage/export.contract.ts';
import { lineageController } from '../../controllers/lineage/lineage.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { DEFAULT_PROPAGATION, type PropagationOptions } from '../../services/lineage/propagation.service.ts';
import { propagationWorker } from '../../workers/lineage/propagation.worker.ts';

export interface LineageServiceOptions {
  propagation?: Partial<PropagationOptions> & { intervalMs?: number };
}

export function createLineageService(options: LineageServiceOptions = {}): ServiceDefinition {
  return defineService({
    name: 'lineage',
    // redis-data: a keyed export's idempotency record.
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const c = lineageController({ databases: deps.databases, services: deps.services, logger: deps.logger });
      return {
        routes: [
          route(getLineage, c.getLineage), route(queryUpstream, c.queryUpstream), route(queryDownstream, c.queryDownstream),
          route(explainMarkings, c.explainMarkings), route(accessOverlay, c.accessOverlay), route(exportLineage, c.exportLineage),
        ],
        workers: [propagationWorker(deps.databases, deps.logger, { ...DEFAULT_PROPAGATION, intervalMs: 5_000, ...options.propagation })],
      };
    },
  });
}

export const service = createLineageService();
