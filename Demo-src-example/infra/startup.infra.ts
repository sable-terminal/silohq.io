import { assertProductionReady, env, isProd } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import * as cache from './cache.infra';
import * as directory from './directory.infra';
import * as kms from './kms.infra';
import * as objectStore from './objectStore.infra';
import * as model from './model.infra';
import { accessToken } from './googleAuth.infra';

const log = childLogger('startup');

/**
 * What must be true before this process accepts a request.
 *
 * THE DISTINCTION IS BETWEEN "CANNOT WORK" AND "WORKS WORSE". A missing KEK means
 * no credential can be opened and none accepted can be kept — every connector
 * fails, and a connector that fails after accepting a credential has lost it. A
 * missing cache means slower. The first refuses to start; the second logs and
 * continues.
 *
 * CHECKED BY USE, NOT BY PRESENCE. A configured KMS key name proves somebody set
 * an environment variable. A round trip through it proves this identity may
 * encrypt and decrypt, which is the permission most likely to be missing and the
 * one that only fails at the moment it is needed.
 *
 * ONE PASS, EVERYTHING REPORTED. Failing at the first problem means fixing it,
 * redeploying, and finding the next — three deploys to discover three missing
 * variables.
 */

export interface Check {
  name: string;
  fatal: boolean;
  ok: boolean;
  detail?: string;
}

export async function preflight(): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  try {
    assertProductionReady();
    checks.push({ name: 'environment', fatal: true, ok: true });
  } catch (error) {
    checks.push({
      name: 'environment',
      fatal: true,
      ok: false,
      detail: error instanceof Error ? error.message : 'invalid',
    });
  }

  /*
   * THE DIRECTORY IS CHECKED BUT IS NOT FATAL. A cell that cannot reach it can
   * still serve everybody already in it — `cellFor` answers null and the login
   * proceeds locally — so refusing to start would turn a degraded shared
   * component into a total outage. What matters is that the operator can see
   * whether it is a separate database at all, because "one cell on purpose" and
   * "the directory was never configured" look identical from outside.
   */
  const dir = await directory.ping();
  checks.push({
    name: 'directory',
    fatal: false,
    ok: dir.reachable,
    detail: dir.separate
      ? dir.reachable
        ? undefined
        : 'Configured but unreachable; every login will route locally.'
      : 'Not a separate database. This deployment can only ever route to its own cell.',
  });

  // Google credentials underpin KMS, storage and the model, so it is checked
  // once rather than surfacing as three unrelated failures.
  if (isProd || env.GCP_PROJECT_ID) {
    const hasToken = (await accessToken()) !== null;
    checks.push({
      name: 'google-credentials',
      fatal: isProd,
      ok: hasToken,
      detail: hasToken ? undefined : 'No metadata server and no application default credentials',
    });
  }

  if (kms.isConfigured()) {
    const result = await kms.verify();
    checks.push({ name: 'kms', fatal: true, ok: result.ok, detail: result.reason });
  } else {
    checks.push({
      name: 'kms',
      fatal: isProd,
      ok: !isProd,
      detail: 'Not configured. No credential can be sealed or opened.',
    });
  }

  const redis = await cache.ping();
  checks.push({
    name: 'cache',
    // Never fatal. A cache that takes the product down has become a database.
    fatal: false,
    ok: redis.reachable,
    detail: redis.configured ? (redis.reachable ? undefined : 'Configured but unreachable') : 'Not configured',
  });

  checks.push({
    name: 'object-store',
    fatal: isProd,
    ok: objectStore.isConfigured(),
    detail: objectStore.isConfigured() ? undefined : 'STORAGE_BUCKET is not set',
  });

  const modelUsable = await model.isUsable();
  checks.push({
    name: 'model',
    fatal: isProd,
    /*
     * CONFIGURED AND ABLE TO AUTHENTICATE. Checking the variable alone meant a
     * stale `gcloud auth application-default login` booted clean and 500'd on
     * the first request — the check reported what had been typed rather than
     * what worked.
     */
    ok: modelUsable,
    detail: modelUsable
      ? undefined
      : model.isConfigured()
        ? 'VERTEX_PROJECT_ID is set but Google refused the credentials — run `gcloud auth application-default login`'
        : 'VERTEX_PROJECT_ID is not set',
  });

  const failed = checks.filter((c) => !c.ok);
  for (const check of failed) {
    const line = { check: check.name, detail: check.detail };
    if (check.fatal) log.error(line, 'Preflight check failed');
    else log.warn(line, 'Preflight check failed; continuing degraded');
  }

  return { ok: !checks.some((c) => c.fatal && !c.ok), checks };
}

/**
 * Run the preflight and stop the process if anything fatal failed.
 *
 * `process.exit`, NOT A THROW. A throw from startup leaves a half-initialised
 * process that the orchestrator may keep alive and route traffic to. Exiting
 * non-zero is unambiguous, and Cloud Run will not send requests to it.
 */
export async function assertReady(): Promise<void> {
  const { ok, checks } = await preflight();

  if (!ok) {
    const fatal = checks.filter((c) => c.fatal && !c.ok);
    process.stderr.write(
      `\nRefusing to start. ${fatal.length} fatal check(s) failed:\n` +
        fatal.map((c) => `  ${c.name}: ${c.detail ?? 'failed'}`).join('\n') +
        '\n\n',
    );
    process.exit(1);
  }

  const degraded = checks.filter((c) => !c.ok);
  log.info(
    { checks: checks.length, degraded: degraded.map((c) => c.name) },
    degraded.length > 0 ? 'Started, degraded' : 'Started',
  );
}
