import type { Request, Response } from 'express';
import { preflight } from '../infra/startup.infra';
import { render } from '../infra/metrics.infra';
import { env } from '../config/env.config';

/**
 * Liveness, readiness, and the difference between them.
 *
 * `/healthz` ANSWERS 200 WHILE THE PROCESS IS ALIVE and touches nothing else.
 * Cloud Run restarts a container that fails its liveness probe, so a liveness
 * check that queries the database restarts every instance when the database
 * hiccups — turning a brief dependency blip into a full outage with no capacity
 * left to serve the requests that would have succeeded.
 *
 * `/readyz` ANSWERS WHETHER THIS INSTANCE CAN SERVE, and is allowed to fail.
 * That takes an instance out of rotation without killing it, which is what you
 * want while a dependency recovers.
 */

export function live(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok', cell: env.CELL_ID });
}

export async function ready(_req: Request, res: Response): Promise<void> {
  const result = await preflight();
  res.status(result.ok ? 200 : 503).json({
    status: result.ok ? 'ready' : 'degraded',
    cell: env.CELL_ID,
    region: env.CELL_REGION,
    checks: result.checks,
  });
}

/**
 * Prometheus text format.
 *
 * NOT ON THE PUBLIC ROUTER. Mounted in `app.ts` behind the same network
 * boundary as the rest, and Cloud Run's ingress is what keeps it off the
 * internet — metric names and label cardinality describe the shape of the system
 * to anyone who can read them.
 */
export function metrics(_req: Request, res: Response): void {
  res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  res.status(200).send(render());
}
