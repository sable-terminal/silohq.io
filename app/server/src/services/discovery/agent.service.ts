// The Silo Agent's side of a scan, as discovery sees it (spec 10.5, 19.3). discovery signs the
// scan; connect-runtime, which holds the agent's tunnel, gives it to the agent and passes back
// what the agent reports (reportScanEvents). The agent runs the probes, enforces read-only
// access and the rate limits (50 hosts a second, 2 connections per host) itself; discovery
// holds every event it reports to the authorisation (runs.service).

import { startDiscoveryScan } from '../../contracts/connect-runtime/discoveryScan.contract.ts';
import type { SignedDiscoveryScan } from '../../contracts/discovery/scan.contract.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Context } from './deps.service.ts';

export interface StartScan {
  agentId: string;
  runId: string;
  scan: SignedDiscoveryScan;
  /** When the agent stops whatever it has not finished. */
  deadline: string;
}

export interface DiscoveryAgentChannel {
  /** Gives the scan to the agent now, or refuses (the agent not connected, or it refused the scan). */
  start(ctx: Context, scan: StartScan): Promise<void>;
}

/** The channel through connect-runtime's agent tunnels. */
export const connectRuntimeChannel = (services: ServiceClient): DiscoveryAgentChannel => ({
  async start(ctx, scan) {
    await services.call(startDiscoveryScan, {
      params: { agentId: scan.agentId }, body: { runId: scan.runId, scan: scan.scan, deadline: scan.deadline, relayed: false },
    }, { request: ctx.request, correlationId: ctx.correlationId });
  },
});
