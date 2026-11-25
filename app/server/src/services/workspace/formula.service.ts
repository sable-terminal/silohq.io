// Workbook formulas (D232): a small spreadsheet language, the same module in the browser (which
// recalculates as a person types) and on the server (which validates and exports). Numbers,
// text, booleans, blanks and errors; cell references (A1, $A$1, Sheet!A1) and ranges (A1:B9);
// arithmetic, comparison and concatenation with the usual precedence; a closed set of functions.
// No function reaches anything outside the workbook: no network, no clock but the evaluation date
// the caller gives, no volatile randomness. Cycles evaluate to #CYCLE!, never loop. Pure.

export type ErrorCode = '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A' | '#NUM!' | '#CYCLE!' | '#PARSE!';
export interface CellError { error: ErrorCode }
export type Value = number | string | boolean | null | CellError;
export const isError = (v: unknown): v is CellError => typeof v === 'object' && v !== null && 'error' in v;
const err = (error: ErrorCode): CellError => ({ error });

// ----------------------------------------------------------------------------- addresses

export interface Address { sheet: string | undefined; col: number; row: number }
export const MAX_COLS = 200;
export const MAX_ROWS = 20_000;

export function columnName(col: number): string {
  let s = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function columnIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const cellName = (col: number, row: number) => `${columnName(col)}${row + 1}`;
export function parseCell(name: string): { col: number; row: number } | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,5})$/.exec(name);
  if (m === null) return undefined;
  const col = columnIndex(m[1]!);
  const row = Number(m[2]) - 1;
  return col < MAX_COLS && row < MAX_ROWS ? { col, row } : undefined;
}

// ----------------------------------------------------------------------------- tokens and syntax

type Token =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'bool'; v: boolean } | { t: 'ref'; v: string } | { t: 'name'; v: string }
  | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' } | { t: 'comma' } | { t: 'colon' } | { t: 'err'; v: ErrorCode };

