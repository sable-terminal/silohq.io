// The status service (spec 7.2, 13.2), in the global tier: cells report component state,
// incident commanders write notices, and the page is published to static hosting apart
// from every cell. The sovereign build publishes the sovereign cell's own page.

import { statusController } from '../../controllers/status/status.controller.ts';
import { putNotice, putNoticeUpdate, readStatus, reportCellStatus } from '../../contracts/status/status.contract.ts';
import { required } from '../../config/index.config.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { directoryPublisher, type StatusPublisher } from '../../services/status/publisher.service.ts';
import { createStatusBoard } from '../../services/status/status.service.ts';
import { publishWorker } from '../../workers/status/publish.worker.ts';

export interface StatusServiceOptions {
  /** Where the page is written; the configured directory by default. */
  publisher?: StatusPublisher;
  /** The clock, for tests of staleness. */
  now?: () => number;
}

export function createStatusService(options: StatusServiceOptions = {}): ServiceDefinition {
  return defineService({
    name: 'status',
    needs: { postgres: ['directory'] },
    async create(deps) {
      const settings = deps.config.globalTier.status;
      const publisher = options.publisher ?? directoryPublisher(required(settings.publishDir, 'STATUS_PUBLISH_DIR'));
      const board = createStatusBoard({
        databases: deps.databases, logger: deps.logger, sovereign: deps.config.cell.buildTarget === 'sovereign',
        staleAfterSeconds: settings.staleAfterSeconds, noticeRetentionDays: settings.noticeRetentionDays,
        ...(options.now ? { now: options.now } : {}),
      });
      const handlers = statusController(board, deps.config.cell.id);
      return {
        routes: [
          route(reportCellStatus, handlers.reportCellStatus),
          route(putNotice, handlers.putNotice),
          route(putNoticeUpdate, handlers.putNoticeUpdate),
          route(readStatus, handlers.readStatus),
        ],
        workers: [publishWorker({ board, publisher, intervalSeconds: settings.publishIntervalSeconds, logger: deps.logger })],
      };
    },
  });
}

export const service = createStatusService();
