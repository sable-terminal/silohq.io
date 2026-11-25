// App branches merged and compared (D229): a three-way merge of app definitions by their
// structure, not their text. Variables by name, pages and their widgets by id, event bindings by
// their source, the Functions and Action types an app names as sets; a page's title and the
// mobile settings as values. A change on one side only is taken; the same change on both is
// taken once; different changes to one element are a conflict, named by its path and decided
// by a person (main's or the branch's), never guessed. Pure: no I/O.

type Json = unknown;
type Side = 'main' | 'branch';

export interface Conflict { path: string; base: Json; main: Json; branch: Json }
export interface Change { path: string; change: 'added' | 'removed' | 'changed' }

const canonical = (v: Json): string => JSON.stringify(v, (_k, x: unknown) =>
  (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const same = (a: Json, b: Json) => (a === undefined || b === undefined ? a === b : canonical(a) === canonical(b));
const record = (v: Json): Record<string, Json> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, Json> : {});
const list = (v: Json): Json[] => (Array.isArray(v) ? v : []);

interface Merger { conflicts: Conflict[]; decisions: ReadonlyMap<string, Side> }

/** One element at a path: taken from the side that changed it, or a conflict (decided when a decision names the path). */
function leaf(m: Merger, path: string, base: Json, main: Json, branch: Json): Json {
  if (same(main, branch)) return main;
  if (same(base, main)) return branch;
  if (same(base, branch)) return main;
  const decided = m.decisions.get(path);
  if (decided !== undefined) return decided === 'main' ? main : branch;
  m.conflicts.push({ path, base, main, branch });
  return main;
}

/** Keys in a merged order: main's, unless main kept base's order and the branch changed it; additions after. */
function order(base: string[], main: string[], branch: string[], kept: ReadonlySet<string>): string[] {
  const common = (a: string[], b: string[]) => a.filter((k) => b.includes(k));
  const chosen = same(common(main, base), common(base, main)) && !same(common(branch, base), common(base, branch)) ? branch : main;
  const out = chosen.filter((k) => kept.has(k));
  for (const k of [...branch, ...main]) if (kept.has(k) && !out.includes(k)) out.push(k);
  return out;
}

/** Elements keyed by id: each merged as a leaf, or by `inner` where all three sides hold it. */
function keyed(m: Merger, path: string, base: Map<string, Json>, main: Map<string, Json>, branch: Map<string, Json>,
  inner?: (path: string, b: Json, x: Json, y: Json) => Json): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const k of new Set([...base.keys(), ...main.keys(), ...branch.keys()])) {
    const [b, x, y] = [base.get(k), main.get(k), branch.get(k)];
    const at = `${path}.${k}`;
    const merged = inner !== undefined && b !== undefined && x !== undefined && y !== undefined && !same(x, y) ? inner(at, b, x, y) : leaf(m, at, b, x, y);
    if (merged !== undefined) out.set(k, merged);
  }
  return out;
}

const byId = (items: Json[]) => new Map(items.map((i) => [String(record(i)['id']), i] as const));
const ids = (items: Json[]) => items.map((i) => String(record(i)['id']));

/** Event bindings by their source: the nth binding of a widget's event. */
function eventKeys(events: Json[]): Map<string, Json> {
  const seen = new Map<string, number>();
  return new Map(events.map((e) => {
    const s = record(record(e)['source']);
    const base = `${String(s['widget'])}:${String(s['event'])}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return [`${base}#${n}`, e] as const;
  }));
}

/** A set of ids: kept by both, or added by either; removed by either and untouched by the other is gone. */
function set(base: Json, main: Json, branch: Json): string[] {
  const [b, x, y] = [new Set(list(base).map(String)), new Set(list(main).map(String)), new Set(list(branch).map(String))];
  return [...new Set([...x, ...y])].filter((k) => (x.has(k) && y.has(k)) || (x.has(k) && !b.has(k)) || (y.has(k) && !b.has(k)));
}

/**
 * The branch's definition merged into main's, both from their common base. Conflicts not decided
 * are returned with main's side in their place; a merge is complete only when there are none.
 */
