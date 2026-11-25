/**
 * Whether a value looks like a secret.
 *
 * FOR THE ONE PLACE A SECRET MUST NOT GO: a connection parameter. Parameters
 * are bound into every expression, shown in the builder and named in the audit
 * trail — that is what makes them useful — so a key typed into one is a key in
 * the clear. The manifest refuses a parameter whose label asks for a secret
 * (MANIFEST-V2 §9.1, finding F27); this refuses a VALUE that looks like one,
 * whatever the label said.
 *
 * SHAPES, NOT PROVIDERS. A PEM private key, a JWT, a long run of high-entropy
 * characters, or a token carrying a secret-looking prefix. A host name, a
 * tenant id, a region or a CA certificate passes: a certificate is public by
 * design, a private key is not.
 */

const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const JWT = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
/** Prefixes token issuers use to mark a string as a secret: sk_, pk_live, xox?-, ghp_, glpat- … */
const SECRET_PREFIX = /^(?:sk|rk|pk)_(?:live|test)_|^sk-[A-Za-z0-9]|^xox[abprs]-|^gh[pousr]_|^glpat-|^AKIA[0-9A-Z]{16}$|^ASIA[0-9A-Z]{16}$/;

/** Shannon entropy in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function looksSecret(value: string): string | null {
  const text = value.trim();
  if (PRIVATE_KEY.test(text)) return 'a private key';
  if (JWT.test(text)) return 'a signed token';
  if (SECRET_PREFIX.test(text)) return 'an API key';
  /* A URL, a host, a path or a certificate carries its own punctuation; a key is one unbroken run. */
  const run = /^[A-Za-z0-9_+/=-]{32,}$/.test(text);
  if (run && entropy(text) >= 4.2 && /[0-9]/.test(text) && /[A-Za-z]/.test(text)) return 'a key';
  return null;
}
