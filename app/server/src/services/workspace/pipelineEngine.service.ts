// Pipeline steps (D235): a table transformed step by step, the same for a preview and a run. A
// table is named columns and rows of values. The steps are a closed set: filter rows by a CEL
// condition; compute a column from a CEL expression; select columns (renaming, reordering, dropping);
// join another input on equal keys (inner or left); aggregate by columns (count, count distinct, sum,
// average, minimum, maximum); dedupe on columns; sort; limit. CEL is compiled by the caller (the
// expression evaluator, server-side), so this module stays pure: no I/O, nothing but the steps.

export type Cell = string | number | boolean | null;
export interface Table { columns: string[]; rows: Cell[][] }

export type Step =
  | { op: 'filter'; cel: string }
  | { op: 'compute'; as: string; cel: string }
  | { op: 'select'; columns: { from: string; as?: string | undefined }[] }
  | { op: 'join'; input: string; on: [string, string][]; kind: 'inner' | 'left' }
  | { op: 'aggregate'; by: string[]; measures: { as: string; fn: 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max'; column?: string | undefined }[] }
  | { op: 'dedupe'; by: string[] }
  | { op: 'sort'; by: { column: string; direction: 'asc' | 'desc' }[] }
  | { op: 'limit'; rows: number };

/** A CEL expression compiled over the table's columns: a row's columns by name in, a value out. */
export type Compile = (expression: string, columns: readonly string[]) => (row: Readonly<Record<string, Cell>>) => unknown;

export class StepError extends Error {
  readonly step: number;
  constructor(step: number, message: string) { super(message); this.step = step; this.name = 'StepError'; }
}

const MAX_ROWS = 200_000;
const record = (columns: readonly string[], row: readonly Cell[]): Record<string, Cell> => Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null]));
const cell = (v: unknown): Cell => (v === null || v === undefined ? null : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v
  : typeof v === 'bigint' ? Number(v) : JSON.stringify(v));
const keyOf = (values: readonly Cell[]) => JSON.stringify(values);
const compare = (a: Cell, b: Cell): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

function index(t: Table, column: string, step: number): number {
  const i = t.columns.indexOf(column);
  if (i < 0) throw new StepError(step, `there is no column ${column} at this step`);
  return i;
}

