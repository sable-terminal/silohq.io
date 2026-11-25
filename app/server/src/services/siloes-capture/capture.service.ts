// Capture (spec 67): transitions, not records.
//
//   row returned (query or change stream) → nominated properties selected → queued →
//   compared with the baseline → a transition where it differs → baseline moved on
//
// - Queued, never inline (67.2): producers (the executor; the state plane for change
//   streams) call enqueueObservations without awaiting it, and a capture failure never fails
//   a question. The queue is a Redis stream per Silo and minute, living ten minutes.
// - No transition on first sighting: the first observation is the baseline.
// - The record is narrow (67.3): object, property, previous and new value, when observed,
//   from which connection. Values are sealed under the organisation's data key, bound to
//   their row. A baseline is rewritten only when its value changes or it was last seen more
//   than ten minutes ago (design: silo_baselines).
// - History is read through the reader's own access (67.4): a property they cannot see is
//   withheld; fewer transitions than the consumer's declared minimum is a baseline still
//   building, and nothing is returned.

import { applyIndexObservations } from '../../contracts/index-builder/observations.contract.ts';
import { applyWarehouseObservations } from '../../contracts/warehouse/observations.contract.ts';
import { openRecordValues, sealRecordValues, type ValueBinding } from '../../contracts/credential/recordValue.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { HISTORY_STATES } from '../../contracts/siloes/siloes.contract.ts';
import { captureQueueKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { NewSiloBaseline, NewTransition } from '../../models/siloes/index.model.ts';
import { siloBaselineRepo, siloObjectTypeRepo, siloRepo, transitionRepo } from '../../repos/siloes/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { canonicalTimestamp } from '../../utils/time.util.ts';
import { recordEvent } from '../warehouse-schema/warehouse.service.ts';
import { readManifest, requireSiloes, siloesEnabled, type Context, type SiloesDeps } from './deps.service.ts';
import { masked } from '../executor/values.service.ts';
import { MINUTE } from './intake.service.ts';

/** Buckets live ten minutes; a drain looks one further back. */
const BUCKETS = 11;
const READ = 2_000;
const BASELINE_TOUCH_MS = 10 * MINUTE;

// ----------------------------------------------------------------------------- the consumer

export const transitionBinding = (organisationId: string, siloId: string, t: { objectTypeId: string; objectRef: string; property: string; observedAt: string })
  : ValueBinding => ({
  table: 'siloes.transitions', organisation_id: organisationId, silo_id: siloId, object_type_id: t.objectTypeId, object_ref: t.objectRef,
  property: t.property, observed_at: t.observedAt,
});

export const baselineBinding = (organisationId: string, siloId: string, k: { objectTypeId: string; objectRef: string; property: string }): ValueBinding => ({
  table: 'siloes.silo_baselines', organisation_id: organisationId, silo_id: siloId, object_type_id: k.objectTypeId, object_ref: k.objectRef,
  property: k.property,
});

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value ?? null), 'utf8').toString('base64');
const decode = (base64: string): unknown => JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));

export async function seal(services: ServiceClient, ctx: Context, items: { binding: ValueBinding; value: unknown }[]): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (let i = 0; i < items.length; i += 5_000) {
    const chunk = items.slice(i, i + 5_000);
    const sealed = await services.call(sealRecordValues, { body: { items: chunk.map((c) => ({ binding: c.binding, value: encode(c.value) })) } },
      { request: ctx.request, correlationId: ctx.correlationId });
    out.push(...sealed.items.map((s) => Buffer.from(s, 'base64')));
  }
  return out;
}

export async function openValues(services: ServiceClient, ctx: Context, items: { binding: ValueBinding; sealed: Buffer }[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < items.length; i += 5_000) {
    const chunk = items.slice(i, i + 5_000);
    const opened = await services.call(openRecordValues, { body: { items: chunk.map((c) => ({ binding: c.binding, sealed: c.sealed.toString('base64') })) } },
      { request: ctx.request, correlationId: ctx.correlationId });
    out.push(...opened.items.map(decode));
  }
  return out;
}

const keyOf = (k: { objectTypeId: string; objectRef: string; property: string }) => `${k.objectTypeId}\u0000${k.objectRef}\u0000${k.property}`;

/**
 * Writes one Silo's queue: every observation compared with its baseline in observed order,
 * a transition for each change, baselines moved on, the queue entries removed. Returns the
 * counts. Observations of a property no longer nominated are dropped.
 */
