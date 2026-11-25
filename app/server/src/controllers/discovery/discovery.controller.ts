// discovery's endpoints: parsed input to the discovery services and back.

import type {
  getDiscoverySettings, getFinding, getScanAuthorisation, getScanRun, listFindings, listScanAuthorisations, listScanRuns, requestScanAuthorisation,
  reviewFinding, revokeScanAuthorisation, setDiscoveryEnabled, startScan,
} from '../../contracts/discovery/discovery.contract.ts';
import type { reportScanEvents } from '../../contracts/discovery/scan.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Authorisations } from '../../services/discovery/authorisations.service.ts';
import type { Findings } from '../../services/discovery/findings.service.ts';
import type { Runs } from '../../services/discovery/runs.service.ts';
import type { Settings } from '../../services/discovery/settings.service.ts';

export function discoveryController(s: { settings: Settings; authorisations: Authorisations; runs: Runs; findings: Findings }) {
  return {
    getDiscoverySettings: { handle: (_input, ctx) => s.settings.get(ctx) } satisfies RouteHandlers<typeof getDiscoverySettings>,
    setDiscoveryEnabled: { handle: ({ body }, ctx) => s.settings.set(ctx, body.enabled) } satisfies RouteHandlers<typeof setDiscoveryEnabled>,
    requestScanAuthorisation: {
      handle: ({ body }, ctx) => s.authorisations.request(ctx, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => s.authorisations.get(ctx, ref!),
    } satisfies RouteHandlers<typeof requestScanAuthorisation>,
    listScanAuthorisations: {
      handle: async ({ query }, ctx) => ({ authorisations: await s.authorisations.list(ctx, query.limit) }),
    } satisfies RouteHandlers<typeof listScanAuthorisations>,
    getScanAuthorisation: { handle: ({ params }, ctx) => s.authorisations.get(ctx, params.authorisationId) } satisfies RouteHandlers<typeof getScanAuthorisation>,
    revokeScanAuthorisation: {
      handle: ({ params }, ctx) => s.authorisations.revoke(ctx, params.authorisationId),
    } satisfies RouteHandlers<typeof revokeScanAuthorisation>,
    startScan: {
      handle: ({ params }, ctx) => s.runs.start(ctx, params.authorisationId),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => s.runs.get(ctx, ref!),
    } satisfies RouteHandlers<typeof startScan>,
    getScanRun: { handle: ({ params }, ctx) => s.runs.get(ctx, params.runId) } satisfies RouteHandlers<typeof getScanRun>,
    listScanRuns: { handle: async ({ params, query }, ctx) => ({ runs: await s.runs.list(ctx, params.authorisationId, query.limit) }) } satisfies RouteHandlers<typeof listScanRuns>,
    reportScanEvents: { handle: ({ params, body }, ctx) => s.runs.report(ctx, params.runId, body) } satisfies RouteHandlers<typeof reportScanEvents>,
    listFindings: { handle: async ({ query }, ctx) => ({ findings: await s.findings.list(ctx, query) }) } satisfies RouteHandlers<typeof listFindings>,
    getFinding: { handle: ({ params }, ctx) => s.findings.get(ctx, params.findingId) } satisfies RouteHandlers<typeof getFinding>,
    reviewFinding: {
      handle: ({ params, body }, ctx) => s.findings.review(ctx, params.findingId, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => s.findings.get(ctx, ref!),
    } satisfies RouteHandlers<typeof reviewFinding>,
  };
}