/** The steps run over the first input, others joined by name; each step's error names the step. */
export function runSteps(inputs: ReadonlyMap<string, Table>, first: string, steps: readonly Step[], compile: Compile): Table {
  let t: Table = { columns: [...inputs.get(first)!.columns], rows: inputs.get(first)!.rows.map((r) => [...r]) };
  steps.forEach((s, n) => {
    const step = n + 1;
    switch (s.op) {
      case 'filter': {
        let test: ReturnType<Compile>;
        try { test = compile(s.cel, t.columns); } catch (e) { throw new StepError(step, `the condition does not compile: ${(e as Error).message}`); }
        t = { columns: t.columns, rows: t.rows.filter((r) => { try { return test(record(t.columns, r)) === true; } catch { return false; } }) };
        break;
      }
      case 'compute': {
        if (t.columns.includes(s.as)) throw new StepError(step, `there is already a column ${s.as}`);
        let f: ReturnType<Compile>;
        try { f = compile(s.cel, t.columns); } catch (e) { throw new StepError(step, `the expression does not compile: ${(e as Error).message}`); }
        t = { columns: [...t.columns, s.as], rows: t.rows.map((r) => { let v: Cell = null; try { v = cell(f(record(t.columns, r))); } catch { v = null; } return [...r, v]; }) };
        break;
      }
      case 'select': {
        const at = s.columns.map((c) => index(t, c.from, step));
        const names = s.columns.map((c) => c.as ?? c.from);
        if (new Set(names).size !== names.length) throw new StepError(step, 'two selected columns would have the same name');
        t = { columns: names, rows: t.rows.map((r) => at.map((i) => r[i] ?? null)) };
        break;
      }
      case 'join': {
        const other = inputs.get(s.input);
        if (other === undefined) throw new StepError(step, `there is no input ${s.input}`);
        const left = s.on.map(([l]) => index(t, l, step));
        const right = s.on.map(([, r]) => { const i = other.columns.indexOf(r); if (i < 0) throw new StepError(step, `${s.input} has no column ${r}`); return i; });
        const kept = other.columns.map((c, i) => ({ c: `${s.input}_${c}`, i })).filter((x) => !right.includes(x.i));
        const byKey = new Map<string, Cell[][]>();
        for (const r of other.rows) {
          const k = keyOf(right.map((i) => r[i] ?? null));
          byKey.set(k, [...(byKey.get(k) ?? []), r]);
        }
        const rows: Cell[][] = [];
        for (const r of t.rows) {
          const matches = byKey.get(keyOf(left.map((i) => r[i] ?? null))) ?? [];
          if (matches.length === 0 && s.kind === 'left') rows.push([...r, ...kept.map(() => null)]);
          for (const m of matches) rows.push([...r, ...kept.map((x) => m[x.i] ?? null)]);
          if (rows.length > MAX_ROWS) throw new StepError(step, `the join makes more than ${MAX_ROWS} rows`);
        }
        t = { columns: [...t.columns, ...kept.map((x) => x.c)], rows };
        break;
      }
      case 'aggregate': {
        const by = s.by.map((c) => index(t, c, step));
        const measured = s.measures.map((m) => (m.fn === 'count' && m.column === undefined ? -1 : index(t, m.column ?? '', step)));
        const groups = new Map<string, { key: Cell[]; rows: Cell[][] }>();
        for (const r of t.rows) {
          const key = by.map((i) => r[i] ?? null);
          const k = keyOf(key);
          const g = groups.get(k) ?? { key, rows: [] };
          g.rows.push(r);
          groups.set(k, g);
        }
        const value = (fn: string, values: Cell[]): Cell => {
          const nums = values.filter((v): v is number => typeof v === 'number');
          switch (fn) {
            case 'count': return values.filter((v) => v !== null).length;
            case 'count_distinct': return new Set(values.filter((v) => v !== null).map((v) => keyOf([v]))).size;
            case 'sum': return nums.reduce((a, b) => a + b, 0);
            case 'avg': return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
            case 'min': return values.filter((v) => v !== null).sort(compare)[0] ?? null;
            default: return values.filter((v) => v !== null).sort(compare).at(-1) ?? null;
          }
        };
        t = {
          columns: [...s.by, ...s.measures.map((m) => m.as)],
          rows: [...groups.values()].map((g) => [...g.key, ...s.measures.map((m, j) => (measured[j] === -1 ? g.rows.length : value(m.fn, g.rows.map((r) => r[measured[j]!] ?? null))))]),
        };
        break;
      }
      case 'dedupe': {
        const by = s.by.length === 0 ? t.columns.map((_, i) => i) : s.by.map((c) => index(t, c, step));
        const seen = new Set<string>();
        t = { columns: t.columns, rows: t.rows.filter((r) => { const k = keyOf(by.map((i) => r[i] ?? null)); if (seen.has(k)) return false; seen.add(k); return true; }) };
        break;
      }
      case 'sort': {
        const by = s.by.map((b) => ({ i: index(t, b.column, step), sign: b.direction === 'desc' ? -1 : 1 }));
        t = { columns: t.columns, rows: [...t.rows].sort((a, b) => { for (const { i, sign } of by) { const c = compare(a[i] ?? null, b[i] ?? null); if (c !== 0) return c * sign; } return 0; }) };
        break;
      }
      case 'limit':
        t = { columns: t.columns, rows: t.rows.slice(0, s.rows) };
        break;
    }
  });
  return t;
}

/** A table as CSV (RFC 4180), a cell that would start a formula in a spreadsheet given a leading quote mark. */
export function toCsv(t: Table): string {
  const quote = (v: Cell): string => {
    if (v === null) return '';
    let s = typeof v === 'string' ? v : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [t.columns.map(quote).join(','), ...t.rows.map((r) => r.map(quote).join(','))].join('\r\n') + '\r\n';
}