export async function drainSilo(deps: SiloesDeps, organisationId: string, siloId: string, correlationId: string)
  : Promise<{ observations: number; transitions: number; baselines: number }> {
  const ctx: Context = { request: { organisationId }, correlationId };
  const pool = deps.databases.pool('control');
  const nowMinute = Math.floor(deps.now() / MINUTE);
  const totals = { observations: 0, transitions: 0, baselines: 0 };
  const { nominated, kind } = await inTransaction(pool, ctx.request, async (db) => ({
    nominated: new Map((await siloObjectTypeRepo.listLive(db, siloId)).map((n) => [n.objectTypeId, new Set(n.nominatedProperties)])),
    kind: (await siloRepo.findById(db, siloId))?.kind,
  }), { readOnly: true });
  for (let minute = nowMinute - BUCKETS; minute <= nowMinute + 1; minute += 1) {
    const key = captureQueueKeys.key(organisationId, { siloId, minute });
    for (;;) {
      const batch = await deps.redis.readStream(captureQueueKeys, key, READ);
      if (batch.length === 0) break;
      const entries = batch.map((b) => b.entry).filter((e) => nominated.get(e.objectTypeId)?.has(e.property) === true);
      // A Warehouse takes the change stream's observations between its syncs (69.15); its syncs read the rest.
      const streamed = () => entries.filter((e) => (e as { origin?: string }).origin === 'change_stream');
      const counts = kind === 'warehouse' ? await toWarehouse(deps, ctx, siloId, streamed())
        : kind === 'object_index' ? await toIndex(deps, ctx, siloId, streamed()) : await writeBatch(deps, ctx, siloId, entries);
      await deps.redis.deleteStreamEntries(captureQueueKeys, key, batch.map((b) => b.id));
      totals.observations += batch.length;
      totals.transitions += counts.transitions;
      totals.baselines += counts.baselines;
    }
  }
  return totals;
}

type Entry = { objectTypeId: string; objectRef: string; property: string; value: unknown; observedAt: string; connectionId: string };

/** An Object Index's share of the queue (69.4), written by index-builder. */
async function toIndex(deps: SiloesDeps, ctx: Context, siloId: string, entries: Entry[]): Promise<{ transitions: number; baselines: number }> {
  for (let i = 0; i < entries.length; i += 5_000) {
    await deps.services.call(applyIndexObservations, {
      body: { siloId, entries: entries.slice(i, i + 5_000).map((e) => ({ ...e, value: (e.value ?? null) as never })) },
    }, { request: ctx.request, correlationId: ctx.correlationId });
  }
  return { transitions: 0, baselines: 0 };
}

