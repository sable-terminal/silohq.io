// Time over Capture (spec 30.8): objects as Capture saw them at a past time. Scrubbing and
// comparing times exist only over Capture history; a session's own observations are never
// offered as history.
//
// Per object and nominated property, the value at T is the last value captured at or before
// T, shown with when it was observed:
// - the last transition at or before T gives its new value, observed then;
// - with none, the first transition after T gives its previous value: what the baseline
//   held from when the object was first seen;
// - with no transition at all, the baseline's value, unchanged since it was first seen.
// An object first seen after T is not yet observed. A property the Silo does not nominate
// is not captured, never its current value. Reading needs the type and each property
// visible, and clearance on the Silo's own markings; history begins at the type's first
// capture or the Silo's retention edge, whichever is later, and the gaps are the periods
// the type was not captured. Values are opened only for what is returned.

import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { siloBaselineRepo, siloObjectTypeRepo, siloRepo, transitionRepo } from '../../repos/siloes/index.repo.ts';
import { canonicalTimestamp } from '../../utils/time.util.ts';
import { baselineBinding, openValues, transitionBinding } from './capture.service.ts';
import { readManifest, requireSiloes, type Context, type SiloesDeps } from './deps.service.ts';

const DAY = 86_400_000;

export interface StateAt {
  state: 'silo' | 'unavailable' | 'withheld';
  reason: string | null;
  siloId: string | null;
  historyBegins: string | null;
  gaps: { from: string; to: string }[];
  properties: { property: string; availability: 'captured' | 'not_captured' | 'withheld' }[];
  objects: { objectRef: string; observed: boolean; values: Record<string, { value: unknown; observedAt: string }> }[];
}

const iso = (t: string | Date): string => new Date(t).toISOString();

