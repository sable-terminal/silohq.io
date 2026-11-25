/**
 * Scrubbing an error before it reaches a log.
 *
 * A DENY-LIST ON PATHS CANNOT SEE INSIDE A MESSAGE. Postgres builds "duplicate
 * key value violates unique constraint ... (email)=(someone@example.com)" by
 * concatenation, so the address is in free text where no path list reaches it.
 * This site's forms are almost entirely addresses and prose somebody typed, so
 * that case is the common one here rather than the exotic one.
 *
 * The stack is kept: file names and line numbers are what make an error
 * diagnosable, and they carry nobody's data.
 */

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export function scrubMessage(message: string): string {
  return message.replace(EMAIL, '[email]');
}

export function scrubError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return typeof error === 'string' ? scrubMessage(error) : error;
  }
  return {
    type: error.name,
    message: scrubMessage(error.message),
    stack: error.stack,
    ...('code' in error ? { code: (error as { code?: unknown }).code } : {}),
  };
}

/** Keys whose value is never safe to log, whatever it looks like. */
const SECRET_KEYS =
  /^(password|newPassword|currentPassword|token|secret|code|authorization|cookie|apiKey|refreshToken|tokenHash|passwordHash)$/i;

/**
 * Scrub a structure on its way to a log.
 *
 * BOTH HALVES ARE NEEDED. The key list catches the values that look ordinary —
 * a TOTP code is six digits and a session token is indistinguishable from an id.
 * `scrubMessage` catches the ones that look like nothing in particular but
 * contain an address, which is most free text a user types here.
 *
 * DEPTH-BOUNDED, because `detail` is populated by whatever threw and a cyclic or
 * pathologically nested object would otherwise turn a log write into a hang.
 */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubMessage(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return scrubError(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactObject(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redactObject(item, depth + 1);
  }
  return out;
}
