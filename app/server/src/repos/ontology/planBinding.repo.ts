// Data access for ontology.plan_bindings, in plain SQL; no ORM.
// Read and written by silo_app (compile). Row-level security applies: call it inside
// inTransaction with the request context.
//
// A binding keeps the values bound into a compiled plan's placeholders (spec 26.4, the
// literal pass), sealed under the organisation's data key, under the id of what holds the
// plan: an Ask turn, a saved view. One id, one binding: written once, never changed.

import type { Queryable } from '../base.repo.ts';
import { planBindingTable, type PlanBinding } from '../../models/ontology/index.model.ts';

export type { PlanBinding };

const SELECT = planBindingTable.select;

export const planBindingRepo = {
  /** Writes the binding once; a retry with the same id changes nothing. True when written now. */
  async insertOnce(db: Queryable, row: Omit<PlanBinding, 'createdAt'>): Promise<boolean> {
    const { rowCount } = await db.query(
      `insert into ontology.plan_bindings (id, organisation_id, compiled_manifest_id, parameters, created_by_membership_id,
         created_by_service_principal_id) values ($1, $2, $3, $4, $5, $6) on conflict (organisation_id, id) do nothing`,
      [row.id, row.organisationId, row.compiledManifestId, row.parameters, row.createdByMembershipId, row.createdByServicePrincipalId]);
    return (rowCount ?? 0) > 0;
  },

  async findById(db: Queryable, id: string): Promise<PlanBinding | undefined> {
    const { rows } = await db.query(`select ${SELECT} from ontology.plan_bindings where id = $1`, [id]);
    return rows[0] as PlanBinding | undefined;
  },

  /** Whether this member bound values to this manifest under this binding: the plan or chain is theirs. */
  async boundBy(db: Queryable, id: string, compiledManifestId: string, membershipId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from ontology.plan_bindings where id = $1 and compiled_manifest_id = $2 and created_by_membership_id = $3) as yes`,
      [id, compiledManifestId, membershipId]);
    return (rows[0] as { yes: boolean }).yes;
  },
};
