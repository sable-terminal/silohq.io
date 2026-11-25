// What every Silo service shares (spec 66, 70.6): the organisation's switch, the Silo view
// with its disclosure, and the clearance check at add time.
//
// The switch: off means unreachable (66.1). Every Silo entry point of every Silo service
// calls requireSiloes before anything else, so no Silo code path runs while it is off.

import { getManifest, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { SiloView } from '../../contracts/siloes/siloes.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Silo } from '../../models/siloes/index.model.ts';
import { storageMeasurementRepo } from '../../repos/billing/index.repo.ts';
import { indexDefinitionRepo, siloDefinitionRepo, siloObjectTypeRepo, siloRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { nominatedProperties, type NominatedProperty } from '../warehouse-schema/schema.service.ts';

export interface SiloesDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  /** redis-data: the capture queue. */
  redis: RedisStore;
  /** The cell's region: where Postgres Capture data sits. */
  location: string;
  now: () => number;
  /** The cell has no Warehouse (the sovereign build): a Capture Silo holds the Action ledger (48.2; D205). */
  ledgerInCapture?: boolean;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export const CAPTURE_STORE = 'pg-capture';

export { siloesEnabled } from './intake.service.ts';
import { siloesEnabled } from './intake.service.ts';

/** Off means unreachable: refused before any Silo work. */
export async function requireSiloes(deps: Pick<SiloesDeps, 'databases'>, ctx: Context): Promise<void> {
  const on = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloesEnabled(db, ctx.request.organisationId!), { readOnly: true });
  if (!on) throw new AppError('forbidden', 'Siloes are switched off for this organisation', { code: 'siloes.disabled' });
}

export function person(ctx: Context): string {
  if (ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'Siloes are managed by a person', { code: 'siloes.person_required' });
  }
  return ctx.request.membershipId;
}

export function readManifest(deps: Pick<SiloesDeps, 'services'>, ctx: Context): Promise<OntologyManifest> {
  return deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
}

/** A Silo of this organisation, of the kind asked for where one is. */
export async function loadSilo(db: Queryable, siloId: string, kind?: Silo['kind']): Promise<Silo> {
  const silo = await siloRepo.findById(db, siloId);
  if (silo === undefined || (kind !== undefined && silo.kind !== kind)) throw new AppError('not_found', 'no such Silo', { code: 'siloes.not_found' });
  return silo;
}

export function open(silo: Silo): Silo {
  if (silo.status === 'purging' || silo.status === 'disabled' || silo.disabledAt !== null) {
    throw new AppError('conflict', 'the Silo is being purged or is disabled', { code: 'siloes.closed' });
  }
  return silo;
}

/**
 * The marking check at add time (66.10): a person who cannot see the object type, or a
 * property in full, cannot put it in a Silo, which would store data they cannot see.
 */
export async function cleared(deps: Pick<SiloesDeps, 'services'>, ctx: Context, manifest: OntologyManifest, objectTypeId: string,
  apiNames: readonly string[]): Promise<NominatedProperty[]> {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId && t.status === 'active');
  if (type === undefined) throw new AppError('validation', 'the object type is not in the ontology', { code: 'siloes.unknown_type' });
  const found = nominatedProperties(manifest, objectTypeId, apiNames);
  const unknown = apiNames.filter((a) => !found.some((f) => f.apiName === a));
  if (unknown.length > 0) {
    throw new AppError('validation', `${type.apiName} has no property ${unknown[0]}`, { code: 'siloes.unknown_property', details: { property: unknown[0]! } });
  }
  const access = await deps.services.call(resolveAccess, {
    body: { objectTypes: [objectTypeId], properties: found.map((p) => p.identityId) },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  if (access.decision !== 'allow' || access.objectTypes.find((t) => t.id === objectTypeId)?.visible !== true) {
    throw new AppError('forbidden', 'you cannot put an object type you cannot see in a Silo', { code: 'siloes.not_cleared' });
  }
  for (const p of found) {
    const seen = access.properties.find((a) => a.id === p.identityId);
    if (seen?.visible !== true || seen.effect !== 'allow') {
      throw new AppError('forbidden', `you cannot put ${p.apiName} in a Silo: you do not see it in full`, { code: 'siloes.not_cleared', details: { property: p.apiName } });
    }
  }
  return found;
}

// ----------------------------------------------------------------------------- disclosure

const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);

/** "name, region on Supplier; order_id on Order", from the nominations and the ontology's names. */
function held(nominations: { objectTypeId: string; properties: string[] }[], manifest: OntologyManifest | undefined): string {
  if (nominations.length === 0) return 'the properties you add, on the object types you add';
  return nominations.map((n) => {
    const type = manifest?.objectTypes.find((t) => t.id === n.objectTypeId);
    const names = n.properties.map((p) => type?.properties.find((x) => x.apiName === p)?.displayName ?? p);
    return `${names.join(', ')} on ${type?.displayName ?? 'an object type'}`;
  }).join('; ');
}

