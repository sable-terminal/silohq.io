import type { AuthStrategyV2 } from '../../schemas/connectorAuth.schema';
import type { ManifestV2, ObjectV2, TransportV2 } from '../../schemas/manifest.schema';
import { refusal } from '../../utils/error.util';
import type { AuthDeps } from '../auth/apply.auth';
import type { Credential } from '../auth/credential.auth';
import { deep, text } from '../expression/evaluate.expression';
import type { ResolvedTls, Route, SendOptions, Transport, WireRequest, WireResponse } from '../transports/contract.transport';
import type { BlobStore } from './blob.read';
import type { ReadBudget } from './budget.read';

/**
 * Everything one read of one connection needs, built once by the service that
 * opened the connection and handed down unchanged.
 *
 * THE ENGINE REACHES NOTHING OF ITS OWN. The credential store, the OAuth
 * service, the token cache, the agent relay and the clock are all handed in —
 * which is what lets the conformance suite run every connector against recorded
 * APIs with no database, and what keeps the credential's single unwrap in the
 * service that is audited for it.
 */
export interface ReadContext {
  manifest: ManifestV2;
  object: ObjectV2;
  /** Connection parameters, declared defaults and non-secret credential fields exposed as params. */
  params: Record<string, string>;
  credential: Credential | null;
  /** Which of the manifest's alternatives this connection was set up with. */
  strategy: AuthStrategyV2 | null;
  route: Route;
  connectionId: string | null;
  /** Connection id and manifest version: what a cached token belongs to. */
  cacheKey: string;
  auth: AuthDeps & { invalidate(keyPrefix: string): Promise<void> };
  budget: ReadBudget;
  blobs: BlobStore;
  /**
   * How a prepared request reaches the source. Direct, or through the
   * customer's agent; the runner does not know which.
   */
  dispatch(transport: Transport, wire: WireRequest, options: SendOptions, route: Route): Promise<WireResponse>;
  /**
   * For a source Silo holds itself — inbound events, a Silo import — the rows,
   * read by the service that holds them. Absent for every other connection.
   */
  local?: (wire: WireRequest) => Promise<unknown[]>;
  /**
   * Whether a statement the document carries was the one its admin confirmed
   * (MANIFEST-V2 F20). Absent where nothing is pinned yet.
   */
  statementConfirmed?: (text: string) => boolean;
  /**
   * The builder's test panel sees each page's records before they are mapped
   * to fields, so it can say which source keys arrived and which declared
   * fields none of them fill. Never set for a question.
   */
  observe?: (records: unknown[]) => void;
}

/** Send directly. The agent relay supplies its own `dispatch`. */
export const directDispatch: ReadContext['dispatch'] = (transport, wire, options, route) => {
  if (route.via === 'agent') {
    throw refusal({
      message: 'This connection is reached through the Silo agent, and no agent relay is available to this read.',
      code: 'upstream.agent_offline',
    });
  }
  return transport.send(wire, options);
};

/**
 * TLS as the socket needs it: the manifest's `tls` with its expressions worked
 * out over `params`. Auth adds the client certificate afterwards.
 */
export async function resolveTls(transport: TransportV2, params: Record<string, string>): Promise<ResolvedTls> {
  const declared = 'tls' in transport ? transport.tls : undefined;
  if (!declared) return { minVersion: 'TLSv1.2' };
  const scope = { params };
  const ca = await text(declared.ca, scope);
  const servername = await text(declared.serverName, scope);
  return {
    minVersion: declared.minVersion === '1.3' ? 'TLSv1.3' : 'TLSv1.2',
    ...(ca ? { ca } : {}),
    ...(servername ? { servername } : {}),
    ...(declared.serverCertificateFingerprint ? { fingerprint: declared.serverCertificateFingerprint } : {}),
    ...(declared.trustStore === 'agent' ? { systemTrust: true } : {}),
  };
}

/** The address a transport's requests are relative to, or null for one that has none. */
export async function baseAddress(transport: TransportV2, params: Record<string, string>): Promise<URL | null> {
  const source =
    transport.kind === 'https_rest' ? transport.baseUrl : transport.kind === 'graphql' || transport.kind === 'soap' ? transport.endpoint : null;
  if (source === null) return null;
  const worked = await text(source, { params });
  try {
    return new URL(worked ?? '');
  } catch {
    throw refusal({
      message: `This connection's address came to ${worked ? `"${worked.slice(0, 200)}"` : 'nothing'}, which is not an address. Check its settings.`,
      code: 'refusal.request_unbuildable',
    });
  }
}

/**
 * The origins a credential may be sent to.
 *
 * WHAT THE MANIFEST DECLARES, WORKED OUT WITH THIS CONNECTION'S PARAMETERS: the
 * transport's own address and every address an auth strategy sends a credential
 * to. At connect time these are shown to the admin and pinned
 * (MANIFEST-V2 §9.2); a request to anywhere else carries no credential.
 */
export async function credentialOrigins(manifest: ManifestV2, params: Record<string, string>): Promise<Set<string>> {
  const out = new Set<string>();
  const add = async (source: string | undefined) => {
    if (!source) return;
    const worked = await text(source, { params });
    try {
      if (worked) out.add(new URL(worked).origin);
    } catch {
      /* not an address: whatever uses it refuses with its own words */
    }
  };
  const base = await baseAddress(manifest.transport, params).catch(() => null);
  if (base) out.add(base.origin);
  for (const alternative of manifest.auth) {
    const parts = alternative.strategy === 'all_of' ? alternative.parts : [alternative];
    for (const part of parts) {
      if ('endpoints' in part) {
        const endpoints = part.endpoints as Record<string, string | undefined>;
        for (const one of Object.values(endpoints)) await add(one);
      }
      if (part.strategy === 'jwt_assertion') await add(part.exchange?.tokenUrl);
      if (part.strategy === 'session') await add(part.request.url);
    }
  }
  return out;
}

/**
 * The transport's own settings with every expression worked out over params:
 * a database host, a directory, a share, brokers. The parts that are not
 * settings — TLS, the agent route, constant headers — are resolved elsewhere.
 */
export async function connectionSettings(transport: TransportV2, params: Record<string, string>): Promise<Record<string, unknown>> {
  const { kind: _kind, ...rest } = transport as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    if (name === 'tls' || name === 'via' || name === 'headers' || name === 'metadata' || name === 'descriptor' || name === 'security') continue;
    settings[name] = await deep(value, { params });
  }
  return settings;
}
