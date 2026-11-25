// Which routes the client calls: a route's name, quoted, in any source file outside the route
// table and the navigation registry (which list every route as data).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROUTES } from '../src/api/routes.generated.ts';

const SRC = path.resolve(import.meta.dirname, '../src');

export async function calledRoutes(): Promise<Set<string>> {
  const files = (await readdir(SRC, { recursive: true }))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith('navigation/') && !f.endsWith('routes.generated.ts'));
  const text = (await Promise.all(files.map((f) => readFile(path.join(SRC, f), 'utf8')))).join('\n');
  const called = new Set<string>();
  for (const name of Object.keys(ROUTES)) if (new RegExp(`['"\`]${name}['"\`]`).test(text)) called.add(name);
  return called;
}
