// Structured logging. One JSON object per line on stdout, collected inside the cell
// (spec 13.1; logs kept 30 days).
//
// "No record value, secret, prompt or model output appears in a log, span, metric label
// or error report" (spec 13.1). This logger takes the allowlist route the spec names as
// its target (open decision 60) rather than today's denylist:
// - Only the fields named in LogFields can be logged, each a SafeString, number or
//   boolean. A RecordValue does not type-check as a SafeString, and an object cannot be
//   passed at all. At run time, an unknown field is dropped.
// - Every string, the message included, is scanned for value patterns
//   (redaction.util.ts). A field that matches is dropped; a message that matches is
//   replaced. Either counts a redaction violation, which pages (spec 13.2).
// - Errors are logged by category, code and class only (describeError), never by
//   message: "Source driver error messages are not logged".

import { trace } from '@opentelemetry/api';
import type { ErrorCategory } from '../utils/errors.util.ts';
import { describeError } from '../utils/errors.util.ts';
import type { SafeString } from '../utils/recordValue.util.ts';
import { findValuePatterns } from '../utils/redaction.util.ts';
import type { LogLevel } from '../config/telemetry.config.ts';

export interface LogFields {
  // Identifiers.
  correlationId?: SafeString;
  requestId?: SafeString;
  organisationId?: SafeString;
  membershipId?: SafeString;
  servicePrincipalId?: SafeString;
  userId?: SafeString;
  sessionId?: SafeString;
  connectionId?: SafeString;
  agentId?: SafeString;
  credentialId?: SafeString;
  keyVersionId?: SafeString;
  resourceType?: SafeString;
  resourceId?: SafeString;
  objectTypeId?: SafeString;
  planId?: SafeString;
  jobId?: SafeString;
  eventId?: SafeString;
  subscriptionId?: SafeString;
  // What happened: closed sets and route templates, never free text.
  event?: SafeString;
  reason?: SafeString;
  outcome?: SafeString;
  route?: SafeString;
  method?: SafeString;
  /** The calling service, from its mTLS identity. */
  caller?: SafeString;
  topic?: SafeString;
  dependency?: SafeString;
  bound?: SafeString;
  /** Source SQL as a template hash, never the SQL (spec 13.1). */
  sqlTemplateHash?: SafeString;
  sqlstate?: SafeString;
  errorCategory?: ErrorCategory;
  errorCode?: SafeString;
  errorClass?: SafeString;
  refusal?: boolean;
  // Counts, sizes and durations.
  status?: number;
  durationMs?: number;
  count?: number;
  rowCount?: number;
  bytes?: number;
  attempt?: number;
  limit?: number;
  queueDepth?: number;
  retryAfterSeconds?: number;
  cacheHit?: boolean;
}

export const LOG_FIELD_NAMES: ReadonlySet<string> = new Set<keyof LogFields>([
  'correlationId', 'requestId', 'organisationId', 'membershipId', 'servicePrincipalId', 'userId', 'sessionId',
  'connectionId', 'agentId', 'credentialId', 'keyVersionId', 'resourceType', 'resourceId', 'objectTypeId', 'planId',
  'jobId', 'eventId', 'subscriptionId', 'event', 'reason', 'outcome', 'route', 'method', 'caller', 'topic', 'dependency', 'bound',
  'sqlTemplateHash', 'sqlstate', 'errorCategory', 'errorCode', 'errorClass', 'refusal', 'status', 'durationMs', 'count',
  'rowCount', 'bytes', 'attempt', 'limit', 'queueDepth', 'retryAfterSeconds', 'cacheHit',
]);

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING = 256;
export const REDACTED_MESSAGE = '[redacted: the message matched a value pattern]';

export interface Logger {
  debug(message: SafeString, fields?: LogFields): void;
  info(message: SafeString, fields?: LogFields): void;
  warn(message: SafeString, fields?: LogFields): void;
  error(message: SafeString, fields?: LogFields): void;
  /** Logs an error by category, code and class; its message is never written. */
  failure(message: SafeString, error: unknown, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  service: string;
  cell: string;
  release: string;
  level: LogLevel;
  write?: (line: string) => void;
  /**
   * Counts a redaction violation; wired to the alerting metric by telemetry, and, where the
   * line named an organisation, to the process's signals so its audit log records it (D209).
   */
  onViolation?: (kinds: string[], organisationId?: string) => void;
}

// Keeps only allowed fields with allowed values. Exported so span attributes pass through
// the same gate (telemetry.infra.ts).
export function sanitiseFields(fields: object, onViolation: (kinds: string[]) => void): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || !LOG_FIELD_NAMES.has(key)) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      const kinds = findValuePatterns(value);
      if (kinds.length > 0) onViolation(kinds);
      else out[key] = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
    }
  }
  return out;
}

export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const write = options.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const violation = options.onViolation ?? (() => undefined);
  const threshold = LEVELS[options.level];

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const emit = (level: LogLevel, message: string, fields: LogFields | undefined): void => {
    if (LEVELS[level] < threshold) return;
    // The organisation the line was about, by identifier only, for the record of a violation.
    const named = (fields?.organisationId ?? bound.organisationId) as unknown;
    const organisationId = typeof named === 'string' && UUID.test(named) ? named : undefined;
    const noted = (kinds: string[]) => violation(kinds, organisationId);
    let text = message;
    const kinds = findValuePatterns(message);
    if (kinds.length > 0) {
      noted(kinds);
      text = REDACTED_MESSAGE;
    }
    const span = trace.getActiveSpan()?.spanContext();
    write(JSON.stringify({
      time: new Date().toISOString(),
      level,
      message: text,
      service: options.service,
      cell: options.cell,
      release: options.release,
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
      ...sanitiseFields({ ...bound, ...fields }, noted),
    }));
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    failure: (message, error, fields) => {
      const described = describeError(error);
      emit(described.refusal ? 'info' : 'error', message, { ...fields, ...described });
    },
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}
