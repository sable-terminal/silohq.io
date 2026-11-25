// Connection parameters against the manifest that declares them (spec 14.3 params).
//
// - A value is accepted only for a declared name, and must match the declared pattern,
//   anchored at both ends.
// - A parameter that fills a host part of the base URL must be one DNS label, so no value
//   can move a request to another host.
// - A required parameter may be missing while the connection is a draft; probing refuses
//   until every one is set.
//
// A pattern comes from a manifest any member may write, and is matched against values here,
// so it is checked when the manifest is saved. A backtracking regular expression can take
// exponential time, out of reach of any meter. Refused: backreferences, lookaround,
// quantified groups that contain a quantifier or an alternation (nested repetition), and
// more than three repeating quantifiers. With values of at most 256 characters, what
// remains runs in polynomial time with a small exponent.

import type { Issue } from '../../utils/errors.util.ts';
import type { Manifest } from '../../contracts/connect/manifest.contract.ts';
import { parameterValue, type ConnectionParameters } from '../../contracts/connect/parameters.contract.ts';
import { AppError } from '../../utils/errors.util.ts';

const MAX_REPEATS = 3;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Why a pattern is refused, or undefined when it is in the safe subset. */
export function unsafePattern(pattern: string): string | undefined {
  try {
    new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return 'not a valid regular expression';
  }
  interface Group { quantified: boolean; alternation: boolean }
  const stack: Group[] = [{ quantified: false, alternation: false }];
  let repeats = 0;
  // What a quantifier would apply to: a closed group (with its contents), or a single atom.
  let last: { kind: 'group'; group: Group } | { kind: 'atom' } | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') return 'backreferences are not allowed';
      i += next === 'u' && pattern[i + 2] === '{' ? pattern.indexOf('}', i) - i : 1;
      last = { kind: 'atom' };
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      for (; j < pattern.length && pattern[j] !== ']'; j++) if (pattern[j] === '\\') j++;
      i = j;
      last = { kind: 'atom' };
      continue;
    }
    if (c === '(') {
      if (pattern[i + 1] === '?') {
        const kind = pattern.slice(i + 2, i + 4);
        if (kind.startsWith('=') || kind.startsWith('!') || kind === '<=' || kind === '<!') return 'lookaround is not allowed';
      }
      stack.push({ quantified: false, alternation: false });
      last = undefined;
      continue;
    }
    if (c === ')') {
      const group = stack.pop()!;
      if (stack.length === 0) return 'unbalanced parentheses';
      const parent = stack.at(-1)!;
      parent.quantified ||= group.quantified;
      last = { kind: 'group', group };
      continue;
    }
    if (c === '|') {
      stack.at(-1)!.alternation = true;
      last = undefined;
      continue;
    }
    const brace = c === '{' ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i)) : null;
    if (c === '*' || c === '+' || c === '?' || brace) {
      if (last === undefined) continue; // a lazy marker after a quantifier
      const repeating = c === '*' || c === '+' || (brace !== null && (brace[2] === undefined ? Number(brace[1]) > 1 : brace[3] === '' || Number(brace[3]) > 1));
      if (last.kind === 'group' && repeating && (last.group.quantified || last.group.alternation)) {
        return 'a repeated group may not contain repetition or alternation';
      }
      if (repeating) {
        repeats += 1;
        stack.at(-1)!.quantified = true;
      }
      if (repeats > MAX_REPEATS) return `at most ${MAX_REPEATS} repeating quantifiers`;
      if (brace) i += brace[0].length - 1;
      last = undefined;
      continue;
    }
    last = { kind: 'atom' };
  }
  return undefined;
}

/** Save-time issues for the parameters a manifest declares. */
export function parameterIssues(manifest: Manifest): Issue[] {
  const issues: Issue[] = [];
  manifest.params.forEach((p, i) => {
    if (p.pattern === undefined) return;
    const reason = unsafePattern(p.pattern);
    if (reason !== undefined) issues.push({ path: `document.params.${i}.pattern`, code: 'manifest.pattern_unsafe', message: `the pattern is refused: ${reason}` });
  });
  return issues;
}

/** Parameters that fill a host part of the base URL. */
function hostParameters(manifest: Manifest): Set<string> {
  const origin = /^https?:\/\/([^/?#]+)/.exec(manifest.transport.baseUrl ?? '')?.[1] ?? '';
  return new Set([...origin.matchAll(/\{params\.([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]!));
}

/** Checks a whole parameter set against the manifest; refuses with the names at fault, never the values. */
export function checkParameters(manifest: Manifest, values: ConnectionParameters): ConnectionParameters {
  const declared = new Map(manifest.params.map((p) => [p.name, p]));
  const hosts = hostParameters(manifest);
  for (const [name, value] of Object.entries(values)) {
    const param = declared.get(name);
    if (param === undefined) {
      throw new AppError('validation', 'the manifest declares no parameter of that name', { code: 'connection.parameter_unknown', details: { parameter: name } });
    }
    if (!parameterValue.safeParse(value).success
      || (param.pattern !== undefined && !new RegExp(`^(?:${param.pattern})$`, 'u').test(value))
      || (hosts.has(name) && !LABEL.test(value))) {
      throw new AppError('validation', 'the value does not fit the parameter', { code: 'connection.parameter_invalid', details: { parameter: name } });
    }
  }
  return values;
}

/** Required parameters with no value. */
export function missingParameters(manifest: Manifest, values: ConnectionParameters): string[] {
  return manifest.params.filter((p) => p.required && values[p.name] === undefined).map((p) => p.name);
}
