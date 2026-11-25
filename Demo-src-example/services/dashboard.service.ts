import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { bounds, denial, invalid, notFound, policy } from '../utils/error.util';
import { assertCan, authorityOf } from './authorisation.service';
import { tileOf, type Tile } from './savedView.service';
import * as dashboardRepo from '../repos/dashboard.repo';
import * as savedViewRepo from '../repos/savedView.repo';
import { MAX_DASHBOARDS_PER_MEMBER, MAX_WIDGETS_PER_DASHBOARD } from '../config/constants.config';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

/**
 * Rendering §8 — dashboards: several per person, named, each a grid of saved
 * views that re-run when it is opened.
 *
 * ── CURATED, AS §8 REQUIRES ────────────────────────────────────────────────
 *
 * "Favouriting is what promotes a view, so the dashboard is curated rather than
 * automatic." A widget is that act, made per dashboard. Nothing here adds one
 * on anybody's behalf.
 *
 * ── OPENING ONE COSTS QUERIES, NEVER TOKENS ────────────────────────────────
 *
 * Every widget is a saved view and re-running one is free (Billing §7). What
 * opening a dashboard does cost is load on the customer's own systems, which
 * is why the widgets run one after another and why there is a ceiling on how
 * many one dashboard can hold.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type Dashboard = dashboardRepo.Dashboard;

export type PlacedWidget = dashboardRepo.Widget & { tile: Tile };

export type OpenedDashboard = Dashboard & { widgets: PlacedWidget[] };

export async function mine(actor: Actor): Promise<Dashboard[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => dashboardRepo.listOwnedBy(db, actor.membershipId)),
  );
}

/** `query.run`, as saving a view is: a grid of your own questions adds nothing you could not already do. */
export async function create(actor: Actor, input: { name: string }): Promise<Dashboard> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'query.run');

      if ((await dashboardRepo.countOwnedBy(db, actor.membershipId)) >= MAX_DASHBOARDS_PER_MEMBER) {
        throw bounds({
          message: `You have ${MAX_DASHBOARDS_PER_MEMBER} dashboards, which is the most one person can keep. Delete one to make another.`,
          code: 'bounds.dashboards',
        });
      }
      await assertNameFree(db, actor, input.name);

      const id = generateId();
      await dashboardRepo.create(db, {
        id,
        organisationId: actor.organisationId,
        ownerMembershipId: actor.membershipId,
        name: input.name,
      });
      return (await dashboardRepo.read(db, id))!;
    }),
  );
}

export async function rename(actor: Actor, id: string, name: string): Promise<Dashboard> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const dashboard = await mustOwn(db, actor, id);
      if (dashboard.name !== name) await assertNameFree(db, actor, name);
      await dashboardRepo.rename(db, { id, name });
      return (await dashboardRepo.read(db, id))!;
    }),
  );
}

/** The dashboard and its places — never the views on it, which are still in the sidebar. */
export async function remove(actor: Actor, id: string): Promise<{ removed: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);
      return { removed: await dashboardRepo.remove(db, id) };
    }),
  );
}

/**
 * Open a dashboard: every widget's view re-run, in order.
 *
 * ── ONE AFTER ANOTHER, NOT ALL AT ONCE ────────────────────────────────────
 *
 * Each widget fans out to the customer's own systems. Twelve opened in
 * parallel is twelve simultaneous fan-outs against an estate sized for one
 * person asking one question, and the first thing it would break is somebody
 * else's production system rather than this one.
 *
 * ── ONE THAT FAILS DOES NOT TAKE THE REST WITH IT ─────────────────────────
 *
 * `tileOf` puts a refusal on its tile, so eleven good widgets still draw
 * beside the one whose grant was withdrawn.
 */
export async function open(actor: Actor, id: string): Promise<OpenedDashboard> {
  const { dashboard, placed } = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const dashboard = await mustOwn(db, actor, id);
      const widgets = await dashboardRepo.widgets(db, id);
      const placed: Array<{ widget: dashboardRepo.Widget; view: savedViewRepo.SavedView }> = [];
      for (const widget of widgets) {
        const view = await savedViewRepo.read(db, widget.viewId);
        if (view) placed.push({ widget, view });
      }
      return { dashboard, placed };
    }),
  );

  const widgets: PlacedWidget[] = [];
  for (const { widget, view } of placed) widgets.push({ ...widget, tile: await tileOf(actor, view) });

  return { ...dashboard, widgets };
}

