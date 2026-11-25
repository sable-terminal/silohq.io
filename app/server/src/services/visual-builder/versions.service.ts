// Saving drafts and moving the sandbox connection, for both build routes (spec 16.3, 16.4).
//
// A version never changes once read (spec 14.3), so every draft that is probed is a new
// version of the private connector: <release>-draft.<n>, n one more than the last draft of
// that release. The release itself is saved once the person publishes. The sandbox
// connection is created in draft by the first try and follows each new version after;
// connect-registry decides who may (connector.build, connector.edit, connection.create,
// the owner or connection.manage).
//
// Each keyed call to the registry carries a key derived from the caller's own, so a retry
// of the same request saves nothing new.

import { changeConnectionStatus, createConnection, getConnection, type ConnectionView } from '../../contracts/connect-registry/connection.contract.ts';
import { createManifestVersion, listManifestVersions } from '../../contracts/connect-registry/connector.contract.ts';
import { setDraftConnectionVersion } from '../../contracts/connect-registry/draft.contract.ts';
import type { Manifest } from '../../contracts/connect/manifest.contract.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { sha256 } from '../../utils/crypto.util.ts';

export interface Call {
  request: RequestContext;
  correlationId: string;
}

/** A key derived from the caller's, within the 200 characters an idempotency key may have. */
export function derivedKey(key: string, suffix: string): string {
  const joined = `${key}.${suffix}`;
  return joined.length <= 200 ? joined : sha256(Buffer.from(joined)).toString('hex');
}

/** The release a version belongs to: its major.minor.patch. */
export const releaseOf = (version: string): string => /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? '0.1.0';
export const isRelease = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface SavedVersion { id: string; version: string }

/** Saves the manifest as the next draft of its release, or as the release itself. */
export async function saveVersion(services: ServiceClient, call: Call, connectorId: string, manifest: Manifest, key: string,
  kind: 'draft' | 'release'): Promise<SavedVersion> {
  const base = releaseOf(manifest.identity.version);
  let label = base;
  if (kind === 'draft') {
    const { versions } = await services.call(listManifestVersions, { params: { connectorId } }, call);
    const pattern = new RegExp(`^${escape(base)}-draft\\.(\\d+)$`);
    const last = versions.reduce((n, v) => Math.max(n, Number(pattern.exec(v.version)?.[1] ?? 0)), 0);
    label = `${base}-draft.${last + 1}`;
  }
  const document = JSON.parse(JSON.stringify({ ...manifest, identity: { ...manifest.identity, version: label } })) as Record<string, never>;
  const view = await services.call(createManifestVersion, { params: { connectorId }, body: { document } },
    { ...call, idempotencyKey: derivedKey(key, label) });
  return { id: view.id, version: view.version };
}

export interface SandboxSpec {
  name: string;
  owningScopeId: string;
  parameters?: Record<string, string> | undefined;
  agentPoolId?: string | undefined;
}

/** The sandbox connection on a version: created in draft the first time, moved after. */
export async function sandboxOn(services: ServiceClient, call: Call, connectorId: string, manifestId: string, key: string,
  existing: { connectionId: string } | { create: SandboxSpec }): Promise<ConnectionView> {
  if ('create' in existing) {
    const spec = existing.create;
    return services.call(createConnection, {
      body: {
        connectorId, manifestId, name: spec.name, owningScopeId: spec.owningScopeId,
        ...(spec.parameters === undefined ? {} : { parameters: spec.parameters }),
        ...(spec.agentPoolId === undefined ? {} : { agentPoolId: spec.agentPoolId }),
      },
    }, { ...call, idempotencyKey: derivedKey(key, 'sandbox') });
  }
  const connection = await services.call(getConnection, { params: { connectionId: existing.connectionId } }, call);
  return services.call(setDraftConnectionVersion, {
    params: { connectionId: connection.id }, body: { manifestId, version: connection.version },
  }, call);
}

/** Moves a draft sandbox to probing, which confirmation starts from (spec 14.7). */
export async function toProbing(services: ServiceClient, call: Call, connection: ConnectionView): Promise<ConnectionView> {
  if (connection.status !== 'draft') return connection;
  return services.call(changeConnectionStatus, {
    params: { connectionId: connection.id }, body: { move: 'probe', version: connection.version },
  }, call);
}
