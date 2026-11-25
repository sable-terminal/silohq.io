// The cell's Kubernetes API (spec 6.3: a cell is Kubernetes in three zones), as the cell's
// Fleet agent uses it to apply a release (spec 11.1 to 11.3): read and patch Deployments, run
// the migration Job, keep its own state in a ConfigMap. Plain HTTPS to the API server, no
// client library: in a pod, the service account's token (read afresh each call, as the
// kubelet rotates it), the cluster's CA and the pod's namespace; elsewhere a URL, with a
// token file and a CA file if it needs them (http only on the loopback, outside production).
//
// An answer the API server refuses is an AppError carrying its status, never its body text;
// a GET of something absent is undefined.

import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { AppError } from '../utils/errors.util.ts';

const IN_CLUSTER = '/var/run/secrets/kubernetes.io/serviceaccount';
const TIMEOUT_MS = 30_000;
const MAX_BODY = 8 * 1024 * 1024;

export interface KubernetesSettings {
  /** in_cluster, or the API server's URL. */
  where: string;
  tokenFile?: string | undefined;
  caFile?: string | undefined;
  namespace?: string | undefined;
}

export interface KubernetesClient {
  readonly namespace: string;
  get<T>(path: string): Promise<T | undefined>;
  /** POST a new object; 'exists' if one of that name is there. */
  create<T>(path: string, body: unknown): Promise<T | 'exists'>;
  /** A strategic merge patch (a JSON merge patch for a custom object). */
  patch<T>(path: string, body: unknown): Promise<T>;
  /** PUT the whole object; 'conflict' if it changed since it was read (its resourceVersion). */
  replace<T>(path: string, body: unknown): Promise<T | 'conflict'>;
  delete(path: string): Promise<void>;
}

export function createKubernetesClient(settings: KubernetesSettings): KubernetesClient {
  const inCluster = settings.where === 'in_cluster';
  const base = inCluster
    ? new URL(`https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT'] ?? '443'}`)
    : new URL(settings.where);
  const tokenFile = settings.tokenFile ?? (inCluster ? `${IN_CLUSTER}/token` : undefined);
  const caFile = settings.caFile ?? (inCluster ? `${IN_CLUSTER}/ca.crt` : undefined);
  const ca = caFile === undefined ? undefined : readFileSync(caFile, 'utf8');
  const namespace = settings.namespace ?? (inCluster ? readFileSync(`${IN_CLUSTER}/namespace`, 'utf8').trim() : 'default');

  function call(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<{ status: number; body: unknown }> {
    const url = new URL(path, base);
    const token = tokenFile === undefined ? undefined : readFileSync(tokenFile, 'utf8').trim();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    if (payload !== undefined) {
      headers['content-type'] = contentType;
      headers['content-length'] = String(payload.length);
    }
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(url, { method, headers, timeout: TIMEOUT_MS, ...(url.protocol === 'https:' && ca !== undefined ? { ca } : {}) }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            request.destroy();
            reject(new AppError('bounds', 'the Kubernetes API answered more than the Fleet agent reads', { code: 'kubernetes.answer_too_large' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = text === '' ? undefined : JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
        response.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new AppError('timeout', 'the Kubernetes API did not answer in time', { code: 'kubernetes.timeout' })));
      request.on('error', (error) => reject(error instanceof AppError ? error
        : new AppError('source_unreachable', 'the Kubernetes API could not be reached', { code: 'kubernetes.unreachable', cause: error })));
      if (payload !== undefined) request.write(payload);
      request.end();
    });
  }

  const refused = (method: string, path: string, status: number): AppError => new AppError(status === 403 || status === 401 ? 'forbidden' : 'upstream',
    `the Kubernetes API refused ${method} ${path.split('?')[0]} (${status})`, { code: `kubernetes.status_${status}`, details: { status } });

  return {
    namespace,
    async get<T>(path: string) {
      const answer = await call('GET', path);
      if (answer.status === 404) return undefined;
      if (answer.status < 200 || answer.status > 299) throw refused('GET', path, answer.status);
      return answer.body as T;
    },
    async create<T>(path: string, body: unknown) {
      const answer = await call('POST', path, body);
      if (answer.status === 409) return 'exists' as const;
      if (answer.status < 200 || answer.status > 299) throw refused('POST', path, answer.status);
      return answer.body as T;
    },
    async patch<T>(path: string, body: unknown) {
      const answer = await call('PATCH', path, body, 'application/strategic-merge-patch+json');
      if (answer.status < 200 || answer.status > 299) throw refused('PATCH', path, answer.status);
      return answer.body as T;
    },
    async replace<T>(path: string, body: unknown) {
      const answer = await call('PUT', path, body);
      if (answer.status === 409) return 'conflict' as const;
      if (answer.status < 200 || answer.status > 299) throw refused('PUT', path, answer.status);
      return answer.body as T;
    },
    async delete(path: string) {
      const answer = await call('DELETE', path);
      if (answer.status !== 404 && (answer.status < 200 || answer.status > 299)) throw refused('DELETE', path, answer.status);
    },
  };
}
