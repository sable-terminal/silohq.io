// change-stream's endpoints: wire to the services and back.

import type {
  disableStream, enableStream, getStreamStatus, pauseStream, receiveChangeWebhook, resumeStream, rotateWebhookSecret, setPollingFallback,
} from '../../contracts/change-stream/stream.contract.ts';
import type { openStreamProbe, readStreamProbe } from '../../contracts/change-stream/probe.contract.ts';
import type { dropChangeCapture, reportCapture, setChangeCapture } from '../../contracts/change-stream/capture.contract.ts';
import type { CaptureReports } from '../../services/change-stream/cdc.service.ts';
import type { StreamProbes } from '../../services/change-stream/probe.service.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { ChangeStreamDeps } from '../../services/change-stream/deps.service.ts';
import { receiveDelivery } from '../../services/change-stream/intake.service.ts';
import type { StreamManagement } from '../../services/change-stream/management.service.ts';
import type { SourceCatalogue } from '../../services/change-stream/sources.service.ts';
import type { StreamHealthStore } from '../../services/change-stream/status.service.ts';

export function streamController(deps: ChangeStreamDeps, catalogue: SourceCatalogue, health: StreamHealthStore, management: StreamManagement,
  probes: StreamProbes, captures: CaptureReports) {
  return {
    setCapture: {
      handle: ({ params, body }, ctx) => management.setCapture(ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof setChangeCapture>,
    dropCapture: { handle: ({ params }, ctx) => management.dropCapture(ctx, params.connectionId) } satisfies RouteHandlers<typeof dropChangeCapture>,
    reportCapture: {
      handle: ({ params, body }, ctx) => captures.report({ organisationId: ctx.request.organisationId! }, ctx.correlationId, params.slotId, body),
    } satisfies RouteHandlers<typeof reportCapture>,
    enable: {
      handle: ({ params, body }, ctx) => management.enable(ctx, params.connectionId, body.secret),
    } satisfies RouteHandlers<typeof enableStream>,
    disable: { handle: ({ params }, ctx) => management.move(ctx, params.connectionId, 'disable') } satisfies RouteHandlers<typeof disableStream>,
    pause: { handle: ({ params }, ctx) => management.move(ctx, params.connectionId, 'pause') } satisfies RouteHandlers<typeof pauseStream>,
    resume: { handle: ({ params }, ctx) => management.move(ctx, params.connectionId, 'resume') } satisfies RouteHandlers<typeof resumeStream>,
    rotate: {
      handle: ({ params, body }, ctx) => management.rotate(ctx, params.connectionId, body.secret),
    } satisfies RouteHandlers<typeof rotateWebhookSecret>,
    status: { handle: ({ params }, ctx) => management.status(ctx, params.connectionId) } satisfies RouteHandlers<typeof getStreamStatus>,
    receive: {
      handle: ({ body }, ctx) => receiveDelivery(deps, catalogue, health, body, ctx.correlationId),
    } satisfies RouteHandlers<typeof receiveChangeWebhook>,
    fallback: {
      handle: ({ params, body }, ctx) => management.setFallback(ctx, params.connectionId, params.object, body),
    } satisfies RouteHandlers<typeof setPollingFallback>,
    openProbe: { handle: ({ params, body }, ctx) => probes.open(ctx, params.connectionId, body.object) } satisfies RouteHandlers<typeof openStreamProbe>,
    readProbe: { handle: ({ params, body }, ctx) => probes.read(ctx, params.probeId, body) } satisfies RouteHandlers<typeof readStreamProbe>,
  };
}
