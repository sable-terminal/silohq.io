import type { DefinitionObject } from '../../schemas/siloDefinition.schema';
import type { DocumentPage, DocumentTextItem, TextSpan, ValueLocation } from '../../models/document.model';
import type { ExtractedRow } from '../../models/rowStore.model';
import { coerce, type Rejection, type TabularOutcome } from './tabular.extraction';

/**
 * §3 — structured documents: labelled fields and tables, located on the page.
 *
 * ── Near certain, and says so for every value ──────────────────────────────
 *
 * A value read from beside its label, or from under a column heading, is the
 * right value when the layout is what the definition expected, and a
 * plausible wrong one when it is not. So every value read here carries `near`,
 * and where it was read — the page and the box around the text — so a person
 * can look at the place and judge it. §5: "Seeing the sentence a figure came
 * from is what makes it judgeable."
 *
 * ── Still refused, not coerced ─────────────────────────────────────────────
 *
 * Exactly as for a spreadsheet. "£1,250.00" beside "Total due" is not a number,
 * and a document whose required label is absent does not produce a record with
 * that field empty.
 *
 * ── Pure ───────────────────────────────────────────────────────────────────
 *
 * Handed positioned text, returns rows. Reading the PDF is `pdfText.util`.
 */

export interface Located {
  rowRef: string;
  field: string;
  /** On a page, for a PDF. */
  location?: ValueLocation;
  /** In the text, for a document with no pages. */
  span?: TextSpan;
  /** `near` unless said otherwise. */
  method?: 'near' | 'inferred';
  /** The model's score, for `inferred` only. */
  confidence?: number;
}

export interface DocumentOutcome extends TabularOutcome {
  /** Where each stored value was read. One entry per flagged value. */
  located: Located[];
}

interface Line {
  page: number;
  /** 1-based, counted from the top of the page. */
  number: number;
  items: DocumentTextItem[];
}

const normalise = (text: string) =>
  text
    .trim()
    .replace(/[:：]\s*$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/**
 * A page's text as lines, top to bottom, each left to right.
 *
 * TEXT WITHIN A THIRD OF ITS OWN HEIGHT OF THE LINE ABOVE SHARES THAT LINE. Two
 * runs of one line rarely sit at exactly the same `y` once a PDF has been
 * through a layout engine, and a tolerance larger than that merges a line with
 * the one beneath it.
 */
export function linesOf(page: DocumentPage): Line[] {
  const sorted = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x);
  const grouped: Array<{ y: number; items: DocumentTextItem[] }> = [];

  for (const item of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && Math.abs(last.y - item.y) <= Math.max(1, item.height / 3)) last.items.push(item);
    else grouped.push({ y: item.y, items: [item] });
  }

  return grouped.map((line, index) => ({
    page: page.page,
    number: index + 1,
    items: line.items.sort((a, b) => a.x - b.x),
  }));
}

/** The run of items on a line whose text, joined, is `wanted`. */
function findRun(items: DocumentTextItem[], wanted: string): DocumentTextItem[] | null {
  for (let start = 0; start < items.length; start++) {
    let joined = '';
    for (let end = start; end < items.length; end++) {
      joined = normalise(`${joined} ${items[end]!.text}`);
      if (joined === wanted) return items.slice(start, end + 1);
      if (!wanted.startsWith(joined)) break;
    }
  }
  return null;
}

export function boxOf(page: number, items: DocumentTextItem[]): ValueLocation {
  const left = Math.min(...items.map((i) => i.x));
  const bottom = Math.min(...items.map((i) => i.y));
  const right = Math.max(...items.map((i) => i.x + i.width));
  const top = Math.max(...items.map((i) => i.y + i.height));
  return { page, x: left, y: bottom, width: right - left, height: top - bottom };
}

const overlaps = (item: DocumentTextItem, left: number, right: number) =>
  item.x < right && item.x + item.width > left;

/* ── Labelled fields ─────────────────────────────────────────────────────── */

