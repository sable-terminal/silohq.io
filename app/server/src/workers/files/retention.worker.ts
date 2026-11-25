// The export retention sweep (spec 41.5): exports past their retention are deleted as a
// person's deletion is, document first, with a receipt naming retention as the reason. The
// claim crosses organisations through files.claim_expired_files (identifiers only); each
// deletion then runs under the file's own organisation.

import type { Worker } from '../../infra/service.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { fileRepo } from '../../repos/files/index.repo.ts';
import type { FilesDeps } from '../../services/files/deps.service.ts';
import { deleteFileAs } from '../../services/files/files.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function retentionWorker(deps: FilesDeps): Worker {
  return {
    name: 'files-retention',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const due = await inTransaction(deps.databases.pool('control'), {}, (db) => fileRepo.claimExpired(db, 100, new Date(deps.now()).toISOString()));
          for (const file of due) {
            if (signal.aborted) break;
            const actor = {
              organisationId: file.organisationId, request: { organisationId: file.organisationId }, membershipId: file.createdBy,
              audit: { kind: 'service' as const, service: 'files' as const }, servicePrincipalId: undefined,
            };
            await deleteFileAs(deps, actor, uuidv7(), file.id, 'retention').catch((error: unknown) => {
              deps.logger.failure('an expired export could not be deleted; the next sweep retries', error, {
                event: 'files.retention_failed', organisationId: file.organisationId, resourceId: file.id,
              });
            });
          }
        } catch (error) {
          deps.logger.failure('the retention sweep failed; the next one retries', error, { event: 'files.sweep_failed' });
        }
        await sleep(deps.config.sweepSeconds * 1000, signal).catch(() => undefined);
      }
    },
  };
}
