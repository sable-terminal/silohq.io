import type { Executor } from '../infra/db.infra';

/**
 * Dashboards and the widgets on them — see migration 109.
 *
 * Every read here is scoped to its owner by the caller passing the membership,
 * not by a join to `saved_views`: a dashboard is the owner's whether or not the
 * views on it still run.
 */

export interface Dashboard {
  id: string;
  ownerMembershipId: string;
  name: string;
  /** How many views are on it — the dropdown says so beside each name. */
  widgetCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Widget {
  id: string;
  dashboardId: string;
  viewId: string;
  position: number;
  /** Null until somebody resizes it: the size its archetype suits. */
  width: number | null;
  height: number | null;
}

type DashboardRow = {
  id: string;
  owner_membership_id: string;
  name: string;
  widget_count: string | number;
  created_at: Date;
  updated_at: Date;
};

type WidgetRow = {
  id: string;
  dashboard_id: string;
  view_id: string;
  position: number;
  width: number | null;
  height: number | null;
};

const DASHBOARD = `d.id, d.owner_membership_id, d.name, d.created_at, d.updated_at,
  (SELECT count(*) FROM dashboard_widgets w WHERE w.dashboard_id = d.id) AS widget_count`;

const mapDashboard = (row: DashboardRow): Dashboard => ({
  id: row.id,
  ownerMembershipId: row.owner_membership_id,
  name: row.name,
  widgetCount: Number(row.widget_count),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapWidget = (row: WidgetRow): Widget => ({
  id: row.id,
  dashboardId: row.dashboard_id,
  viewId: row.view_id,
  position: row.position,
  width: row.width,
  height: row.height,
});

/** The dropdown's order: oldest first, so the first one somebody made stays at the top. */
export async function listOwnedBy(db: Executor, membershipId: string): Promise<Dashboard[]> {
  const { rows } = await db.query<DashboardRow>(
    `SELECT ${DASHBOARD} FROM dashboards d WHERE d.owner_membership_id = $1 ORDER BY d.created_at, d.name`,
    [membershipId],
  );
  return rows.map(mapDashboard);
}

export async function read(db: Executor, id: string): Promise<Dashboard | null> {
  const { rows } = await db.query<DashboardRow>(`SELECT ${DASHBOARD} FROM dashboards d WHERE d.id = $1`, [id]);
  return rows[0] ? mapDashboard(rows[0]) : null;
}

export async function findByName(db: Executor, membershipId: string, name: string): Promise<Dashboard | null> {
  const { rows } = await db.query<DashboardRow>(
    `SELECT ${DASHBOARD} FROM dashboards d WHERE d.owner_membership_id = $1 AND d.name = $2`,
    [membershipId, name],
  );
  return rows[0] ? mapDashboard(rows[0]) : null;
}

export async function countOwnedBy(db: Executor, membershipId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) FROM dashboards WHERE owner_membership_id = $1`,
    [membershipId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function create(
  db: Executor,
  input: { id: string; organisationId: string; ownerMembershipId: string; name: string },
): Promise<void> {
  await db.query(
    `INSERT INTO dashboards (id, organisation_id, owner_membership_id, name) VALUES ($1, $2, $3, $4)`,
    [input.id, input.organisationId, input.ownerMembershipId, input.name],
  );
}

export async function rename(db: Executor, input: { id: string; name: string }): Promise<void> {
  await db.query(`UPDATE dashboards SET name = $2, updated_at = now() WHERE id = $1`, [input.id, input.name]);
}

export async function remove(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM dashboards WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/* ── Widgets ─────────────────────────────────────────────────────────────── */

export async function widgets(db: Executor, dashboardId: string): Promise<Widget[]> {
  const { rows } = await db.query<WidgetRow>(
    `SELECT id, dashboard_id, view_id, position, width, height
       FROM dashboard_widgets WHERE dashboard_id = $1 ORDER BY position, created_at`,
    [dashboardId],
  );
  return rows.map(mapWidget);
}

/** Onto the end: the newest thing somebody added is where they are about to look. */
export async function addWidget(
  db: Executor,
  input: { id: string; organisationId: string; dashboardId: string; viewId: string },
): Promise<Widget> {
  const { rows } = await db.query<WidgetRow>(
    `INSERT INTO dashboard_widgets (id, organisation_id, dashboard_id, view_id, position)
     VALUES ($1, $2, $3, $4,
             (SELECT coalesce(max(position) + 1, 0) FROM dashboard_widgets WHERE dashboard_id = $3))
     RETURNING id, dashboard_id, view_id, position, width, height`,
    [input.id, input.organisationId, input.dashboardId, input.viewId],
  );
  await touch(db, input.dashboardId);
  return mapWidget(rows[0]!);
}

export async function removeWidget(db: Executor, input: { dashboardId: string; id: string }): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM dashboard_widgets WHERE id = $1 AND dashboard_id = $2`, [
    input.id,
    input.dashboardId,
  ]);
  await touch(db, input.dashboardId);
  return (rowCount ?? 0) > 0;
}

/** Order and sizes together, because one drag changes both at once. */
export async function arrange(
  db: Executor,
  input: { dashboardId: string; widgets: Array<{ id: string; width: number | null; height: number | null }> },
): Promise<void> {
  for (const [position, widget] of input.widgets.entries()) {
    await db.query(
      `UPDATE dashboard_widgets SET position = $3, width = $4, height = $5 WHERE id = $1 AND dashboard_id = $2`,
      [widget.id, input.dashboardId, position, widget.width, widget.height],
    );
  }
  await touch(db, input.dashboardId);
}

async function touch(db: Executor, dashboardId: string): Promise<void> {
  await db.query(`UPDATE dashboards SET updated_at = now() WHERE id = $1`, [dashboardId]);
}
