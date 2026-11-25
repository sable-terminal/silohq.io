// Compile (spec 26; decision 2026-11-15): how many object types a question is compiled against
// when the reader's vocabulary is larger, chosen by description embeddings (schema linking),
// before widening once to the whole vocabulary where the narrowed one cannot answer.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const schema = z.object({ narrowTypes: zPositiveInt(1_000).default(20) });

export type CompileConfig = z.output<typeof schema>;

export function loadCompileConfig(env: Env, problems: string[]): CompileConfig | undefined {
  return parseSection(schema, { narrowTypes: read(env, 'COMPILE_NARROW_TYPES') }, { narrowTypes: 'COMPILE_NARROW_TYPES' }, problems);
}
