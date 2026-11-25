// The audit service (spec 7.5, 13.4, 63): the append-only, hash-chained audit ledger.
// Consumes audit.events from bus-durable, chains product events per organisation,
// publishes the daily chain head, and serves the audit view and export.
//
// Its login is a member of silo_audit_writer (insert on the ledgers) and silo_app (the
// scope tree and grants, read to scope a reader). Partition seals are written by the
// maintenance service, which can read a closed partition across organisations.

import {
  listAuditEvents, listAuthEvents, listChainHeads, listCredentialUnwraps, listPartitionSeals, readAuditChain,
} from '../../contracts/audit/read.contract.ts';
import { readController } from '../../controllers/audit/read.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createAuditReader } from '../../services/audit/read.service.ts';
import { createAuditWriter } from '../../services/audit/writer.service.ts';
import { recordFleetEvents, recordIncidentEvents, recordRedactionViolations } from '../../contracts/audit/fleetEvents.contract.ts';
import {
  recordFleetEvents as copyFleetEvents, recordIncidentEvents as copyIncidentEvents, recordRedactionViolations as writeRedactionViolations,
} from '../../services/audit/fleetEvents.service.ts';
import { AppError } from '../../utils/errors.util.ts';
import { chainHeadsWorker } from '../../workers/audit/chainHeads.worker.ts';
import { consumerWorker } from '../../workers/audit/consumer.worker.ts';

export interface AuditOptions {
  /** The bus consumer (a Pub/Sub subscription audit.events.<consumer>). Default 'audit'. */
  consumer?: string;
  /** How often the daily close looks for ended days. Default 15 minutes. */
  chainHeadIntervalMs?: number;
}

export function createAuditService(options: AuditOptions = {}): ServiceDefinition {
  return defineService({
    name: 'audit',
    needs: { postgres: ['control'], bus: ['durable'] },
    create(deps) {
      if (!deps.durableBus) throw new AppError('configuration', 'the audit service needs bus-durable', { code: 'config.bus.durable' });
      const writer = createAuditWriter({ databases: deps.databases, logger: deps.logger });
      const controller = readController(createAuditReader({ databases: deps.databases, services: deps.services }));
      return {
        routes: [
          route(recordFleetEvents, { handle: (input, ctx) => copyFleetEvents(deps, input.body.events, ctx.correlationId) }),
          route(recordIncidentEvents, { handle: (input, ctx) => copyIncidentEvents(deps, input.body.events, ctx.correlationId) }),
          route(recordRedactionViolations, { handle: (input, ctx) => writeRedactionViolations(deps, input.body.violations, ctx.correlationId) }),
          route(listAuditEvents, controller.listAuditEvents),
          route(listAuthEvents, controller.listAuthEvents),
          route(listCredentialUnwraps, controller.listCredentialUnwraps),
          route(listChainHeads, controller.listChainHeads),
          route(readAuditChain, controller.readAuditChain),
          route(listPartitionSeals, controller.listPartitionSeals),
        ],
        workers: [
          consumerWorker(deps.durableBus, writer, options.consumer ?? 'audit'),
          chainHeadsWorker(deps.databases, writer, deps.logger, options.chainHeadIntervalMs ?? 15 * 60_000),
        ],
      };
    },
  });
}

export const service = createAuditService();