function tokens(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\.?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (c === '"') {
      let s = ''; i++;
      for (;;) {
        if (i >= src.length) throw new SyntaxError('a text is not closed');
        if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      out.push({ t: 'str', v: s }); continue;
    }
    if (c === '#') {
      const m = /^#(DIV\/0!|VALUE!|REF!|NAME\?|N\/A|NUM!)/.exec(src.slice(i));
      if (m === null) throw new SyntaxError('unknown error literal');
      out.push({ t: 'err', v: m[0] as ErrorCode }); i += m[0].length; continue;
    }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (c === ',' || c === ';') { out.push({ t: 'comma' }); i++; continue; }
    if (c === ':') { out.push({ t: 'colon' }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    // A sheet-qualified reference: 'My sheet'!A1 or Sheet1!A1
    const quoted = /^'((?:[^']|'')+)'!(\$?[A-Za-z]{1,3}\$?[0-9]{1,6})/.exec(src.slice(i));
    if (quoted !== null) { out.push({ t: 'ref', v: `${quoted[1]!.replaceAll("''", "'")}!${quoted[2]}` }); i += quoted[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*(?:!\$?[A-Za-z]{1,3}\$?[0-9]{1,6})?|^\$[A-Za-z]{1,3}\$?[0-9]{1,6}/.exec(src.slice(i));
    if (word !== null) {
      const w = word[0];
      if (w.includes('!') || /^\$?[A-Za-z]{1,3}\$?[0-9]{1,6}$/.test(w)) out.push({ t: 'ref', v: w });
      else if (/^(TRUE|FALSE)$/i.test(w)) out.push({ t: 'bool', v: w.toUpperCase() === 'TRUE' });
      else out.push({ t: 'name', v: w.toUpperCase() });
      i += w.length; continue;
    }
    throw new SyntaxError(`unexpected ${c}`);
  }
  return out;
}

export type Node =
  | { k: 'lit'; v: Value } | { k: 'ref'; a: Address } | { k: 'range'; from: Address; to: Address }
  | { k: 'un'; op: string; x: Node } | { k: 'bin'; op: string; l: Node; r: Node } | { k: 'call'; name: string; args: Node[] } | { k: 'pct'; x: Node };

function address(text: string): Address {
  const bang = text.lastIndexOf('!');
  const sheet = bang < 0 ? undefined : text.slice(0, bang);
  const cell = parseCell(bang < 0 ? text : text.slice(bang + 1));
  if (cell === undefined) throw new SyntaxError(`no such cell ${text}`);
  return { sheet, ...cell };
}

/** A formula's syntax tree; a SyntaxError says why it does not parse. */
export function parse(formula: string): Node {
  const ts = tokens(formula.startsWith('=') ? formula.slice(1) : formula);
  let p = 0;
  const peek = () => ts[p];
  const op = (...ops: string[]) => { const t = ts[p]; if (t?.t === 'op' && ops.includes(t.v)) { p++; return t.v; } return undefined; };
  const levels: string[][] = [['=', '<>', '<', '<=', '>', '>='], ['&'], ['+', '-'], ['*', '/'], ['^']];
  const binary = (level: number): Node => {
    if (level === levels.length) return unary();
    let l = binary(level + 1);
    for (let o = op(...levels[level]!); o !== undefined; o = op(...levels[level]!)) l = { k: 'bin', op: o, l, r: binary(level + 1) };
    return l;
  };
  const unary = (): Node => {
    const o = op('-', '+');
    if (o !== undefined) return { k: 'un', op: o, x: unary() };
    let x = primary();
    while (op('%') !== undefined) x = { k: 'pct', x };
    return x;
  };
  const primary = (): Node => {
    const t = ts[p++];
    if (t === undefined) throw new SyntaxError('the formula ends early');
    switch (t.t) {
      case 'num': return { k: 'lit', v: t.v };
      case 'str': return { k: 'lit', v: t.v };
      case 'bool': return { k: 'lit', v: t.v };
      case 'err': return { k: 'lit', v: err(t.v) };
      case 'ref': {
        const from = address(t.v);
        if (peek()?.t === 'colon') {
          p++;
          const next = ts[p++];
          if (next?.t !== 'ref') throw new SyntaxError('a range needs two cells');
          const to = address(next.v);
          return { k: 'range', from, to: { ...to, sheet: to.sheet ?? from.sheet } };
        }
        return { k: 'ref', a: from };
      }
      case 'name': {
        if (peek()?.t !== 'lp') throw new SyntaxError(`${t.v} is not a cell or a function`);
        p++;
        const args: Node[] = [];
        if (peek()?.t !== 'rp') {
          for (;;) {
            args.push(binary(0));
            if (peek()?.t === 'comma') { p++; continue; }
            break;
          }
        }
        if (ts[p++]?.t !== 'rp') throw new SyntaxError(`${t.v}( is not closed`);
        return { k: 'call', name: t.v, args };
      }
      case 'lp': {
        const x = binary(0);
        if (ts[p++]?.t !== 'rp') throw new SyntaxError('a bracket is not closed');
        return x;
      }
      default: throw new SyntaxError('unexpected symbol');
    }
  };
  const tree = binary(0);
  if (p !== ts.length) throw new SyntaxError('unexpected symbol after the formula');
  return tree;
}

/** The cells a formula reads, ranges expanded (bounded), for the dependency graph. */
export function references(node: Node, sheet: string, out: string[] = []): string[] {
  switch (node.k) {
    case 'ref': out.push(key(node.a.sheet ?? sheet, node.a.col, node.a.row)); break;
    case 'range': {
      const s = node.from.sheet ?? sheet;
      for (let r = Math.min(node.from.row, node.to.row); r <= Math.max(node.from.row, node.to.row) && out.length < 100_000; r++) {
        for (let c = Math.min(node.from.col, node.to.col); c <= Math.max(node.from.col, node.to.col); c++) out.push(key(s, c, r));
      }
      break;
    }
    case 'un': case 'pct': references(node.x, sheet, out); break;
    case 'bin': references(node.l, sheet, out); references(node.r, sheet, out); break;
    case 'call': for (const a of node.args) references(a, sheet, out); break;
    default: break;
  }
  return out;
}

export const key = (sheet: string, col: number, row: number) => `${sheet}!${col},${row}`;

// ----------------------------------------------------------------------------- evaluation

/** What evaluation reads: a cell's value (evaluated on demand), and the evaluation date for TODAY(). */
export interface Context { get(sheet: string, col: number, row: number): Value; sheet: string; today: string; hasSheet(name: string): boolean }

type Arg = Value | Value[];
const num = (v: Value): number | CellError => {
  if (isError(v)) return v;
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isFinite(n) ? n : err('#VALUE!');
};
const text = (v: Value): string | CellError => (isError(v) ? v : v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const truth = (v: Value): boolean | CellError => {
  if (isError(v)) return v;
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  const u = v.toUpperCase();
  return u === 'TRUE' ? true : u === 'FALSE' ? false : err('#VALUE!');
};
const flat = (args: Arg[]): Value[] => args.flatMap((a) => (Array.isArray(a) ? a : [a]));
/** Numbers among the arguments: a range's text and blanks are skipped, a direct argument's text must be a number. */
function numbers(args: Arg[]): number[] | CellError {
  const out: number[] = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const v of a) { if (isError(v)) return v; if (typeof v === 'number') out.push(v); }
    } else {
      const n = num(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** A criterion as SUMIF and COUNTIF read it: ">10", "<>x", "=5", or a value matched exactly. */
function criterion(c: Value): (v: Value) => boolean {
  if (typeof c === 'string') {
    const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(c);
    if (m !== null) {
      const [, o, rest] = m as unknown as [string, string, string];
      const target = rest.trim() !== '' && Number.isFinite(Number(rest)) ? Number(rest) : rest;
      return (v) => {
        if (isError(v)) return false;
        const a: number | string = typeof target === 'number' ? (typeof v === 'number' ? v : NaN) : String(v ?? '').toLowerCase();
        const b: number | string = typeof target === 'number' ? target : target.toLowerCase();
        switch (o) {
          case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
          case '<>': return a !== b; default: return a === b;
        }
      };
    }
    return (v) => typeof v === 'string' && v.toLowerCase() === c.toLowerCase();
  }
  return (v) => v === c;
}

const round = (n: number, digits: number, mode: 'half' | 'up' | 'down') => {
  const f = 10 ** digits;
  const x = n * f;
  const r = mode === 'half' ? Math.sign(x) * Math.round(Math.abs(x)) : mode === 'up' ? Math.sign(x) * Math.ceil(Math.abs(x) - 1e-9) : Math.sign(x) * Math.floor(Math.abs(x) + 1e-9);
  return r / f;
};

type Fn = (args: Arg[], ctx: Context) => Value;
const n1 = (f: (n: number) => number | CellError): Fn => (a) => { if (a.length !== 1 || Array.isArray(a[0])) return err('#VALUE!'); const n = num(a[0]!); return isError(n) ? n : f(n); };
const t1 = (f: (s: string) => Value): Fn => (a) => { if (a.length !== 1 || Array.isArray(a[0])) return err('#VALUE!'); const s = text(a[0]!); return isError(s) ? s : f(s); };

export const FUNCTIONS: Readonly<Record<string, Fn>> = {
  SUM: (a) => { const ns = numbers(a); return isError(ns) ? ns : ns.reduce((x, y) => x + y, 0); },
  AVERAGE: (a) => { const ns = numbers(a); return isError(ns) ? ns : ns.length === 0 ? err('#DIV/0!') : ns.reduce((x, y) => x + y, 0) / ns.length; },
  MIN: (a) => { const ns = numbers(a); return isError(ns) ? ns : ns.length === 0 ? 0 : Math.min(...ns); },
  MAX: (a) => { const ns = numbers(a); return isError(ns) ? ns : ns.length === 0 ? 0 : Math.max(...ns); },
  COUNT: (a) => flat(a).filter((v) => typeof v === 'number').length,
  COUNTA: (a) => flat(a).filter((v) => v !== null && v !== '').length,
  COUNTBLANK: (a) => flat(a).filter((v) => v === null || v === '').length,
  IF: (a) => {
    if (a.length < 2 || a.length > 3) return err('#VALUE!');
    const c = truth(a[0] as Value);
    return isError(c) ? c : c ? (a[1] as Value) : a.length === 3 ? (a[2] as Value) : false;
  },
  IFERROR: (a) => (a.length !== 2 ? err('#VALUE!') : isError(a[0]) ? (a[1] as Value) : (a[0] as Value)),
  AND: (a) => { let r = true; for (const v of flat(a)) { if (v === null) continue; const b = truth(v); if (isError(b)) return b; r &&= b; } return r; },
  OR: (a) => { let r = false; for (const v of flat(a)) { if (v === null) continue; const b = truth(v); if (isError(b)) return b; r ||= b; } return r; },
  NOT: (a) => { if (a.length !== 1) return err('#VALUE!'); const b = truth(a[0] as Value); return isError(b) ? b : !b; },
  ROUND: (a) => { const n = num(a[0] as Value); const d = num((a[1] ?? 0) as Value); return isError(n) ? n : isError(d) ? d : round(n, Math.trunc(d), 'half'); },
  ROUNDUP: (a) => { const n = num(a[0] as Value); const d = num((a[1] ?? 0) as Value); return isError(n) ? n : isError(d) ? d : round(n, Math.trunc(d), 'up'); },
  ROUNDDOWN: (a) => { const n = num(a[0] as Value); const d = num((a[1] ?? 0) as Value); return isError(n) ? n : isError(d) ? d : round(n, Math.trunc(d), 'down'); },
  ABS: n1(Math.abs),
  INT: n1(Math.floor),
  SQRT: n1((n) => (n < 0 ? err('#NUM!') : Math.sqrt(n))),
  POWER: (a) => { const x = num(a[0] as Value); const y = num(a[1] as Value); if (isError(x)) return x; if (isError(y)) return y; const r = x ** y; return Number.isFinite(r) ? r : err('#NUM!'); },
  MOD: (a) => { const x = num(a[0] as Value); const y = num(a[1] as Value); if (isError(x)) return x; if (isError(y)) return y; return y === 0 ? err('#DIV/0!') : x - y * Math.floor(x / y); },
  LEN: t1((s) => s.length),
  UPPER: t1((s) => s.toUpperCase()),
  LOWER: t1((s) => s.toLowerCase()),
  TRIM: t1((s) => s.trim().replace(/\s+/g, ' ')),
  CONCAT: (a) => { let s = ''; for (const v of flat(a)) { const t = text(v); if (isError(t)) return t; s += t; } return s; },
  LEFT: (a) => { const s = text(a[0] as Value); const n = num((a[1] ?? 1) as Value); return isError(s) ? s : isError(n) ? n : s.slice(0, Math.max(0, n)); },
  RIGHT: (a) => { const s = text(a[0] as Value); const n = num((a[1] ?? 1) as Value); return isError(s) ? s : isError(n) ? n : n <= 0 ? '' : s.slice(-n); },
  MID: (a) => { const s = text(a[0] as Value); const st = num(a[1] as Value); const n = num(a[2] as Value); if (isError(s)) return s; if (isError(st)) return st; if (isError(n)) return n; return st < 1 ? err('#VALUE!') : s.slice(st - 1, st - 1 + n); },
  SUMIF: (a) => {
    const range = a[0]; const test = criterion(a[1] as Value); const sum = a[2] ?? a[0];
    if (!Array.isArray(range) || !Array.isArray(sum)) return err('#VALUE!');
    return range.reduce<number>((acc, v, i) => (test(v) && typeof sum[i] === 'number' ? acc + (sum[i] as number) : acc), 0);
  },
  COUNTIF: (a) => { const range = a[0]; if (!Array.isArray(range)) return err('#VALUE!'); const test = criterion(a[1] as Value); return range.filter(test).length; },
  AVERAGEIF: (a) => {
    const range = a[0]; const test = criterion(a[1] as Value); const avg = a[2] ?? a[0];
    if (!Array.isArray(range) || !Array.isArray(avg)) return err('#VALUE!');
    const ns = range.flatMap((v, i) => (test(v) && typeof avg[i] === 'number' ? [avg[i] as number] : []));
    return ns.length === 0 ? err('#DIV/0!') : ns.reduce((x, y) => x + y, 0) / ns.length;
  },
  TODAY: (_a, ctx) => ctx.today,
};

/** Ranges keep their shape for lookups: rows of cells. */
function grid(node: Extract<Node, { k: 'range' }>, ctx: Context): Value[][] | CellError {
  const sheet = node.from.sheet ?? ctx.sheet;
  if (!ctx.hasSheet(sheet)) return err('#REF!');
  const rows: Value[][] = [];
  for (let r = Math.min(node.from.row, node.to.row); r <= Math.max(node.from.row, node.to.row); r++) {
    const row: Value[] = [];
    for (let c = Math.min(node.from.col, node.to.col); c <= Math.max(node.from.col, node.to.col); c++) row.push(ctx.get(sheet, c, r));
    rows.push(row);
  }
  return rows;
}

const LOOKUPS: Readonly<Record<string, (args: Node[], ctx: Context) => Value>> = {
  VLOOKUP: (args, ctx) => {
    if (args.length < 3 || args[1]!.k !== 'range') return err('#VALUE!');
    const want = evaluate(args[0]!, ctx); const table = grid(args[1] as Extract<Node, { k: 'range' }>, ctx);
    const col = num(evaluate(args[2]!, ctx)); const approximate = args[3] === undefined ? false : truth(evaluate(args[3], ctx));
    if (isError(want)) return want; if (isError(table)) return table; if (isError(col)) return col; if (isError(approximate)) return approximate;
    if (col < 1 || col > (table[0]?.length ?? 0)) return err('#REF!');
    const same = (v: Value) => (typeof v === 'string' && typeof want === 'string' ? v.toLowerCase() === want.toLowerCase() : v === want);
    const hit = table.find((row) => same(row[0]!));
    return hit === undefined ? err('#N/A') : hit[col - 1]!;
  },
  INDEX: (args, ctx) => {
    if (args.length < 2 || args[0]!.k !== 'range') return err('#VALUE!');
    const table = grid(args[0] as Extract<Node, { k: 'range' }>, ctx); const r = num(evaluate(args[1]!, ctx)); const c = num(args[2] === undefined ? 1 : evaluate(args[2], ctx));
    if (isError(table)) return table; if (isError(r)) return r; if (isError(c)) return c;
    const row = table.length === 1 && args[2] === undefined ? table[0] : table[r - 1];
    const value = table.length === 1 && args[2] === undefined ? row?.[r - 1] : row?.[c - 1];
    return value === undefined ? err('#REF!') : value;
  },
  MATCH: (args, ctx) => {
    if (args.length < 2 || args[1]!.k !== 'range') return err('#VALUE!');
    const want = evaluate(args[0]!, ctx); const table = grid(args[1] as Extract<Node, { k: 'range' }>, ctx);
    if (isError(want)) return want; if (isError(table)) return table;
    const cells = table.length === 1 ? table[0]! : table.map((row) => row[0]!);
    const i = cells.findIndex((v) => (typeof v === 'string' && typeof want === 'string' ? v.toLowerCase() === want.toLowerCase() : v === want));
    return i < 0 ? err('#N/A') : i + 1;
  },
};

function compare(op: string, a: Value, b: Value): Value {
  if (isError(a)) return a;
  if (isError(b)) return b;
  const rank = (v: Value) => (v === null ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);
  let c: number;
  if (rank(a) === rank(b) || a === null || b === null) {
    const x = a === null ? (typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0) : a;
    const y = b === null ? (typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0) : b;
    const [p, q] = typeof x === 'string' && typeof y === 'string' ? [x.toLowerCase(), y.toLowerCase()] : [x, y];
    c = p! < q! ? -1 : p! > q! ? 1 : 0;
  } else c = rank(a) - rank(b);
  switch (op) {
    case '=': return c === 0; case '<>': return c !== 0; case '<': return c < 0; case '<=': return c <= 0; case '>': return c > 0; default: return c >= 0;
  }
}

export function evaluate(node: Node, ctx: Context): Value {
  switch (node.k) {
    case 'lit': return node.v;
    case 'ref': {
      const sheet = node.a.sheet ?? ctx.sheet;
      return ctx.hasSheet(sheet) ? ctx.get(sheet, node.a.col, node.a.row) : err('#REF!');
    }
    case 'range': return err('#VALUE!');
    case 'pct': { const n = num(evaluate(node.x, ctx)); return isError(n) ? n : n / 100; }
    case 'un': { const n = num(evaluate(node.x, ctx)); return isError(n) ? n : node.op === '-' ? -n : n; }
    case 'bin': {
      const a = evaluate(node.l, ctx);
      const b = evaluate(node.r, ctx);
      if (node.op === '&') { const x = text(a); const y = text(b); return isError(x) ? x : isError(y) ? y : x + y; }
      if (['=', '<>', '<', '<=', '>', '>='].includes(node.op)) return compare(node.op, a, b);
      const x = num(a); const y = num(b);
      if (isError(x)) return x;
      if (isError(y)) return y;
      const r = node.op === '+' ? x + y : node.op === '-' ? x - y : node.op === '*' ? x * y : node.op === '/' ? (y === 0 ? NaN : x / y) : x ** y;
      return node.op === '/' && y === 0 ? err('#DIV/0!') : Number.isFinite(r) ? r : err('#NUM!');
    }
    case 'call': {
      const lookup = LOOKUPS[node.name];
      if (lookup !== undefined) return lookup(node.args, ctx);
      const f = FUNCTIONS[node.name];
      if (f === undefined) return err('#NAME?');
      // IF and IFERROR evaluate every argument; a function reads none outside the workbook.
      const args: Arg[] = node.args.map((a) => {
        if (a.k !== 'range') return evaluate(a, ctx);
        const g = grid(a, ctx);
        return isError(g) ? g : g.flat();
      });
      return f(args, ctx);
    }
  }
}

// ----------------------------------------------------------------------------- a workbook recalculated

/** A cell as written: a value, or a formula beginning with "=". */
export type Input = string | number | boolean | null;
export interface Sheet { name: string; cells: Readonly<Record<string, Input>> }

/** A value typed into a cell: a number where it reads as one, TRUE/FALSE, otherwise its text. */
export function literal(input: Input): Value {
  if (typeof input !== 'string') return input;
  const t = input.trim();
  if (t === '') return null;
  if (/^(TRUE|FALSE)$/i.test(t)) return t.toUpperCase() === 'TRUE';
  const n = Number(t);
  return Number.isFinite(n) && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) ? n : input;
}

/**
 * Every cell's value, formulas evaluated on demand with memoisation; a cell met again while it is
 * being evaluated is a cycle (#CYCLE!), never a loop. `overlay` holds values placed by live ranges.
 */
export function recalculate(sheets: readonly Sheet[], today: string, overlay: ReadonlyMap<string, Value> = new Map()): Map<string, Value> {
  const bySheet = new Map(sheets.map((s) => [s.name, s]));
  const done = new Map<string, Value>();
  const active = new Set<string>();
  const parsed = new Map<string, Node | CellError>();
  const get = (sheet: string, col: number, row: number): Value => {
    const k = key(sheet, col, row);
    if (done.has(k)) return done.get(k)!;
    if (overlay.has(k)) return overlay.get(k)!;
    const input = bySheet.get(sheet)?.cells[cellName(col, row)];
    if (typeof input !== 'string' || !input.startsWith('=') || input.length === 1) { const v = literal(input ?? null); done.set(k, v); return v; }
    if (active.has(k)) return err('#CYCLE!');
    active.add(k);
    let tree = parsed.get(k);
    if (tree === undefined) {
      try { tree = parse(input); } catch { tree = err('#PARSE!'); }
      parsed.set(k, tree);
    }
    const v = isError(tree) && !('k' in tree) ? tree : evaluate(tree as Node, { get, sheet, today, hasSheet: (n) => bySheet.has(n) });
    active.delete(k);
    done.set(k, v);
    return v;
  };
  for (const s of sheets) {
    for (const name of Object.keys(s.cells)) {
      const at = parseCell(name);
      if (at !== undefined) get(s.name, at.col, at.row);
    }
  }
  return done;
}

/** A value as a cell shows it. */
export function display(v: Value): string {
  if (v === null) return '';
  if (isError(v)) return v.error;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  return v;
}
