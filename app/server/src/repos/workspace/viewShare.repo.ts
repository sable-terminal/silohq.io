// Data access for workspace.view_shares, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { SCOPES_CONTAINING_MEMBER } from './savedView.repo.ts';
import {
  viewShareTable,
  type NewViewShare,
  type ViewShare,
  type ViewShareChanges,
} from '../../models/workspace/viewShare.model.ts';

/** A shared document's arm of a share row: a fixed column, never caller text. */
export type DocumentArm = 'workbook' | 'report' | 'process' | 'ai_agent' | 'notebook' | 'ml_model';
const DOCUMENT_COLUMN: Readonly<Record<DocumentArm, 'workbook_id' | 'report_id' | 'process_analysis_id' | 'ai_agent_id' | 'notebook_id' | 'ml_model_id'>> = {
  workbook: 'workbook_id', report: 'report_id', process: 'process_analysis_id', ai_agent: 'ai_agent_id', notebook: 'notebook_id', ml_model: 'ml_model_id',
};

export const viewShareRepo = {
  insert(db: Queryable, row: NewViewShare): Promise<ViewShare> {
    return insertRow(db, viewShareTable, row);
  },

  findById(db: Queryable, id: ViewShare['id']): Promise<ViewShare | undefined> {
    return findRow(db, viewShareTable, { id });
  },

  update(db: Queryable, id: ViewShare['id'], changes: ViewShareChanges): Promise<ViewShare | undefined> {
    return updateRow(db, viewShareTable, { id }, changes);
  },

  /** The shares of a saved view that reach a member now: to them, to a scope containing one of theirs, or to everyone. */
  async liveReaching(db: Queryable, viewId: string, membershipId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where saved_view_id = $2 and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId, viewId]);
    return rows as ViewShare[];
  },

  async listForView(db: Queryable, viewId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares where saved_view_id = $1 order by shared_at, id`, [viewId]);
    return rows as ViewShare[];
  },

  /** The one share of a view for a grantee, whatever its state (re-sharing updates it). */
  async findForGrantee(db: Queryable, viewId: string, grantee: { membershipId?: string; scopeId?: string; organisation?: true }): Promise<ViewShare | undefined> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where saved_view_id = $1 and (($2::uuid is not null and membership_id = $2) or ($3::uuid is not null and scope_id = $3)
                                     or ($4 and organisation_wide))
       for update`,
      [viewId, grantee.membershipId ?? null, grantee.scopeId ?? null, grantee.organisation === true]);
    return rows[0] as ViewShare | undefined;
  },

  /** A transfer suspends a view's live shares until the receiving admin reviews it. */
  async suspendLive(db: Queryable, viewId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.view_shares set suspended_at = $2 where saved_view_id = $1 and revoked_at is null and suspended_at is null', [viewId, at]);
    return rowCount ?? 0;
  },

  async resumeSuspended(db: Queryable, viewId: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.view_shares set suspended_at = null where saved_view_id = $1 and revoked_at is null and suspended_at is not null', [viewId]);
    return rowCount ?? 0;
  },

  /** Revokes every share of a view not already revoked (archiving, retaining privately). */
  async revokeAll(db: Queryable, viewId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.view_shares set revoked_at = $2 where saved_view_id = $1 and revoked_at is null', [viewId, at]);
    return rowCount ?? 0;
  },

  /** A share to a membership later removed is revoked at removal (spec 37.10). */
  async revokeToMembership(db: Queryable, membershipId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.view_shares set revoked_at = $2 where membership_id = $1 and revoked_at is null', [membershipId, at]);
    return rowCount ?? 0;
  },

  /** Whether two members sit together in at least one active scope (the scope_only policy). */
  async shareAScope(db: Queryable, a: string, b: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from iam.scope_memberships x join iam.scope_memberships y
                        on y.organisation_id = x.organisation_id and y.scope_id = x.scope_id
                      where x.membership_id = $1 and y.membership_id = $2 and x.inactive_since is null and y.inactive_since is null) as yes`,
      [a, b]);
    return (rows[0] as { yes: boolean }).yes;
  },

  /** Whether a scope is one a member sits in, or lies within one (the scope_only policy, for a scope share). */
  async scopeWithinMember(db: Queryable, membershipId: string, scopeId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from iam.scope_memberships sm
                        join iam.scopes mine on mine.organisation_id = sm.organisation_id and mine.id = sm.scope_id
                        join iam.scopes target on target.organisation_id = mine.organisation_id and target.id = $2
                      where sm.membership_id = $1 and sm.inactive_since is null and target.path <@ mine.path) as yes`,
      [membershipId, scopeId]);
    return (rows[0] as { yes: boolean }).yes;
  },

  // ---- Canvas views (spec 29.10): the same share rows, on the canvas_view_id arm.

  /** The shares of a canvas view that reach a member now. */
  async liveReachingCanvas(db: Queryable, canvasViewId: string, membershipId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where canvas_view_id = $2 and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId, canvasViewId]);
    return rows as ViewShare[];
  },

  async listForCanvas(db: Queryable, canvasViewId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares where canvas_view_id = $1 order by shared_at, id`, [canvasViewId]);
    return rows as ViewShare[];
  },

  async findForCanvasGrantee(db: Queryable, canvasViewId: string, grantee: { membershipId?: string; scopeId?: string; organisation?: true })
    : Promise<ViewShare | undefined> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where canvas_view_id = $1 and (($2::uuid is not null and membership_id = $2) or ($3::uuid is not null and scope_id = $3)
                                      or ($4 and organisation_wide))
       for update`,
      [canvasViewId, grantee.membershipId ?? null, grantee.scopeId ?? null, grantee.organisation === true]);
    return rows[0] as ViewShare | undefined;
  },

  async revokeAllForCanvas(db: Queryable, canvasViewId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.view_shares set revoked_at = $2 where canvas_view_id = $1 and revoked_at is null', [canvasViewId, at]);
    return rowCount ?? 0;
  },

  /** Canvas views shared with a member and live now: the "shared with me" list. */
  async canvasViewsReaching(db: Queryable, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct canvas_view_id as id from workspace.view_shares
       where canvas_view_id is not null and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  // ---- Workbooks and reports (D232, D233): the same share rows, on their documents' arms.

  /** The shares of a workbook or report that reach a member now. */
  async liveReachingDocument(db: Queryable, arm: DocumentArm, id: string, membershipId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where ${DOCUMENT_COLUMN[arm]} = $2 and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId, id]);
    return rows as ViewShare[];
  },

  async listForDocument(db: Queryable, arm: DocumentArm, id: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares where ${DOCUMENT_COLUMN[arm]} = $1 order by shared_at, id`, [id]);
    return rows as ViewShare[];
  },

  async findForDocumentGrantee(db: Queryable, arm: DocumentArm, id: string, grantee: { membershipId?: string; scopeId?: string; organisation?: true })
    : Promise<ViewShare | undefined> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where ${DOCUMENT_COLUMN[arm]} = $1 and (($2::uuid is not null and membership_id = $2) or ($3::uuid is not null and scope_id = $3)
                                   or ($4 and organisation_wide))
       for update`,
      [id, grantee.membershipId ?? null, grantee.scopeId ?? null, grantee.organisation === true]);
    return rows[0] as ViewShare | undefined;
  },

  /** Workbooks or reports shared with a member and live now: the "shared with me" list. */
  async documentsReaching(db: Queryable, arm: DocumentArm, membershipId: string): Promise<string[]> {
    const column = DOCUMENT_COLUMN[arm];
    const { rows } = await db.query(
      `select distinct ${column} as id from workspace.view_shares
       where ${column} is not null and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  // ---- Scenarios (spec 39.7): the same share rows, on the scenario_id arm.

  /** The shares of a scenario that reach a member now. */
  async liveReachingScenario(db: Queryable, scenarioId: string, membershipId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where scenario_id = $2 and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId, scenarioId]);
    return rows as ViewShare[];
  },

  async listForScenario(db: Queryable, scenarioId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares where scenario_id = $1 order by shared_at, id`, [scenarioId]);
    return rows as ViewShare[];
  },

  async findForScenarioGrantee(db: Queryable, scenarioId: string, grantee: { membershipId?: string; scopeId?: string; organisation?: true })
    : Promise<ViewShare | undefined> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where scenario_id = $1 and (($2::uuid is not null and membership_id = $2) or ($3::uuid is not null and scope_id = $3)
                                   or ($4 and organisation_wide))
       for update`,
      [scenarioId, grantee.membershipId ?? null, grantee.scopeId ?? null, grantee.organisation === true]);
    return rows[0] as ViewShare | undefined;
  },

  /** Scenarios shared with a member and live now: the "shared with me" list. */
  async scenariosReaching(db: Queryable, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct scenario_id as id from workspace.view_shares
       where scenario_id is not null and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  // ---- Crons (spec 40.8): the same share rows, on the automation_id arm; access is always view.

  /** The shares of a Cron that reach a member now. */
  async liveReachingAutomation(db: Queryable, automationId: string, membershipId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where automation_id = $2 and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId, automationId]);
    return rows as ViewShare[];
  },

  async listForAutomation(db: Queryable, automationId: string): Promise<ViewShare[]> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares where automation_id = $1 order by shared_at, id`, [automationId]);
    return rows as ViewShare[];
  },

  async findForAutomationGrantee(db: Queryable, automationId: string, grantee: { membershipId?: string; scopeId?: string; organisation?: true })
    : Promise<ViewShare | undefined> {
    const { rows } = await db.query(
      `select ${viewShareTable.select} from workspace.view_shares
       where automation_id = $1 and (($2::uuid is not null and membership_id = $2) or ($3::uuid is not null and scope_id = $3)
                                     or ($4 and organisation_wide))
       for update`,
      [automationId, grantee.membershipId ?? null, grantee.scopeId ?? null, grantee.organisation === true]);
    return rows[0] as ViewShare | undefined;
  },

  /** Crons shared with a member and live now: the "shared with me" list. */
  async automationsReaching(db: Queryable, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct automation_id as id from workspace.view_shares
       where automation_id is not null and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  /** A deleted Cron's shares end with it. */
  async revokeAllForAutomation(db: Queryable, automationId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.view_shares set revoked_at = $2 where automation_id = $1 and revoked_at is null', [automationId, at]);
    return rowCount ?? 0;
  },
};
