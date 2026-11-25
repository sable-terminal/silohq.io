/**
 * Addresses a customer-supplied URL may not reach.
 *
 * THE METADATA SERVER IS THE DANGEROUS ONE. `169.254.169.254` on GCP and AWS
 * serves this process's own service account token to anything that asks, so a
 * connector pointed at it exfiltrates the credentials protecting every other
 * tenant. Loopback and the private ranges are here because a connector is a way
 * to ask this server to make a request from inside the VPC.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /^127\./, /^0\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/, /^fc00:/i, /^fe80:/i,
];

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === 'metadata.google.internal' || host.endsWith('.internal')) {
    return true;
  }
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(host));
}
