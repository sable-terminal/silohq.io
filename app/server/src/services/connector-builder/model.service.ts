// The model's part of parse (spec 16.3): pasted documentation to a build draft, through the
// model gateway's connector_generation role.
//
// The prompt is the documentation as written for the schema (spec 62.1), and on a second
// round the source field names a probe observed and the objects the source did not know,
// never a record value. Documentation that carries a value pattern (an address, a card or
// a long number) is refused here, naming the kind, rather than sent and refused by the
// gateway; the person removes it. The output must match the draft schema, checked by the
// gateway and again here, and is refused, never repaired.

import { callModel, outputSpec, parseOutput } from '../../contracts/model-gateway/call.contract.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { findValuePatterns } from '../../utils/redaction.util.ts';
import { draftSchema, type Draft } from './draft.service.ts';
import type { Call } from '../visual-builder/versions.service.ts';

const INSTRUCTIONS = [
  'You draft a connector for an HTTP JSON API from its documentation.',
  'List each endpoint that returns a list of records: its path on the base URL, where the records sit in the response body',
  '(a dot path, or null for the body itself), each field with its dot path in a record and its type, and the field that',
  'identifies a record. Name the paging style (none, cursor, page or offset), the query parameter it uses, where the next',
  'cursor or the page count sits in the body, and the page size parameter. List query parameters that filter a field by',
  'equality. Give the authentication: none, bearer, basic, or api_key with where the key goes and its name.',
  'Use only what the documentation says. Never write an example value. Leave anything the documentation does not say null.',
].join(' ');

export interface Retry {
  /** Objects the source did not know at their path, by name and code. */
  failures: { object: string; code: string }[];
  /** Field names a probe observed, per object: source field names (spec 62.1). */
  observed: { object: string; fields: { name: string; type: string }[] }[];
}

export interface ModelDraft {
  draft: Draft;
  callId: string;
  tokens: number;
}

export async function draftFromText(services: ServiceClient, call: Call, connector: string, doc: { title: string; text: string },
  retry?: Retry): Promise<ModelDraft> {
  const kinds = [...new Set([...findValuePatterns(doc.title), ...findValuePatterns(doc.text)])];
  if (kinds.length > 0) {
    throw new AppError('validation', 'the documentation holds what looks like a record value; remove it and try again', {
      code: 'build.documentation_values', details: { kinds: kinds.join(','), stage: 'parse' },
    });
  }
  const question = retry === undefined ? undefined
    : `The source answered not found for these objects at their paths: ${retry.failures.map((f) => `${f.object} (${f.code})`).join(', ')}. `
      + 'Draft them again with the paths the documentation gives.';
  const result = await services.call(callModel, {
    body: {
      role: 'connector_generation',
      instructions: INSTRUCTIONS,
      vocabulary: {
        documentation: [{ title: doc.title, text: doc.text }],
        ...(retry === undefined ? {} : {
          sourceFields: retry.observed.flatMap((o) => o.fields.slice(0, 200).map((f) => ({ connection: connector, object: o.object, field: f.name, type: f.type }))),
        }),
      },
      ...(question === undefined ? {} : { question: question.slice(0, 2_000) }),
      output: outputSpec('connector_draft', draftSchema),
      maxOutputTokens: 8_192,
    },
  }, { ...call, timeoutMs: 60_000 });
  const draft = parseOutput(draftSchema, result.output);
  return { draft, callId: result.callId, tokens: result.usage.inputTokens + result.usage.outputTokens };
}
