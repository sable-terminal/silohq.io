import { manifestV2, type ManifestV2 } from '../../schemas/manifest.schema';
import { compileV1 } from './compile.compat';

/**
 * Any stored connector document, as the v2 manifest the engine executes.
 *
 * ONE DOOR FOR EVERY READER — the repository, the inbound intake, the builder's
 * preview — so there is one place that decides what a version 1 document means
 * today. The stored row is never rewritten: a version cited by figures it
 * produced keeps its bytes.
 */

/** The newest document version this process writes and reads. */
export const CURRENT_SCHEMA_VERSION = 2;

export type Loaded = { ok: true; manifest: ManifestV2; notes: string[] } | { ok: false; issues: string[] };

export function loadManifest(document: unknown, schemaVersion: number): Loaded {
  if (schemaVersion === 1) {
    try {
      const { manifest, notes } = compileV1(document);
      return { ok: true, manifest, notes };
    } catch (error) {
      const issues =
        error && typeof error === 'object' && 'issues' in error && Array.isArray((error as { issues: unknown[] }).issues)
          ? (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues.map((i) => `${i.path.join('.')}: ${i.message}`)
          : [error instanceof Error ? error.message : String(error)];
      return { ok: false, issues: issues.slice(0, 5) };
    }
  }
  const parsed = manifestV2.safeParse(document);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) };
  return { ok: true, manifest: parsed.data, notes: [] };
}