/**
 * What every disclosure ends with (spec 8.2: "Backups holding purged data expire on schedule (at
 * most 12 months). A restore replays the purge ledger before opening to traffic, so purged data
 * never returns to service. The disclosure says so"; D253).
 */
export const BACKUP_DISCLOSURE = 'Deleted data leaves Silo\'s backups as they expire, within 12 months, and is never brought back into service.';

/** The disclosure of 70.6, filled from the Silo's configuration; shown at every change. */
export function disclosureOf(silo: Silo, nominations: { objectTypeId: string; properties: string[]; schedule?: string }[],
  manifest: OntologyManifest | undefined, documents: boolean): string {
  return `${kindDisclosure(silo, nominations, manifest, documents)} ${BACKUP_DISCLOSURE}`;
}

function kindDisclosure(silo: Silo, nominations: { objectTypeId: string; properties: string[]; schedule?: string }[],
  manifest: OntologyManifest | undefined, documents: boolean): string {
  const window = days(silo.retentionDays);
  switch (silo.kind) {
    case 'capture':
      return `Silo will keep the previous and new values of ${held(nominations, manifest)} each time they change, in Postgres, ${silo.location}, `
        + `for ${window}. Nothing else from your systems is kept. Nothing is kept the first time an object is seen: changes are kept from the `
        + 'second sighting. You can delete it at any time.';
    case 'import':
      return `Silo will keep the files you import and the rows read from them, in Google Cloud Storage and BigQuery, ${silo.location}, for ${window}. `
        + (documents
          ? 'No model reads tabular files. The text of documents you import is sent to a language model to read it, through a zero-retention '
            + 'endpoint, and is never logged. '
          : 'No model reads these files. ')
        + 'You can delete them at any time.';
    case 'object_index': {
      const schedules = [...new Set(nominations.map((n) => n.schedule).filter((s): s is string => s !== undefined))];
      return `Silo will keep a searchable copy of ${held(nominations, manifest)}, refreshed on the schedule ${schedules.join(', ') || 'you set'} `
        + `from your systems, in BigQuery, ${silo.location}, for ${window}. You can delete it at any time.`;
    }
    case 'warehouse':
      return `Silo will create a data warehouse for you in Google BigQuery, in a project used only by your organisation, in ${silo.location}, and `
        + `keep the current state and change history of ${held(nominations, manifest)} in it, updated from your systems, for ${window}. It is `
        + 'encrypted with a key used only for your organisation. You can take it with you or delete it at any time.';
  }
}

/** The switch's own disclosure, shown once at enable (70.6). */
export const ENABLE_DISCLOSURE = 'Switching Siloes on lets this organisation keep copies of data from its systems in Silo, but only in Siloes '
  + 'you create, each for a stated purpose and retention window, over object types and properties you choose one at a time. Nothing is kept '
  + `until you do. Everything kept can be deleted at any time. ${BACKUP_DISCLOSURE}`;

// ----------------------------------------------------------------------------- the view

export async function siloView(db: Queryable, silo: Silo, manifest: OntologyManifest | undefined): Promise<SiloView> {
  const nominations = silo.kind === 'object_index'
    ? (await indexDefinitionRepo.listForSilo(db, silo.id, true)).map((d) => ({
      objectTypeId: d.objectTypeId, properties: d.nominatedProperties, addedAt: d.addedAt, schedule: d.refreshSchedule,
    }))
    : (await siloObjectTypeRepo.listLive(db, silo.id)).map((n) => ({ objectTypeId: n.objectTypeId, properties: n.nominatedProperties, addedAt: n.addedAt }));
  const documents = silo.kind === 'import'
    && (silo.carveoutAcknowledgedAt !== null || (await siloDefinitionRepo.listForSilo(db, silo.id)).some((d) => d.requiresModel));
  const sizes = await storageMeasurementRepo.latestPerStore(db, silo.id);
  const size = sizes.length === 0 ? null : {
    bytes: sizes.reduce((sum, m) => sum + BigInt(m.bytesHeld), 0n).toString(),
    measuredAt: sizes.map((m) => m.measuredAt).sort().at(-1)!,
  };
  return {
    id: silo.id, kind: silo.kind, name: silo.name, purpose: silo.purpose, retentionDays: silo.retentionDays, location: silo.location,
    status: silo.status, store: silo.storeRef, createdAt: silo.createdAt, disabledAt: silo.disabledAt,
    objectTypes: nominations.map((n) => ({ objectTypeId: n.objectTypeId, properties: n.properties, addedAt: n.addedAt })),
    size, disclosure: disclosureOf(silo, nominations, manifest, documents),
    actionLedger: silo.actionLedgerEnabledAt === null ? 'off' : silo.actionLedgerIncludeValues === true ? 'values' : 'references',
  };
}

/** The view, with the ontology's names where the reader's manifest has them. */
export async function loadSiloView(deps: Pick<SiloesDeps, 'databases' | 'services'>, ctx: Context, siloId: string): Promise<SiloView> {
  const manifest = await readManifest(deps, ctx).catch(() => undefined);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => siloView(db, await loadSilo(db, siloId), manifest), { readOnly: true });
}
