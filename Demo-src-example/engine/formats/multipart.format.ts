import { FormatError, type FormatParser } from './contract.format';

/**
 * A multipart response — MTOM/XOP from a SOAP service, `multipart/mixed` from a
 * batch API — split into its parts (finding F3).
 *
 * EACH PART'S BODY IS BYTES, which the runner turns into a blob handle, so an
 * attachment reaches a later step's `source` and a parser of its own without
 * ever being text. The root part is also offered decoded, because it is almost
 * always the XML or JSON document the rest refer to by `cid`.
 */

function boundaryOf(contentType: string | null): string {
  const match = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '');
  if (!match) throw new FormatError('multipart', 'The response is multipart but names no boundary.');
  return match[1]!;
}

function headersOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

export const multipart: FormatParser = {
  name: 'multipart',
  contentTypes: ['multipart/related', 'multipart/mixed', 'multipart/form-data'],
  binary: true,
  parse({ input, contentType }) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
    const delimiter = Buffer.from(`--${boundaryOf(contentType)}`);
    const parts: Array<{ cid: string | null; contentType: string | null; headers: Record<string, string>; body: Buffer }> = [];

    let at = bytes.indexOf(delimiter);
    while (at !== -1) {
      const start = at + delimiter.length;
      if (bytes.subarray(start, start + 2).toString() === '--') break;
      const next = bytes.indexOf(delimiter, start);
      if (next === -1) break;
      const chunk = bytes.subarray(start, next);
      const split = chunk.indexOf('\r\n\r\n') !== -1 ? chunk.indexOf('\r\n\r\n') : chunk.indexOf('\n\n');
      if (split !== -1) {
        const headerText = chunk.subarray(0, split).toString('latin1');
        const gap = chunk[split] === 0x0d ? 4 : 2;
        let body = chunk.subarray(split + gap);
        if (body.subarray(-2).toString() === '\r\n') body = body.subarray(0, -2);
        else if (body.subarray(-1).toString() === '\n') body = body.subarray(0, -1);
        const headers = headersOf(headerText);
        parts.push({
          cid: headers['content-id']?.replace(/^<|>$/g, '') ?? null,
          contentType: headers['content-type'] ?? null,
          headers,
          body,
        });
      }
      at = next;
    }

    if (parts.length === 0) throw new FormatError('multipart', 'The multipart response has no parts.');
    return { root: parts[0]!.body.toString('utf8'), parts };
  },
};
