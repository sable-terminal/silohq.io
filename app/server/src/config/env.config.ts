// Reading configuration from the environment. Fleet delivers every value: the release
// configuration as environment variables, secrets as files mounted from the cell's
// secret store (spec 11.1). A secret may be given as NAME or as NAME_FILE, a path to a
// file holding it; the file form keeps secrets out of process listings and crash
// reports.
//
// Problems are collected across every section and reported together, naming the
// variable and never echoing its value (it may be a secret).

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from '../utils/errors.util.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends AppError {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super('configuration', `configuration refused:\n  ${problems.join('\n  ')}`, {
      code: 'config.invalid', details: { problems: problems.length },
    });
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

// NAME, or the contents of the file at NAME_FILE (trailing newline trimmed).
export function readSecret(env: Env, name: string, problems: string[]): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) {
    problems.push(`${name}: set either ${name} or ${name}_FILE, not both`);
    return undefined;
  }
  if (file === undefined) return direct === '' ? undefined : direct;
  try {
    return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch {
    problems.push(`${name}_FILE: cannot read the file`);
    return undefined;
  }
}

// Plain variables, with empty strings treated as unset.
export function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

// Validates one section. vars maps each field to the variable it came from, so a problem
// names what an operator can fix.
export function parseSection<S extends z.ZodType>(
  schema: S,
  raw: Record<string, unknown>,
  vars: Readonly<Record<string, string>>,
  problems: string[],
): z.output<S> | undefined {
  const defined = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const result = schema.safeParse(defined);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    const variable = typeof field === 'string' ? vars[field] ?? field : 'configuration';
    problems.push(`${variable}: ${issue.message}`);
  }
  return undefined;
}

export const zPort = z.coerce.number().int().min(1).max(65535);
export const zPositiveInt = (max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(1).max(max);
export const zBool = z.stringbool();
export const zList = z.string().transform((value) => value.split(',').map((s) => s.trim()).filter(Boolean));

// A 256-bit key given as base64.
export const zKey32 = z.string()
  .transform((value) => Buffer.from(value, 'base64'))
  .refine((key) => key.length === 32, 'must be 32 bytes, base64-encoded');

export const zPostgresUrl = z.string().regex(/^postgres(?:ql)?:\/\/.+/, 'must be a postgres:// URL');

// Every value in config is read-only once loaded.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
