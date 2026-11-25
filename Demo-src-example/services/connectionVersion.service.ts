import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound, refusal } from '../utils/error.util';
import { loadManifest } from '../engine/compat/load.compat';
import { V1_STRATEGY } from '../engine/compat/compile.compat';
import { paramsFor } from '../engine/read/params.read';
import { pinChanges, pinsFor, statementsOf, type Pins } from '../engine/read/pins.read';
import type { ManifestV2 } from '../schemas/manifest.schema';
import * as connectionRepo from '../repos/connection.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as lifecycle from '../repos/connectorVerify.repo';
import { log as writeAudit } from './audit.service';
import * as connectorService from './connector.service';
import { withConnection } from './connectorRuntime.service';
import { executeRead } from '../engine/read/execute.read';
import type { Actor } from './scope.service';

/**
 * Moving a connection to another version of its connector (MANIFEST-V2 §9.2, F19).
 *
 * ── A NEW VERSION IS A NEW DOCUMENT, AND A DOCUMENT DECIDES WHERE A
 * ── CREDENTIAL GOES ────────────────────────────────────────────────────────
 *
 * Publishing a version changes nothing for the connections on the old one.
 * Moving one across is an admin's act, and before it happens they are shown
 * what the new document does differently with their credential: any address it
 * would now send it to, any statement it would now run, and whether its
 * authentication, credentials or parameters changed. Where anything did, the
 * move needs them to confirm exactly what they were shown — the confirmation
 * is echoed back and checked, so a preview gone stale is not confirmation.
 *
 * ── A VERSION THE CONNECTION CANNOT USE IS REFUSED, NOT ADOPTED ───────────
 *
 * If the stored credential's strategy is not one the new version offers, or
 * it needs a parameter this connection does not have, moving would produce a
 * connection that fails at its first request. It is refused by name instead.
 */

const SECTIONS = ['transport', 'auth', 'credentials', 'parameters'] as const;

export interface AdoptionPreview {
  fromManifestId: string;
  toManifestId: string;
  toVersion: number;
  /** Where the credential would go after the move, and what differs from now. */
  pins: Pins;
  originsAdded: string[];
  originsRemoved: string[];
  statementsChanged: boolean;
  /** The statements the new version runs, as text, for the person to read. */
  statements: string[];
  /** Which of the security-relevant parts of the document differ. */
  sectionsChanged: Array<(typeof SECTIONS)[number]>;
  /** The version writes differently: writes are switched off until verified again. */
  writesChanged: boolean;
  needsConfirmation: boolean;
  /** Why the move cannot happen at all, when it cannot. */
  blockers: string[];
}

const canonical = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v));

async function preview(db: Parameters<Parameters<typeof withTransaction>[0]>[0], connection: connectorRepo.LoadedConnection, manifestId: string): Promise<AdoptionPreview & { target: ManifestV2 }> {
  const lineage = await connectionRepo.manifestLineage(db, connection.manifestId);
  const entry = lineage.find((v) => v.id === manifestId);
  if (!entry) throw notFound({ message: 'That is not a version of this connection’s connector.', code: 'missing.manifest_version' });
  if (manifestId === connection.manifestId) throw invalid({ message: 'The connection is already on that version.', code: 'invalid.same_version' });

  const stored = await connectionRepo.manifestDocument(db, manifestId);
  const loaded = stored ? loadManifest(stored.document, stored.schemaVersion) : null;
  if (!loaded || !loaded.ok) throw invalid({ message: 'That version of the connector is not a valid document.', code: 'invalid.manifest_stored' });
  const target = loaded.manifest;

  const before = connection.pins ?? (await pinsFor(connection.manifest, paramsFor(connection.manifest, connection.parameters, null)));
  const after = await pinsFor(target, paramsFor(target, connection.parameters, null));
  const changes = pinChanges(before, after);
  const sectionsChanged = SECTIONS.filter((section) => canonical((connection.manifest as Record<string, unknown>)[section]) !== canonical((target as Record<string, unknown>)[section]));

  const writesOf = (m: ManifestV2) => canonical(m.objects.map((o) => [o.name, (o as { write?: unknown }).write ?? null]));
  const writesChanged = writesOf(connection.manifest) !== writesOf(target);

  const blockers: string[] = [];
  const credentials = await connectorRepo.credentialsFor(db, [connection.connectionId]);
  const credential = credentials.get(connection.connectionId);
  if (credential) {
    const strategy = V1_STRATEGY[credential.authStrategy] ?? credential.authStrategy;
    if (!target.auth.some((a) => a.strategy === strategy)) {
      blockers.push(`Version ${entry.version} no longer signs in with ${strategy}, which is how this connection was connected. Reconnect it after moving, or stay on this version.`);
    }
  }
  for (const [name, parameter] of Object.entries(target.parameters)) {
    if (parameter.default === undefined && !connection.parameters[name]) {
      blockers.push(`Version ${entry.version} needs a setting this connection does not have: ${parameter.label ?? name}.`);
    }
  }

  return {
    target,
    fromManifestId: connection.manifestId,
    toManifestId: manifestId,
    toVersion: entry.version,
    pins: after,
    ...changes,
    statements: statementsOf(target),
    sectionsChanged,
    writesChanged,
    needsConfirmation: changes.originsAdded.length > 0 || changes.statementsChanged || sectionsChanged.length > 0,
    blockers,
  };
}

export async function adoption(actor: Actor, connectionId: string, manifestId: string): Promise<AdoptionPreview> {
  const connection = await connectorService.manageableConnection(actor, connectionId);
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => {
      const { target: _target, ...shown } = await preview(db, connection, manifestId);
      return shown;
    }),
  );
}

