// Document extraction (spec 62.5): the one disclosed carve-out from "no record values in a
// prompt". Siloes Import sends the contents of a file the person explicitly imported into
// an import Silo, and only once a holder of silo.enable has acknowledged the carve-out on
// that Silo. Tabular files never come here: a CSV import never invokes a model.
//
// The document is a recordValue() field, the only one in any model request; the
// vocabulary request (call.contract.ts) has none. The gateway checks the acknowledgement
// itself, records the call with request type document_extraction, and writes
// extraction_carveout_used with the file reference and byte count.

import { z } from 'zod';
import { DOCUMENT_MEDIA_TYPES } from '../../config/model.config.ts';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { modelCallResult, outputContract } from './call.contract.ts';

export const extractDocument = defineContract({
  service: 'model-gateway', name: 'extractDocument', method: 'POST', path: '/v1/extractions',
  callers: ['siloes-import'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    siloId: z.uuid(),
    fileId: z.uuid(),
    instructions: z.string().min(1).max(32_000),
    document: z.strictObject({
      mediaType: z.enum(DOCUMENT_MEDIA_TYPES),
      /** The file's bytes, base64. Record values: never logged, hashed or kept. */
      contentBase64: recordValue(z.base64().min(4)),
    }),
    output: outputContract,
    maxOutputTokens: z.int().min(1).max(1_000_000).optional(),
  }),
  response: modelCallResult,
  // The process limit (HTTP_MAX_BODY_BYTES) applies when lower.
  maxBodyBytes: 64 * 1024 * 1024,
});
