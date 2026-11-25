import express, { Router } from 'express';
import * as siloImport from '../controllers/siloImport.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/siloImport.schema';

/**
 * Siloes — Import. Mounted beside the Silo router under `/siloes`, and only
 * where the build has storage.
 *
 * `silo.import` FOR ALL OF IT, checked in the service. Putting data in is a
 * different act from configuring what is kept, and defining the structure data
 * is read under is part of putting it in.
 */
export const siloImportRouter: Router = Router();

siloImportRouter.use(requireAuth);

siloImportRouter.post(
  '/:id/sources',
  writeLimit,
  validate({ params: schema.siloParams, body: schema.createSource }),
  siloImport.createSource,
);
siloImportRouter.get('/:id/sources', validate({ params: schema.siloParams }), siloImport.sources);

siloImportRouter.post(
  '/sources/:sourceId/uploads',
  writeLimit,
  validate({ params: schema.sourceParams, body: schema.requestUpload }),
  siloImport.requestUpload,
);
siloImportRouter.get('/sources/:sourceId/files', validate({ params: schema.sourceParams }), siloImport.files);

siloImportRouter.post(
  '/files/:fileId/received',
  writeLimit,
  validate({ params: schema.fileParams }),
  siloImport.markReceived,
);

siloImportRouter.post(
  '/sources/:sourceId/definitions/draft',
  writeLimit,
  validate({ params: schema.sourceParams, body: schema.draftFromFile }),
  siloImport.draftFromFile,
);
siloImportRouter.post(
  '/sources/:sourceId/definitions/prebuilt',
  writeLimit,
  validate({ params: schema.sourceParams, body: schema.adoptPrebuilt }),
  siloImport.adoptPrebuilt,
);
siloImportRouter.get(
  '/sources/:sourceId/definitions',
  validate({ params: schema.sourceParams }),
  siloImport.definitions,
);
siloImportRouter.get('/definitions/prebuilt', siloImport.prebuilt);

siloImportRouter.put(
  '/definitions/:definitionId',
  writeLimit,
  validate({ params: schema.definitionParams, body: schema.saveDraft }),
  siloImport.saveDraft,
);
siloImportRouter.post(
  '/definitions/:definitionId/probe',
  writeLimit,
  validate({ params: schema.definitionParams, body: schema.probe }),
  siloImport.probe,
);
siloImportRouter.post(
  '/definitions/:definitionId/publish',
  writeLimit,
  validate({ params: schema.definitionParams }),
  siloImport.publish,
);

/*
 * §8 — THE CARVE-OUT. `silo.enable` to choose it, in the service; anybody who can
 * see the import may see whether it is on and read the words.
 */
siloImportRouter.get('/document-model', siloImport.documentModel);
siloImportRouter.put(
  '/document-model',
  writeLimit,
  validate({ body: schema.setDocumentModel }),
  siloImport.setDocumentModel,
);
siloImportRouter.post(
  '/sources/:sourceId/definitions/ai',
  writeLimit,
  validate({ params: schema.sourceParams, body: schema.draftFromDocuments }),
  siloImport.draftFromDocuments,
);

/* §5 — confirming a flagged value asserts a fact about a concept: `concept.confirm`, in the service. */
siloImportRouter.post(
  '/files/:fileId/flag/confirm',
  writeLimit,
  validate({ params: schema.fileParams, body: schema.confirmFlag }),
  siloImport.confirmFlag,
);

/* §5 — the file's flagged values. Without the list, neither of the two below can be reached. */
siloImportRouter.get('/files/:fileId/flags', validate({ params: schema.fileParams }), siloImport.flagged);

/* §5 — a flag's explanation. Read-only, and held to the same conditions as the value. */
siloImportRouter.get(
  '/files/:fileId/flag',
  validate({ params: schema.fileParams, query: schema.flagQuery }),
  siloImport.explainFlag,
);

/*
 * WATCHED LOCATIONS. Configuring one is `silo.import` — "uploading files or
 * configuring a watched location" — and so is asking for its host key, because
 * that is this server opening a connection somewhere a person named.
 */
siloImportRouter.post(
  '/watched/fingerprint',
  writeLimit,
  validate({ body: schema.fingerprintRequest }),
  siloImport.fingerprint,
);
siloImportRouter.post(
  '/:id/watched',
  writeLimit,
  validate({ params: schema.siloParams, body: schema.configureWatched }),
  siloImport.configureWatched,
);
siloImportRouter.post(
  '/sources/:sourceId/poll',
  writeLimit,
  validate({ params: schema.sourceParams }),
  siloImport.pollNow,
);
siloImportRouter.delete(
  '/sources/:sourceId',
  writeLimit,
  validate({ params: schema.sourceParams }),
  siloImport.stopWatching,
);

/**
 * The local object store's stand-in for a signed upload URL.
 *
 * MOUNTED ONLY WHERE THE STORE IS LOCAL, and the only route in the API that
 * takes a raw body. 64 MB is the import cap; the global JSON parser ignores a
 * body whose type is not JSON, so it reaches this one untouched.
 */
export const localUploadRouter: Router = Router();

localUploadRouter.put(
  '/:token',
  express.raw({ type: () => true, limit: '64mb' }),
  validate({ params: schema.localUploadParams }),
  siloImport.localUpload,
);