/** A Warehouse's share of the queue, written by warehouse-sync; its history rows count as transitions. */
async function toWarehouse(deps: SiloesDeps, ctx: Context, siloId: string, entries: Entry[]): Promise<{ transitions: number; baselines: number }> {
  let history = 0;
  for (let i = 0; i < entries.length; i += 5_000) {
    const out = await deps.services.call(applyWarehouseObservations, {
      body: { siloId, entries: entries.slice(i, i + 5_000).map((e) => ({ ...e, value: (e.value ?? null) as never })) },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    history += out.history;
  }
  return { transitions: history, baselines: 0 };
}

async function writeBatch(deps: SiloesDeps, ctx: Context, siloId: string, entries: Entry[]): Promise<{ transitions: number; baselines: number }> {
  if (entries.length === 0) return { transitions: 0, baselines: 0 };
  const organisationId = ctx.request.organisationId!;
  const pool = deps.databases.pool('control');
  entries.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const keys = [...new Map(entries.map((e) => [keyOf(e), { objectTypeId: e.objectTypeId, objectRef: e.objectRef, property: e.property }])).values()];
  const stored = await inTransaction(pool, ctx.request, (db) => siloBaselineRepo.findMany(db, siloId, keys), { readOnly: true });
  const opened = stored.length === 0 ? [] : await openValues(deps.services, ctx, stored.map((b) => ({
    binding: baselineBinding(organisationId, siloId, b), sealed: b.lastObservedValue,
  })));
  const baseline = new Map(stored.map((b, i) => [keyOf(b), { value: opened[i], seenAt: b.lastSeenAt }]));

  const transitions: (Entry & { previous: unknown })[] = [];
  const moved = new Map<string, { key: Entry; value: unknown; seenAt: string }>();
  for (const e of entries) {
    const k = keyOf(e);
    const before = baseline.get(k);
    if (before === undefined) {
      // First sighting: a baseline, never a transition (67.2).
      moved.set(k, { key: e, value: e.value, seenAt: e.observedAt });
    } else if (canonicalJson(before.value ?? null) !== canonicalJson(e.value ?? null)) {
      transitions.push({ ...e, previous: before.value });
      moved.set(k, { key: e, value: e.value, seenAt: e.observedAt });
    } else if (Date.parse(e.observedAt) - Date.parse(before.seenAt) > BASELINE_TOUCH_MS) {
      moved.set(k, { key: e, value: e.value, seenAt: e.observedAt });
    }
    const m = moved.get(k);
    if (m !== undefined) baseline.set(k, { value: m.value, seenAt: m.seenAt });
  }

  const sealedTransitions = await seal(deps.services, ctx, transitions.flatMap((t) => {
    const binding = transitionBinding(organisationId, siloId, t);
    return [{ binding, value: t.previous }, { binding, value: t.value }];
  }));
  const baselineRows = [...moved.values()];
  const sealedBaselines = await seal(deps.services, ctx, baselineRows.map((m) => ({ binding: baselineBinding(organisationId, siloId, m.key), value: m.value })));
  await inTransaction(pool, ctx.request, async (db) => {
    await transitionRepo.insertMany(db, transitions.map((t, i): NewTransition => ({
      organisationId, siloId, objectTypeId: t.objectTypeId, objectRef: t.objectRef, property: t.property,
      previousValue: sealedTransitions[2 * i]!, newValue: sealedTransitions[2 * i + 1]!, observedAt: t.observedAt, connectionId: t.connectionId,
    })));
    await siloBaselineRepo.upsertMany(db, baselineRows.map((m, i): NewSiloBaseline => ({
      organisationId, siloId, objectTypeId: m.key.objectTypeId, objectRef: m.key.objectRef, property: m.key.property,
      // first_seen_at is set on insert only: the repo never moves it.
      lastObservedValue: sealedBaselines[i]!, lastSeenAt: m.seenAt, firstSeenAt: m.seenAt,
    })));
    if (transitions.length > 0 || baselineRows.length > 0) {
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'transition_captured_batch', resource: { type: 'silo', id: siloId },
        detail: { observations: entries.length, transitions: transitions.length, baselines: baselineRows.length }, service: 'siloes-capture',
      });
    }
  });
  return { transitions: transitions.length, baselines: baselineRows.length };
}

/** The scheduled drain: every active Capture Silo's queue. */
export async function drainAll(deps: SiloesDeps, correlationId: string): Promise<number> {
  const siloes = await inTransaction(deps.databases.pool('control'), {}, (db) => siloRepo.liveAcrossCell(db, 10_000), { readOnly: true });
  let written = 0;
  for (const s of siloes.filter((x) => x.kind === 'capture' || x.kind === 'warehouse' || x.kind === 'object_index')) {
    try {
      written += (await drainSilo(deps, s.organisationId, s.id, correlationId)).transitions;
    } catch (error) {
      deps.logger.failure('a Capture queue could not be written; it is kept for the next pass', error, {
        event: 'siloes.capture_drain_failed', organisationId: s.organisationId,
      });
    }
  }
  return written;
}

// ----------------------------------------------------------------------------- history

