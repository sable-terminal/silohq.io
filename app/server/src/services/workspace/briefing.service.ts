// Home as a briefing (spec 33.7): what needs this person's attention since they last looked,
// in five sections in fixed order, read together.
//
// 1. Approvals waiting: chains with an open step this person may decide now (approvals'
//    own qualification rules), oldest first, with their risk class.
// 2. Crons that fired: runs since the marker on Crons they own or follow and may still read.
// 3. Findings: new findings since the marker on the object types of the object sets they own
//    or follow (decision 2026-11-17), each listed with the sets of its type; findings they
//    may not see are withheld by recognition, as everywhere.
// 4. Favourited clones: the objects they favourited, by reference (live state joins with the
//    Clone Canvas).
// 5. Favourited apps they can still open, and the dashboard tiles of their favourited views.
//
// "Since last visit" is workspace_preferences.last_home_seen_at; before a first visit it is
// the last seven days. Reading the briefing changes nothing: the page marks Home seen once it
// has shown it. Each section is read on its own: one whose source could not be read says so,
// with the reason, and never looks empty. Values never appear: references, names, counts.

import { listApprovalInbox } from '../../contracts/approvals/approval.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { listFindingsRaisedSince } from '../../contracts/recognition/finding.contract.ts';
import { listFiredRuns } from '../../contracts/scheduler/cron.contract.ts';
import { getApp } from '../../contracts/studio/app.contract.ts';
import type { BriefingView } from '../../contracts/workspace/shell.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { favouriteRepo, followRepo, savedViewRepo, workspacePreferenceRepo } from '../../repos/workspace/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { member, type Context, type WorkspaceDeps } from './deps.service.ts';
import { dashboard, read as readView } from './views.service.ts';

const FIRST_VISIT_DAYS = 7;
const ITEMS = 20;

type Section<T> = { status: 'ok'; items: T[]; more: boolean } | { status: 'unavailable'; reason: string };

/** A section read on its own: what went wrong is its reason, in the source's own public words. */
async function section<T>(read: () => Promise<{ items: T[]; more: boolean }>): Promise<Section<T>> {
  try {
    return { status: 'ok', ...await read() };
  } catch (error) {
    const reason = isAppError(error) && error.httpStatus < 500 ? error.message : 'the service that holds it did not answer';
    return { status: 'unavailable', reason };
  }
}

