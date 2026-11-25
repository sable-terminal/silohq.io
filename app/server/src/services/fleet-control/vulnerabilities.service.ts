// SBOM checks (spec 11.1): "SBOMs are checked for vulnerabilities daily; a critical one in a
// reachable component blocks stable."
//
// - SBOMs: each release's, as the manifest names them by digest, received after it is
//   registered and read into components (sbom.service.ts). A digest that differs from the
//   manifest's is refused, so the SBOM checked is the one signed.
// - Advisories: a mirror of OSV's exports (infra/advisoryFeed.infra.ts), one feed per
//   ecosystem the live releases' components come from (and FLEET_ADVISORY_ECOSYSTEMS). A
//   feed is loaded whole from all.zip the first time, read by range, then kept in step from
//   modified_id.csv, newest first, as far back as it last reached less a day's margin for
//   the export's own lag; more than FULL_RELOAD_ABOVE changes loads it whole again. A
//   replica holds a feed's lease while it syncs, so replicas never sync one feed at once.
// - Findings: a component an advisory affects (advisories.service.ts), with the advisory's
//   rating, or the highest rating of the records it shares an alias with when it has none.
//   It blocks when critical, unless the latest VEX statement for the release, the advisory
//   (or an alias) and the component says not_affected or fixed: reachability is what the
//   security officer states, never assumed (spec 11.6: the security officer's capability).
// - The gate: promotion into stable, sovereign and their agent channels needs every SBOM
//   of the channel's artefacts (images, or agent binaries), every feed they draw on synced
//   within FLEET_ADVISORY_MAX_AGE_HOURS, and no blocking finding, checked again inside the
//   promotion's own transaction. A missing SBOM or a stale feed refuses, as "a missing
//   health signal is a failure" (spec 11.2).
// - Daily: the worker syncs each feed due, then checks every live release again (a channel
//   head, a release with a promotion pending, or one registered in the last 30 days). A
//   blocking finding on stable's head is logged for the security officer to act on.

import { releaseManifest, type Channel, type ReleaseManifest } from '../../contracts/fleet-control/release.contract.ts';
import type { AdvisorySource } from '../../infra/advisoryFeed.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import {
  advisoryFeedRepo, advisoryPackageRepo, advisoryRepo, channelHeadRepo, fleetLockRepo, releaseComponentRepo, releaseFindingRepo,
  releaseRepo, releaseSbomRepo, sbomCheckRepo, vexStatementRepo,
} from '../../repos/fleet/index.repo.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { parsePurl, purlIdentity } from '../../utils/purl.util.ts';
import { zipContents, zipEntries } from '../../utils/zip.util.ts';
import { advisoryOf, affects, higher, packagesOf, type OsvAdvisory, type Rating } from './advisories.service.ts';
import type { ArtefactStore } from './artefactStore.service.ts';
import { readSbom, readVex } from './sbom.service.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MARGIN_MS = DAY;
const LEASE_MS = 2 * HOUR;
const LIVE_MS = 30 * DAY;
const FULL_RELOAD_ABOVE = 5_000;
const UPSERT_BATCH = 500;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

export interface SbomDeps {
  databases: Databases;
  store: ArtefactStore;
  feed: AdvisorySource;
  logger: Logger;
  syncEveryMs: number;
  maxAgeMs: number;
  /** Feeds kept in step whatever the releases hold. */
  extraFeeds: readonly string[];
  now?: () => number;
}

export interface CheckResult { components: number; unmatched: number; findings: number; blocking: number }
export interface FeedOutcome { feed: string; outcome: 'synced' | 'busy' | 'failed'; advisories: number; error?: string }

/** The export an ecosystem's advisories are in: OSV's ecosystem without its release. */
export const feedOf = (ecosystem: string): string => ecosystem.split(':')[0]!;

const familyOf = (channel: Channel): 'image' | 'agent' | undefined =>
  channel === 'stable' || channel === 'sovereign' ? 'image' : channel === 'agent-stable' || channel === 'agent-sovereign' ? 'agent' : undefined;

