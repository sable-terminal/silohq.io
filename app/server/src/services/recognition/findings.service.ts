// Reading findings, and the organisation disposition that tunes thresholds (spec 38.3, 38.5,
// 38.9 to 38.11).
//
// Visibility: a finding is shown only to a reader who can see its object type and every
// property it names (with no field policy), and who satisfies every marking on it (spec
// 38.11). Findings the reader cannot see are counted, never described.
//
// Tuning (38.5): only organisation dispositions count. After a disposition, each threshold
// the finding was raised under weighs the dispositions recorded since it last moved: from
// five on, mostly dismissed raises it and mostly confirmed lowers it, by at most a quarter.
// Every movement is audited with its evidence. Lens dispositions never count.

import { accessToLens } from './lensAccess.service.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { credibleInterval } from '../../utils/bayes.util.ts';
import type { DISPOSITIONS, FindingView } from '../../contracts/recognition/finding.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Finding } from '../../models/recognition/finding.model.ts';
import {
  detectorRepo, detectorRunRepo, detectorThresholdRepo, findingConnectionRepo, findingLinkRepo, findingMarkingRepo, findingObjectRepo, findingRepo,
  findingScoreRepo, lensDispositionRepo, lensRepo,
} from '../../repos/recognition/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { access, demand, member, readManifest, recordEvent, actor, type Context, type RecognitionDeps } from './deps.service.ts';
import { CEILING, isFederated, PER_PROPERTY, tunedThreshold } from './detectors.service.ts';

type Disposition = (typeof DISPOSITIONS)[number];

const notFound = (): AppError => new AppError('not_found', 'no such finding', { code: 'recognition.finding_not_found' });

interface Assembled { finding: Finding; view: FindingView; propertyIds: string[] }

/** Every part of each finding, in one read. */
/** How often findings of this detector on this type proved useful, where the organisation turned inference on (D73). */
async function usefulnessOf(db: Queryable, findings: readonly Finding[]): Promise<Map<string, FindingView['usefulness']>> {
  const out = new Map<string, FindingView['usefulness']>();
  if (findings.length === 0) return out;
  const organisation = await organisationRepo.findById(db, findings[0]!.organisationId);
  if (organisation?.inferenceFindings !== true) return out;
  for (const key of new Set(findings.map((f) => `${f.detectorId}/${f.objectTypeId}`))) {
    const [detectorId, objectTypeId] = key.split('/') as [string, string];
    const { confirmed, dismissed } = await findingRepo.dispositionsSince(db, detectorId, objectTypeId, null, '1970-01-01T00:00:00Z');
    const decided = confirmed + dismissed;
    const round = (x: number) => Math.round(x * 10_000) / 10_000;
    const [lo, hi] = credibleInterval(confirmed, decided);
    out.set(key, {
      probability: round((confirmed + 1) / (decided + 2)), interval: [round(lo), round(hi)], confirmed, dismissed,
      statement: `Inferred from your organisation's dispositions of this detector's findings on this type: ${confirmed} confirmed, ${dismissed} dismissed. `
        + 'The finding is a computed fact; this is how often such findings proved useful.',
    });
  }
  return out;
}

export async function assemble(db: Queryable, findings: readonly Finding[], manifest: OntologyManifest, lensId: string | undefined): Promise<Assembled[]> {
  const ids = findings.map((f) => f.id);
  const usefulness = await usefulnessOf(db, findings);
  const [objects, connections, markings, scores, links, runs, registry, lens] = await Promise.all([
    findingObjectRepo.listFor(db, ids), findingConnectionRepo.listFor(db, ids), findingMarkingRepo.listFor(db, ids), findingScoreRepo.listFor(db, ids),
    findingLinkRepo.listFor(db, ids), detectorRunRepo.listByIds(db, [...new Set(findings.map((f) => f.detectorRunId))]), detectorRepo.listActive(db),
    lensId === undefined ? Promise.resolve([]) : lensDispositionRepo.listFor(db, lensId, ids),
  ]);
  const group = <T extends { findingId: string }>(rows: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.findingId, [...(map.get(row.findingId) ?? []), row]);
    return map;
  };
  const objectsOf = group(objects);
  const connectionsOf = group(connections);
  const markingsOf = group(markings);
  const linksOf = group(links);
  return findings.map((f) => {
    const type = manifest.objectTypes.find((t) => t.id === f.objectTypeId);
    const propertyIds = f.properties.map((name) => type?.properties.find((p) => p.apiName === name)?.identityId ?? '');
    const run = runs.find((r) => r.id === f.detectorRunId);
    const computation = f.computation as FindingView['computation'];
    return {
      finding: f, propertyIds,
      view: {
        id: f.id, detector: registry.find((d) => d.id === f.detectorId)?.key ?? 'retired', detectorVersion: run?.detectorVersion ?? '',
        runId: f.detectorRunId, objectTypeId: f.objectTypeId, objectIds: (objectsOf.get(f.id) ?? []).map((o) => o.objectKey),
        properties: f.properties, connectionIds: (connectionsOf.get(f.id) ?? []).map((c) => c.connectionId),
        markingIds: (markingsOf.get(f.id) ?? []).map((m) => m.markingId), computation, coverage: f.coverage as FindingView['coverage'],
        score: Number(scores.find((s) => s.findingId === f.id)?.score ?? 0),
        links: (linksOf.get(f.id) ?? []).map((l) => ({ findingId: l.linkedFindingId, sharedObjects: l.sharedRefsCount })),
        orgDisposition: f.orgDisposition, lensDisposition: lens.find((d) => d.findingId === f.id)?.disposition ?? null,
        usefulness: usefulness.get(`${f.detectorId}/${f.objectTypeId}`) ?? null,
        current: f.supersededAt === null, raisedAt: f.raisedAt, supersededAt: f.supersededAt, version: f.version,
      },
    };
  });
}