function readLabel(
  lines: Line[],
  spec: { label: string; direction: 'right' | 'below'; page?: number },
  otherLabels: Set<string>,
): { text: string; location: ValueLocation } | null {
  const wanted = normalise(spec.label);

  for (const [index, line] of lines.entries()) {
    if (spec.page !== undefined && line.page !== spec.page) continue;

    const label = findRun(line.items, wanted);
    if (!label) continue;

    const left = Math.min(...label.map((i) => i.x));
    const right = Math.max(...label.map((i) => i.x + i.width));
    let value: DocumentTextItem[] = [];

    if (spec.direction === 'right') {
      /* Everything after the label on its line, up to the next declared label. */
      for (const item of line.items.slice(line.items.indexOf(label[label.length - 1]!) + 1)) {
        if (otherLabels.has(normalise(item.text))) break;
        value.push(item);
      }
    } else {
      const below = lines
        .slice(index + 1)
        .find((next) => next.page === line.page && next.items.some((item) => overlaps(item, left, right)));
      value = below ? below.items.filter((item) => overlaps(item, left, right)) : [];
    }

    return value.length === 0
      ? { text: '', location: boxOf(line.page, label) }
      : { text: value.map((item) => item.text).join(' ').trim(), location: boxOf(line.page, value) };
  }

  return null;
}

/**
 * One record per document, read label by label.
 *
 * THE ROW REFERENCE IS `document`, because there is one: a notification, a
 * form, a statement header. A definition that wants one record per page names a
 * page on each field.
 */
export function extractLabelled(input: { object: DefinitionObject; pages: DocumentPage[] }): DocumentOutcome {
  const lines = input.pages.flatMap(linesOf);
  const rowRef = 'document';
  const identifiers = new Set(input.object.identifier);
  const labels = input.object.fields
    .map((f) => (f.extraction.method === 'labelled' ? normalise(f.extraction.label) : null))
    .filter((label): label is string => label !== null);

  const values: Record<string, unknown> = {};
  const methods: ExtractedRow['methods'] = {};
  const located: Located[] = [];

  const refuse = (rejection: Rejection): DocumentOutcome => ({
    rows: [],
    rejected: [rejection],
    missingColumns: [],
    rowsRead: 1,
    located: [],
  });

  for (const f of input.object.fields) {
    if (f.extraction.method !== 'labelled') continue;

    const wanted = normalise(f.extraction.label);
    const found = readLabel(lines, f.extraction, new Set(labels.filter((label) => label !== wanted)));
    const outcome = found ? coerce(found.text, f) : ({ ok: true, value: null } as const);

    if (!outcome.ok) return refuse({ rowRef, field: f.name, reason: outcome.reason });

    if (outcome.value === null && (!f.nullable || identifiers.has(f.name))) {
      return refuse({
        rowRef,
        field: f.name,
        reason: found
          ? identifiers.has(f.name) ? 'An identifier is empty.' : 'A required value is empty.'
          : `The label "${f.extraction.label}" is not on the document.`,
      });
    }

    values[f.name] = outcome.value;
    if (found && outcome.value !== null) {
      methods[f.name] = 'near';
      located.push({ rowRef, field: f.name, location: found.location });
    }
  }

  return { rows: [{ rowRef, values, methods }], rejected: [], missingColumns: [], rowsRead: 1, located };
}

/* ── Tables ──────────────────────────────────────────────────────────────── */

/**
 * Rows of a table in a PDF, read by column heading.
 *
 * ── The header is the line that has every heading ───────────────────────────
 *
 * On each page, the first line on which every column the definition names
 * appears. A page without one contributes nothing; a document without one is
 * the same failure as a spreadsheet missing a column.
 *
 * ── Columns split halfway between headings ─────────────────────────────────
 *
 * Numbers sit right-aligned under a left-aligned heading, so a cell rarely
 * starts where its heading does. Each cell belongs to the column whose band its
 * centre falls in, and the bands meet halfway between neighbouring headings.
 *
 * ── The table ends where the columns stop being filled ─────────────────────
 *
 * A line with fewer than half the columns filled — a total, a footer, a note —
 * ends the table on that page, rather than becoming a record with most of its
 * fields empty.
 */
