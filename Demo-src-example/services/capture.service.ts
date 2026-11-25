import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { childLogger } from '../config/logger.config';
import { env } from '../config/env.config';
import { log as writeAudit } from './audit.service';
import * as siloRepo from '../repos/silo.repo';

const log = childLogger('capture');

/**
 * §5 — capture rides on queries, and never in front of one.
 *
 * QUEUED, NEVER INLINE. A query must not wait on a write to storage, and a
 * capture failure must never fail somebody's question. The row is already in
 * hand when an answer is assembled, so noticing what changed is nearly free —
 * writing it is not, and that cost belongs after the answer has gone back.
 *
 * THE QUEUE IS THE SINGLE PLACE HOLDING EVERYTHING IN FLIGHT IN THIS PROCESS.
 * Other instances hold their own, which is why a purge does not rely on reaching
 * them: its receipt is a fence that `captureBatch` checks every reading against,
 * wherever the reading was queued.
 *
 * SAMPLED BY WHAT PEOPLE ASK. An entity nobody queries is never captured, and
 * drift on it is invisible. That is a STATED LIMITATION rather than a defect.
 */

export interface Pending extends siloRepo.Reading {
  organisationId: string;
  siloId: string;
}

/** One field of one entity from one system, before it is stamped and queued. */
export interface Observed {
  connectionId: string;
  entityRef: string;
  fieldPath: string;
  value: string | null;
}

/**
 * In memory, deliberately, and the limits are the honest part.
 *
 * A DURABLE QUEUE WOULD BE A SECOND STORE OF THE SAME VALUES — the thing the
 * disclosure exists to bound — so losing a batch on restart is the right trade:
 * capture is sampled by what people ask anyway, and the next query re-observes
 * the same entity.
 */
const queue: Pending[] = [];
const MAX_QUEUED = 10_000;

/**
 * THE COUNT CAP DID NOT BOUND MEMORY. Ten thousand readings of a pasted
 * document are gigabytes. A value longer than this is not captured at all —
 * refused, not cut: a truncated value compared against a truncated value
 * records changes that did not happen and misses ones that did. 065 holds the
 * same bound as a CHECK, so a reading that got past here still could not land.
 */
const MAX_VALUE_LENGTH = 4096;

let cutShort = 0;
let oversized = 0;

/**
 * Notice what an answer contained.
 *
 * TAKES AN ITERABLE, NOT AN ARRAY. The caller used to build every reading of a
 * full page — maxRows times every nominated field — before this looked at any of
 * them, blocking the request for a fifth of a second to construct readings a
 * full queue then threw away. Iterated lazily, a full queue stops the caller's
 * generator after one reading.
 *
 * STAMPED HERE, ONCE. When the answer was assembled is when the value was true,
 * and it is what a purge's fence and the retention window are measured against.
 */
export function observe(input: {
  organisationId: string;
  siloId: string;
  conceptId: string;
  readings: Iterable<Observed>;
}): void {
  if (!env.SILOES_AVAILABLE) return;

  const observedAt = new Date().toISOString();

  for (const reading of input.readings) {
    if (queue.length >= MAX_QUEUED) {
      cutShort += 1;
      break;
    }

    if (reading.value !== null && reading.value.length > MAX_VALUE_LENGTH) {
      oversized += 1;
      continue;
    }

    queue.push({
      organisationId: input.organisationId,
      siloId: input.siloId,
      conceptId: input.conceptId,
      connectionId: reading.connectionId,
      entityRef: reading.entityRef,
      fieldPath: reading.fieldPath,
      value: reading.value,
      observedAt,
    });
  }
}

export type Drained = {
  batches: number;
  written: number;
  /** Readings the write refused: a switch thrown, a field no longer nominated, a purge's fence. */
  refused: number;
  /** Per Silo, how many transitions this drain wrote. Read by the wipe's audit entry. */
  bySilo: Record<string, number>;
};

/* ── One drain at a time ─────────────────────────────────────────────────── */

/**
 * THE GUARD USED TO LIVE IN THE TIMER, NOT IN THE DRAIN. So a purge's drain ran
 * beside the timer's: each spliced part of the queue, and the timer's batch
 * could commit after the purge's delete — writing purged data back behind a
 * receipt that said it was gone. Every drain now goes through one chain, and
 * `afterDraining` holds it across the caller's own work.
 */
