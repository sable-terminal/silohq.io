import { z } from 'zod';

/**
 * Siloes — Import, at the door.
 *
 * NO FILE CONTENT CROSSES THIS ROUTER. A file is described here — its name, its
 * declared type and size — and its bytes go straight to object storage through
 * a signed URL. A definition document does cross it, and is validated by the
 * service against the definition schema, so a half-finished draft can be saved.
 */

const uuid = z.string().uuid();

export const siloParams = z.object({ id: uuid }).strict();
export const sourceParams = z.object({ sourceId: uuid }).strict();
export const fileParams = z.object({ fileId: uuid }).strict();
export const definitionParams = z.object({ definitionId: uuid }).strict();

export const createSource = z.object({ name: z.string().trim().min(1).max(128) }).strict();

export const requestUpload = z
  .object({
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(128),
    /* The schema's own cap on `silo_files.declared_bytes`. */
    bytes: z.number().int().min(1).max(64 * 1024 * 1024),
  })
  .strict();

export const draftFromFile = z
  .object({ fileId: uuid, name: z.string().trim().min(1).max(128).optional() })
  .strict();

export const adoptPrebuilt = z.object({ definitionId: uuid }).strict();

export const saveDraft = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    document: z.record(z.string(), z.unknown()),
  })
  .strict();

export const probe = z.object({ fileId: uuid }).strict();

export const localUploadParams = z.object({ token: z.string().min(10).max(2048) }).strict();

/* ── Watched locations ───────────────────────────────────────────────────── */

/* A DNS name or an IPv4 address. An IPv6 literal is not accepted yet. */
const HOST = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/);

const PORT = z.number().int().min(1).max(65_535).default(22);

export const fingerprintRequest = z.object({ host: HOST, port: PORT }).strict();

export const configureWatched = z
  .object({
    name: z.string().trim().min(1).max(128),
    host: HOST,
    port: PORT,
    directory: z
      .string()
      .min(1)
      .max(512)
      .refine((path) => path.startsWith('/'), 'The directory is an absolute path.')
      .refine((path) => !path.split('/').includes('..'), 'The directory may not climb out of itself.')
      .refine((path) => [...path].every((char) => char.charCodeAt(0) >= 32), 'The directory contains a control character.'),
    pattern: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9 _.*?-]+$/).default('*'),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    username: z.string().min(1).max(128),
    secret: z.string().min(1).max(16_384),
    includeExisting: z.boolean().default(false),
  })
  .strict();

/* ── A flag ──────────────────────────────────────────────────────────────── */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export const setDocumentModel = z
  .object({ enabled: z.boolean(), acknowledgedDisclosure: z.string().regex(/^[0-9a-f]{64}$/).optional() })
  .strict();

export const draftFromDocuments = z
  .object({ fileIds: z.array(uuid).min(1).max(5), name: z.string().trim().min(1).max(128).optional() })
  .strict();

export const confirmFlag = z
  .object({
    object: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
    row: z.string().min(1).max(128),
    field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  })
  .strict();

export const flagQuery = z
  .object({
    object: z.string().regex(IDENTIFIER),
    row: z.string().min(1).max(128),
    field: z.string().regex(IDENTIFIER),
  })
  .strict();

