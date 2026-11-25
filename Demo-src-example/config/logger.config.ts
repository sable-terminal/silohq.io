import pino, { type Logger } from 'pino';
import { isProd, isTest } from './env.config';
import { scrubError } from '../utils/redact.util';

/**
 * Logging, with a deny-list.
 *
 * THIS PROCESS HANDLES ALMOST NOTHING BUT PERSONAL DATA. Every write it accepts
 * is somebody's email address and, on the contact form, a message they typed.
 * There is no "mostly harmless" traffic here to dilute it, so redaction is
 * configured once at the logger rather than remembered at call sites. A rule
 * that depends on every future author remembering it is not a rule.
 */

const REDACTED = [
  'email', 'name', 'company', 'note', 'message', 'subject', 'body',
  '*.email', '*.name', '*.company', '*.note', '*.message', '*.body',
  'token', 'secret', 'turnstileToken',
  '*.token', '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isTest ? 'silent' : isProd ? 'info' : 'debug'),
  redact: { paths: REDACTED, censor: '[redacted]' },
  base: { service: 'silo-app' },
  /**
   * Errors go through `redact.util` on the way out. The deny-list above works on
   * KNOWN PATHS in a structured object; an error message is free text a driver
   * may have built by concatenation, and no path list can see inside it.
   */
  serializers: {
    err: (error: unknown) => scrubError(error),
    error: (error: unknown) => scrubError(error),
  },
  ...(isProd
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

/** A logger tagged with the component, so a line says where it came from. */
export function childLogger(component: string): Logger {
  return logger.child({ component });
}