export async function briefing(deps: WorkspaceDeps, ctx: Context, sinceAsked: string | undefined): Promise<BriefingView> {
  const me = member(ctx);
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const now = Date.now();
  const stored = await inTransaction(deps.databases.pool('control'), me.request, async (db) => ({
    preference: await workspacePreferenceRepo.findByKey(db, { organisationId: me.organisationId, membershipId: me.membershipId }),
    follows: await followRepo.listForMember(db, me.membershipId),
    favourites: await favouriteRepo.listForMember(db, me.membershipId),
    ownedSets: (await savedViewRepo.listOwned(db, me.membershipId, { archived: false, favouritedOnly: false, limit: 200 })).filter((v) => v.kind === 'object_set'),
  }), { readOnly: true });
  const marker = sinceAsked ?? stored.preference?.lastHomeSeenAt ?? null;
  const since = marker ?? new Date(now - FIRST_VISIT_DAYS * 86_400_000).toISOString();
  const followed = (type: 'cron' | 'view') => stored.follows.filter((f) => f.resourceType === type).map((f) => f.resourceId);

  // Object type names, for findings and favourited objects: read once, shared by both.
  let manifest: Promise<Awaited<ReturnType<typeof readManifest>>> | undefined;
  const readManifest = () => deps.services.call(getManifest, { query: {} }, options);
  const types = () => (manifest ??= readManifest());

  const [approvals, crons, findings, clones, apps, tiles] = await Promise.all([
    section(async () => {
      const { chains } = await deps.services.call(listApprovalInbox, { query: { limit: ITEMS + 1, forMe: 'true' } }, options);
      const oldest = [...chains].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        items: oldest.slice(0, ITEMS).map((c) => ({
          chainId: c.id, subjectKind: c.subjectKind, riskClass: c.riskClass, createdAt: c.createdAt, expiresAt: c.expiresAt,
          approvalsRequired: c.approvalsRequired, approvalsReceived: c.approvalsReceived,
        })),
        more: chains.length > ITEMS,
      };
    }),
    section(async () => {
      const fired = await deps.services.call(listFiredRuns, { body: { since, followedCronIds: followed('cron').slice(0, 200), limit: ITEMS } }, options);
      return {
        items: fired.runs.map((r) => ({
          cronId: r.cronId, cronName: r.cronName, owned: r.owned, runId: r.run.id, trigger: r.run.trigger, status: r.run.status,
          startedAt: r.run.startedAt, conditionOutcome: r.run.conditionOutcome, actions: r.run.actions.map((a) => ({ kind: a.kind, outcome: a.outcome })),
        })),
        more: fired.more,
      };
    }),
    section(async () => {
      // The sets: owned, and followed ones the person may still open; each by its object type.
      const sets: { viewId: string; name: string; objectSetId: string }[] = stored.ownedSets
        .filter((v) => v.objectSetId !== null).map((v) => ({ viewId: v.id, name: v.name, objectSetId: v.objectSetId! }));
      for (const viewId of followed('view')) {
        const view = await readView(deps, ctx, viewId).catch(() => undefined);
        if (view?.kind === 'object_set' && view.objectSetId !== null && view.archivedAt === null) sets.push({ viewId, name: view.name, objectSetId: view.objectSetId });
      }
      const byType = new Map<string, { viewId: string; name: string }[]>();
      for (const set of sets.slice(0, 50)) {
        const definition = await deps.services.call(getObjectSet, { params: { objectSetId: set.objectSetId } }, options).catch(() => undefined);
        if (definition?.baseTypeId == null) continue;
        byType.set(definition.baseTypeId, [...(byType.get(definition.baseTypeId) ?? []), { viewId: set.viewId, name: set.name }]);
      }
      if (byType.size === 0) return { items: [], more: false };
      const raised = await deps.services.call(listFindingsRaisedSince, { body: { since, objectTypeIds: [...byType.keys()].slice(0, 50), limit: ITEMS } }, options);
      return {
        items: raised.findings.map(({ finding, detectorName, objectTypeName, objectTypePlural }) => ({
          findingId: finding.id, detector: finding.detector, detectorLabel: detectorName, objectTypeId: finding.objectTypeId, objectTypeName, objectTypePlural,
          objectCount: finding.objectIds.length, score: finding.score, raisedAt: finding.raisedAt, sets: byType.get(finding.objectTypeId) ?? [],
        })),
        more: raised.more,
      };
    }),
    section(async () => {
      const objects = stored.favourites.filter((f) => f.objectRef !== null);
      if (objects.length === 0) return { items: [], more: false };
      const { objectTypes } = await types();
      return {
        items: objects.slice(0, ITEMS).map((f) => ({
          favouriteId: f.id, objectTypeId: f.objectTypeId!, objectRef: f.objectRef!,
          objectTypeName: objectTypes.find((t) => t.id === f.objectTypeId)?.displayName ?? 'Object',
        })),
        more: objects.length > ITEMS,
      };
    }),
    section(async () => {
      const favourited = stored.favourites.filter((f) => f.appId !== null).slice(0, ITEMS);
      const items: { favouriteId: string; appId: string; name: string }[] = [];
      for (const f of favourited) {
        // An app the person can no longer open is not named.
        const app = await deps.services.call(getApp, { params: { appId: f.appId! } }, options).catch((error: unknown) => {
          if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) return undefined;
          throw error;
        });
        if (app !== undefined) items.push({ favouriteId: f.id, appId: app.app.id, name: app.app.name });
      }
      return { items, more: stored.favourites.filter((f) => f.appId !== null).length > ITEMS };
    }),
    section(async () => {
      const all = await dashboard(deps, ctx);
      return {
        items: all.slice(0, ITEMS).map((t) => ({ tileId: t.tileId, viewId: t.view.id, name: t.view.name, lastRunAt: t.lastRun?.ranAt ?? t.view.lastRunAt })),
        more: all.length > ITEMS,
      };
    }),
  ]);

  return { since: marker, generatedAt: new Date(now).toISOString(), approvals, crons, findings, clones, apps, dashboard: tiles };
}