/** Keeps what the reader may see (38.11): one policy decision for the batch. */
export async function visibleTo(deps: RecognitionDeps, ctx: Context, assembled: readonly Assembled[], asMembershipId?: string)
  : Promise<{ visible: Assembled[]; withheld: number }> {
  if (assembled.length === 0) return { visible: [], withheld: 0 };
  const decision = await access(deps, ctx, {
    objectTypes: assembled.map((a) => a.finding.objectTypeId),
    properties: assembled.flatMap((a) => a.propertyIds.filter((id) => id !== '')),
    markings: assembled.flatMap((a) => a.view.markingIds),
  }, asMembershipId);
  const visible = assembled.filter((a) => decision.allowed && decision.typeVisible(a.finding.objectTypeId)
    && a.propertyIds.every((id) => id !== '' && decision.propertyClear(id)) && a.view.markingIds.every((m) => decision.markingSatisfied(m)));
  return { visible, withheld: assembled.length - visible.length };
}

/** A Lens applied by its owner, or by a member it is shared with to use or copy (38.9); otherwise not found. */
async function ownLens(db: Queryable, membershipId: string, lensId: string): Promise<void> {
  const lens = await lensRepo.findById(db, lensId);
  const held = lens === undefined ? undefined : await accessToLens(db, lens, membershipId);
  if (held === undefined || held === 'view') {
    throw new AppError('not_found', 'no such Lens', { code: 'recognition.lens_not_found' });
  }
}

export async function listFindings(deps: RecognitionDeps, ctx: Context, query: {
  objectTypeId?: string | undefined; detector?: string | undefined; detectorId?: string | undefined; includeSuperseded: boolean;
  lensId?: string | undefined; limit: number;
}): Promise<{ findings: FindingView[]; withheld: number; silenced: number }> {
  const who = actor(ctx);
  if (query.lensId !== undefined) member(ctx);
  const manifest = await readManifest(deps, ctx);
  const assembled = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    if (query.lensId !== undefined) await ownLens(db, who.membershipId!, query.lensId);
    const byKey = query.detector === undefined ? undefined : (await detectorRepo.findByKey(db, query.detector))?.id;
    if (query.detector !== undefined && (byKey === undefined || (query.detectorId !== undefined && byKey !== query.detectorId))) return [];
    const detectorId = byKey ?? query.detectorId;
    const rows = await findingRepo.list(db, {
      ...(query.objectTypeId === undefined ? {} : { objectTypeId: query.objectTypeId }), ...(detectorId === undefined ? {} : { detectorId }),
      includeSuperseded: query.includeSuperseded, limit: query.limit,
    });
    return assemble(db, rows, manifest, query.lensId);
  }, { readOnly: true });
  const { visible, withheld } = await visibleTo(deps, ctx, assembled);
  // A dismissal in the reader's Lens silences the finding for them only (38.9).
  const shown = visible.filter((a) => a.view.lensDisposition !== 'dismissed');
  return { findings: shown.map((a) => a.view), withheld, silenced: visible.length - shown.length };
}

/** Home's new findings (spec 33.7): raised since a moment on these types, as the reader may see them, newest first. */
export async function listFindingsRaisedSince(deps: RecognitionDeps, ctx: Context, input: { since: string; objectTypeIds: string[]; limit: number }) {
  const who = member(ctx);
  const manifest = await readManifest(deps, ctx);
  const { assembled, names, more } = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const rows = (await findingRepo.list(db, { objectTypeIds: input.objectTypeIds, raisedSince: input.since, includeSuperseded: false, limit: input.limit + 1 }))
      .filter((f) => f.orgDisposition !== 'dismissed');
    const registry = await detectorRepo.listActive(db);
    return {
      assembled: await assemble(db, rows.slice(0, input.limit), manifest, undefined),
      names: new Map(registry.map((d) => [d.key, d.name])), more: rows.length > input.limit,
    };
  }, { readOnly: true });
  const { visible, withheld } = await visibleTo(deps, ctx, assembled);
  return {
    findings: visible.map(({ view }) => {
      const type = manifest.objectTypes.find((t) => t.id === view.objectTypeId);
      return { finding: view, detectorName: names.get(view.detector) ?? view.detector, objectTypeName: type?.displayName ?? 'object', objectTypePlural: type?.pluralName ?? 'objects' };
    }),
    more, withheld,
  };
}

