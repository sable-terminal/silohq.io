// change-stream (spec 18; catalogue: change-stream): keeps clones live without copying data.
// Receives providers' webhooks (verified by the credential service before anything is
// decoded), polls with watermarks for what is held live, decodes every source into one
// delta, and publishes deltas on bus-live for the state plane, never anywhere that
// persists. Change epochs it bumps invalidate cached query results (spec 24.6).

import { receiveEmail } from '../../services/change-stream/email.service.ts';
import { createStreamCapture } from '../../services/change-stream/capture.service.ts';
import {
  disableStream, enableStream, getStreamStatus, pauseStream, receiveChangeEmail, receiveChangeWebhook, resumeStream, rotateWebhookSecret, setPollingFallback,
} from '../../contracts/change-stream/stream.contract.ts';
import { openStreamProbe, readStreamProbe } from '../../contracts/change-stream/probe.contract.ts';
import { dropChangeCapture, reportCapture, setChangeCapture } from '../../contracts/change-stream/capture.contract.ts';
import { createCaptureReports } from '../../services/change-stream/cdc.service.ts';
import { createStreamProbes } from '../../services/change-stream/probe.service.ts';
import { streamController } from '../../controllers/change-stream/stream.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import type { ChangeStreamDeps } from '../../services/change-stream/deps.service.ts';
import { createStreamManagement } from '../../services/change-stream/management.service.ts';
import { createSourceCatalogue } from '../../services/change-stream/sources.service.ts';
import { createStreamHealth } from '../../services/change-stream/status.service.ts';
import { sourcesWorker } from '../../workers/change-stream/sources.worker.ts';

export interface ChangeStreamOptions {
  /** How often the round runs (choosing sources, heartbeats, polls); tests shorten it. */
  tickMs?: number;
}

export function createChangeStreamService(options: ChangeStreamOptions = {}): ServiceDefinition {
  return defineService({
    name: 'change-stream',
    needs: { postgres: ['control'], redis: ['state', 'data'], bus: ['live'] },
    create(deps) {
      const streamDeps: ChangeStreamDeps = {
        cellId: deps.config.cell.id, databases: deps.databases, services: deps.services, state: deps.redis.state!, data: deps.redis.data!,
        liveBus: deps.liveBus!, logger: deps.logger,
        ...(deps.config.connect.inboundEmailDomain !== undefined && deps.config.connect.inboundEmailSecret !== undefined
          ? { inboundEmail: { domain: deps.config.connect.inboundEmailDomain, secret: deps.config.connect.inboundEmailSecret } } : {}),
      };
      streamDeps.capture = createStreamCapture(streamDeps);
      const catalogue = createSourceCatalogue(deps.databases);
      const health = createStreamHealth(streamDeps);
      const management = createStreamManagement(streamDeps, catalogue, health);
      const streams = streamController(streamDeps, catalogue, health, management, createStreamProbes(streamDeps, catalogue),
        createCaptureReports(streamDeps, catalogue, health));
      return {
        routes: [
          route(enableStream, streams.enable), route(disableStream, streams.disable), route(pauseStream, streams.pause),
          route(resumeStream, streams.resume), route(rotateWebhookSecret, streams.rotate), route(getStreamStatus, streams.status),
          route(receiveChangeWebhook, streams.receive), route(setPollingFallback, streams.fallback),
          // Email fallback: notifications the cell's mail relay forwards (spec 14.4).
          route(receiveChangeEmail, { handle: ({ body }, ctx) => receiveEmail(streamDeps, catalogue, health, body, ctx.correlationId) }),
          // The change-stream class watches a test record through a probe (decision 2026-11-15).
          route(openStreamProbe, streams.openProbe), route(readStreamProbe, streams.readProbe),
          // Change data capture, read by the Silo Agent (spec 18.1, 10.3).
          route(setChangeCapture, streams.setCapture), route(dropChangeCapture, streams.dropCapture), route(reportCapture, streams.reportCapture),
        ],
        workers: [sourcesWorker(streamDeps, catalogue, health, options.tickMs ?? 5_000)],
      };
    },
  });
}

export const service = createChangeStreamService();