let tail: Promise<unknown> = Promise.resolve();

function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function drainNow(): Promise<Drained> {
  const drained: Drained = { batches: 0, written: 0, refused: 0, bySilo: {} };

  if (cutShort > 0 || oversized > 0) {
    log.warn({ cutShort, oversized }, 'Capture readings not queued');
    cutShort = 0;
    oversized = 0;
  }

  if (queue.length === 0) return drained;

  const taken = queue.splice(0, queue.length);
  const byTenant = new Map<string, Pending[]>();

  for (const one of taken) {
    const key = `${one.organisationId}|${one.siloId}`;
    const group = byTenant.get(key);
    if (group) group.push(one);
    else byTenant.set(key, [one]);
  }

  for (const readings of byTenant.values()) {
    const { organisationId, siloId } = readings[0]!;

    try {
      const result = await runWithTenant({ organisationId, membershipId: null }, () =>
        withTransaction(async (db) => {
          const outcome = await siloRepo.captureBatch(db, {
            organisationId,
            siloId,
            readings: readings.map(({ organisationId: _o, siloId: _s, ...reading }) => reading),
          });

          if (outcome.written > 0) {
            await writeAudit(db, {
              event: 'transition_captured_batch',
              organisationId,
              membershipId: null,
              userId: null,
              /* A COUNT, NEVER A VALUE. */
              detail: { siloId, captured: outcome.written, examined: readings.length },
            });
          }

          return outcome;
        }),
      );

      drained.batches += 1;
      drained.written += result.written;
      drained.refused += readings.length - result.admitted;
      drained.bySilo[siloId] = (drained.bySilo[siloId] ?? 0) + result.written;
    } catch (error: unknown) {
      /*
       * A CAPTURE FAILURE IS NOT A QUERY FAILURE, and by now the query is long
       * gone. Logged and dropped: re-queueing a batch that failed for a
       * structural reason would retry it forever.
       */
      log.warn({ siloId, readings: readings.length, err: error }, 'Capture batch failed');
    }
  }

  return drained;
}

/** Write what is waiting, after any drain already in progress. */
export function drain(): Promise<Drained> {
  return serially(drainNow);
}

/**
 * Drain, then do something before any other drain can start.
 *
 * §9 — "DRAINS THE QUEUE FIRST." A wipe runs its delete inside this, so nothing
 * this process queued before the wipe can be written after it.
 */
export function afterDraining<T>(work: (drained: Drained) => Promise<T>): Promise<T> {
  return serially(async () => work(await drainNow()));
}

/** How much is waiting for one Silo. Never the whole queue: that is every tenant's activity. */
export function queuedFor(siloId: string): number {
  let count = 0;
  for (const one of queue) if (one.siloId === siloId) count += 1;
  return count;
}

/* ── The drain loop ──────────────────────────────────────────────────────── */

/**
 * IN PROCESS, AND IT HAS TO BE. The queue lives in this process's memory, so an
 * external scheduler would connect to a database and find nothing to do while
 * the readings sat here.
 */
const DRAIN_INTERVAL_MS = 5_000;

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function start(): void {
  if (!env.SILOES_AVAILABLE || timer) return;

  timer = setInterval(() => {
    /* Not a correctness guard — `serially` is that. This only stops ticks
       queueing behind a slow drain. */
    if (busy) return;
    busy = true;

    void drain()
      .catch((error: unknown) => log.warn({ err: error }, 'Capture drain failed'))
      .finally(() => {
        busy = false;
      });
  }, DRAIN_INTERVAL_MS);

  timer.unref();
  log.info({ everyMs: DRAIN_INTERVAL_MS }, 'Capture drain started');
}

/**
 * Stop, and write what is left before going.
 *
 * ON THE SHUTDOWN PATH, BEFORE THE POOLS CLOSE. Cloud Run sends SIGTERM and
 * then takes the instance away; a queue abandoned here is data the customer's
 * query already paid to read.
 */
export async function stop(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  const waiting = queue.length;
  const drained = await drain();
  if (waiting > 0) log.info({ waiting, ...drained }, 'Capture drained on shutdown');
}
