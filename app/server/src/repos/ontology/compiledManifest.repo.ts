// Data access for ontology.compiled_manifests, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  compiledManifestTable,
  type CompiledManifest,
  type NewCompiledManifest,
} from '../../models/ontology/compiledManifest.model.ts';

export const compiledManifestRepo = {
  insert(db: Queryable, row: NewCompiledManifest): Promise<CompiledManifest> {
    return insertRow(db, compiledManifestTable, row);
  },

  findById(db: Queryable, id: CompiledManifest['id']): Promise<CompiledManifest | undefined> {
    return findRow(db, compiledManifestTable, { id });
  },

  findByManifestHashAndPolicyVersion(
    db: Queryable,
    key: Pick<CompiledManifest, 'organisationId' | 'manifestHash' | 'policyVersion'>,
  ): Promise<CompiledManifest | undefined> {
    return findRow(db, compiledManifestTable, key);
  },

  /** Of these manifests, the chains (spec 37.8): each one's step operations in order. */
  async analysisOperations(db: Queryable, ids: readonly CompiledManifest['id'][]): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const { rows } = await db.query(
      `select m.id, coalesce((select array_agg(s.step->>'operation' order by s.position)
                                from jsonb_array_elements(m.manifest->'steps') with ordinality as s(step, position)), '{}') as operations
         from ontology.compiled_manifests m
        where m.id = any($1::uuid[]) and m.kind = 'analysis'`, [[...new Set(ids)]]);
    return new Map((rows as { id: string; operations: string[] }[]).map((r) => [r.id, r.operations]));
  },

  /** The kind of branch the plan's ontology version is on (spec 25.3): 'main', or a branch's kind. */
  async branchKindOf(db: Queryable, id: CompiledManifest['id']): Promise<string | undefined> {
    const { rows } = await db.query(
      `select b.kind from ontology.compiled_manifests m
         join ontology.ontology_versions v on v.organisation_id = m.organisation_id and v.id = m.ontology_version_id
         join ontology.ontology_branches b on b.organisation_id = v.organisation_id and b.id = v.branch_id
        where m.id = $1`, [id]);
    return (rows[0] as { kind: string } | undefined)?.kind;
  },
};
