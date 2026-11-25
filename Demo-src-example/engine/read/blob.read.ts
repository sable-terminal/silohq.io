import { bounds } from '../../utils/error.util';

/**
 * Large binaries as handles, not strings (MANIFEST-V2 §9.8).
 *
 * A downloaded CSV, an attachment, a PDF: the transport hands back bytes, the
 * runner files them here, and what an expression sees is a small handle —
 * `{ blob, contentType, bytes }` — that a later step passes to `source`. Nothing
 * large passes through the evaluator, and nothing binary is ever decoded as
 * text by accident.
 *
 * ONE STORE PER READ, EMPTIED WHEN THE READ ENDS. Its total is bounded; the
 * bytes also count against the read's budget when they arrive.
 */

export interface BlobHandle {
  blob: string;
  contentType: string | null;
  bytes: number;
}

const MAX_STORE_BYTES = 64 * 1024 * 1024;

export class BlobStore {
  private readonly blobs = new Map<string, { bytes: Buffer; contentType: string | null }>();
  private total = 0;
  private next = 1;

  put(bytes: Buffer, contentType: string | null): BlobHandle {
    this.total += bytes.length;
    if (this.total > MAX_STORE_BYTES) {
      throw bounds({
        message: 'This read downloaded more files than one question may hold. Narrow it.',
        code: 'bounds.bytes',
        detail: { limit: MAX_STORE_BYTES, observed: this.total },
      });
    }
    const id = `blob:${this.next++}`;
    this.blobs.set(id, { bytes, contentType });
    return { blob: id, contentType, bytes: bytes.length };
  }

  get(value: unknown): { bytes: Buffer; contentType: string | null } | null {
    if (value === null || typeof value !== 'object') return null;
    const id = (value as { blob?: unknown }).blob;
    if (typeof id !== 'string') return null;
    return this.blobs.get(id) ?? null;
  }

  clear(): void {
    this.blobs.clear();
    this.total = 0;
  }
}

/**
 * Replace every Buffer in a parsed value with a handle. Parsers return
 * JSON-shaped values, but a multipart part's body and the `binary` parser's
 * output are bytes.
 */
export function handlesFor(value: unknown, store: BlobStore, contentType: string | null = null, depth = 0): unknown {
  if (Buffer.isBuffer(value)) return store.put(value, contentType);
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((one) => handlesFor(one, store, null, depth + 1));
  const out: Record<string, unknown> = {};
  const own = (value as Record<string, unknown>).contentType;
  for (const [name, one] of Object.entries(value as Record<string, unknown>)) {
    out[name] = handlesFor(one, store, typeof own === 'string' ? own : null, depth + 1);
  }
  return out;
}
