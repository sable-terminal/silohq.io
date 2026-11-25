/**
 * The two merges a manifest's patches mean, exactly (MANIFEST-V2 §3.1).
 *
 * `⊕` on a string map: the right wins per key, and a `null` on the right
 * DELETES the key — which is how a paging patch removes a parameter the first
 * request needed and the second must not send.
 *
 * `⊕deep` on trees: objects merge recursively, arrays replace, `null` deletes,
 * scalars replace. Key order is preserved and new keys are appended, because a
 * strict SOAP service checks element order.
 */

export function mergeMap<T>(left: Record<string, T>, right: Record<string, T | null> | undefined): Record<string, T> {
  const out: Record<string, T> = { ...left };
  for (const [name, value] of Object.entries(right ?? {})) {
    if (value === null) delete out[name];
    else if (value !== undefined) out[name] = value;
  }
  return out;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);

export function mergeDeep(left: unknown, right: unknown): unknown {
  if (right === undefined) return left;
  if (!isPlain(right) || !isPlain(left)) return right;
  const out: Record<string, unknown> = { ...left };
  for (const [name, value] of Object.entries(right)) {
    if (value === null) delete out[name];
    else if (value !== undefined) out[name] = name in out ? mergeDeep(out[name], value) : value;
  }
  return out;
}