export async function readHistory(deps: SiloesDeps, ctx: Context, input: {
  objectTypeId: string; property: string; objectRefs?: string[] | undefined; from?: string | undefined; to?: string | undefined;
  minimumTransitions: number; limit: number;
}): Promise<{
  state: (typeof HISTORY_STATES)[number]; siloId: string | null; capturedFrom: string | null; have: number; need: number;
  transitions: { objectRef: string; previousValue: unknown; newValue: unknown; observedAt: string; connectionId: string }[];
}> {
  await requireSiloes(deps, ctx);
  const none = { siloId: null, capturedFrom: null, have: 0, need: input.minimumTransitions, transitions: [] };
  const manifest = await readManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === input.objectTypeId);
  const property = type?.properties.find((p) => p.apiName === input.property);
  if (type === undefined || property === undefined) return { state: 'withheld', ...none };
  const access = await deps.services.call(resolveAccess, { body: { objectTypes: [type.id], properties: [property.identityId] } },
    { request: ctx.request, correlationId: ctx.correlationId });
  const seen = access.properties.find((p) => p.id === property.identityId);
  if (access.decision !== 'allow' || access.objectTypes[0]?.visible !== true || seen?.visible !== true || seen.effect !== 'allow') {
    return { state: 'withheld', ...none };
  }
  const pool = deps.databases.pool('control');
  const found = await inTransaction(pool, ctx.request, async (db) => {
    const nomination = (await siloObjectTypeRepo.liveCaptureFor(db, [type.id])).find((n) => n.nominatedProperties.includes(input.property));
    if (nomination === undefined) return undefined;
    const filter = { siloId: nomination.siloId, objectTypeId: type.id, property: input.property, objectRefs: input.objectRefs, from: input.from, to: input.to };
    const stats = await transitionRepo.stats(db, filter);
    const rows = stats.count < input.minimumTransitions ? [] : await transitionRepo.list(db, filter, input.limit);
    return { siloId: nomination.siloId, stats, rows };
  }, { readOnly: true });
  if (found === undefined) return { state: 'unavailable', ...none };
  const base = { siloId: found.siloId, capturedFrom: found.stats.first, have: found.stats.count, need: input.minimumTransitions };
  // Never a thin baseline (67.4): how much exists and how much is needed, and nothing else.
  if (found.stats.count < input.minimumTransitions) return { state: 'building', ...base, transitions: [] };
  const organisationId = ctx.request.organisationId!;
  const values = found.rows.length === 0 ? [] : await openValues(deps.services, ctx, found.rows.flatMap((t) => {
    const binding = transitionBinding(organisationId, found.siloId, { ...t, observedAt: canonicalTimestamp(t.observedAt) });
    return [{ binding, sealed: t.previousValue }, { binding, sealed: t.newValue }];
  }));
  return {
    state: 'silo', ...base,
    transitions: found.rows.map((t, i) => ({
      objectRef: t.objectRef, previousValue: values[2 * i] ?? null, newValue: values[2 * i + 1] ?? null, observedAt: t.observedAt, connectionId: t.connectionId,
    })),
  };
}


/** What Capture holds of a type that the reader may read in full, and where it begins (38.8). */
export async function readCaptureCoverage(deps: SiloesDeps, ctx: Context, input: { objectTypeId: string }) {
  const none = { siloId: null, capturedFrom: null, properties: [] as string[] };
  const pool = deps.databases.pool('control');
  if (!await inTransaction(pool, ctx.request, (db) => siloesEnabled(db, ctx.request.organisationId!), { readOnly: true })) {
    return { state: 'unavailable' as const, ...none };
  }
  const manifest = await readManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === input.objectTypeId);
  if (type === undefined) return { state: 'withheld' as const, ...none };
  const access = await deps.services.call(resolveAccess, { body: { objectTypes: [type.id], properties: type.properties.map((p) => p.identityId) } },
    { request: ctx.request, correlationId: ctx.correlationId });
  if (access.decision !== 'allow' || access.objectTypes[0]?.visible !== true) return { state: 'withheld' as const, ...none };
  // As readHistory decides: the property visible with no field policy.
  const readable = new Set(type.properties.filter((p) => access.properties.some((x) => x.id === p.identityId && x.visible && x.effect === 'allow')).map((p) => p.apiName));
  const found = await inTransaction(pool, ctx.request, async (db) => {
    const nominations = [];
    for (const n of await siloObjectTypeRepo.liveCaptureFor(db, [type.id])) {
      if ((await siloRepo.findById(db, n.siloId))?.kind === 'capture') nominations.push(n);
    }
    if (nominations.length === 0) return undefined;
    const siloIds = nominations.map((n) => n.siloId);
    const properties = [...new Set(nominations.flatMap((n) => n.nominatedProperties))].filter((p) => readable.has(p)).sort();
    return { siloId: siloIds[0]!, properties, capturedFrom: properties.length === 0 ? null : await transitionRepo.firstObserved(db, siloIds, type.id, properties) };
  }, { readOnly: true });
  if (found === undefined) return { state: 'unavailable' as const, ...none };
  return { state: 'silo' as const, ...found };
}

type Effect = 'allow' | 'mask' | 'redact' | 'deny';
const RANK: Record<Effect, number> = { allow: 0, mask: 1, redact: 2, deny: 3 };

