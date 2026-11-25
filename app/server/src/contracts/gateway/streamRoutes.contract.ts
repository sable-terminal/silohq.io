// Change streams in the product (spec 18.8, 18.10): enabling a connection's stream
// (stream.enable), and pausing, resuming, disabling, rotating the webhook secret and reading
// its health (stream.manage). The gateway asks the permission on the connection; change-
// stream then applies its own rule, the connection's owner or the permission at its owning
// scope. An owner who holds neither permission waits, like Connect's owner routes, for
// owner-aware decisions in the policy service. A provider's deliveries arrive at
// /api/v1/hooks/changes/:organisationId/:token (controllers/gateway/changeHooks).

import {
  disableStream as disable, enableStream as enable, getStreamStatus as status, pauseStream as pause, resumeStream as resume,
  rotateWebhookSecret as rotate, setPollingFallback as fallback,
} from '../change-stream/stream.contract.ts';
import { dropChangeCapture as dropCapture, setChangeCapture as setCapture } from '../change-stream/capture.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const onConnection = (permission: 'stream.enable' | 'stream.manage') => ({
  permission,
  resource: (input: { params: { connectionId: string } }) => ({ type: 'connection' as const, id: input.params.connectionId }),
});

export const enableStream = definePublicRoute({
  name: 'enableStream', method: 'POST', path: '/connect/connections/:connectionId/stream', session: 'complete',
  permission: onConnection('stream.enable'),
  params: enable.params, body: enable.body, response: enable.response, status: 201,
  forwards: enable,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

export const readStream = definePublicRoute({
  name: 'readStream', method: 'GET', path: '/connect/connections/:connectionId/stream', session: 'complete',
  permission: onConnection('stream.manage'),
  params: status.params, response: status.response,
  forwards: status,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

const moveRoute = (name: 'disableStream' | 'pauseStream' | 'resumeStream', path: 'disable' | 'pause' | 'resume',
  contract: typeof disable | typeof pause | typeof resume) => definePublicRoute({
  name, method: 'POST', path: `/connect/connections/:connectionId/stream/${path}`, session: 'complete',
  permission: onConnection('stream.manage'),
  params: contract.params, response: contract.response,
  forwards: contract,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const disableStream = moveRoute('disableStream', 'disable', disable);
export const pauseStream = moveRoute('pauseStream', 'pause', pause);
export const resumeStream = moveRoute('resumeStream', 'resume', resume);

export const rotateWebhookSecret = definePublicRoute({
  name: 'rotateWebhookSecret', method: 'POST', path: '/connect/connections/:connectionId/stream/secret-rotations', session: 'complete',
  permission: onConnection('stream.manage'),
  params: rotate.params, body: rotate.body, response: rotate.response, status: 201,
  forwards: rotate,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

/** Polling a stream that is not subscribable, every N minutes, shown as not live (decision 2026-11-15). */
export const setPollingFallback = definePublicRoute({
  name: 'setPollingFallback', method: 'PUT', path: '/connect/connections/:connectionId/stream/objects/:object/polling-fallback', session: 'complete',
  permission: onConnection('stream.manage'),
  params: fallback.params, body: fallback.body, response: fallback.response,
  forwards: fallback,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

/**
 * Change data capture (spec 18.1): the owner confirms the slot Silo makes on their database,
 * with its name shown; dropping it has an agent of the pool drop the slot.
 */
export const setChangeCapture = definePublicRoute({
  name: 'setChangeCapture', method: 'POST', path: '/connect/connections/:connectionId/stream/capture', session: 'complete',
  permission: onConnection('stream.enable'),
  params: setCapture.params, body: setCapture.body, response: setCapture.response, status: 201,
  forwards: setCapture,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

export const dropChangeCapture = definePublicRoute({
  name: 'dropChangeCapture', method: 'POST', path: '/connect/connections/:connectionId/stream/capture/drop', session: 'complete',
  permission: onConnection('stream.manage'),
  params: dropCapture.params, response: dropCapture.response,
  forwards: dropCapture,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const STREAM_ROUTES = [
  enableStream, readStream, disableStream, pauseStream, resumeStream, rotateWebhookSecret, setPollingFallback, setChangeCapture, dropChangeCapture,
] as const;