export function mergeDefinitions(base: Record<string, Json>, main: Record<string, Json>, branch: Record<string, Json>,
  decisions: ReadonlyMap<string, Side> = new Map()): { merged: Record<string, Json>; conflicts: Conflict[] } {
  const m: Merger = { conflicts: [], decisions };
  const merged: Record<string, Json> = { ...main };

  const variables = keyed(m, 'variables', new Map(Object.entries(record(base['variables']))), new Map(Object.entries(record(main['variables']))),
    new Map(Object.entries(record(branch['variables']))));
  merged['variables'] = Object.fromEntries(variables);

  const [bp, mp, rp] = [list(base['pages']), list(main['pages']), list(branch['pages'])];
  const pages = keyed(m, 'pages', byId(bp), byId(mp), byId(rp), (path, b, x, y) => {
    const [pb, px, py] = [record(b), record(x), record(y)];
    const [wb, wx, wy] = [list(pb['widgets']), list(px['widgets']), list(py['widgets'])];
    const widgets = keyed(m, `${path}.widgets`, byId(wb), byId(wx), byId(wy));
    return {
      ...px, title: leaf(m, `${path}.title`, pb['title'], px['title'], py['title']),
      widgets: order(ids(wb), ids(wx), ids(wy), new Set(widgets.keys())).map((k) => widgets.get(k)),
    };
  });
  merged['pages'] = order(ids(bp), ids(mp), ids(rp), new Set(pages.keys())).map((k) => pages.get(k));

  const [eb, ex, ey] = [eventKeys(list(base['events'])), eventKeys(list(main['events'])), eventKeys(list(branch['events']))];
  const events = keyed(m, 'events', eb, ex, ey);
  merged['events'] = order([...eb.keys()], [...ex.keys()], [...ey.keys()], new Set(events.keys())).map((k) => events.get(k));

  merged['functions'] = set(base['functions'], main['functions'], branch['functions']);
  merged['actions'] = set(base['actions'], main['actions'], branch['actions']);
  const mobile = leaf(m, 'mobile', base['mobile'], main['mobile'], branch['mobile']);
  if (mobile === undefined) delete merged['mobile']; else merged['mobile'] = mobile;
  return { merged, conflicts: m.conflicts };
}

/** What changed from one definition to another, element by element, by the same paths a merge names. */
export function compareDefinitions(from: Record<string, Json>, to: Record<string, Json>): Change[] {
  const out: Change[] = [];
  const walk = (path: string, a: Map<string, Json>, b: Map<string, Json>, inner?: (path: string, x: Json, y: Json) => void) => {
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      const [x, y] = [a.get(k), b.get(k)];
      const at = `${path}.${k}`;
      if (x === undefined) out.push({ path: at, change: 'added' });
      else if (y === undefined) out.push({ path: at, change: 'removed' });
      else if (!same(x, y)) { if (inner === undefined) out.push({ path: at, change: 'changed' }); else inner(at, x, y); }
    }
  };
  walk('variables', new Map(Object.entries(record(from['variables']))), new Map(Object.entries(record(to['variables']))));
  walk('pages', byId(list(from['pages'])), byId(list(to['pages'])), (path, x, y) => {
    if (!same(record(x)['title'], record(y)['title'])) out.push({ path: `${path}.title`, change: 'changed' });
    walk(`${path}.widgets`, byId(list(record(x)['widgets'])), byId(list(record(y)['widgets'])));
  });
  walk('events', eventKeys(list(from['events'])), eventKeys(list(to['events'])));
  for (const kind of ['functions', 'actions'] as const) {
    walk(kind, new Map(list(from[kind]).map((v) => [String(v), v] as const)), new Map(list(to[kind]).map((v) => [String(v), v] as const)));
  }
  if (!same(from['mobile'], to['mobile'])) out.push({ path: 'mobile', change: from['mobile'] === undefined ? 'added' : to['mobile'] === undefined ? 'removed' : 'changed' });
  return out;
}