/**
 * The object view's observed changes (34.4): one object's captured transitions, newest first,
 * across the captured properties the reader may see, each value under the reader's field
 * policy. 'unavailable' where no Capture Silo holds the type or Siloes are off; 'withheld'
 * where the reader may not see the type.
 */
export async function readObjectChanges(deps: SiloesDeps, ctx: Context, input: {
  objectTypeId: string; objectId: string; before?: string | undefined; limit: number;
}) {
  const none = { siloId: null, capturedFrom: null, properties: [] as string[], changes: [], next: null };
  const pool = deps.databases.pool('control');
  if (!await inTransaction(pool, ctx.request, (db) => siloesEnabled(db, ctx.request.organisationId!), { readOnly: true })) {
    return { state: 'unavailable' as const, ...none };
  }
  const manifest = await readManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === input.objectTypeId);
  if (type === undefined) return { state: 'withheld' as const, ...none };
  // What the reader may see of each property: its own policy and its source fields', the strictest (as the planner decides).
  const fields = type.properties.flatMap((p) => p.mappings.map((m) => ({ connectionId: m.connectionId, path: m.fieldPath })));
  const access = await deps.services.call(resolveAccess, {
    body: { objectTypes: [type.id], properties: type.properties.map((p) => p.identityId), fields },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  if (access.decision !== 'allow' || access.objectTypes[0]?.visible !== true) return { state: 'withheld' as const, ...none };
  const fieldEffect = new Map(access.fields.map((f) => [`${f.connectionId}\u0000${f.path}`, f.effect as Effect]));
  const effectOf = new Map(type.properties.map((p) => {
    const own = access.properties.find((x) => x.id === p.identityId);
    const effects: Effect[] = [own?.visible === true ? own.effect : 'deny', ...p.mappings.map((m) => fieldEffect.get(`${m.connectionId}\u0000${m.fieldPath}`) ?? 'deny')];
    return [p.apiName, effects.reduce<Effect>((a, b) => (RANK[b] > RANK[a] ? b : a), 'allow')];
  }));
  const found = await inTransaction(pool, ctx.request, async (db) => {
    const nominations = [];
    for (const n of await siloObjectTypeRepo.liveCaptureFor(db, [type.id])) {
      // A Warehouse's history is its own (69.16); Capture's transitions are a Capture Silo's.
      if ((await siloRepo.findById(db, n.siloId))?.kind === 'capture') nominations.push(n);
    }
    if (nominations.length === 0) return undefined;
    const properties = [...new Set(nominations.flatMap((n) => n.nominatedProperties))].filter((p) => (effectOf.get(p) ?? 'deny') !== 'deny').sort();
    const siloIds = nominations.map((n) => n.siloId);
    const rows = await transitionRepo.listForObject(db, { siloIds, objectTypeId: type.id, objectRef: input.objectId, properties, before: input.before }, input.limit + 1);
    return { siloId: siloIds[0]!, properties, capturedFrom: await transitionRepo.firstObserved(db, siloIds, type.id, properties), rows };
  }, { readOnly: true });
  if (found === undefined) return { state: 'unavailable' as const, ...none };
  const page = found.rows.slice(0, input.limit);
  const organisationId = ctx.request.organisationId!;
  const values = page.length === 0 ? [] : await openValues(deps.services, ctx, page.flatMap((t) => {
    const binding = transitionBinding(organisationId, t.siloId, { ...t, observedAt: canonicalTimestamp(t.observedAt) });
    return [{ binding, sealed: t.previousValue }, { binding, sealed: t.newValue }];
  }));
  const shown = (value: unknown, effect: Effect) => (effect === 'redact' ? null : effect === 'mask' ? masked((value ?? null) as never) : (value ?? null));
  return {
    state: 'silo' as const, siloId: found.siloId, capturedFrom: found.capturedFrom, properties: found.properties,
    changes: page.map((t, i) => {
      const effect = effectOf.get(t.property) ?? 'deny';
      return {
        property: t.property, previousValue: shown(values[2 * i], effect) as never, newValue: shown(values[2 * i + 1], effect) as never,
        withheld: effect === 'mask' || effect === 'redact' ? effect : null, observedAt: new Date(t.observedAt).toISOString(), connectionId: t.connectionId,
      };
    }),
    next: found.rows.length > input.limit ? new Date(page.at(-1)!.observedAt).toISOString() : null,
  };
}