export async function getFinding(deps: RecognitionDeps, ctx: Context, findingId: string, lensId: string | undefined): Promise<FindingView> {
  const who = actor(ctx);
  if (lensId !== undefined) member(ctx);
  const manifest = await readManifest(deps, ctx);
  const assembled = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    if (lensId !== undefined) await ownLens(db, who.membershipId!, lensId);
    const finding = await findingRepo.findById(db, findingId);
    return finding === undefined ? [] : assemble(db, [finding], manifest, lensId);
  }, { readOnly: true });
  const { visible } = await visibleTo(deps, ctx, assembled);
  if (visible.length === 0) throw notFound();
  return visible[0]!.view;
}

/** The findings panel of an object (38.10). */
export async function listObjectFindings(deps: RecognitionDeps, ctx: Context, objectTypeId: string, objectId: string, lensId: string | undefined)
  : Promise<{ findings: FindingView[]; withheld: number }> {
  const who = actor(ctx);
  if (lensId !== undefined) member(ctx);
  const manifest = await readManifest(deps, ctx);
  const assembled = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    if (lensId !== undefined) await ownLens(db, who.membershipId!, lensId);
    const ids = await findingObjectRepo.currentFindingsOn(db, objectTypeId, objectId, 200);
    return assemble(db, await findingRepo.list(db, { ids, includeSuperseded: false, limit: 200 }), manifest, lensId);
  }, { readOnly: true });
  const { visible, withheld } = await visibleTo(deps, ctx, assembled);
  return { findings: visible.map((a) => a.view), withheld };
}

/** finding.disposition (38.5, 38.11), with the tuning it may cause. */
export async function dispositionFinding(deps: RecognitionDeps, ctx: Context, findingId: string, input: { disposition: Disposition; version: number })
  : Promise<{ finding: FindingView; tuned: { from: number; to: number } | null }> {
  const who = member(ctx);
  // Visible first: a reviewer never dispositions what they cannot see.
  const seen = await getFinding(deps, ctx, findingId, undefined);
  await demand(deps, ctx, 'finding.disposition', { type: 'object_type', id: seen.objectTypeId });
  const manifest = await readManifest(deps, ctx);
  const at = new Date().toISOString();
  const { finding, tuned } = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const updated = await findingRepo.dispositionAtVersion(db, findingId, input.version, { disposition: input.disposition, by: who.membershipId, at });
    if (updated === undefined) {
      throw new AppError('conflict', 'the finding changed since you read it', { code: 'recognition.finding_stale' });
    }
    await recordEvent(db, who, ctx.correlationId, {
      event: 'finding_dispositioned', resource: { type: 'finding', id: findingId },
      detail: { disposition: input.disposition, detector: seen.detector },
    });
    const movement = await tune(db, who, ctx.correlationId, seen.detector, updated);
    return { finding: (await assemble(db, [updated], manifest, undefined))[0]!.view, tuned: movement };
  });
  return { finding, tuned };
}

/** Spec 38.5: tune each threshold the finding was raised under, from the evidence since it last moved. */
async function tune(db: Queryable, who: Parameters<typeof recordEvent>[1], correlationId: string, detectorKey: string, finding: Finding)
  : Promise<{ from: number; to: number } | null> {
  if (!isFederated(detectorKey)) return null;
  const properties: (string | null)[] = PER_PROPERTY[detectorKey] ? finding.properties : [null];
  let moved: { from: number; to: number } | null = null;
  for (const property of properties) {
    const threshold = await detectorThresholdRepo.findByDetectorIdAndObjectTypeIdAndProperty(db, {
      organisationId: finding.organisationId, detectorId: finding.detectorId, objectTypeId: finding.objectTypeId, property,
    });
    if (threshold === undefined) continue;
    const evidence = await findingRepo.dispositionsSince(db, finding.detectorId, finding.objectTypeId, property, threshold.updatedAt);
    const from = Number(threshold.value);
    const to = tunedThreshold(from, evidence, CEILING[detectorKey]);
    if (to === undefined) continue;
    const updated = await detectorThresholdRepo.tuneAtVersion(db, threshold.id, threshold.version, String(to));
    if (updated === undefined) {
      throw new AppError('conflict', 'the threshold was tuned at the same moment; record the disposition again', { code: 'recognition.threshold_stale' });
    }
    await recordEvent(db, who, correlationId, {
      event: 'threshold_tuned', resource: { type: 'detector_threshold', id: threshold.id },
      detail: {
        detector: detectorKey, object_type_id: finding.objectTypeId, property, from, to, origin_was: threshold.origin,
        confirmed: evidence.confirmed, dismissed: evidence.dismissed, deferred: evidence.deferred, since: threshold.updatedAt,
      },
    });
    moved = { from, to };
  }
  return moved;
}
