// The cell's Fleet agent: what of it is built so far (spec 11.1: "A Fleet agent in each cell
// pulls its channel, applies releases ..."). It runs under fleet-control's name inside the cell
// (FLEET_ROLE=cell_agent) and, for now, carries the cell's agent channel to its Silo Agents
// (spec 10.7, 11.4): it pulls the channel's head and the release it names from fleet-control,
// checks both with the Silo release key, copies each platform's binary into the cell's object
// storage by its digest (hashing every byte), and installs the release in connect-runtime,
// which checks it all again and rolls it through the cell's agents in waves. Applying cell
// releases, migrations and health gates come with the rest of the Fleet agent.

import { createHash } from 'node:crypto';
import type { BuildTarget } from '../../config/cell.config.ts';
import { readAgentBinary } from '../../contracts/fleet-control/agentBinary.contract.ts';
import { readRelease } from '../../contracts/fleet-control/release.contract.ts';
import { readChannel } from '../../contracts/fleet-control/rollout.contract.ts';
import { installAgentRelease } from '../../contracts/connect-runtime/agentRelease.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { objectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { agentChannelFor, checkAgentRelease } from './agentRelease.service.ts';
import type { TrustedKey } from './signing.service.ts';

export interface CellAgentDeps {
  services: ServiceClient;
  objects: ObjectStore;
  logger: Logger;
  /** The Silo release key. */
  trusted: readonly TrustedKey[];
  target: BuildTarget;
}

export type PullOutcome = 'none' | 'installed' | 'unchanged';

export function createCellFleetAgent(deps: CellAgentDeps) {
  const channel = agentChannelFor(deps.target);
  /** The head sequence last installed: a head seen already is not fetched again. */
  let installedSequence = 0;

  /** Copies a binary from fleet-control into the cell, unless it is there; the bytes are hashed as they come. */
  async function copy(hex: string, correlationId: string): Promise<void> {
    const key = objectKey.agentBinary(hex);
    if (await deps.objects.head('files', key) !== undefined) return;
    const upload = await deps.objects.openUpload('files', key, 'application/octet-stream');
    const hash = createHash('sha256');
    try {
      let offset = 0;
      let total = 1;
      while (offset < total) {
        const part = await deps.services.call(readAgentBinary, { params: { sha256: hex }, query: { offset } }, { correlationId, timeoutMs: 60_000 });
        const data = Buffer.from(part.data, 'base64');
        if (part.offset !== offset || data.length === 0) throw new AppError('integrity', 'fleet-control sent a part out of place', { code: 'fleet.agent_binary_part' });
        total = part.bytes;
        hash.update(data);
        await upload.write(data);
        offset += data.length;
      }
      if (offset !== total || hash.digest('hex') !== hex) {
        throw new AppError('integrity', 'an agent binary from fleet-control does not match its digest', { code: 'fleet.agent_binary_mismatch' });
      }
      await upload.finish();
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
  }

  return {
    channel,

    /** One pull of the agent channel: what came of it. */
    async pull(correlationId: string): Promise<PullOutcome> {
      const { head } = await deps.services.call(readChannel, { params: { channel } }, { correlationId });
      if (head === null) return 'none';
      if (head.document.sequence <= installedSequence) return 'unchanged';
      const release = await deps.services.call(readRelease, { params: { releaseId: head.document.releaseId } }, { correlationId });
      const signed = {
        head: { text: canonicalJson(head.document), signatures: head.signatures },
        release: { text: canonicalJson(release.manifest), signatures: release.signatures },
      };
      // Nothing is copied for a release the cell would refuse.
      const checked = checkAgentRelease(signed, deps.trusted, { channel, target: deps.target });
      for (const binary of checked.manifest.agentBinaries) await copy(binary.digest.slice('sha256:'.length), correlationId);
      let installed: boolean;
      try {
        ({ installed } = await deps.services.call(installAgentRelease, { body: signed }, { correlationId, timeoutMs: 120_000 }));
      } catch (error) {
        // A copy damaged in storage is taken again at the next pull.
        if (isAppError(error) && error.code === 'agent.binary_mismatch') {
          for (const binary of checked.manifest.agentBinaries) {
            await deps.objects.delete('files', objectKey.agentBinary(binary.digest.slice('sha256:'.length))).catch(() => undefined);
          }
        }
        throw error;
      }
      installedSequence = head.document.sequence;
      deps.logger.info('agent release carried into the cell', {
        event: 'fleet.agent_release_installed', resourceType: 'release', outcome: installed ? 'installed' : 'unchanged', count: checked.manifest.agentBinaries.length,
      });
      return installed ? 'installed' : 'unchanged';
    },
  };
}

export type CellFleetAgent = ReturnType<typeof createCellFleetAgent>;
