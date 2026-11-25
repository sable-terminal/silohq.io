import { Router } from 'express';
import * as file from '../controllers/file.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireCapability } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/file.schema';

/**
 * Files.
 *
 * `canExport`, NOT `canQuery`, AND THE DIFFERENCE IS §15.3's PROMISE. A
 * cancelled account cannot ask new questions, and export and history are
 * "never withheld" — so reading and downloading what somebody already produced
 * stays open at the bottom of the billing ladder.
 *
 * PRODUCING a new export does ask a question, so that one is behind `canQuery`
 * as well. Exporting a view runs it.
 */
export const fileRouter: Router = Router();

fileRouter.use(requireAuth);
fileRouter.use(requireCapability('canExport'));

fileRouter.get('/', file.mine);

/* §6 — before `/:id`, like the others: a receipt outlives its file, so this
   cannot be a path under one. */
fileRouter.get('/deletions', file.deletions);

/* §2 — before `/:id`, or "folders" is read as a file id. */
fileRouter.get('/folders', file.browse);

fileRouter.post('/folders', writeLimit, validate({ body: schema.createFolder }), file.createFolder);

fileRouter.post(
  '/exports',
  writeLimit,
  requireCapability('canQuery'),
  validate({ body: schema.exportView }),
  file.exportView,
);

/*
 * §5 — TWO STEPS, because the bytes go straight to the object store and never
 * through this process. The first judges everything decidable without them;
 * the second judges the bytes themselves.
 */
fileRouter.post('/uploads', writeLimit, validate({ body: schema.requestUpload }), file.requestUpload);

fileRouter.post(
  '/uploads/:id/received',
  writeLimit,
  validate({ params: schema.fileId }),
  file.confirmUpload,
);

fileRouter.get('/:id', validate({ params: schema.fileId }), file.read);

fileRouter.get('/:id/download', validate({ params: schema.fileId }), file.download);

/* §5 — the second outcome, asked for separately because it is a decision. */
fileRouter.post(
  '/:id/ingest',
  writeLimit,
  validate({ params: schema.fileId, body: schema.ingestFile }),
  file.ingest,
);

/* §6 — removes the document, its extractions and what was derived from them. */
fileRouter.delete('/:id', writeLimit, validate({ params: schema.fileId }), file.remove);

fileRouter.patch(
  '/:id/folder',
  writeLimit,
  validate({ params: schema.fileId, body: schema.moveFile }),
  file.move,
);

fileRouter.post(
  '/:id/shares',
  writeLimit,
  validate({ params: schema.fileId, body: schema.shareFile }),
  file.share,
);

fileRouter.delete(
  '/:id/shares/:shareId',
  writeLimit,
  validate({ params: schema.shareId }),
  file.revokeShare,
);
