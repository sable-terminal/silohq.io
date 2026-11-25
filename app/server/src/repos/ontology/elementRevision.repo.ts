// Data access for ontology.element_revisions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  elementRevisionTable,
  type ElementRevision,
  type NewElementRevision,
} from '../../models/ontology/elementRevision.model.ts';

export const elementRevisionRepo = {
  insert(db: Queryable, row: NewElementRevision): Promise<ElementRevision> {
    return insertRow(db, elementRevisionTable, row);
  },

  findById(db: Queryable, id: ElementRevision['id']): Promise<ElementRevision | undefined> {
    return findRow(db, elementRevisionTable, { id });
  },

  findByElementRefAndRevision(
    db: Queryable,
    key: Pick<ElementRevision, 'organisationId' | 'elementRef' | 'revision'>,
  ): Promise<ElementRevision | undefined> {
    return findRow(db, elementRevisionTable, key);
  },

  /**
   * The latest revision of each element (link type, interface, shared property, function,
   * field authority) in a version chain, and whether the element has a revision on main
   * in that chain.
   */
  async latestInChain(db: Queryable, chain: { id: string; depth: number; onMain: boolean }[])
    : Promise<(ElementRevision & { onMain: boolean })[]> {
    const { rows } = await db.query(
      `with c as (select * from unnest($1::uuid[], $2::int[], $3::bool[]) as c(cid, cdepth, con_main)),
            e as (select r.id as rid, r.element_ref as rref, c.cdepth, c.con_main
                    from ontology.element_revisions r join c on c.cid = r.ontology_version_id),
            l as (select distinct on (rref) rid, bool_or(con_main) over (partition by rref) as on_main from e order by rref, cdepth)
       select ${elementRevisionTable.select}, l.on_main as "onMain"
         from ontology.element_revisions join l on l.rid = id`,
      [chain.map((c) => c.id), chain.map((c) => c.depth), chain.map((c) => c.onMain)]);
    return rows as (ElementRevision & { onMain: boolean })[];
  },

  async maxRevision(db: Queryable, elementRef: string): Promise<number> {
    const { rows } = await db.query('select coalesce(max(revision), 0)::int as n from ontology.element_revisions where element_ref = $1', [elementRef]);
    return (rows[0] as { n: number }).n;
  },
};
