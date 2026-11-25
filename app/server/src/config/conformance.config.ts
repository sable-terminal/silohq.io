// Conformance (spec 17.2; decision 2026-11-15): how long the change-stream class waits for a
// change to arrive after each edit of the test record, and how often it looks meanwhile.
// A webhook arrives when the provider sends it; a poll source is read on each look.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const schema = z.object({
  streamWaitMs: zPositiveInt(15 * 60_000).default(120_000),
  streamPollMs: zPositiveInt(60_000).default(2_000),
});

export type ConformanceConfig = z.output<typeof schema>;

export function loadConformanceConfig(env: Env, problems: string[]): ConformanceConfig | undefined {
  return parseSection(schema, { streamWaitMs: read(env, 'CONFORMANCE_STREAM_WAIT_MS'), streamPollMs: read(env, 'CONFORMANCE_STREAM_POLL_MS') },
    { streamWaitMs: 'CONFORMANCE_STREAM_WAIT_MS', streamPollMs: 'CONFORMANCE_STREAM_POLL_MS' }, problems);
}