export function extractDocumentTable(input: { object: DefinitionObject; pages: DocumentPage[] }): DocumentOutcome {
  const { object } = input;
  const identifiers = new Set(object.identifier);
  const headings = [
    ...new Set(
      object.fields.map((f) => (f.extraction.method === 'column' ? normalise(f.extraction.column) : null)),
    ),
  ].filter((heading): heading is string => heading !== null);

  const rows: ExtractedRow[] = [];
  const rejected: Rejection[] = [];
  const located: Located[] = [];
  let rowsRead = 0;
  let headerSeen = false;

  for (const page of input.pages) {
    const lines = linesOf(page);
    const headerAt = lines.findIndex((line) => headings.every((heading) => findRun(line.items, heading)));
    if (headerAt === -1) continue;
    headerSeen = true;

    const spans = headings
      .map((heading) => {
        const run = findRun(lines[headerAt]!.items, heading)!;
        return {
          heading,
          left: Math.min(...run.map((i) => i.x)),
          right: Math.max(...run.map((i) => i.x + i.width)),
        };
      })
      .sort((a, b) => a.left - b.left);

    const bands = spans.map((span, at) => ({
      heading: span.heading,
      from: at === 0 ? -Infinity : (spans[at - 1]!.right + span.left) / 2,
      to: at === spans.length - 1 ? Infinity : (span.right + spans[at + 1]!.left) / 2,
    }));

    for (const line of lines.slice(headerAt + 1)) {
      const cells = new Map<string, DocumentTextItem[]>();
      for (const item of line.items) {
        const centre = item.x + item.width / 2;
        const band = bands.find((one) => centre >= one.from && centre < one.to);
        if (band) cells.set(band.heading, [...(cells.get(band.heading) ?? []), item]);
      }

      if (cells.size * 2 < bands.length) break;
      rowsRead += 1;

      const rowRef = `page ${page.page} line ${line.number}`;
      const values: Record<string, unknown> = {};
      const methods: ExtractedRow['methods'] = {};
      const here: Located[] = [];
      let refused: Rejection | null = null;

      for (const f of object.fields) {
        if (f.extraction.method !== 'column') continue;
        const cell = cells.get(normalise(f.extraction.column)) ?? [];
        const outcome = coerce(cell.map((item) => item.text).join(' ').trim(), f);

        if (!outcome.ok) {
          refused = { rowRef, field: f.name, reason: outcome.reason };
          break;
        }
        if (outcome.value === null && (!f.nullable || identifiers.has(f.name))) {
          refused = {
            rowRef,
            field: f.name,
            reason: identifiers.has(f.name) ? 'An identifier is empty.' : 'A required value is empty.',
          };
          break;
        }

        values[f.name] = outcome.value;
        if (outcome.value !== null) {
          methods[f.name] = 'near';
          here.push({ rowRef, field: f.name, location: boxOf(page.page, cell) });
        }
      }

      if (refused) {
        rejected.push(refused);
      } else {
        rows.push({ rowRef, values, methods });
        located.push(...here);
      }
    }
  }

  if (!headerSeen) {
    return {
      rows: [],
      rejected: [],
      missingColumns: object.fields
        .map((f) => (f.extraction.method === 'column' ? f.extraction.column : null))
        .filter((column): column is string => column !== null),
      rowsRead: 0,
      located: [],
    };
  }

  return { rows, rejected, missingColumns: [], rowsRead, located };
}

/**
 * A first definition from a document: each line that reads as a label and a
 * value becomes a labelled field.
 *
 * STRINGS, AND NULLABLE, EVERY ONE. A document's layout says nothing reliable
 * about types, and a guessed number that rejects the next document is worse
 * than a string somebody changes on purpose. The builder is where it becomes a
 * definition; this only saves typing the labels.
 */
export function labelsOf(pages: DocumentPage[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const line of pages.slice(0, 1).flatMap(linesOf)) {
    if (line.items.length < 2) continue;
    const label = line.items[0]!.text.trim().replace(/[:：]\s*$/, '').trim();
    if (label === '' || label.length > 80 || /^[\d.,£$€%\s-]+$/.test(label) || seen.has(normalise(label))) continue;
    seen.add(normalise(label));
    labels.push(label);
    if (labels.length === 50) break;
  }

  return labels;
}
