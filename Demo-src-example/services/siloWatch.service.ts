import { MAX_IMPORT_FILE_BYTES as MAX_FILE_BYTES } from '../config/constants.config';
import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { AppError, invalid, notFound, policy, refusal, upstream } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { env } from '../config/env.config';
import { seal } from '../utils/envelope.util';
import { withSecret, type AccessLog } from '../utils/mediator.util';
import { wrapper } from '../infra/kms.infra';
import * as sftpDrop from '../infra/sftpDrop.infra';
import * as siloImportRepo from '../repos/siloImport.repo';
import * as siloRepo from '../repos/silo.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as rowStore from './rowStore.service';
import * as siloImport from './siloImport.service';
import { storageAllowed } from '../models/organisation.model';
import type { Actor } from './scope.service';

const log = childLogger('silo-watch');

/**
 * Siloes — Import §2, watched locations.
 *
 * ── A folder the organisation controls ─────────────────────────────────────
 *
 * An SFTP directory an export job writes into. Configured once by somebody
 * holding `silo.import`, with the host key they confirmed and a credential that
 * is sealed on arrival; after that a schedule looks for files modified since
 * the last one taken, and hands each to the same path an upload takes.
 *
 * ── Proved when configured, not discovered on the first night ──────────────
 *
 * Configuring connects, checks the key, authenticates and lists the directory
 * before anything is saved. A location that cannot be read is refused while the
 * person who typed it is still looking at the form.
 *
 * ── A failed pickup is recorded on the source, and nothing else moves ──────
 *
 * The cursor advances one file at a time, after that file is safely received,
 * so a pickup that fails part-way resumes where it stopped. Why it failed is a
 * code on the source rather than a message, because the message from an SSH
 * library can quote the host and the path, and neither belongs in a log line.
 */

type Db = Parameters<Parameters<typeof withTransaction>[0]>[0];

/** The schema's own cap on `silo_files.declared_bytes`. */

/** Files taken per pickup. The rest wait for the next one, oldest first. */
const PICKUP_BATCH = 50;

const purposeOf = (sourceId: string) => `silo-source:${sourceId}`;

function locationOf(host: string, port: number, directory: string): string {
  return `sftp://${host}:${port}${encodeURI(directory)}`;
}

function parseLocation(location: string): { host: string; port: number; directory: string } {
  const url = new URL(location);
  return { host: url.hostname, port: Number(url.port || 22), directory: decodeURI(url.pathname) };
}

/** `ledger-*.csv` — the wildcards anybody writes for a drop folder, and nothing else. */
function matcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

const joinPath = (directory: string, name: string) => `${directory.replace(/\/+$/, '')}/${name}`;

function tenant<T>(actor: Actor, work: (db: Db) => Promise<T>): Promise<T> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(work),
  );
}

async function assertStorageOn(db: Db, organisationId: string): Promise<void> {
  if (!env.SILOES_AVAILABLE) {
    throw refusal({ message: 'This deployment is built without storage.', code: 'refusal.siloes_compiled_out' });
  }
  const organisation = await organisationRepo.findById(db, organisationId);
  if (!organisation || !storageAllowed(organisation)) {
    throw refusal({
      message: 'Storage is switched off for this organisation. A super admin turns it on.',
      code: 'refusal.storage_disabled',
    });
  }
}

/**
 * Recorded as a connector credential's opening is — against the person whose
 * standing arrangement opened it, with the reason saying it was a pickup — under
 * its own event, because what was opened is a source and not a connection.
 */
function accessLogFor(organisationId: string, membershipId: string): AccessLog {
  return {
    async record(entry) {
      await runWithTenant({ organisationId, membershipId: null }, () =>
        withTransaction((db) =>
          writeAudit(db, {
            event: 'watch_credential_unwrapped',
            organisationId,
            membershipId,
            userId: null,
            detail: { sourceId: entry.subject, reason: entry.reason, outcome: entry.outcome },
            occurredAt: entry.at,
          }),
        ),
      );
    },
  };
}

