/**
 * Dot paths into a parsed value: `data.items[0].id`.
 *
 * FOR PLACES, NOT FOR EXPRESSIONS. `body:auth.token` says where auth writes a
 * value and `body:access_token` where it reads one; an expression never needs
 * this, because JSONata is a better path language. What this can reach is
 * deliberately small — names and indexes — so a place cannot be made to mean
 * anything clever.
 */

type Step = string | number;

export function steps(path: string): Step[] {
  const out: Step[] = [];
  for (const part of path.split('.')) {
    if (part === '') continue;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      out.push(part);
      continue;
    }
    if (match[1]) out.push(match[1]);
    for (const index of match[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(index[1]));
  }
  return out;
}

/** The value at `path`, or undefined. Never throws. */
export function getPath(value: unknown, path: string): unknown {
  let here: unknown = value;
  for (const step of steps(path)) {
    if (here === null || here === undefined || typeof here !== 'object') return undefined;
    here = (here as Record<string | number, unknown>)[step];
  }
  return here;
}

/**
 * Set the value at `path`, creating objects and arrays on the way. Returns the
 * new root, so an absent body becomes an object.
 *
 * `__proto__`, `constructor` AND `prototype` ARE REFUSED as steps, because a
 * place is written by a manifest and the object is later serialised.
 */
export function setPath(root: unknown, path: string, value: unknown): unknown {
  const all = steps(path);
  if (all.length === 0) return value;
  if (all.some((step) => step === '__proto__' || step === 'constructor' || step === 'prototype')) {
    throw new Error(`Refused path ${path}.`);
  }
  const top: Record<string | number, unknown> =
    root !== null && typeof root === 'object' ? (root as Record<string | number, unknown>) : typeof all[0] === 'number' ? ([] as unknown as Record<number, unknown>) : {};
  let here = top;
  all.forEach((step, i) => {
    if (i === all.length - 1) {
      here[step] = value;
      return;
    }
    const next = here[step];
    if (next === null || typeof next !== 'object') {
      here[step] = typeof all[i + 1] === 'number' ? [] : {};
    }
    here = here[step] as Record<string | number, unknown>;
  });
  return top;
}
