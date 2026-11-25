// A cell's health signals for its Fleet agent's gates (spec 11.2: "error rate, latency against
// SLO targets, refusal rate against the previous release, crash loops, audit outbox backlog").
// Every process in the cell reports, every half minute, what its service listener answered
// since it started (requests, refusals, errors, a latency histogram) under the release it runs,
// and any gauge its services keep (the outbox relay: the backlog's oldest age). The Fleet agent
// keeps the latest of each process in memory and judges a release on the processes running it.

import { z } from 'zod';
import { SERVICES, type ServiceName } from '../../config/service.config.ts';
import { defineContract } from '../endpoint.contract.ts';

/** Upper bounds of the latency buckets, in milliseconds; one more bucket holds the rest. */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

/** The services outside a cell's Fleet agent: the global tier's, and the agent itself. */
const GLOBAL: readonly ServiceName[] = ['directory', 'fleet-control', 'status'];
export const SIGNAL_REPORTERS = SERVICES.filter((s) => !GLOBAL.includes(s));

const count = z.int().min(0);

export const processSignals = z.strictObject({
  services: z.array(z.enum(SERVICES)).min(1).max(SERVICES.length),
  /** The release the process runs (SILO_RELEASE, which the Fleet agent sets with the image). */
  release: z.string().min(1).max(128),
  startedAt: z.iso.datetime({ offset: true }),
  reportedAt: z.iso.datetime({ offset: true }),
  /** Since the process started: answered below 400, refused (4xx), failed (5xx); latency of requests with no extended bound. */
  requests: z.strictObject({
    total: count, refused: count, errors: count,
    latency: z.array(count).length(LATENCY_BUCKETS_MS.length + 1),
  }),
  gauges: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.number().finite()).refine((g) => Object.keys(g).length <= 20, 'at most 20 gauges'),
  /**
   * Since the process started: log lines a value pattern was redacted from, by the organisation
   * the line named (13.1; D209). Counts and pattern kinds only. Absent from processes that have none.
   */
  redactions: z.array(z.strictObject({ organisationId: z.uuid(), count, kinds: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(10) })).max(50).optional(),
});
export type ProcessSignals = z.infer<typeof processSignals>;

export const reportProcessSignals = defineContract({
  service: 'fleet-control', name: 'reportProcessSignals', method: 'PUT', path: '/v1/process-signals/:processId',
  callers: SIGNAL_REPORTERS,
  // The latest report of a process stands; repeating one changes nothing.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ processId: z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/) }),
  body: processSignals,
  response: z.object({ accepted: z.boolean() }),
  // Room for the redaction counts of up to 50 organisations (D209).
  maxBodyBytes: 16_384,
});