/** Put a saved view on a dashboard, at the end, and run it so it can be drawn at once. */
export async function addWidget(actor: Actor, id: string, viewId: string): Promise<PlacedWidget> {
  const { widget, view } = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const dashboard = await mustOwn(db, actor, id);

      const view = await savedViewRepo.read(db, viewId);
      if (!view) throw notFound({ message: 'That view does not exist.', code: 'missing.view' });
      if (view.ownerMembershipId !== actor.membershipId) {
        throw denial({ message: 'That saved view belongs to somebody else.', code: 'denial.view_not_owned' });
      }

      const placed = await dashboardRepo.widgets(db, id);
      if (placed.some((one) => one.viewId === viewId)) {
        throw policy({
          message: `${view.name} is already on ${dashboard.name}.`,
          code: 'policy.widget_duplicate',
        });
      }
      if (placed.length >= MAX_WIDGETS_PER_DASHBOARD) {
        throw bounds({
          message:
            `${dashboard.name} holds ${MAX_WIDGETS_PER_DASHBOARD} views, which is the most one dashboard can. ` +
            'Every one re-runs against your systems when it opens. Make another dashboard for the rest.',
          code: 'bounds.widgets',
        });
      }

      const widget = await dashboardRepo.addWidget(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        dashboardId: id,
        viewId,
      });
      return { widget, view };
    }),
  );

  return { ...widget, tile: await tileOf(actor, view) };
}

/** Take a view off a dashboard. The view itself is untouched. */
export async function removeWidget(actor: Actor, id: string, widgetId: string): Promise<{ removed: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);
      const removed = await dashboardRepo.removeWidget(db, { dashboardId: id, id: widgetId });
      if (!removed) throw notFound({ message: 'That widget is not on this dashboard.', code: 'missing.widget' });
      return { removed };
    }),
  );
}

/**
 * Order and sizes, as the grid now shows them.
 *
 * THE WHOLE ARRANGEMENT OR NOTHING. A list that leaves a widget out, or names
 * one from another dashboard, is refused rather than applied in part: a
 * half-applied order is two widgets at one position and a grid that reads
 * differently on the next open.
 */
export async function arrange(
  actor: Actor,
  id: string,
  widgets: Array<{ id: string; width: number | null; height: number | null }>,
): Promise<{ arranged: number }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);

      const current = new Set((await dashboardRepo.widgets(db, id)).map((widget) => widget.id));
      const given = new Set(widgets.map((widget) => widget.id));
      if (given.size !== widgets.length || given.size !== current.size || [...given].some((one) => !current.has(one))) {
        throw invalid({
          message: 'The arrangement has to name every widget on this dashboard, once each. Reload it and try again.',
          code: 'invalid.arrangement',
        });
      }

      await dashboardRepo.arrange(db, { dashboardId: id, widgets });
      return { arranged: widgets.length };
    }),
  );
}

/** The dashboard, if it is the caller's — refused as a denial inside one organisation, as views are. */
async function mustOwn(db: PoolClient, actor: Actor, id: string): Promise<Dashboard> {
  const dashboard = await dashboardRepo.read(db, id);
  if (!dashboard) throw notFound({ message: 'That dashboard does not exist.', code: 'missing.dashboard' });
  if (dashboard.ownerMembershipId !== actor.membershipId) {
    throw denial({ message: 'That dashboard belongs to somebody else.', code: 'denial.dashboard_not_owned' });
  }
  return dashboard;
}

/** Said by name, rather than the database's "That already exists." */
async function assertNameFree(db: PoolClient, actor: Actor, name: string): Promise<void> {
  if (await dashboardRepo.findByName(db, actor.membershipId, name)) {
    throw policy({ message: `You already have a dashboard called ${name}.`, code: 'policy.dashboard_name_taken' });
  }
}
