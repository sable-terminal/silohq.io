// Connection parameters (spec 14.3 params): the values a manifest declares that are public
// and never secret, such as a tenant subdomain, a region or a database name. They live on
// the connection row (connect.connections.parameters), set by connect-registry when the
// connection is created or changed, and read as data by the runtime and by the credential
// service when it builds a request URL. Secrets are sealed by the credential service and
// never travel this way.

import { z } from 'zod';
import { AppError } from '../../utils/errors.util.ts';

/** A parameter value: one line, bounded, no control characters. */
export const PARAMETER_VALUE_MAX = 256;
export const parameterValue = z.string().min(1).max(PARAMETER_VALUE_MAX)
  .regex(/^[^\p{Cc}]*$/u, 'no control characters');

export const parameterName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

/** At most one value per declared parameter; the manifest allows at most 20. */
export const connectionParameters = z.record(parameterName, parameterValue)
  .refine((p) => Object.keys(p).length <= 20, 'at most 20 parameters');
export type ConnectionParameters = z.infer<typeof connectionParameters>;

/** The stored column as parameters. A row that does not parse is a fault, never an empty set. */
export function parametersOf(stored: unknown): ConnectionParameters {
  const parsed = connectionParameters.safeParse(stored ?? {});
  if (!parsed.success) {
    throw new AppError('integrity', 'the connection\'s stored parameters do not parse', { code: 'connection.parameters_corrupt' });
  }
  return parsed.data;
}
