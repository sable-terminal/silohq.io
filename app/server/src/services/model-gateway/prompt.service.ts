// The gateway builds every prompt itself from the typed request (spec 62.3), so what a
// model receives is exactly what the request schema permits and nothing a caller wrote
// around it. The rendering is deterministic (canonical JSON), so the same request gives
// the same prompt and the same prompt hash.
//
// The hash (SHA-256) is what platform.model_calls keeps instead of the prompt. For a
// document extraction it covers the media type and byte count, not the document: a hash
// of a customer's file would let anyone holding a guess confirm it.

import type { z } from 'zod';
import type { ModelRole } from '../../config/model.config.ts';
import type { calendarContext, findingsSummary, vocabulary } from '../../contracts/model-gateway/call.contract.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';

export interface PromptParts {
  role: ModelRole;
  instructions: string;
  vocabulary?: z.output<typeof vocabulary> | undefined;
  question?: string | undefined;
  context?: z.output<typeof calendarContext> | undefined;
  findingsSummary?: z.output<typeof findingsSummary> | undefined;
  output: { name: string; schema: Record<string, unknown> };
  /** document_extraction: described, not included. */
  document?: { mediaType: string; bytes: number } | undefined;
}

export interface Prompt {
  system: string;
  user: string;
  /** The output contract as the endpoint receives it. */
  outputName: string;
  outputSchema: Record<string, unknown>;
  /** UTF-8 bytes of everything sent except a document. */
  bytes: number;
  hash: Buffer;
}

const isEmpty = (value: object | undefined): boolean =>
  value === undefined || Object.values(value).every((v) => v === undefined || (Array.isArray(v) && v.length === 0));

export function assemblePrompt(parts: PromptParts): Prompt {
  // The dialect marker means nothing to an endpoint and some refuse it.
  const { $schema: _dialect, ...outputSchema } = parts.output.schema;

  const sections: string[] = [];
  if (!isEmpty(parts.vocabulary)) {
    sections.push(`Vocabulary: the names this reader may see. It contains no record values.\n${canonicalJson(parts.vocabulary)}`);
  }
  if (parts.findingsSummary !== undefined) {
    const fields = parts.findingsSummary.copiedFields.map((f) => `${f.objectType}.${f.property}`);
    sections.push(`Findings summary. Figures are copied from these fields only: ${fields.length > 0 ? fields.join(', ') : 'none'}.\n`
      + canonicalJson(parts.findingsSummary));
  }
  if (!isEmpty(parts.context)) sections.push(`Calendar:\n${canonicalJson(parts.context)}`);
  if (parts.question !== undefined) sections.push(`Question:\n${parts.question}`);
  if (parts.document !== undefined) sections.push('Document: the attached file.');

  const system = `${parts.instructions}\n\nAnswer with one JSON value that matches the output schema named ${parts.output.name}.`;
  const user = sections.join('\n\n');
  const schemaText = canonicalJson(outputSchema);
  return {
    system,
    user,
    outputName: parts.output.name,
    outputSchema,
    bytes: Buffer.byteLength(system) + Buffer.byteLength(user) + Buffer.byteLength(schemaText),
    hash: sha256(canonicalJson({
      role: parts.role, system, user, output: { name: parts.output.name, schema: outputSchema }, document: parts.document ?? null,
    })),
  };
}
