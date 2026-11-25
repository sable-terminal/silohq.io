// The daily close: every interval, closes and publishes the chain heads of the days that
// have ended, for every organisation of the cell (audit.organisations_for_chain_close), so
// a quiet organisation still gets its daily head after a restart. The writer also closes
// them on the first write of a day.

import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import { chainHeadRepo } from '../../repos/audit/index.repo.ts';
import { closeChainHeads, utcDate } from '../../services/audit/chain.service.ts';
import type { AuditWriter } from '../../services/audit/writer.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function chainHeadsWorker(databases: Databases, writer: AuditWriter, logger: Logger, intervalMs: number): Worker {
  const pool = databases.pool('control');
  return {
    name: 'audit-chain-heads',
    async run(signal) {
      while (!signal.aborted) {
        const today = utcDate(Date.now());
        const everyone = await inTransaction(pool, {}, (db) => chainHeadRepo.organisationsToClose(db)).catch((error: unknown) => {
          logger.failure('listing the organisations to close failed; closing those written for', error, { event: 'audit.chain_heads_failed' });
          return [] as string[];
        });
        for (const organisationId of new Set([...everyone, ...writer.organisations])) {
          if (signal.aborted) break;
          try {
            const closed = await inTransaction(pool, { organisationId }, (db) => closeChainHeads(db, organisationId, today));
            if (closed > 0) logger.info('chain heads published', { event: 'audit.chain_heads_published', organisationId, count: closed });
          } catch (error) {
            logger.failure('closing chain heads failed; the next pass retries', error, { event: 'audit.chain_heads_failed', organisationId });
          }
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