export async function readStateAt(deps: SiloesDeps, ctx: Context, input: { objectTypeId: string; objectRefs: string[]; properties: string[]; at: string })
  : Promise<StateAt> {
  await requireSiloes(deps, ctx);
  const none = (state: StateAt['state'], reason: string): StateAt => ({
    state, reason, siloId: null, historyBegins: null, gaps: [], properties: input.properties.map((property) => ({ property, availability: 'withheld' as const })), objects: [],
  });
  const manifest = await readManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === input.objectTypeId);
  if (type === undefined) return none('withheld', 'the object type is not visible to you');
  const pool = deps.databases.pool('control');
  const found = await inTransaction(pool, ctx.request, async (db) => {
    const nominations = await siloObjectTypeRepo.liveCaptureFor(db, [type.id]);
    const nomination = nominations[0];
    if (nomination === undefined) return undefined;
    return {
      nomination, silo: (await siloRepo.findById(db, nomination.siloId))!, history: await siloObjectTypeRepo.historyFor(db, nomination.siloId, type.id),
      siloMarkings: (await resourceMarkingRepo.markingsFor(db, 'silo', [nomination.siloId])).map((m) => m.markingId),
    };
  }, { readOnly: true });
  if (found === undefined) return none('unavailable', 'History is not retained. Enable Siloes Capture for this object type to compare times.');

  // The reader's access: the type, each property, and the Silo's markings.
  const identities = new Map(type.properties.filter((p) => input.properties.includes(p.apiName)).map((p) => [p.apiName, p.identityId]));
  const access = await deps.services.call(resolveAccess, {
    body: { objectTypes: [type.id], properties: [...identities.values()], markings: found.siloMarkings },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  if (access.decision !== 'allow' || access.objectTypes[0]?.visible !== true) return none('withheld', 'the object type is not visible to you');
  if (found.siloMarkings.some((m) => access.markings.find((x) => x.id === m)?.satisfied !== true)) {
    return none('withheld', 'scrubbing needs clearance on the Silo as well as the type');
  }
  const visible = (apiName: string) => {
    const id = identities.get(apiName);
    const seen = id === undefined ? undefined : access.properties.find((p) => p.id === id);
    return seen?.visible === true && seen.effect === 'allow';
  };
  const properties = input.properties.map((property) => ({
    property,
    availability: !visible(property) ? 'withheld' as const : found.nomination.nominatedProperties.includes(property) ? 'captured' as const : 'not_captured' as const,
  }));
  const captured = properties.filter((p) => p.availability === 'captured').map((p) => p.property);

  // Where history begins, and its gaps.
  const retentionEdge = Date.now() - found.silo.retentionDays * DAY;
  const firstAdded = found.history[0] === undefined ? null : Date.parse(found.history[0].addedAt);
  const historyBegins = firstAdded === null ? null : iso(new Date(Math.max(firstAdded, retentionEdge)));
  const gaps: StateAt['gaps'] = [];
  for (let i = 0; i < found.history.length - 1; i++) {
    const removed = found.history[i]!.removedAt;
    const next = found.history[i + 1]!.addedAt;
    if (removed !== null && Date.parse(next) > Date.parse(removed)) gaps.push({ from: iso(removed), to: iso(next) });
  }
  const at = Date.parse(input.at);
  const base = { siloId: found.silo.id, historyBegins, gaps, properties };
  if (historyBegins === null || at < Date.parse(historyBegins)) {
    return { state: 'silo', reason: 'before history begins', ...base, objects: input.objectRefs.map((objectRef) => ({ objectRef, observed: false, values: {} })) };
  }

  // Per property: the transitions around the time, and the baselines.
  const atText = canonicalTimestamp(input.at);
  const rows = await inTransaction(pool, ctx.request, async (db) => {
    const out = new Map<string, { last: Awaited<ReturnType<typeof transitionRepo.lastAtOrBefore>>; next: Awaited<ReturnType<typeof transitionRepo.firstAfter>> }>();
    for (const property of captured) {
      const f = { siloId: found.silo.id, objectTypeId: type.id, property, objectRefs: input.objectRefs, at: atText };
      out.set(property, { last: await transitionRepo.lastAtOrBefore(db, f), next: await transitionRepo.firstAfter(db, f) });
    }
    return { transitions: out, baselines: await siloBaselineRepo.forObjects(db, found.silo.id, type.id, input.objectRefs, captured) };
  }, { readOnly: true });

  const organisationId = ctx.request.organisationId!;
  const firstSeen = new Map(rows.baselines.map((b) => [`${b.objectRef}\u0000${b.property}`, b]));
  const wanted: { objectRef: string; property: string; observedAt: string; sealed: Buffer; binding: Parameters<typeof openValues>[2][number]['binding'] }[] = [];
  for (const objectRef of input.objectRefs) {
    for (const property of captured) {
      const baseline = firstSeen.get(`${objectRef}\u0000${property}`);
      if (baseline === undefined || Date.parse(baseline.firstSeenAt) > at) continue;
      const { last, next } = rows.transitions.get(property)!;
      const before = last.find((t) => t.objectRef === objectRef);
      const after = next.find((t) => t.objectRef === objectRef);
      const key = { objectTypeId: type.id, objectRef, property };
      if (before !== undefined) {
        wanted.push({ objectRef, property, observedAt: iso(before.observedAt), sealed: before.newValue,
          binding: transitionBinding(organisationId, found.silo.id, { ...key, observedAt: canonicalTimestamp(before.observedAt) }) });
      } else if (after !== undefined) {
        wanted.push({ objectRef, property, observedAt: iso(baseline.firstSeenAt), sealed: after.previousValue,
          binding: transitionBinding(organisationId, found.silo.id, { ...key, observedAt: canonicalTimestamp(after.observedAt) }) });
      } else {
        wanted.push({ objectRef, property, observedAt: iso(baseline.firstSeenAt), sealed: baseline.lastObservedValue, binding: baselineBinding(organisationId, found.silo.id, key) });
      }
    }
  }
  const opened = wanted.length === 0 ? [] : await openValues(deps.services, ctx, wanted.map((w) => ({ binding: w.binding, sealed: w.sealed })));
  const objects = input.objectRefs.map((objectRef) => {
    const values: Record<string, { value: unknown; observedAt: string }> = {};
    wanted.forEach((w, i) => { if (w.objectRef === objectRef) values[w.property] = { value: opened[i] ?? null, observedAt: w.observedAt }; });
    const observed = rows.baselines.some((b) => b.objectRef === objectRef && Date.parse(b.firstSeenAt) <= at);
    return { objectRef, observed, values };
  });
  return { state: 'silo', reason: null, ...base, objects };
}
