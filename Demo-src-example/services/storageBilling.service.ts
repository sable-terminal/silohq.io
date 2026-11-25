import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { env } from '../config/env.config';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import { entitlementsFor } from './billing.service';
import * as siloRepo from '../repos/silo.repo';
import * as siloImportRepo from '../repos/siloImport.repo';
import * as storageRepo from '../repos/storage.repo';
import * as rowStore from './rowStore.service';
import { billable, costOf, MARGIN_PERCENT, RATE_CARD, type Residency } from '../models/storagePricing.model';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

const log = childLogger('storage-billing');

/**
 * Billing §6 — what a Silo held and scanned, what it cost us, and what that is
 * charged at.
 *
 * ── Measured, not estimated ────────────────────────────────────────────────
 *
 * Bytes held are read from the stores themselves: transitions and baselines by
 * their row size, imported files by their bytes, imported rows from the row
 * store, whether that is Postgres or BigQuery. Bytes scanned are what queries
 * actually scanned, which the row store has been counting per Silo since it was
 * built. Nothing here is a guess, which is what makes "cost plus 10%" sayable.
 *
 * ── A reading per Silo per month, updated as the month goes ────────────────
 *
 * Storage is a level, not an event: the reading taken today replaces today's,
 * and the period is the month it belongs to. Bytes scanned are the difference
 * from the last reading's running total, so two readings in a month do not
 * charge the same terabyte twice.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

const monthStart = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));

/** The rate card this deployment is on. Sovereign residency is its own card (§6). */
function ratesFor(residency: Residency = env.SILO_RESIDENCY as Residency) {
  return { residency, rates: RATE_CARD[residency] ?? RATE_CARD.unrestricted };
}

/**
 * Take a reading for every Silo of one organisation.
 *
 * SYSTEM WORK, UNDER THE ORGANISATION'S TENANT. Called by the scheduled
 * measurement; the numbers are the organisation's own and are read through the
 * same row level security everything else uses.
 */
export async function measure(organisationId: string, at = new Date()): Promise<{ siloes: number }> {
  const period = monthStart(at);
  const { residency, rates } = ratesFor();

  const siloes = await runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) => siloRepo.list(db)),
  );

  for (const silo of siloes) {
    const held = await runWithTenant({ organisationId, membershipId: null }, () =>
      withTransaction(async (db) => ({
        stored: await siloRepo.bytesStored(db, silo.id),
        files: await siloImportRepo.bytesOfFiles(db, silo.id),
        shapes: await importedShapes(db, silo.id),
        previous: await storageRepo.latestBefore(db, { siloId: silo.id, period }),
      })),
    );

    const rows =
      held.shapes.length === 0
        ? 0
        : await rowStore.bytesHeld({ organisationId, siloId: silo.id, sources: held.shapes });

    /*
     * WHAT THIS PERIOD SCANNED, not what the Silo has ever scanned. The counter
     * on the Silo only goes up; a period is the difference between two readings,
     * and the first reading of a Silo's life charges everything before it.
     */
    const cumulative = silo.bytesScanned;
    const scanned = Math.max(0, cumulative - (held.previous?.scannedCumulative ?? 0));

    /*
     * §6 — "The underlying cost is recorded per line… 10% over cost is a claim
     * that only means something if the cost is visible."
     *
     * THE COST OF THE ROW AS IT WILL STAND, NOT OF THIS READING. The two halves
     * behave differently: held bytes are a point in time and are overwritten,
     * scanned bytes are a delta and accumulate across every reading in the
     * month. A single cost column overwritten with this reading's figure kept
     * only the last scan — so a Silo measured hourly recorded a cost that fell
     * further behind the charge every hour, and the invoice line `statement`
     * recomputes from the accumulated bytes disagreed with the number stored
     * beside it. The disclosed cost is the whole point of the margin claim.
     *
     * COMPUTED FROM THE ACCUMULATED BYTES rather than by adding up each
     * reading's rounded cost. Twelve readings that each scan four hundredths of
     * a penny are four hundredths of a penny twelve times — nought each, by
     * rounding — and a half-penny in total.
     */
    const priorThisPeriod =
      held.previous && held.previous.periodStart.getTime() === period.getTime()
        ? held.previous.bytesScanned
        : 0;
    const scannedThisPeriod = priorThisPeriod + scanned;

    const costed = costOf(
      {
        bytesHeldObject: held.files,
        bytesHeldRows: rows + held.stored.transitions + held.stored.baselines,
        bytesScanned: scannedThisPeriod,
      },
      rates,
    );

    await runWithTenant({ organisationId, membershipId: null }, () =>
      withTransaction(async (db) => {
        await storageRepo.record(db, {
          id: generateId(),
          organisationId,
          siloId: silo.id,
          periodStart: period,
          bytesHeld: held.files + rows + held.stored.transitions + held.stored.baselines,
          bytesScanned: scanned,
          scannedCumulative: cumulative,
          providerCostPence: costed.providerCostPence,
          rates,
          residency,
        });

        await writeAudit(db, {
          organisationId,
          membershipId: null,
          userId: null,
          event: 'storage_measured',
          /* What the record says after this reading, not what this reading
             alone saw: a reviewer comparing the trail against the invoice is
             looking for the figure the statement is built from. */
          detail: {
            siloId: silo.id,
            bytesHeld: held.files + rows + held.stored.transitions + held.stored.baselines,
            bytesScanned: scannedThisPeriod,
            providerCostPence: costed.providerCostPence,
            residency,
          },
        });
      }),
    );
  }

  log.info({ organisationId, siloes: siloes.length }, 'Storage measured');
  return { siloes: siloes.length };
}

