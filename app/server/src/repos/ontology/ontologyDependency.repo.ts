// Data access for ontology.ontology_dependencies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by no service.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import {
  ontologyDependencyTable,
  type OntologyDependency,
} from '../../models/ontology/ontologyDependency.model.ts';

export const ontologyDependencyRepo = {
  findById(db: Queryable, id: OntologyDependency['id']): Promise<OntologyDependency | undefined> {
    return findRow(db, ontologyDependencyTable, { id });
  },

  /** Live dependants of these elements (the dependency index, spec 25.6): one row per element and dependant. */
  async liveForElements(db: Queryable, elementIds: readonly string[])
    : Promise<{ elementRef: string; dependantRef: string; dependantKind: string }[]> {
    if (elementIds.length === 0) return [];
    const { rows } = await db.query(
      `select element_ref as "elementRef", dependant_ref as "dependantRef",
              case when app_id is not null then 'app' when saved_view_id is not null then 'saved_view'
                   when object_set_id is not null then 'object_set' when automation_id is not null then 'automation'
                   when dependant_action_type_id is not null then 'action_type' when scenario_id is not null then 'scenario'
                   when dependant_function_id is not null then 'function' when silo_object_type_id is not null then 'silo_object_type'
                   when detector_threshold_id is not null then 'detector_threshold' when lens_id is not null then 'lens'
                   else 'interface_implementation' end as "dependantKind"
         from ontology.ontology_dependencies
        where element_ref = any($1::uuid[]) and removed_at is null`, [elementIds]);
    return rows as { elementRef: string; dependantRef: string; dependantKind: string }[];
  },

  /** The one write path (ontology.record_dependencies): the dependant relies on exactly these elements. */
  async record(db: Queryable, dependant: { kind: string; id: string }, ontologyVersionId: string,
    elements: readonly { kind: string; id: string }[]): Promise<void> {
    await db.query('select ontology.record_dependencies($1, $2, $3, $4::text[], $5::uuid[])',
      [dependant.kind, dependant.id, ontologyVersionId, elements.map((e) => e.kind), elements.map((e) => e.id)]);
  },

  /**
   * The people accountable for what depends on these elements, by dependant: an app's, a saved
   * view's, an object set's, a Cron's and a scenario's owner, and a lens's holder. Dependants
   * with no single owner (an Action type, a function, an interface implementation) name none.
   */
  async ownersOf(db: Queryable, elementIds: readonly string[]): Promise<string[]> {
    if (elementIds.length === 0) return [];
    const { rows } = await db.query(
      `select distinct coalesce(a.owner_membership_id, v.owner_membership_id, s.owner_membership_id, au.owner_membership_id,
                                sc.owner_membership_id, l.membership_id) as "membershipId"
         from ontology.ontology_dependencies d
         left join workspace.apps a on a.organisation_id = d.organisation_id and a.id = d.app_id
         left join workspace.saved_views v on v.organisation_id = d.organisation_id and v.id = d.saved_view_id
         left join ontology.object_sets s on s.organisation_id = d.organisation_id and s.id = d.object_set_id
         left join automation.automations au on au.organisation_id = d.organisation_id and au.id = d.automation_id
         left join simulation.scenarios sc on sc.organisation_id = d.organisation_id and sc.id = d.scenario_id
         left join recognition.lenses l on l.organisation_id = d.organisation_id and l.id = d.lens_id
        where d.element_ref = any($1::uuid[]) and d.removed_at is null`, [elementIds]);
    return rows.map((r) => (r as { membershipId: string | null }).membershipId).filter((m): m is string => m !== null).sort();
  },
};
