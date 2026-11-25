// The marking check (spec 69.16): at each interval, every Warehouse with live direct SQL
// grants is checked; one that now holds marked data has its grants ended by the system.

import type { Worker } from '../../infra/service.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { warehouseSqlGrantRepo } from '../../repos/siloes/index.repo.ts';
import { enforceMarkings, type AccessDeps } from '../../services/warehouse-access/access.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export async function checkGrants(deps: AccessDeps): Promise<number> {
  const projects = await inTransaction(deps.databases.pool('control'), {}, (db) => warehouseSqlGrantRepo.projectsWithLiveGrants(db, 1_000), { readOnly: true });
  let ended = 0;
  for (const p of projects) {
    ended += await enforceMarkings(deps, p.organisationId, p.warehouseProjectId, uuidv7()).catch((error: unknown) => {
      deps.logger.failure('a Warehouse\'s direct grants could not be checked against markings', error, {
        event: 'warehouse.access_check_failed', organisationId: p.organisationId,
      });
      return 0;
    });
  }
  return ended;
}

export function markingsWorker(deps: AccessDeps): Worker {
  return {
    name: 'warehouse-access-markings',
    async run(signal) {
      while (!signal.aborted) {
        await sleep(deps.config.accessCheckSeconds * 1_000, signal).catch(() => undefined);
        if (signal.aborted) break;
        await checkGrants(deps);
      }
    },
  };
}