const expectedSboms = (manifest: ReleaseManifest) => [
  ...manifest.images.map((i) => ({ digest: i.sbom.digest, format: i.sbom.format, subject: `image:${i.service}` })),
  ...manifest.agentBinaries.map((a) => ({ digest: a.sbom.digest, format: a.sbom.format, subject: `agent:${a.platform}` })),
];

const refuse = (code: string, message: string, details?: Record<string, string | number>): never => {
  throw new AppError('conflict', message, { code, ...(details ? { details } : {}) });
};

export function createSbomChecks(deps: SbomDeps) {
  const pool = deps.databases.pool('directory');
  const now = deps.now ?? Date.now;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const read = <T>(work: (db: Queryable) => Promise<T>): Promise<T> => inTransaction(pool, {}, work, { readOnly: true });
  const locked = <T>(work: (db: Queryable) => Promise<T>): Promise<T> =>
    inTransaction(pool, {}, async (db) => {
      await fleetLockRepo.lock(db);
      return work(db);
    });

  /** Matches a release's components against the mirror, and records what it found. */
  async function check(db: Queryable, releaseId: string): Promise<CheckResult> {
    const time = iso(now());
    const candidates = await advisoryRepo.candidatesFor(db, releaseId);
    const counts = await releaseComponentRepo.countsFor(db, releaseId);
    const unrated = candidates.filter((c) => c.severity === 'unrated');
    const keys = [...new Set(unrated.flatMap((c) => [c.advisoryId, ...c.aliases]))];
    const relatives = keys.length === 0 ? [] : await advisoryRepo.ratedSharing(db, keys);
    const statements = await vexStatementRepo.forRelease(db, releaseId);

    const findings: Parameters<typeof releaseFindingRepo.record>[2][number][] = [];
    for (const c of candidates) {
      const outcome = affects({ affected: c.affected }, c.ecosystem, c.name, c.version);
      if (outcome === 'not_affected') continue;
      let severity: Rating = c.severity;
      let score = c.score;
      if (severity === 'unrated') {
        const names = new Set([c.advisoryId, ...c.aliases]);
        for (const r of relatives) {
          if (r.id === c.advisoryId || !(names.has(r.id) || r.aliases.some((a) => names.has(a)))) continue;
          severity = higher(severity, r.severity);
          if (r.score !== null && (score === null || r.score > score)) score = r.score;
        }
      }
      const purl = parsePurl(c.purl);
      const identities = purl === undefined ? [] : [purlIdentity(purl), purlIdentity(purl, false)];
      const names = new Set([c.advisoryId, ...c.aliases].map((n) => n.toUpperCase()));
      const statement = statements.filter((s) => names.has(s.vulnerability.toUpperCase()) && identities.includes(s.purl)).at(-1);
      const stated = statement !== undefined && (statement.status === 'not_affected' || statement.status === 'fixed');
      findings.push({
        advisoryId: c.advisoryId, purl: c.purl, subject: c.subject, severity, score, resolution: outcome,
        vexStatementId: statement?.id ?? null, blocking: severity === 'critical' && !stated,
      });
    }
    await releaseFindingRepo.record(db, releaseId, findings, time);
    const result = { ...counts, findings: findings.length, blocking: findings.filter((f) => f.blocking).length };
    await sbomCheckRepo.record(db, { releaseId, checkedAt: time, ...result });
    return result;
  }

  /** Promotion's SBOM gate, in the promotion's transaction (fleet.service.ts checkPromotion). */
  async function gate(db: Queryable, manifest: ReleaseManifest, channel: Channel): Promise<void> {
    const family = familyOf(channel);
    if (family === undefined) return;
    const received = await releaseSbomRepo.forRelease(db, manifest.releaseId);
    const missing = expectedSboms(manifest).filter((e) => e.subject.startsWith(`${family}:`) && !received.some((r) => r.digest === e.digest));
    if (missing.length > 0) {
      refuse('fleet.sbom_missing', `${channel} takes releases whose SBOMs have been received and checked; missing: ${missing.map((m) => m.subject).join(', ')}`,
        { missing: missing.map((m) => m.subject).join(',') });
    }
    const feeds = [...new Set((await releaseComponentRepo.ecosystemsFor(db, [manifest.releaseId])).map(feedOf))];
    const state = await advisoryFeedRepo.forFeeds(db, feeds);
    const stale = feeds.filter((f) => {
      const synced = state.find((s) => s.feed === f)?.lastSyncedAt;
      return synced == null || now() - Date.parse(synced) > deps.maxAgeMs;
    });
    if (stale.length > 0) {
      refuse('fleet.advisories_stale', `the advisories for ${stale.join(', ')} are older than the check allows; sync them, then promote`,
        { feeds: stale.join(',') });
    }
    await check(db, manifest.releaseId);
    const blocking = await releaseFindingRepo.blockingFor(db, manifest.releaseId, family);
    if (blocking.length > 0) {
      const ids = [...new Set(blocking.map((b) => b.advisoryId))];
      refuse('fleet.sbom_blocking', `${ids.length} critical advisories affect this release's ${family === 'image' ? 'images' : 'agent binaries'}: `
        + 'ship a fix, or have the security officer state in a VEX document that the component is not affected', { advisories: ids.slice(0, 20).join(',') });
    }
  }

  const digestOf = (document: string, hex: string): string => {
    const actual = sha256(Buffer.from(document, 'utf8')).toString('hex');
    if (actual !== hex) throw new AppError('validation', 'the document\'s SHA-256 is not the one named', { code: 'fleet.document_digest_mismatch' });
    return `sha256:${hex}`;
  };

  const requireManifest = async (db: Queryable, releaseId: string): Promise<ReleaseManifest> => {
    const row = await releaseRepo.findByReleaseId(db, releaseId);
    if (row === undefined) throw new AppError('not_found', 'no such release', { code: 'fleet.release_unknown', details: { releaseId } });
    return releaseManifest.parse(row.manifest);
  };

  // --------------------------------------------------------------------------- the mirror

  async function upsert(feed: string, advisories: OsvAdvisory[]): Promise<number> {
    if (advisories.length === 0) return 0;
    return inTransaction(pool, {}, async (db) => {
      const changed = await advisoryRepo.upsertMany(db, advisories, feed, iso(now()));
      const kept = new Set(changed);
      await advisoryPackageRepo.replaceFor(db, changed, advisories.filter((a) => kept.has(a.id))
        .flatMap((a) => packagesOf(a).map((p) => ({ advisoryId: a.id, ...p }))));
      return changed.length;
    });
  }

  async function loadWhole(feed: string): Promise<number> {
    const path = `${feed}/all.zip`;
    const size = await deps.feed.size(path);
    if (size === undefined) throw new AppError('not_found', `the advisory feed has no export for ${feed}`, { code: 'fleet.advisory_feed_missing' });
    const source = { size, read: (start: number, end: number) => deps.feed.read(path, start, end) };
    const archive = await zipEntries(source);
    let batch: OsvAdvisory[] = [];
    let count = 0;
    for await (const { entry, body } of zipContents(source, archive)) {
      if (!entry.name.endsWith('.json')) continue;
      let record: unknown;
      try {
        record = JSON.parse(body.toString('utf8'));
      } catch {
        continue;
      }
      const advisory = advisoryOf(record);
      if (advisory === undefined) continue;
      batch.push(advisory);
      if (batch.length >= UPSERT_BATCH) {
        count += await upsert(feed, batch);
        batch = [];
      }
    }
    return count + await upsert(feed, batch);
  }

  async function loadChanged(feed: string, ids: readonly string[]): Promise<number> {
    let batch: OsvAdvisory[] = [];
    let count = 0;
    for (const id of ids) {
      const text = await deps.feed.text(`${feed}/${id}.json`);
      if (text === undefined) continue;
      let advisory: OsvAdvisory | undefined;
      try {
        advisory = advisoryOf(JSON.parse(text));
      } catch {
        advisory = undefined;
      }
      if (advisory === undefined) continue;
      batch.push(advisory);
      if (batch.length >= UPSERT_BATCH) {
        count += await upsert(feed, batch);
        batch = [];
      }
    }
    return count + await upsert(feed, batch);
  }

  async function syncFeed(feed: string): Promise<FeedOutcome> {
    const startedAt = now();
    const claimed = await inTransaction(pool, {}, (db) => advisoryFeedRepo.claim(db, feed, iso(startedAt), iso(startedAt + LEASE_MS)));
    if (claimed === undefined) return { feed, outcome: 'busy', advisories: 0 };
    try {
      let changed: number;
      if (claimed.syncedThrough === null) {
        changed = await loadWhole(feed);
      } else {
        const since = Date.parse(claimed.syncedThrough);
        const ids: string[] = [];
        let whole = false;
        for await (const line of deps.feed.lines(`${feed}/modified_id.csv`)) {
          const comma = line.indexOf(',');
          const modified = Date.parse(line.slice(0, comma));
          if (comma < 0 || Number.isNaN(modified)) continue;
          if (modified < since) break;
          const id = line.slice(comma + 1).trim().split('/').pop()!;
          if (!ID.test(id)) continue;
          ids.push(id);
          if (ids.length > FULL_RELOAD_ABOVE) {
            whole = true;
            break;
          }
        }
        changed = whole ? await loadWhole(feed) : await loadChanged(feed, ids);
      }
      const advisories = await inTransaction(pool, {}, (db) =>
        advisoryFeedRepo.finish(db, feed, { syncedThrough: iso(startedAt - MARGIN_MS), lastSyncedAt: iso(startedAt) }));
      deps.logger.info('advisory feed synced', { event: 'fleet.advisories_synced', resourceType: 'advisory_feed', resourceId: feed, count: changed });
      return { feed, outcome: 'synced', advisories };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'failed';
      await inTransaction(pool, {}, (db) => advisoryFeedRepo.fail(db, feed, message)).catch(() => undefined);
      deps.logger.failure('an advisory feed did not sync; the next run tries again', error, { event: 'fleet.advisories_sync_failed', resourceId: feed });
      return { feed, outcome: 'failed', advisories: 0, error: message };
    }
  }

  /** Syncs each feed due (or every feed, when forced), then checks every live release again. */
  async function run(force: boolean): Promise<{ feeds: FeedOutcome[]; checked: number }> {
    const time = now();
    const live = await read((db) => releaseRepo.live(db, iso(time - LIVE_MS)));
    const feeds = new Set(deps.extraFeeds);
    for (const ecosystem of await read((db) => releaseComponentRepo.ecosystemsFor(db, live))) feeds.add(feedOf(ecosystem));
    const state = await read((db) => advisoryFeedRepo.forFeeds(db, [...feeds]));
    const due = [...feeds].sort().filter((f) => {
      const synced = state.find((s) => s.feed === f)?.lastSyncedAt;
      return force || synced == null || time - Date.parse(synced) >= deps.syncEveryMs;
    });
    const outcomes: FeedOutcome[] = [];
    for (const feed of due) outcomes.push(await syncFeed(feed));
    let checked = 0;
    if (outcomes.some((o) => o.outcome === 'synced')) {
      const stableHead = (await read((db) => channelHeadRepo.latest(db, 'stable')))?.releaseId;
      for (const releaseId of live) {
        const result = await locked((db) => check(db, releaseId));
        checked += 1;
        if (releaseId === stableHead && result.blocking > 0) {
          deps.logger.warn('a critical advisory affects the release on stable', {
            event: 'fleet.stable_release_vulnerable', resourceType: 'release', resourceId: releaseId, count: result.blocking,
          });
        }
      }
    }
    return { feeds: outcomes, checked };
  }

  return {
    check,
    gate,
    run,

    /** An SBOM the release names, received; its components are checked at once. */
    async putSbom(releaseId: string, hex: string, document: string, operatorId: string) {
      const digest = digestOf(document, hex);
      const manifest = await read((db) => requireManifest(db, releaseId));
      const named = expectedSboms(manifest).find((e) => e.digest === digest);
      if (named === undefined) throw new AppError('validation', 'the release names no SBOM with that digest', { code: 'fleet.sbom_not_in_release' });
      const { components, withoutPurl } = readSbom(document, named.format);
      await deps.store.create(`releases/${releaseId}/sboms/${hex}.json`, Buffer.from(document, 'utf8'));
      return locked(async (db) => {
        if (await releaseSbomRepo.findByKey(db, { releaseId, digest }) === undefined) {
          await releaseSbomRepo.insert(db, {
            releaseId, digest, format: named.format, subject: named.subject, components: components.length, withoutPurl,
            receivedBy: operatorId, receivedAt: iso(now()),
          });
          await releaseComponentRepo.insertMany(db, releaseId, digest, components);
        }
        const result = await check(db, releaseId);
        // components: this SBOM's; unmatched, findings and blocking: the release's, all its SBOMs together.
        return { ...result, releaseId, digest, format: named.format, subject: named.subject, components: components.length, withoutPurl };
      });
    },

    /** A VEX document about the release, from the security officer: its statements apply at once. */
    async putVex(releaseId: string, hex: string, document: string, operatorId: string) {
      const digest = digestOf(document, hex);
      const entries = readVex(document);
      await read((db) => requireManifest(db, releaseId));
      await deps.store.create(`releases/${releaseId}/vex/${hex}.json`, Buffer.from(document, 'utf8'));
      return locked(async (db) => {
        const stated = await vexStatementRepo.countForDocument(db, releaseId, digest);
        if (stated === 0) {
          const at = iso(now());
          for (const e of entries) {
            await vexStatementRepo.insert(db, {
              id: uuidv7(), releaseId, vulnerability: e.vulnerability, purl: e.purl, status: e.status, justification: e.justification,
              impactStatement: e.impactStatement, documentDigest: digest, statedBy: operatorId, statedAt: at,
            });
          }
        }
        const result = await check(db, releaseId);
        return { releaseId, digest, statements: stated === 0 ? entries.length : stated, ...result };
      });
    },

    /** What the release's SBOMs hold and what affects them. */
    async findings(releaseId: string) {
      return read(async (db) => {
        const manifest = await requireManifest(db, releaseId);
        const received = await releaseSbomRepo.forRelease(db, releaseId);
        const checked = await sbomCheckRepo.findByReleaseId(db, releaseId);
        const feeds = [...new Set((await releaseComponentRepo.ecosystemsFor(db, [releaseId])).map(feedOf))].sort();
        const state = await advisoryFeedRepo.forFeeds(db, feeds);
        return {
          releaseId,
          sboms: expectedSboms(manifest).map((e) => {
            const r = received.find((x) => x.digest === e.digest);
            return { subject: e.subject, digest: e.digest, format: e.format, receivedAt: r ? iso(Date.parse(r.receivedAt)) : null, components: r?.components ?? null };
          }),
          checkedAt: checked ? iso(Date.parse(checked.checkedAt)) : null,
          components: checked?.components ?? 0, unmatched: checked?.unmatched ?? 0, blocking: checked?.blocking ?? 0,
          feeds: feeds.map((f) => {
            const s = state.find((x) => x.feed === f);
            return { feed: f, lastSyncedAt: s?.lastSyncedAt ? iso(Date.parse(s.lastSyncedAt)) : null, lastError: s?.lastError ?? null };
          }),
          findings: (await releaseFindingRepo.openFor(db, releaseId)).map((f) => ({
            advisoryId: f.advisoryId, aliases: f.aliases, summary: f.summary, purl: f.purl, subject: f.subject, severity: f.severity,
            score: f.score, resolution: f.resolution, blocking: f.blocking, vexStatus: f.vexStatus, firstFoundAt: iso(Date.parse(f.firstFoundAt)),
          })),
        };
      });
    },
  };
}

export type SbomChecks = ReturnType<typeof createSbomChecks>;
