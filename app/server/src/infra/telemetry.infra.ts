// OpenTelemetry traces and metrics (spec 13.1), exported to the collector inside the
// cell. With no collector configured the API's no-op implementation is used, so code can
// always create spans and counters.
//
// No automatic instrumentation is installed: an instrumented driver would record SQL
// text, HTTP bodies or message payloads. Spans and metrics are created explicitly, and
// their attributes pass the same allowlist as log fields (sanitiseFields). Trace context
// is propagated over HTTP, WebSocket and both buses by the code that crosses them
// (bus.infra.ts carries it in message headers).

import { context, metrics, propagation, trace, type Attributes, type Span } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { Config } from '../config/index.config.ts';
import { describeError } from '../utils/errors.util.ts';
import { sanitiseFields, type LogFields } from './logger.infra.ts';

export interface Telemetry {
  shutdown(): Promise<void>;
}

export async function startTelemetry(config: Config): Promise<Telemetry> {
  const endpoint = config.telemetry.otlpEndpoint;
  if (endpoint === undefined) return { shutdown: async () => undefined };
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.service,
      [ATTR_SERVICE_VERSION]: config.release,
      'silo.cell': config.cell.id,
    }),
    traceExporter: new OTLPTraceExporter({ url: new URL('/v1/traces', endpoint).toString() }),
    metricReaders: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: new URL('/v1/metrics', endpoint).toString() }),
    })],
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.telemetry.traceSampleRatio) }),
    instrumentations: [],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

const meter = () => metrics.getMeter('silo');

// Outcomes, counted three ways because "a refusal is not an error" (spec 12.1) and the
// rollout gates compare refusal and error rates separately (spec 11.2).
export function recordOutcome(operation: string, error?: unknown): void {
  const described = error === undefined ? undefined : describeError(error);
  const outcome = described === undefined ? 'ok' : described.refusal ? 'refusal' : 'error';
  meter().createCounter('silo.operations').add(1, {
    operation, outcome, ...(described ? { category: described.errorCategory } : {}),
  });
}

// "A value found anywhere outside the table above is a SEV1" (spec 8.5); pages (spec 13.2).
export function recordRedactionViolation(kinds: string[]): void {
  const counter = meter().createCounter('silo.redaction_violations');
  for (const kind of kinds) counter.add(1, { kind });
}

// Span attributes through the log-field allowlist.
export function safeAttributes(fields: LogFields): Attributes {
  return sanitiseFields(fields, recordRedactionViolation);
}

export async function inSpan<T>(name: string, fields: LogFields, work: (span: Span) => Promise<T>): Promise<T> {
  return trace.getTracer('silo').startActiveSpan(name, { attributes: safeAttributes(fields) }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      const described = describeError(error);
      span.setAttributes({ 'error.category': described.errorCategory, 'error.refusal': described.refusal });
      if (!described.refusal) span.setStatus({ code: 2 });
      throw error;
    } finally {
      span.end();
    }
  });
}

// Trace context to and from message headers (W3C traceparent), for the buses.
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function withExtractedTraceContext<T>(carrier: Record<string, string>, work: () => T): T {
  return context.with(propagation.extract(context.active(), carrier), work);
}
