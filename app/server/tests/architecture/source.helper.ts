// The source files under src, and a small scanner the architecture checks share. The
// scanner knows strings, template literals (with their tag and interpolations), comments
// and regular expression literals, so a check can tell code from text.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The only modules that build SQL for customer systems (tests/architecture/sql.test.ts),
// and the builder they use.
export const SQL_MODULES = [
  'services/connect-runtime/protocols/sql/',
  'services/connect-runtime/protocols/bigquery/',
  'services/warehouse-schema/generator/',
];
export const SQL_BUILDER = 'utils/sqlBuilder.util.ts';

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Every .ts file under src, with a path relative to src using forward slashes. */
export const all = files(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  source: readFileSync(file, 'utf8'),
}));

/** The module specifiers a file imports or re-exports, static and dynamic. */
export const imports = (source: string): string[] =>
  [...source.matchAll(/(?:import|export)[^'"]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)|^import\s+'([^']+)'/gm)]
    .map((m) => m[1] ?? m[2] ?? m[3]!);

/** A relative import as a path under src ('../infra/x.ts' from 'services/a/b.ts' gives 'services/infra/x.ts'). */
export const resolveImport = (file: string, specifier: string): string =>
  specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier;

export interface Literal {
  kind: 'string' | 'template';
  /** The text, without quotes. A template's interpolations read as ${}. */
  text: string;
  /** The tag of a tagged template (sql`...`), if any. */
  tag: string | undefined;
  interpolated: boolean;
  start: number;
  end: number;
}

export interface Scanned {
  /** The source with comments blanked. */
  code: string;
  /** The source with comments and the contents of every string and template blanked. */
  blank: string;
  literals: Literal[];
}

const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'case', 'throw', 'else', 'in', 'of', 'await', 'yield', 'void', 'delete', 'new']);

export function scan(source: string): Scanned {
  const code = [...source];
  const blank = [...source];
  const literals: Literal[] = [];
  const clear = (target: string[], from: number, to: number): void => {
    for (let k = from; k < to; k++) if (target[k] !== '\n') target[k] = ' ';
  };
  type Frame = { kind: 'template'; literal: Literal } | { kind: 'expression'; depth: number };
  const stack: Frame[] = [];
  let previous = '';
  const wordBefore = (i: number): string | undefined => /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(Math.max(0, i - 40), i))?.[1];
  const regexMayStart = (i: number): boolean => {
    if (previous === '' || '(,=:[!&|?{};+-*%<>~^'.includes(previous)) return true;
    const word = wordBefore(i);
    return word !== undefined && /[\w$]/.test(previous) && KEYWORDS_BEFORE_EXPRESSION.has(word);
  };

  let i = 0;
  while (i < source.length) {
    const top = stack[stack.length - 1];
    const ch = source[i]!;
    if (top?.kind === 'template') {
      if (ch === '\\') {
        top.literal.text += source.slice(i, i + 2);
        clear(blank, i, i + 2);
        i += 2;
      } else if (ch === '`') {
        top.literal.end = i + 1;
        stack.pop();
        previous = '`';
        i += 1;
      } else if (ch === '$' && source[i + 1] === '{') {
        top.literal.text += '${}';
        top.literal.interpolated = true;
        stack.push({ kind: 'expression', depth: 0 });
        previous = '{';
        i += 2;
      } else {
        top.literal.text += ch;
        clear(blank, i, i + 1);
        i += 1;
      }
      continue;
    }
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i);
      clear(code, i, end);
      clear(blank, i, end);
      i = end;
    } else if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? source.length : close + 2;
      clear(code, i, end);
      clear(blank, i, end);
      i = end;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== ch && source[j] !== '\n') {
        if (source[j] === '\\') {
          text += source.slice(j, j + 2);
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      literals.push({ kind: 'string', text, tag: undefined, interpolated: false, start: i, end: j + 1 });
      clear(blank, i + 1, j);
      previous = ch;
      i = j + 1;
    } else if (ch === '`') {
      const tag = /([A-Za-z_$][\w$.]*)\s*$/.exec(source.slice(Math.max(0, i - 80), i))?.[1];
      const literal: Literal = {
        kind: 'template', text: '', tag: tag !== undefined && !KEYWORDS_BEFORE_EXPRESSION.has(tag) && /[\w$]/.test(previous) ? tag : undefined,
        interpolated: false, start: i, end: -1,
      };
      literals.push(literal);
      stack.push({ kind: 'template', literal });
      i += 1;
    } else if (ch === '/' && regexMayStart(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j += 1;
      }
      if (source[j] !== '/') {
        previous = ch;
        i += 1;
        continue;
      }
      j += 1;
      while (/[a-z]/.test(source[j] ?? '')) j += 1;
      clear(blank, i + 1, j - 1);
      previous = '/';
      i = j;
    } else {
      if (top?.kind === 'expression') {
        if (ch === '{') top.depth += 1;
        else if (ch === '}') {
          if (top.depth === 0) {
            stack.pop();
            previous = '}';
            i += 1;
            continue;
          }
          top.depth -= 1;
        }
      }
      if (!/\s/.test(ch)) previous = ch;
      i += 1;
    }
  }
  return { code: code.join(''), blank: blank.join(''), literals };
}

/** Whether a literal is the specifier of an import or export. */
export const isImportSpecifier = (scanned: Scanned, literal: Literal): boolean =>
  /(?:\bfrom|\bimport\s*\(|^\s*import|\brequire\s*\()\s*$/m.test(scanned.blank.slice(Math.max(0, literal.start - 40), literal.start));
