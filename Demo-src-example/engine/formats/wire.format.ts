import { checkNodes, FormatError, type FormatParser } from './contract.format';

/**
 * What a protocol that is not HTTP hands back: JSON, with bytes marked.
 *
 * An IMAP attachment, a Kafka value that is not text, a file inside a listing
 * — a transport that answers in JSON cannot put raw bytes in it, so it writes
 * `{ "$bytes": "<base64>" }` and this turns each back into bytes, which the
 * runner hands to expressions as a blob (MANIFEST-V2 §9.8), typed by a
 * `contentType` beside it. A later step reads one with `source`.
 *
 * NEVER CHOSEN BY A DOCUMENT OR A CONTENT TYPE. The runner uses it for the
 * transports that declare they answer this way, so no system on the internet
 * can make its JSON be read as bytes by labelling it.
 */

export const WIRE_CONTENT_TYPE = 'application/vnd.silo.wire+json';

/** The marker a transport writes around bytes. */
export const bytesOf = (bytes: Buffer | Uint8Array): { $bytes: string } => ({ $bytes: Buffer.from(bytes).toString('base64') });

function revive(value: unknown, depth: number): unknown {
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map((one) => revive(one, depth + 1));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$bytes === 'string' && Object.keys(record).length === 1) return Buffer.from(record.$bytes, 'base64');
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = revive(v, depth + 1);
    return out;
  }
  return value;
}

export const wire: FormatParser = {
  name: 'wire',
  contentTypes: [],
  binary: false,
  parse({ input }) {
    let value: unknown;
    try {
      value = JSON.parse(String(input));
    } catch {
      throw new FormatError('wire', 'The transport answered with something that is not its own format.');
    }
    checkNodes('wire', value);
    return revive(value, 0);
  },
};