/** Organisations with a Silo to measure. Cross-tenant: the scheduled measurement's. */
export async function organisationsWithSiloes(db: PoolClient): Promise<string[]> {
  return storageRepo.organisationsWithSiloes(db);
}

export type StorageLine = {
  siloId: string;
  periodStart: Date;
  bytesHeld: number;
  bytesScanned: number;
  /** §6 — the provider's own cost, disclosed. */
  providerCostPence: number;
  /** What it is charged at: the cost plus the margin. */
  chargePence: number;
  marginPercent: number;
  residency: string;
  rates: Record<string, number>;
};

/**
 * §6 — what a customer is paying for, with the cost beside it.
 *
 * INCLUDED STORAGE COMES OFF THE BYTES BEFORE ANYTHING IS PRICED, so a Silo
 * entirely inside what the plan includes bills nothing rather than billing and
 * crediting.
 */
export async function statement(actor: Actor, months = 3): Promise<{ lines: StorageLine[]; includedBytes: number }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'billing.view');

      const entitlements = await entitlementsFor(db, actor.organisationId);
      const includedBytes = entitlements?.storageIncludedBytes ?? 0;

      const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - (months - 1), 1));
      const measurements = await storageRepo.since(db, { organisationId: actor.organisationId, from });

      const lines = measurements.map((one) => {
        const costed = costOf(
          {
            /* Held bytes are priced together; the allowance comes off the total. */
            bytesHeldObject: 0,
            bytesHeldRows: billable(one.bytesHeld, includedBytes),
            bytesScanned: one.bytesScanned,
          },
          one.rates,
        );

        return {
          siloId: one.siloId,
          periodStart: one.periodStart,
          bytesHeld: one.bytesHeld,
          bytesScanned: one.bytesScanned,
          providerCostPence: costed.providerCostPence,
          chargePence: costed.chargePence,
          marginPercent: MARGIN_PERCENT,
          residency: one.residency,
          rates: one.rates as unknown as Record<string, number>,
        };
      });

      return { lines, includedBytes };
    }),
  );
}

/** Which sources and objects a Silo's imported rows live in. */
async function importedShapes(
  db: PoolClient,
  siloId: string,
): Promise<Array<{ sourceId: string; objectNames: string[] }>> {
  const sources = await siloImportRepo.sourcesIn(db, siloId);
  const shapes: Array<{ sourceId: string; objectNames: string[] }> = [];

  for (const source of sources) {
    const definition = source.definitionId ? await siloImportRepo.findDefinition(db, source.definitionId) : null;
    const document = definition?.document as { objects?: Array<{ name: string }> } | null;
    if (!document?.objects) continue;

    shapes.push({ sourceId: source.id, objectNames: document.objects.map((object) => object.name) });
  }

  return shapes;
}
