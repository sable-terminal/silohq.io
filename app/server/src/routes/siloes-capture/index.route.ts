// siloes-capture (catalogue; spec 66, 67, 70): the organisation's switch and the Siloes page,
// Capture (queue, baselines, transitions, history), retention for every Silo type, and every
// wipe with its approval, receipt and impact.

import { replaySiloPurges } from '../../contracts/platform/purgeLedger.contract.ts';
import * as l from '../../contracts/siloes/captureLedger.contract.ts';
import { replaySiloWipes } from '../../services/siloes-capture/purge.service.ts';
import * as c from '../../contracts/siloes/siloes.contract.ts';
import { siloesController } from '../../controllers/siloes-capture/siloes.controller.ts';
import { cellLocation } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { createObjectStore, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { siloesWorkers } from '../../workers/siloes-capture/siloes.worker.ts';

export function createSiloesCaptureService(options: { store?: ObjectStore; schedule?: boolean; now?: () => number } = {}) {
  return defineService({
    name: 'siloes-capture',
    needs: { postgres: ['control'], redis: ['data'] },
    async create(deps) {
      const config = deps.config.siloes;
      if (config.postgresPricePerGibMonth === undefined) {
        throw new AppError('configuration', 'Capture metering needs the region\'s Postgres price', { code: 'config.siloes_prices' });
      }
      const storage = deps.config.objectStorage;
      const store = options.store ?? (storage?.siloesBucket === undefined ? undefined : await createObjectStore(storage));
      const shared = {
        databases: deps.databases, services: deps.services, logger: deps.logger, redis: deps.redis.data!, store,
        location: deps.config.bigQuery?.location ?? cellLocation(deps.config.cell.id, deps.config.cell.residency), now: options.now ?? Date.now,
        // No Warehouse in this cell (the sovereign build): its Capture Siloes hold the Action ledger (48.2; D205).
        ledgerInCapture: !deps.config.cell.capabilities.has('warehouse'),
      };
      const h = siloesController(shared);
      return {
        routes: [
          route(c.getSiloesSetting, h.getSiloesSetting), route(c.setSiloesEnabled, h.setSiloesEnabled), route(c.listSiloes, h.listSiloes), route(c.getSiloesWeb, h.getSiloesWeb),
          route(c.getSilo, h.getSilo), route(c.createCaptureSilo, h.createCaptureSilo), route(c.addCaptureType, h.addCaptureType),
          route(c.changeCaptureProperties, h.changeCaptureProperties), route(c.removeCaptureType, h.removeCaptureType),
          route(c.changeRetention, h.changeRetention), route(c.requestPurge, h.requestPurge), route(c.previewPurge, h.previewPurge),
          route(c.getPurge, h.getPurge), route(c.listPurges, h.listPurges), route(c.readHistory, h.readHistory), route(c.readObjectChanges, h.readObjectChanges), route(c.readCaptureCoverage, h.readCaptureCoverage), route(c.runRetentionSweep, h.runRetentionSweep),
          route(c.readStateAt, h.readStateAt),
          route(l.setCaptureActionLedger, h.setCaptureActionLedger), route(l.writeCaptureLedger, h.writeCaptureLedger),
          route(l.purgeCaptureLedgerValues, h.purgeCaptureLedgerValues), route(l.listCaptureLedger, h.listCaptureLedger),
          route(c.adoptMovedSiloes, h.adoptMovedSiloes), route(c.releaseMovedSiloes, h.releaseMovedSiloes),
          // After a restore, before traffic (8.2, 12.5; D251).
          route(replaySiloPurges, { handle: (input) => replaySiloWipes(shared, input.body.entries) }),
        ],
        workers: options.schedule === false ? [] : siloesWorkers(shared, {
          drainSeconds: config.captureDrainSeconds, purgeSeconds: config.purgePollSeconds, sweepSeconds: config.retentionSweepSeconds,
          meteringSeconds: deps.config.bigqueryJobs.meteringIntervalSeconds, pricePerGibMonth: config.postgresPricePerGibMonth,
        }),
      };
    },
  });
}

export const service = createSiloesCaptureService();
