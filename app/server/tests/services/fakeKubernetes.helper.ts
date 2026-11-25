// A Kubernetes API server for the Fleet agent's tests: Deployments, Jobs and ConfigMaps of one
// namespace in memory, over plain HTTP on the loopback. A patched Deployment rolls at once
// (the next read finds every replica updated and available) unless it is told to stall, when
// it reports ProgressDeadlineExceeded; a Job succeeds or fails as told. Every call is kept, so
// a test can read the order things were done in.

import { createServer, type Server } from 'node:http';

export interface FakeDeployment {
  name: string;
  service: string;
  zone: string;
  image: string;
}

export interface FakeKubernetes {
  url: string;
  calls: { method: string; path: string; body: unknown }[];
  deployments: Map<string, Record<string, any>>;
  jobs: Map<string, Record<string, any>>;
  configMaps: Map<string, Record<string, any>>;
  /** What a Job created from now on does. */
  jobOutcome: 'succeeded' | 'failed';
  /** Deployments that never finish rolling; and whose pods crash loop. */
  stall: Set<string>;
  crash: Set<string>;
  imageOf(name: string): string;
  close(): Promise<void>;
}

const NS = 'silo';

export async function startFakeKubernetes(initial: readonly FakeDeployment[]): Promise<FakeKubernetes> {
  const deployments = new Map<string, Record<string, any>>();
  for (const d of initial) {
    deployments.set(d.name, {
      metadata: { name: d.name, generation: 1, labels: { 'silo.io/service': d.service, 'topology.kubernetes.io/zone': d.zone }, annotations: {} },
      spec: { replicas: 2, template: { metadata: { annotations: {} }, spec: { containers: [{ name: d.service, image: d.image }] } } },
      status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, availableReplicas: 2 },
    });
  }
  const fake = {
    url: '', close: async () => undefined,
    calls: [], deployments, jobs: new Map(), configMaps: new Map(), jobOutcome: 'succeeded', stall: new Set(), crash: new Set(),
    imageOf: (name: string) => deployments.get(name)!['spec'].template.spec.containers[0].image,
  } as FakeKubernetes;
  const merge = (target: Record<string, any>, patch: Record<string, any>): void => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'containers' && Array.isArray(value)) {
        // Strategic merge: containers by name.
        for (const c of value) Object.assign(target['containers'].find((t: { name: string }) => t.name === c.name), c);
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        target[key] ??= {};
        merge(target[key], value);
      } else {
        target[key] = value;
      }
    }
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const url = new URL(req.url!, 'http://kube');
      fake.calls.push({ method: req.method!, path: url.pathname + url.search, body });
      const send = (status: number, value?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      const parts = url.pathname.split('/').filter(Boolean);
      const kind = parts.at(-2) === NS ? parts.at(-1)! : parts.at(-2)!;
      const name = parts.at(-2) === NS ? undefined : parts.at(-1)!;
      if (kind === 'pods' && req.method === 'GET') {
        // Two pods a Deployment, carrying its template's annotations; crash looping if told to.
        return send(200, {
          items: [...deployments.values()].flatMap((d) => [0, 1].map((i) => ({
            metadata: { name: `${d['metadata'].name}-${i}`, labels: d['metadata'].labels, annotations: { ...d['spec'].template.metadata?.annotations } },
            status: { containerStatuses: [fake.crash.has(d['metadata'].name)
              ? { restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } } : { restartCount: 0, state: { running: {} } }] },
          }))),
        });
      }
      const store = kind === 'deployments' ? deployments : kind === 'jobs' ? fake.jobs : kind === 'configmaps' ? fake.configMaps : undefined;
      if (store === undefined || !url.pathname.includes(`/namespaces/${NS}/`)) return send(404);
      if (req.method === 'GET' && name === undefined) {
        const selector = url.searchParams.get('labelSelector');
        const [key, value] = selector?.split('=') ?? [];
        return send(200, { items: [...store.values()].filter((o) => key === undefined || o['metadata'].labels?.[key] === value) });
      }
      if (req.method === 'GET') {
        const found = store.get(name!);
        if (found === undefined) return send(404);
        if (kind === 'deployments' && !fake.stall.has(name!)) {
          found['status'] = { observedGeneration: found['metadata'].generation, replicas: 2, updatedReplicas: 2, availableReplicas: 2 };
        }
        return send(200, found);
      }
      if (req.method === 'POST') {
        if (store.has(body.metadata.name)) return send(409, { reason: 'AlreadyExists' });
        const created = structuredClone(body);
        if (kind === 'jobs') created.status = fake.jobOutcome === 'succeeded' ? { succeeded: 1 } : { failed: 1 };
        store.set(body.metadata.name, created);
        return send(201, created);
      }
      if (req.method === 'PATCH') {
        const found = store.get(name!);
        if (found === undefined) return send(404);
        merge(found, body);
        if (kind === 'deployments') {
          found['metadata'].generation += 1;
          found['status'] = fake.stall.has(name!)
            ? { observedGeneration: found['metadata'].generation, replicas: 3, updatedReplicas: 1, availableReplicas: 2, unavailableReplicas: 1,
              conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] }
            : { observedGeneration: found['metadata'].generation - 1, replicas: 3, updatedReplicas: 1, availableReplicas: 2 };
        }
        return send(200, found);
      }
      return send(405);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}