/** What a person configuring a location is told when the server will not do. */
function refusedAtConfiguration(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof sftpDrop.BlockedAddress) {
    throw refusal({ message: error.message, code: 'refusal.blocked_host' });
  }
  if (error instanceof sftpDrop.HostKeyMismatch) {
    throw invalid({
      message:
        'The server presented a different host key from the one entered. Check the fingerprint with ' +
        'whoever runs the server before trusting it.',
      code: 'invalid.host_key_mismatch',
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/authentication|permission denied/i.test(message)) {
    throw invalid({ message: 'The server refused that username and credential.', code: 'invalid.watch_credentials' });
  }
  if (/no such file|ENOENT/i.test(message)) {
    throw invalid({ message: 'The server has no directory at that path.', code: 'invalid.watch_directory' });
  }
  throw upstream({ message: 'The server could not be reached.', code: 'upstream.sftp', cause: error });
}

/** Why a scheduled pickup could not run, as a code a person can act on. */
function failureCodeOf(error: unknown): string {
  if (error instanceof sftpDrop.HostKeyMismatch) return 'watch.host_key_changed';
  if (error instanceof sftpDrop.BlockedAddress) return 'watch.address_blocked';
  if (error instanceof AppError) {
    if (error.code === 'denial.clearance') return 'watch.configurer_not_cleared';
    if (error.code === 'denial.silo.import') return 'watch.configurer_not_permitted';
    if (error.code === 'refusal.storage_disabled' || error.code === 'refusal.siloes_compiled_out') return 'watch.storage_off';
    if (error.code === 'refusal.import_unconfigured') return 'watch.import_unconfigured';
    if (error.code.startsWith('missing.')) return 'watch.source_gone';
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/authentication|permission denied/i.test(message)) return 'watch.credentials_refused';
  if (/no such file|ENOENT/i.test(message)) return 'watch.directory_missing';
  if (/unable to authenticate data|unsupported state/i.test(message)) return 'watch.credential_unreadable';
  return 'watch.unreachable';
}

/* ── Configuring ─────────────────────────────────────────────────────────── */

/**
 * The host key a server presents, for somebody to compare with what its owner
 * says it should be. Nothing is sent to the server but a key exchange.
 */
export async function fingerprint(actor: Actor, input: { host: string; port: number }): Promise<{ fingerprint: string }> {
  await tenant(actor, async (db) => {
    assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.import');
  });

  try {
    return { fingerprint: await sftpDrop.presentedFingerprint(input) };
  } catch (error) {
    return refusedAtConfiguration(error);
  }
}

export async function configure(
  actor: Actor,
  input: {
    siloId: string;
    name: string;
    host: string;
    port: number;
    directory: string;
    pattern: string;
    fingerprint: string;
    username: string;
    secret: string;
    /** Take what is already in the folder, rather than only what arrives after today. */
    includeExisting: boolean;
  },
): Promise<siloImportRepo.SiloSource> {
  rowStore.assertAvailable();

  const check = (db: Db) =>
    (async () => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'silo.import');
      await assertStorageOn(db, actor.organisationId);
      const silo = await siloRepo.find(db, input.siloId);
      if (!silo || silo.disabledAt) throw notFound({ message: 'No such Silo.', code: 'missing.silo' });
      return silo;
    })();

  await tenant(actor, check);

  /* Proved before it is saved. Outside a transaction: this is a network call. */
  try {
    const drop = await sftpDrop.openDrop(input);
    try {
      await drop.list(input.directory);
    } finally {
      await drop.end();
    }
  } catch (error) {
    refusedAtConfiguration(error);
  }

  const sourceId = generateId();
  const sealed = await seal(input.secret, wrapper(), purposeOf(sourceId));

  return tenant(actor, async (db) => {
    const silo = await check(db);

    const source = await siloImportRepo
      .insertSource(db, {
        id: sourceId,
        organisationId: actor.organisationId,
        siloId: silo.id,
        kind: 'watched',
        name: input.name.trim(),
        location: locationOf(input.host, input.port, input.directory),
        createdBy: actor.membershipId,
        watchPattern: input.pattern,
        hostFingerprint: input.fingerprint,
        /* "Processed as they arrive": from now, unless the person asked for the backlog. */
        watchCursor: input.includeExisting ? null : new Date(),
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '23505') {
          throw policy({
            message: `${silo.name} already has an import called ${input.name.trim()}.`,
            code: 'policy.silo_source_name_taken',
          });
        }
        throw error;
      });

    await siloImportRepo.insertCredential(db, {
      id: generateId(),
      organisationId: actor.organisationId,
      sourceId,
      username: input.username,
      sealed,
      createdBy: actor.membershipId,
    });

    await writeAudit(db, {
      event: 'silo_source_created',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { siloId: silo.id, sourceId, kind: 'watched' },
    });

    return source;
  });
}

/** Stop watching. The credential is destroyed; what was already imported stays until purged. */
export async function stop(actor: Actor, sourceId: string): Promise<void> {
  await tenant(actor, async (db) => {
    assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.import');

    const source = await siloImportRepo.findSource(db, sourceId);
    if (!source || source.kind !== 'watched' || source.retiredAt) {
      throw notFound({ message: 'No such watched location.', code: 'missing.silo_source' });
    }

    await siloImportRepo.retireSource(db, sourceId);
    await siloImportRepo.deleteCredential(db, sourceId);

    await writeAudit(db, {
      event: 'silo_source_retired',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { siloId: source.siloId, sourceId, kind: source.kind },
    });
  });
}

