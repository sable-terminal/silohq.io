// Capture metering (spec 67.6, 74.1): bytes held in Postgres per Capture Silo, from the first
// day it exists, measured in the same windows as every Silo store and recorded as
// storage_measured. Postgres scans are not billed separately.

import { inTransaction } from '../../infra/postgres.infra.ts';
import { siloRepo, transitionRepo } from '../../repos/siloes/index.repo.ts';
import { measureStore } from '../bigquery-metering/metering.service.ts';
import type { SiloesDeps } from './deps.service.ts';

export async function meterCapture(deps: SiloesDeps & { intervalSeconds: number; pricePerGibMonth: string }, correlationId: string): Promise<number> {
  const pool = deps.databases.pool('control');
  const siloes = (await inTransaction(pool, {}, (db) => siloRepo.liveAcrossCell(db, 100_000), { readOnly: true })).filter((s) => s.kind === 'capture');
  let measured = 0;
  for (const s of siloes) {
    try {
      const silo = (await inTransaction(pool, { organisationId: s.organisationId }, (db) => siloRepo.findById(db, s.id), { readOnly: true }))!;
      measured += (await measureStore(deps, s.organisationId, {
        silo, store: 'postgres', pricePerGibMonth: deps.pricePerGibMonth, pricePerTib: '0',
        bytesHeld: async () => BigInt(await inTransaction(pool, { organisationId: s.organisationId }, (db) => transitionRepo.captureBytes(db, s.organisationId, s.id),
          { readOnly: true })),
        bytesScanned: async (windows) => windows.map(() => 0n),
      }, correlationId)).length;
    } catch (error) {
      deps.logger.failure('a Capture Silo could not be measured; the next pass measures its windows', error, {
        event: 'siloes.metering_failed', organisationId: s.organisationId,
      });
    }
  }
  return measured;
}
