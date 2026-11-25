import { z } from 'zod';

/**
 * Files §3 — producing an export.
 *
 * THE SOURCE IS NAMED BY KIND AND ID, not by a free-form reference. §3 lists
 * four things an export may be produced from, and only views exist here yet —
 * the others arrive as the routes that read them do.
 */

export const exportView = z
  .object({
    viewId: z.string().uuid(),
    format: z.enum(['json', 'csv']).default('json'),
    /** Defaults to the view's own name. */
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const fileId = z.object({ id: z.string().uuid() }).strict();

/*
 * §2 — a folder is an arrangement. Nothing here grants anything, which is why
 * there is no access field: "a folder that grants access would let someone
 * widen a file's reach by moving it".
 */
export const createFolder = z
  .object({
    name: z.string().trim().min(1).max(128),
    parentId: z.string().uuid().nullable().default(null),
  })
  .strict();

export const browseFolder = z.object({ folderId: z.string().uuid().nullable().default(null) }).strict();

export const moveFile = z.object({ folderId: z.string().uuid().nullable().default(null) }).strict();

/*
 * §4 — one grantee, as maps have it. `view` or `download`, and not `edit`: a
 * file is a frozen result and there is nothing in it to edit.
 */
export const shareFile = z
  .object({
    grantee: z.union([
      z.object({ membershipId: z.string().uuid() }).strict(),
      z.object({ scopeId: z.string().uuid() }).strict(),
      z.object({ organisationWide: z.literal(true) }).strict(),
    ]),
    access: z.enum(['view', 'download']).default('download'),
    expiresAt: z.coerce.date().nullable().default(null),
  })
  .strict();

export const shareId = z.object({ id: z.string().uuid(), shareId: z.string().uuid() }).strict();

/*
 * §5 — asking to upload. The declared content type is recorded and then
 * disbelieved: §5 takes the type "from the bytes rather than the declared
 * header", and this field exists so the two can be compared.
 */
export const requestUpload = z
  .object({
    siloId: z.string().uuid(),
    filename: z.string().trim().min(1).max(256),
    contentType: z.string().trim().min(1).max(255),
    bytes: z.number().int().min(1).max(64 * 1024 * 1024),
  })
  .strict();

/*
 * §5 — "Ingestion is a deliberate act." Its own request rather than a flag on
 * the upload, so turning a document into queryable data is never a field
 * somebody set without meaning to.
 */
export const ingestFile = z.object({ sourceId: z.string().uuid() }).strict();