/**
 * Move the connection, pinning what was confirmed. `confirmed` must be
 * exactly what the preview showed; anything else — a preview older than a
 * publish, a list edited by hand — is refused.
 *
 * READ FIRST, MOVE SECOND (§3.7 step 2). Every available object of the new
 * version is read, one record each, through this connection with the new
 * document; any failure stops the move and names the object. A version that
 * cannot read what the old one could is not adopted and then discovered.
 */
export async function adopt(
  actor: Actor,
  connectionId: string,
  manifestId: string,
  confirmed: { origins: string[]; statements: string[] },
): Promise<{ manifestId: string; version: number; origins: string[] }> {
  const connection = await connectorService.manageableConnection(actor, connectionId);
  const inTenant = <T>(work: () => Promise<T>) => runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, work);
  const same = (a: string[], b: string[]) => [...a].sort().join('\n') === [...b].sort().join('\n');
  const check = (shown: Awaited<ReturnType<typeof preview>>) => {
    if (shown.blockers.length > 0) {
      throw refusal({ message: shown.blockers.join(' '), code: 'refusal.version_unusable', detail: { blockers: shown.blockers } });
    }
    if (!same(confirmed.origins, shown.pins.origins) || !same(confirmed.statements, shown.pins.statements)) {
      throw refusal({
        message: 'What was confirmed is not what this version would do now. Look at the change again and confirm it.',
        code: 'refusal.adoption_unconfirmed',
        detail: { origins: shown.pins.origins },
      });
    }
  };

  const shown = await inTenant(() => withTransaction((db) => preview(db, connection, manifestId)));
  check(shown);
  await readEveryObject(actor, connection, shown.target, shown.pins);

  return inTenant(() =>
    withTransaction(async (db) => {
      /* Looked at again inside the move: a publish between the read and now is not what was confirmed. */
      const now = await preview(db, connection, manifestId);
      check(now);
      await lifecycle.pointAtManifest(db, connectionId, manifestId);
      /* A write verified against one document is not verified against another (WP11). */
      if (now.writesChanged) await connectionRepo.disableWrites(db, connectionId);
      await connectionRepo.replacePins(db, { organisationId: actor.organisationId, connectionId, ...now.pins, confirmedBy: actor.membershipId });
      await writeAudit(db, {
        event: 'connection_version_adopted',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: {
          connectionId,
          fromManifestId: now.fromManifestId,
          toManifestId: manifestId,
          originsAdded: now.originsAdded,
          originsRemoved: now.originsRemoved,
          statementsChanged: now.statementsChanged,
        },
      });
      return { manifestId, version: now.toVersion, origins: now.pins.origins };
    }),
  );
}

/** One record of every available object, read with the candidate document and what was confirmed for it. */
async function readEveryObject(actor: Actor, connection: connectorRepo.LoadedConnection, target: ManifestV2, pins: Pins): Promise<void> {
  const kind = target.transport.kind;
  if (kind === 'inbound_webhook' || kind === 'email_fallback' || kind === 'queue_tap' || kind === 'silo_import') return;
  const credential = (await withTransaction((db) => connectorRepo.credentialsFor(db, [connection.connectionId]))).get(connection.connectionId);
  await withConnection({
    actor,
    connection: { ...connection, manifest: target, pins },
    credential,
    reason: 'connection-verify',
    use: async (open) => {
      for (const object of target.objects.filter((o) => o.available !== false)) {
        try {
          await executeRead(await open(object.name), { object: object.name, filters: [], sort: [], fields: [], limit: 1 });
        } catch (error) {
          const e = error as { code?: string; message?: string };
          throw refusal({
            message: `The new version could not read ${object.name}: ${e.message ?? 'it failed'}. The connection stays where it is.`,
            code: 'refusal.version_probe_failed',
            detail: { object: object.name, cause: e.code ?? null },
          });
        }
      }
    },
  });
}

/* ── Prebuilt connectors, moved weekly when nothing that matters changed ─ */

export interface AutoAdoption {
  connectionId: string;
  toManifestId: string;
  outcome: 'adopted' | 'needs_a_person' | 'failed';
  reason: string | null;
}

/**
 * Silo's own connectors, kept current for an organisation that asked (§3.7).
 *
 * ONLY WHEN THE MOVE NEEDS NOBODY'S CONFIRMATION — no new address for the
 * credential, no changed statement, no change to sign-in, credentials or
 * settings — and only after every object reads with the new version. Anything
 * else waits on the connection's page for a person. A tenant's own connectors
 * never move by themselves.
 */
export async function autoAdoptPrebuilt(actor: Actor): Promise<AutoAdoption[]> {
  const candidates = await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => ((await connectionRepo.autoAdoptEnabled(db, actor.organisationId)) ? connectionRepo.prebuiltBehind(db) : [])),
  );
  const out: AutoAdoption[] = [];
  for (const candidate of candidates) {
    try {
      const shown = await adoption(actor, candidate.connectionId, candidate.newestManifestId);
      if (shown.needsConfirmation || shown.blockers.length > 0) {
        out.push({ connectionId: candidate.connectionId, toManifestId: candidate.newestManifestId, outcome: 'needs_a_person', reason: shown.blockers[0] ?? 'The new version changes where the credential goes or how it signs in.' });
        continue;
      }
      await adopt(actor, candidate.connectionId, candidate.newestManifestId, { origins: shown.pins.origins, statements: shown.pins.statements });
      out.push({ connectionId: candidate.connectionId, toManifestId: candidate.newestManifestId, outcome: 'adopted', reason: null });
    } catch (error) {
      out.push({ connectionId: candidate.connectionId, toManifestId: candidate.newestManifestId, outcome: 'failed', reason: (error as Error).message?.slice(0, 300) ?? null });
    }
  }
  return out;
}
