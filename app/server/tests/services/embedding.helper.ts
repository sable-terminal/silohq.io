// A stand-in embedding model for tests: each word (lower-cased, a trailing s dropped) hashed
// into one of the vector's dimensions, the vector normalised. Texts sharing words are near,
// texts sharing none are orthogonal, and the same text always embeds the same way.

import { createHash } from 'node:crypto';

export const DIMENSIONS = 1536;

export function fakeEmbedding(text: string, dimensions = DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const word of words) {
    const stem = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
    vector[createHash('sha256').update(stem).digest().readUInt32BE(0) % dimensions]! += 1;
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/** The OpenAI-compatible embeddings reply a self-hosted server gives, for a request body. */
export function embeddingsReply(body: { input: string[] | string; model?: string }): Record<string, unknown> {
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  return {
    model: body.model ?? 'embedding-test', object: 'list',
    data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(text) })),
    usage: { prompt_tokens: inputs.reduce((n, t) => n + t.split(/\s+/).length, 0), total_tokens: 0 },
  };
}
