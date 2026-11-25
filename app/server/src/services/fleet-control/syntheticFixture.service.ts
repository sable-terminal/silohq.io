// The synthetic organisation's source (spec 11.2; decision 2026-11-18): a small REST API of
// "probes" the cell's Fleet agent serves on FLEET_SYNTHETIC_PORT, behind the cell's own ingress
// at FLEET_SYNTHETIC_URL, so connect-runtime reaches it through its egress like any SaaS source
// and the release tests cover the real path. It holds no customer data: three probes, a name and
// a score each. Every request needs the bearer token the agent sets on the connection each round
// (a new one each time the agent starts); anything else is refused.
//
// GET /v1/probes (?id=, or ?since= an updated_at, the stream's watermark to resume from), POST
// /v1/probes, PATCH and DELETE /v1/probes/:id: what the conformance classes, the write path and a
// resumable stream need. Each change is posted, signed, to the connection's change
// stream webhook once the agent has enabled it (HMAC-SHA256 over the timestamp and the body, the
// way its manifest verifies it), so a live subscription sees it as a delta.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../../infra/logger.infra.ts';

export interface Probe {
  id: string;
  /** When it last changed: strictly increasing, the stream's watermark. */
  updated_at: string;
  properties: { name: string; score: number };
}

const MAX_BODY = 16 * 1024;

export function createSyntheticFixture(logger: Logger) {
  let clock = Date.now();
  /** A strictly increasing time, so two changes in one millisecond still order. */
  const tick = (): string => { clock = Math.max(clock + 1, Date.now()); return new Date(clock).toISOString(); };
  const probes = new Map<string, Probe>((['one', 'two', 'three'] as const).map((name, i) =>
    [`p${i + 1}`, { id: `p${i + 1}`, updated_at: tick(), properties: { name: `Probe ${name}`, score: (i + 1) * 10 } }]));
  const token = randomBytes(24).toString('base64url');
  let stream: { url: string; secret: string } | undefined;

  /** A change, posted signed to the stream's webhook; a failed post is the stream's to notice (its gap or backfill). */
  async function emit(type: 'insert' | 'update' | 'delete', probe: Probe): Promise<void> {
    if (stream === undefined) return;
    // The change's own time is its sequence, so the webhook and the poll order alike.
    const body = JSON.stringify({ events: [{ id: probe.id, type, data: probe.properties, seq: probe.updated_at }] });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', stream.secret).update(`${timestamp}.${body}`).digest('hex');
    await fetch(stream.url, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': signature }, signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => logger.failure('a synthetic change could not be posted to its stream', error, { event: 'fleet.synthetic_emit_failed' }));
  }

  const send = (res: ServerResponse, status: number, value?: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(value === undefined ? '' : JSON.stringify(value));
  };

  async function readBody(req: IncomingMessage): Promise<{ properties?: Partial<Probe['properties']> } | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return undefined;
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
      return typeof parsed === 'object' && parsed !== null ? parsed as { properties?: Partial<Probe['properties']> } : undefined;
    } catch {
      return undefined;
    }
  }

  const valid = (p: Partial<Probe['properties']> | undefined): p is Partial<Probe['properties']> => p !== undefined
    && (p.name === undefined || (typeof p.name === 'string' && p.name.length <= 200))
    && (p.score === undefined || (Number.isInteger(p.score) && Math.abs(p.score) <= 1_000_000));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorised' });
    const url = new URL(req.url ?? '/', 'http://fixture');
    const match = /^\/v1\/probes(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(url.pathname);
    if (match === null) return send(res, 404, { error: 'not_found' });
    const id = match[1];
    if (req.method === 'GET' && id === undefined) {
      const only = url.searchParams.get('id');
      const since = url.searchParams.get('since');
      return send(res, 200, {
        results: [...probes.values()].filter((p) => (only === null || p.id === only) && (since === null || p.updated_at > since))
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at)),
      });
    }
    if (req.method === 'GET') return probes.has(id!) ? send(res, 200, probes.get(id!)) : send(res, 404, { error: 'not_found' });
    if (req.method === 'POST' && id === undefined) {
      const body = await readBody(req);
      if (!valid(body?.properties)) return send(res, 400, { error: 'invalid' });
      const probe: Probe = { id: `p-${randomUUID()}`, updated_at: tick(), properties: { name: body!.properties!.name ?? 'Probe', score: body!.properties!.score ?? 0 } };
      probes.set(probe.id, probe);
      await emit('insert', probe);
      return send(res, 201, probe);
    }
    if (req.method === 'PATCH' && id !== undefined) {
      const probe = probes.get(id);
      if (probe === undefined) return send(res, 404, { error: 'not_found' });
      const body = await readBody(req);
      if (!valid(body?.properties)) return send(res, 400, { error: 'invalid' });
      probe.properties = { ...probe.properties, ...body!.properties };
      probe.updated_at = tick();
      await emit('update', probe);
      return send(res, 200, probe);
    }
    if (req.method === 'DELETE' && id !== undefined) {
      const probe = probes.get(id);
      if (probe === undefined) return send(res, 404, { error: 'not_found' });
      probes.delete(id);
      await emit('delete', { ...probe, updated_at: tick() });
      return send(res, 204);
    }
    return send(res, 405, { error: 'method_not_allowed' });
  }

  return {
    token,
    probes,
    /** The connection's change stream webhook, once enabled. */
    setStream(url: string, secret: string): void {
      stream = { url, secret };
    },
    handler(req: IncomingMessage, res: ServerResponse): void {
      handle(req, res).catch((error: unknown) => {
        logger.failure('the synthetic source failed a request', error, { event: 'fleet.synthetic_fixture_failed' });
        if (!res.headersSent) send(res, 500, { error: 'internal' });
      });
    },
  };
}

export type SyntheticFixture = ReturnType<typeof createSyntheticFixture>;