/* ── Picking up ──────────────────────────────────────────────────────────── */

export type PollOutcome =
  | { status: 'inactive' }
  | { status: 'failed'; failureCode: string }
  | { status: 'polled'; picked: number; skipped: number };

/** A person asking for a pickup now, rather than waiting for the schedule. */
export async function pollNow(actor: Actor, sourceId: string): Promise<PollOutcome> {
  await tenant(actor, async (db) => {
    assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.import');
    const source = await siloImportRepo.findSource(db, sourceId);
    if (!source || source.kind !== 'watched' || source.retiredAt) {
      throw notFound({ message: 'No such watched location.', code: 'missing.silo_source' });
    }
  });

  return poll(actor.organisationId, sourceId);
}

/**
 * Look in a watched location and take what is new.
 *
 * ── Oldest first, one file at a time ───────────────────────────────────────
 *
 * Each file is received, and the cursor moved past it, before the next is
 * fetched. A pickup interrupted after the tenth file starts at the eleventh.
 *
 * ── What is skipped is skipped for good ────────────────────────────────────
 *
 * An empty file, or one past the 64 MB an import reads, moves the cursor
 * without being imported — otherwise one oversized export would stop every
 * file behind it for ever. It is counted in the outcome so it is not silent.
 */
export async function poll(organisationId: string, sourceId: string): Promise<PollOutcome> {
  const within = <T>(work: (db: Db) => Promise<T>) =>
    runWithTenant({ organisationId, membershipId: null }, () => withTransaction(work));

  const loaded = await within(async (db) => {
    const source = await siloImportRepo.findSource(db, sourceId);
    if (!source || source.kind !== 'watched' || source.retiredAt || !source.location || !source.hostFingerprint) {
      return null;
    }
    const silo = await siloRepo.find(db, source.siloId);
    const credential = await siloImportRepo.credentialOf(db, sourceId);
    return silo && !silo.disabledAt && credential ? { source, credential } : null;
  });

  if (!loaded) return { status: 'inactive' };

  const { source, credential } = loaded;
  const { host, port, directory } = parseLocation(source.location!);
  const pattern = matcher(source.watchPattern ?? '*');

  let cursor = source.watchCursor;
  let atCursor = new Set(source.watchCursorNames);
  let picked = 0;
  let skipped = 0;

  try {
    rowStore.assertAvailable();

    await withSecret(
      credential.sealed,
      { wrapper: wrapper(), log: accessLogFor(organisationId, source.createdBy) },
      { reason: 'watch-pickup', subject: sourceId, additionalData: purposeOf(sourceId) },
      async (secret) => {
        const drop = await sftpDrop.openDrop({
          host,
          port,
          username: credential.username,
          secret,
          fingerprint: source.hostFingerprint!,
        });

        try {
          const arrived = (await drop.list(directory))
            .filter((entry) => pattern.test(entry.name))
            .filter(
              (entry) =>
                !cursor ||
                entry.modifiedAt.getTime() > cursor.getTime() ||
                (entry.modifiedAt.getTime() === cursor.getTime() && !atCursor.has(entry.name)),
            )
            .sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime() || a.name.localeCompare(b.name))
            .slice(0, PICKUP_BATCH);

          for (const entry of arrived) {
            if (entry.bytes === 0 || entry.bytes > MAX_FILE_BYTES) {
              skipped += 1;
            } else {
              try {
                const body = await drop.get(joinPath(directory, entry.name), MAX_FILE_BYTES);
                await siloImport.receiveWatched({ organisationId, sourceId, filename: entry.name, body });
                picked += 1;
              } catch (error) {
                /* Grew past the cap between the listing and the fetch. */
                if (!(error instanceof sftpDrop.FileTooLarge)) throw error;
                skipped += 1;
              }
            }

            await within((db) =>
              siloImportRepo.advanceCursor(db, { id: sourceId, modifiedAt: entry.modifiedAt, name: entry.name }),
            );
            if (cursor && entry.modifiedAt.getTime() === cursor.getTime()) {
              atCursor.add(entry.name);
            } else {
              cursor = entry.modifiedAt;
              atCursor = new Set([entry.name]);
            }
          }
        } finally {
          await drop.end();
        }
      },
    );
  } catch (error) {
    const failureCode = failureCodeOf(error);
    log.warn({ sourceId, failureCode, picked }, 'A watched location could not be picked up from');
    await within((db) => siloImportRepo.recordPoll(db, { id: sourceId, failureCode }));
    return { status: 'failed', failureCode };
  }

  await within((db) => siloImportRepo.recordPoll(db, { id: sourceId, failureCode: null }));
  if (picked + skipped > 0) log.info({ sourceId, picked, skipped }, 'Picked up from a watched location');
  return { status: 'polled', picked, skipped };
}
