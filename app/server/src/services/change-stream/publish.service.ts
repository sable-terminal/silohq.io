// From decoded changes to deltas on bus-live (spec 18.2, 18.3, 18.6).
//
// For each change: the object must be one the manifest streams from this source; only
// fields the manifest declares for it are kept; a change whose de-duplication key was seen
// in the last 10 minutes is dropped (the key is the manifest's dedupKey expression, or
// connection, object, entity and source sequence; a change without a sequence and without
// an expression cannot be told from a repeat, so it is never dropped as one). Every accepted
// change bumps the change epoch of its source object, so cached results over it stop
// matching (spec 24.6), and is queued to Capture where a Capture Silo holds its type, without
// waiting (spec 30.7). It is published live only where the state plane holds the object; the
// rest are discarded and counted. Every change, accepted or a repeat, is offered to the stream
// probes watching its record (probeStore.service; decision 2026-11-15), and to the caller's
// listener where one is given.
//
// Values exist here only in memory: nothing is logged but counts and references.
//
// Quotas (spec 9.5, 12.4: one tenant cannot consume a cell): an organisation's changes, and a
// connection's, are counted in one-second windows; a delivery that would go over either is
// refused whole, as rate limited with a retry time, so a provider retries its webhook and the
// agent keeps the changes in its spool (10.6). Nothing is half taken.

import { LIMITS } from '../../config/limits.config.ts';
import { AppError } from '../../utils/errors.util.ts';
import { noteProbes, type PublishNote } from './probeStore.service.ts';
import { createHash } from 'node:crypto';
import { sourceChange, type SourceChange } from '../../contracts/change-stream/delta.contract.ts';
import type { ChangeSourceKind } from '../../contracts/connect/manifest.contract.ts';
import { liveSubjects } from '../../infra/bus.infra.ts';
import { bumpChangeEpochs, changeDedupKeys, liveInterest, rateLimitKeys } from '../../infra/keyspaces.infra.ts';
import type { ChangeDeltaDraft } from '../expression-evaluator/evaluator.service.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import type { ChangeStreamDeps } from './deps.service.ts';
import type { ConnectionSources } from './sources.service.ts';

const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export interface PublishOutcome {
  accepted: number;
  /** Not streamed from this source, undeclared, duplicates, or not held live. */
  discarded: number;
  /** Accepted changes per object, for health and metrics. */
  objects: Set<string>;
}

const toText = (value: string | number | undefined): string | null => (value === undefined ? null : String(value));

/** Counts a delivery's changes against the organisation's and the connection's windows; refused over either. */
export async function chargeChangeRate(data: ChangeStreamDeps['data'], organisationId: string, connectionId: string, changes: number,
  limits: { perOrganisation: number; perConnection: number } = {
    perOrganisation: LIMITS.bus.changeEventsPerSecondPerOrganisation, perConnection: LIMITS.bus.changeEventsPerSecondPerConnection,
  }): Promise<void> {
  if (changes === 0) return;
  const second = Math.floor(Date.now() / 1000);
  const windows = [
    { subject: organisationId, limit: limits.perOrganisation, name: 'change_events_organisation', of: 'organisation' },
    { subject: connectionId, limit: limits.perConnection, name: 'change_events_connection', of: 'connection' },
  ];
  for (const w of windows) {
    const used = await data.increment(rateLimitKeys, rateLimitKeys.key({ subject: w.subject, limit: `${w.name}.${second}` }), changes, { ttlSeconds: 2 });
    if (used > w.limit) {
      throw new AppError('rate_limited', `more than ${w.limit} changes a second for this ${w.of}; try again shortly`, {
        code: 'stream.rate_limited', retryAfterSeconds: 1, details: { limit: w.limit, quota: w.name },
      });
    }
  }
}

export async function publishChanges(deps: ChangeStreamDeps, sources: ConnectionSources, kind: ChangeSourceKind,
  drafts: readonly ChangeDeltaDraft[], now: Date = new Date(), listen?: (note: PublishNote) => void): Promise<PublishOutcome> {
  const { connection, manifest } = sources;
  const organisationId = connection.organisationId;
  await chargeChangeRate(deps.data, organisationId, connection.id, drafts.length);
  const outcome: PublishOutcome = { accepted: 0, discarded: 0, objects: new Set() };
  const interest = await liveInterest(deps.state, organisationId, connection.id);
  const dedupKey = changeDedupKeys.key(organisationId, { connectionId: connection.id });
  await deps.state.removeScoredUpTo(changeDedupKeys, dedupKey, now.getTime() - DEDUP_WINDOW_MS);
  const accepted: SourceChange[] = [];
  const notes: PublishNote[] = [];

  for (const draft of drafts) {
    const streamed = sources.streamed.get(draft.object);
    if (streamed === undefined || !streamed.kinds.includes(kind)) {
      outcome.discarded += 1;
      continue;
    }
    const declared = new Set(streamed.object.fields.map((f) => f.name));
    const changed = Object.fromEntries(Object.entries(draft.changed ?? {}).filter(([field]) => declared.has(field)));
    const sourceAt = draft.sourceAt !== undefined && !Number.isNaN(Date.parse(draft.sourceAt)) ? new Date(draft.sourceAt).toISOString() : null;
    const delta: SourceChange = {
      organisationId, connectionId: connection.id, manifestVersion: manifest.identity.version, object: draft.object,
      entityRef: String(draft.entityRef), operation: draft.operation, changed, observedAt: now.toISOString(), sourceAt,
      sourceSeq: toText(draft.sourceSeq), ordering: streamed.stream.ordering, source: kind, markings: [],
    };
    let key: string | null;
    try {
      key = streamed.stream.dedupKey !== undefined
        ? await compileExpression('change.dedupKey', 'cel', streamed.stream.dedupKey.cel).evaluate({ delta }, now) as string
        : delta.sourceSeq === null ? null : JSON.stringify([connection.id, delta.object, delta.entityRef, delta.sourceSeq]);
    } catch {
      key = null;
    }
    let hash: string | null = null;
    if (key !== null) {
      hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
      const fresh = await deps.state.addScored(changeDedupKeys, dedupKey, [{ member: hash, score: now.getTime() }]);
      if (fresh === 0) {
        notes.push({ delta, duplicate: true, dedupHash: hash });
        outcome.discarded += 1;
        continue;
      }
    }
    notes.push({ delta, duplicate: false, dedupHash: hash });
    accepted.push(delta);
  }
  if (listen !== undefined) for (const note of notes) listen(note);
  try {
    await noteProbes(deps.state, organisationId, connection.id, notes);
  } catch (error) {
    deps.logger.failure('a stream probe could not note a change', error, { event: 'stream.probe_note_failed', connectionId: connection.id });
  }

  if (accepted.length > 0) {
    await bumpChangeEpochs(deps.data, organisationId, accepted.map((d) => ({ connectionId: connection.id, sourceObject: d.object })));
    if (deps.capture !== undefined) void deps.capture.capture(organisationId, connection.id, accepted);
  }
  for (const delta of accepted) {
    outcome.objects.add(delta.object);
    if (!interest.has(delta.object)) {
      outcome.discarded += 1;
      continue;
    }
    deps.liveBus.publish(sourceChange, liveSubjects.change(organisationId, connection.id, delta.object), delta);
    outcome.accepted += 1;
  }
  return outcome;
}
