// Logs, traces and metrics (spec 13.1). OpenTelemetry to the collector inside the cell;
// telemetry is stored in the cell, and none leaves a sovereign cell.

import { z } from 'zod';
import { parseSection, read, type Env } from './env.config.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const schema = z.object({
  logLevel: z.enum(LOG_LEVELS).default('info'),
  otlpEndpoint: z.url().optional(),
  traceSampleRatio: z.coerce.number().min(0).max(1).default(0.1),
});

export type TelemetryConfig = z.output<typeof schema>;

export function loadTelemetryConfig(env: Env, problems: string[]): TelemetryConfig | undefined {
  return parseSection(schema, {
    logLevel: read(env, 'LOG_LEVEL'),
    otlpEndpoint: read(env, 'OTEL_EXPORTER_OTLP_ENDPOINT'),
    traceSampleRatio: read(env, 'OTEL_TRACES_SAMPLER_RATIO'),
  }, {
    logLevel: 'LOG_LEVEL', otlpEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT', traceSampleRatio: 'OTEL_TRACES_SAMPLER_RATIO',
  }, problems);
}

// Whether a collector endpoint is inside the cell: a cluster-local name, localhost or a
// private address. A sovereign cell refuses anything else.
export function isInCellEndpoint(endpoint: string): boolean {
  const host = new URL(endpoint).hostname;
  return host === 'localhost' || host.endsWith('.svc') || host.endsWith('.svc.cluster.local') || host.endsWith('.internal')
    || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}
