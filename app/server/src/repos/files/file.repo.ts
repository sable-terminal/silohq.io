// Data access for files.files, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { fileTable, type File, type FileChanges, type NewFile } from '../../models/files/file.model.ts';

export const fileRepo = {
  insert(db: Queryable, row: NewFile): Promise<File> {
    return insertRow(db, fileTable, row);
  },

  findById(db: Queryable, id: File['id']): Promise<File | undefined> {
    return findRow(db, fileTable, { id });
  },

  update(db: Queryable, id: File['id'], changes: FileChanges): Promise<File | undefined> {
    return updateRow(db, fileTable, { id }, changes);
  },

  /**
   * Files the member may see, with the access each gives: their own, and those shared with
   * them through a live share (the membership, a scope whose subtree holds one of theirs, or
   * the organisation). Never a count of the rest (spec 41.1).
   */
  async listVisible(db: Queryable, input: { membershipId: string; scopePaths: readonly string[]; which: 'all' | 'mine' | 'shared';
    folderId?: string | undefined; fileId?: string | undefined; limit: number }): Promise<(File & { access: 'owner' | 'view' | 'download' })[]> {
    const { rows } = await db.query(
      `with shared as (
         select s.file_id, max(case s.access when 'download' then 2 else 1 end) as level
         from files.file_shares s
         left join iam.scopes sc on sc.organisation_id = s.organisation_id and sc.id = s.grantee_scope_id
         where s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
           and (s.grantee_membership_id = $1 or s.grantee_whole_organisation
                or (sc.id is not null and exists (select 1 from unnest($2::text[]) as p where p::ltree <@ sc.path)))
         group by s.file_id)
       select ${fileTable.select.split(',').map((c) => `f.${c.trim()}`).join(', ')},
              case when f.created_by = $1 then 'owner' when sh.level = 2 then 'download' else 'view' end as access
       from files.files f left join shared sh on sh.file_id = f.id
       where f.status = 'available'
         and (case $3 when 'mine' then f.created_by = $1 when 'shared' then f.created_by <> $1 and sh.file_id is not null
                      else f.created_by = $1 or sh.file_id is not null end)
         and ($4::uuid is null or f.folder_id = $4) and ($5::uuid is null or f.id = $5)
       order by f.created_at desc, f.id limit $6`,
      [input.membershipId, [...input.scopePaths], input.which, input.folderId ?? null, input.fileId ?? null, input.limit]);
    return rows as (File & { access: 'owner' | 'view' | 'download' })[];
  },

  /** Locks the file for a change that must not cross a deletion. */
  /** The entries of uploads kept as these Silo files. */
  async listForSiloFiles(db: Queryable, siloFileIds: readonly string[]): Promise<File[]> {
    if (siloFileIds.length === 0) return [];
    const { rows } = await db.query(`select ${fileTable.select} from files.files where silo_file_id = any($1::uuid[]) for update`, [siloFileIds]);
    return rows as File[];
  },

  async findForUpdate(db: Queryable, id: string): Promise<File | undefined> {
    const { rows } = await db.query(`select ${fileTable.select} from files.files where id = $1 for update`, [id]);
    return rows[0] as File | undefined;
  },

  /**
   * Exports past their retention, across organisations: identifiers only, through the
   * definer function files.claim_expired_files, each locked for the caller's transaction.
   */
  async claimExpired(db: Queryable, batch: number, now: string): Promise<{ organisationId: string; id: string; createdBy: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", id, created_by as "createdBy" from files.claim_expired_files($1, $2)', [batch, now]);
    return rows as { organisationId: string; id: string; createdBy: string }[];
  },
};
