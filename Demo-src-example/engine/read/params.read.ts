import type { ManifestV2 } from '../../schemas/manifest.schema';
import type { Credential } from '../auth/credential.auth';

/** Declared defaults, then the connection's own values, then non-secret credential fields the manifest exposes. */
export function paramsFor(manifest: ManifestV2, connection: Record<string, string>, credential: Credential | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(manifest.parameters ?? {})) if (p.default !== undefined) out[name] = p.default;
  Object.assign(out, connection);
  for (const [name, field] of Object.entries(manifest.credentials ?? {})) {
    if (field.exposeAsParam && !field.secret) {
      const value = credential?.fields[name] ?? field.fixed;
      if (value !== undefined) out[name] = value;
    }
  }
  return out;
}

