// change-stream's round (spec 18.1, 18.7): for every object the state plane holds live,
// choose the source, watch a webhook's heartbeat, and poll what is due. Several replicas
// may run it: each poll is taken under a lock.

import type { Worker } from '../../infra/service.infra.ts';
import { dropChangeInterest, interestedConnections, interestedOrganisations, liveInterest } from '../../infra/keyspaces.infra.ts';
import { isAppError } from '../../utils/errors.util.ts';
import type { ChangeStreamDeps } from '../../services/change-stream/deps.service.ts';
import { serviceConnection } from '../../services/change-stream/poller.service.ts';
import type { SourceCatalogue } from '../../services/change-stream/sources.service.ts';
import type { StreamHealthStore } from '../../services/change-stream/status.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function sourcesWorker(deps: ChangeStreamDeps, catalogue: SourceCatalogue, health: StreamHealthStore, tickMs: number): Worker {
  return {
    name: 'change-stream-sources',
    async run(signal) {
      while (!signal.aborted) {
        try {
          for (const organisationId of await interestedOrganisations(deps.state, deps.cellId)) {
            for (const connectionId of await interestedConnections(deps.state, organisationId)) {
              if (signal.aborted) return;
              try {
                const objects = await liveInterest(deps.state, organisationId, connectionId);
                if (objects.size === 0) continue;
                const sources = await catalogue.load({ organisationId }, connectionId);
                if (sources.connection.status === 'revoked') {
                  await dropChangeInterest(deps.state, organisationId, connectionId);
                  continue;
                }
                await serviceConnection(deps, health, sources, objects);
              } catch (error) {
                // Not here (another cell's, or deleted): skipped quietly; its interest lapses on its own.
                if (isAppError(error) && error.code === 'connection.not_found') continue;
                deps.logger.failure('a connection\'s stream round failed; the next round retries', error, {
                  event: 'stream.round_failed', organisationId, connectionId,
                });
              }
            }
          }
        } catch (error) {
          deps.logger.failure('the stream round could not list live interest', error, { event: 'stream.round_failed' });
        }
        await sleep(tickMs, signal).catch(() => undefined);
      }
    },
  };
}
