// PDF exports (spec 41.2): a printable table written here without a library. A4 landscape,
// the standard Helvetica faces (nothing embedded, so nothing is fetched or parsed), the
// document's head on the first page, the table's header repeated on every page, and the
// markings and the page number printed on every page (invariant 7). Text is set in the
// WinAnsi encoding; a character outside it prints as "?", and a cell too wide for its column
// is cut with "..." (the spreadsheet and CSV carry it whole).

import { deflateSync } from 'node:zlib';
import { text, type ExportDocument } from './document.service.ts';
import type { PdfImage } from './pdfImage.service.ts';

const PAGE = { width: 842, height: 595, margin: 36 } as const;
const SIZE = 8;
const LEADING = 11;
/** Helvetica's average advance, as a share of the size: enough to fit a column without metrics. */
const ADVANCE = 0.52;

/** WinAnsi text for a PDF string: Latin-1 as itself, the rest as "?", and the delimiters escaped. */
function pdfText(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const c = code < 0x20 ? ' ' : code > 0xff || (code >= 0x80 && code < 0xa0) ? '?' : ch;
    out += c === '\\' || c === '(' || c === ')' ? `\\${c}` : c;
  }
  return out;
}

function fit(value: string, width: number): string {
  const max = Math.max(1, Math.floor(width / (SIZE * ADVANCE)) - 1);
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

type Line = { cells: string[]; bold?: boolean } | { text: string; bold?: boolean };

export const PDF_CONTENT_TYPE = 'application/pdf';

export function renderPdf(doc: ExportDocument): Buffer {
  const usable = PAGE.width - 2 * PAGE.margin;
  const columns = Math.max(1, doc.header.length);
  const columnWidth = usable / columns;
  const markings = doc.markings.length === 0 ? 'Markings: none' : `Markings: ${doc.markings.join('; ')}`;
  const top = PAGE.height - PAGE.margin;
  const linesPerPage = Math.floor((top - PAGE.margin - 3 * LEADING) / LEADING);

  // The lines, then pages of them, the table header repeated after the first.
  const head: Line[] = [...doc.head.map(([label, value]): Line => ({ text: `${label}: ${text(value)}` })), { text: '' }];
  const header: Line = { cells: doc.header, bold: true };
  const body: Line[] = doc.rows.map((row) => ({ cells: row.map(text) }));
  const pages: Line[][] = [];
  let current: Line[] = [...head, header];
  for (const line of body) {
    if (current.length >= linesPerPage) {
      pages.push(current);
      current = [header];
    }
    current.push(line);
  }
  pages.push(current);

  const streams = pages.map((lines, index) => {
    let out = `BT /F2 ${SIZE} Tf ${PAGE.margin} ${top} Td (${pdfText(fit(markings, usable))}) Tj ET\n`;
    let y = top - 2 * LEADING;
    for (const line of lines) {
      const font = line.bold === true ? 'F2' : 'F1';
      if ('text' in line) {
        out += `BT /${font} ${SIZE} Tf ${PAGE.margin} ${y} Td (${pdfText(fit(line.text, usable))}) Tj ET\n`;
      } else {
        line.cells.forEach((cell, c) => {
          out += `BT /${font} ${SIZE} Tf ${(PAGE.margin + c * columnWidth).toFixed(2)} ${y} Td (${pdfText(fit(cell, columnWidth))}) Tj ET\n`;
        });
      }
      y -= LEADING;
    }
    const footer = `${doc.name} - page ${index + 1} of ${pages.length} - ${markings}`;
    out += `BT /F1 ${SIZE} Tf ${PAGE.margin} ${PAGE.margin - LEADING} Td (${pdfText(fit(footer, usable))}) Tj ET\n`;
    return deflateSync(Buffer.from(out, 'latin1'));
  });

  return pdfFile(doc.name, streams);
}

// ----------------------------------------------------------------------------- canvas exports (29.10)

export type DrawnState = 'normal' | 'warning' | 'failed' | 'unknown' | 'stale';

export interface CanvasDrawing {
  name: string;
  markings: readonly string[];
  /** When the drawing's state was read. */
  computedAt: string;
  /** Per source: its name and how old its state was when read. */
  sources: { name: string; age: string }[];
  /** Placed objects, in layout units (any scale, y down): position, label and state; expected, on a timeline, for what is still to come. */
  nodes: { x: number; y: number; label: string; state: DrawnState; expected?: boolean | undefined }[];
  edges: (readonly [number, number])[];
  /** Indices into edges that close a cycle: drawn dashed, as the canvas draws them distinctly (29.2). */
  backEdges?: readonly number[] | undefined;
  /** Stage columns, timeline lanes: text at layout positions. */
  guides?: readonly { x: number; y: number; text: string }[] | undefined;
  /** Lines with a word: the present on a timeline. */
  marks?: readonly { x0: number; y0: number; x1: number; y1: number; text: string }[] | undefined;
  /** A hierarchy's containers, to three levels, as nested regions. */
  regions?: readonly { x0: number; y0: number; x1: number; y1: number; depth: number }[] | undefined;
  /** A site plan under the drawing, covering layout units [0, width] by [0, height]. */
  background?: { image: PdfImage; width: number; height: number } | undefined;
  /** Printed under the drawing (a map without a base map says so). */
  note?: string | undefined;
  /** Objects the layout could not place (29.10 prints the count). */
  notPlaced: number;
  /** Flags that travel with the drawing (invariant 10): withheld elements, disputed values. */
  flags: string[];
}

/** Fill colours by state, as RGB in 0..1; each state has its shape too and its word beside it (28.4: colour is never the only sign). */
const STATE_FILL: Readonly<Record<DrawnState, [number, number, number]>> = {
  normal: [0.42, 0.45, 0.49], warning: [0.80, 0.52, 0.0], failed: [0.71, 0.14, 0.09], unknown: [0.11, 0.12, 0.14], stale: [0.42, 0.45, 0.49],
};

const f = (n: number) => n.toFixed(2);
const circle = (x: number, y: number, r: number): string => {
  const k = 0.5523 * r;
  return `${f(x + r)} ${f(y)} m ${f(x + r)} ${f(y + k)} ${f(x + k)} ${f(y + r)} ${f(x)} ${f(y + r)} c `
    + `${f(x - k)} ${f(y + r)} ${f(x - r)} ${f(y + k)} ${f(x - r)} ${f(y)} c ${f(x - r)} ${f(y - k)} ${f(x - k)} ${f(y - r)} ${f(x)} ${f(y - r)} c `
    + `${f(x + k)} ${f(y - r)} ${f(x + r)} ${f(y - k)} ${f(x + r)} ${f(y)} c `;
};

/** A state's glyph (28.4) at x, y: a filled circle, a triangle, a square with a cross, an outlined circle with "?", a clock. */
function glyph(state: DrawnState, x: number, y: number, r: number): string {
  const [cr, cg, cb] = STATE_FILL[state];
  const colour = `${cr} ${cg} ${cb} rg ${cr} ${cg} ${cb} RG`;
  switch (state) {
    case 'normal': return `${colour} ${circle(x, y, r)}f\n`;
    case 'warning': return `${colour} ${f(x)} ${f(y + r * 1.15)} m ${f(x + r * 1.1)} ${f(y - r * 0.85)} l ${f(x - r * 1.1)} ${f(y - r * 0.85)} l h f\n`;
    case 'failed': return `${colour} ${f(x - r)} ${f(y - r)} ${f(2 * r)} ${f(2 * r)} re f 1 1 1 RG ${f(r / 3)} w `
      + `${f(x - r * 0.6)} ${f(y - r * 0.6)} m ${f(x + r * 0.6)} ${f(y + r * 0.6)} l ${f(x - r * 0.6)} ${f(y + r * 0.6)} m ${f(x + r * 0.6)} ${f(y - r * 0.6)} l S\n`;
    case 'unknown': return `1 1 1 rg ${colour.split(' rg ')[1]} ${f(r / 3.5)} w ${circle(x, y, r)}B ${colour} BT /F2 ${f(r * 1.4)} Tf ${f(x - r * 0.38)} ${f(y - r * 0.5)} Td (?) Tj ET\n`;
    case 'stale': return `1 1 1 rg ${colour.split(' rg ')[1]} ${f(r / 3.5)} w ${circle(x, y, r)}B ${f(x)} ${f(y)} m ${f(x)} ${f(y + r * 0.62)} l ${f(x)} ${f(y)} m ${f(x + r * 0.5)} ${f(y - r * 0.1)} l S\n`;
  }
}

/** Above this many objects, labels are left out of a drawing (the list layout prints every name). */
const LABEL_LIMIT = 500;

/** One A4 landscape page: the drawing scaled to fit, a legend, and what must be printed with it. */
export function renderCanvasPdf(d: CanvasDrawing): Buffer {
  const markings = d.markings.length === 0 ? 'Markings: none' : `Markings: ${d.markings.join('; ')}`;
  const top = PAGE.height - PAGE.margin;
  const textLine = (x: number, y: number, s: string, font = 'F1', width = PAGE.width - 2 * PAGE.margin) =>
    `BT /${font} ${SIZE} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(fit(s, width))}) Tj ET\n`;
  let out = `0 0 0 rg ${textLine(PAGE.margin, top, markings, 'F2')}`;
  out += textLine(PAGE.margin, top - LEADING, `${d.name} - computed at ${d.computedAt}`);
  const sourceLine = d.sources.length === 0 ? 'Sources: none' : `State age by source: ${d.sources.map((s) => `${s.name} ${s.age}`).join('; ')}`;
  out += textLine(PAGE.margin, top - 2 * LEADING, sourceLine);
  const labelled = d.nodes.length <= LABEL_LIMIT;
  const flags = [`${d.notPlaced} not placed`, ...d.flags, ...(labelled ? [] : [`labels left out above ${LABEL_LIMIT} objects`])].join('; ');
  out += textLine(PAGE.margin, top - 3 * LEADING, `Flags: ${flags}`);

  // The drawing area, below the head and above the legend; a plan sets the extent it covers.
  const area = { x: PAGE.margin, y: PAGE.margin + 3 * LEADING, w: PAGE.width - 2 * PAGE.margin, h: top - 5 * LEADING - (PAGE.margin + 3 * LEADING) };
  const xs = [...d.nodes.map((n) => n.x), ...(d.background === undefined ? [] : [0, d.background.width]), ...(d.regions ?? []).flatMap((r) => [r.x0, r.x1])];
  const ys = [...d.nodes.map((n) => n.y), ...(d.background === undefined ? [] : [0, d.background.height]), ...(d.regions ?? []).flatMap((r) => [r.y0, r.y1])];
  const [minX, maxX] = xs.length === 0 ? [0, 1] : [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = ys.length === 0 ? [0, 1] : [Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((area.w - 160) / Math.max(1e-9, maxX - minX), (area.h - 40) / Math.max(1e-9, maxY - minY));
  const at = (n: { x: number; y: number }): [number, number] =>
    [area.x + 20 + (n.x - minX) * scale, area.y + area.h - 20 - (n.y - minY) * scale];

  if (d.background !== undefined) {
    const [x0, yTop] = at({ x: 0, y: 0 });
    const [, yBottom] = at({ x: 0, y: d.background.height });
    out += `q ${f(d.background.width * scale)} 0 0 ${f(yTop - yBottom)} ${f(x0)} ${f(yBottom)} cm /Im1 Do Q\n`;
  }
  for (const r of d.regions ?? []) {
    const [x0, y0] = at({ x: r.x0, y: r.y1 });
    const [x1, y1] = at({ x: r.x1, y: r.y0 });
    const shade = 0.97 - 0.03 * r.depth;
    out += `${shade} ${shade} ${shade} rg 0.6 0.6 0.6 RG 0.5 w ${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)} re B\n`;
  }
  const back = new Set(d.backEdges ?? []);
  d.edges.forEach(([a, b], i) => {
    const from = d.nodes[a];
    const to = d.nodes[b];
    if (from === undefined || to === undefined) return;
    const [x1, y1] = at(from);
    const [x2, y2] = at(to);
    out += back.has(i) ? `0.04 0.36 0.68 RG 1 w [3 2] 0 d ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S [] 0 d\n` : `0.6 0.6 0.6 RG 0.5 w ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S\n`;
  });
  for (const k of d.marks ?? []) {
    const [x1, y1] = at({ x: k.x0, y: k.y0 });
    const [x2, y2] = at({ x: k.x1, y: k.y1 });
    out += `0.1 0.1 0.1 RG 0.8 w ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S 0 0 0 rg ${textLine(x1 + 2, y1 + 3, k.text, 'F2', 80)}`;
  }
  for (const g of d.guides ?? []) {
    const [x, y] = at(g);
    out += `0 0 0 rg ${textLine(x, y + 4, g.text, 'F2', 140)}`;
  }
  const radius = 3.5;
  for (const n of d.nodes) {
    const [x, y] = at(n);
    out += glyph(n.state, x, y, radius);
    if (labelled) out += `0 0 0 rg ${textLine(x + radius + 2, y - 3, `${n.label} (${n.state}${n.expected === true ? ', expected' : ''})`, 'F1', 140)}`;
  }
  if (back.size > 0) out += `0 0 0 rg ${textLine(PAGE.margin, PAGE.margin + 2 * LEADING, `${back.size} link${back.size === 1 ? '' : 's'} closing a cycle, dashed`, 'F1', 300)}`;
  if (d.note !== undefined) out += `0 0 0 rg ${textLine(PAGE.margin + 320, PAGE.margin + 2 * LEADING, d.note, 'F1', 420)}`;
  // The legend: every state, as its shape, colour and word.
  let lx = PAGE.margin;
  for (const state of Object.keys(STATE_FILL) as DrawnState[]) {
    out += glyph(state, lx + 4, PAGE.margin + LEADING + 3, 4) + `0 0 0 rg ${textLine(lx + 11, PAGE.margin + LEADING, state, 'F1', 60)}`;
    lx += 72;
  }
  out += `0 0 0 rg ${textLine(PAGE.margin, PAGE.margin - LEADING, `${d.name} - ${markings}`)}`;
  return pdfFile(d.name, [deflateSync(Buffer.from(out, 'latin1'))], d.background?.image);
}

/** A PDF of these compressed page contents, with the two Helvetica faces. */
function pdfFile(title: string, streams: readonly Buffer[], image?: PdfImage, page: { width: number; height: number } = PAGE): Buffer {
  const objects: Buffer[] = [];
  const pageIds = streams.map((_, i) => 6 + 2 * i);
  // An image, and its soft mask, follow the pages.
  const imageId = 6 + 2 * streams.length;
  const maskId = imageId + 1;
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${streams.length} >>`));
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  objects.push(Buffer.from(`<< /Title (${pdfText(title)}) /Producer (Silo) >>`, 'latin1'));
  streams.forEach((stream, i) => {
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${image === undefined ? '' : ` /XObject << /Im1 ${imageId} 0 R >>`} >> /Contents ${pageIds[i]! + 1} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  });
  if (image !== undefined) {
    const mask = image.alpha === undefined ? '' : ` /SMask ${maskId} 0 R`;
    objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.colourSpace} `
      + `/BitsPerComponent 8 /Filter /${image.filter}${mask} /Length ${image.data.length} >>\nstream\n`), image.data, Buffer.from('\nendstream')]));
    if (image.alpha !== undefined) {
      objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray `
        + `/BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alpha.length} >>\nstream\n`), image.alpha, Buffer.from('\nendstream')]));
    }
  }
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
  parts.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------------------- reports (D233)

export type ReportBlock =
  | { kind: 'heading'; text: string; level: 1 | 2 }
  | { kind: 'text'; text: string }
  | { kind: 'table'; caption: string | undefined; header: string[]; rows: string[][]; note: string | undefined };

const PORTRAIT = { width: 595, height: 842, margin: 48 } as const;

/** Words wrapped to a width, by Helvetica's average advance; a word longer than the width is cut. */
function wrap(value: string, width: number, size: number): string[] {
  const max = Math.max(8, Math.floor(width / (size * ADVANCE)));
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
      const w = word.length > max ? `${word.slice(0, max - 3)}...` : word;
      if (line === '') line = w;
      else if (line.length + 1 + w.length <= max) line += ` ${w}`;
      else { lines.push(line); line = w; }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * A report as a document (D233): portrait A4, headings, wrapped paragraphs and tables whose
 * header repeats on each page they run onto; the markings at the top of every page and the name,
 * page and markings at the foot (invariant 7).
 */
export function renderReportPdf(input: { name: string; markings: readonly string[]; computedAt: string; blocks: readonly ReportBlock[] }): Buffer {
  const usable = PORTRAIT.width - 2 * PORTRAIT.margin;
  const markings = input.markings.length === 0 ? 'Markings: none' : `Markings: ${input.markings.join('; ')}`;
  type Op = { font: 'F1' | 'F2'; size: number; lead: number; text: string; x?: number } | { cells: string[]; widths: number[]; bold: boolean } | { gap: number };
  const ops: Op[] = [
    { font: 'F2', size: 16, lead: 22, text: input.name },
    { font: 'F1', size: 8, lead: 14, text: `Computed ${input.computedAt}` },
  ];
  // Each table remembers its header, so a page break repeats it.
  const tableHeaders = new Map<number, Op>();
  for (const b of input.blocks) {
    if (b.kind === 'heading') {
      ops.push({ gap: 6 });
      const size = b.level === 1 ? 13 : 11;
      for (const line of wrap(b.text, usable, size)) ops.push({ font: 'F2', size, lead: size + 5, text: line });
    } else if (b.kind === 'text') {
      for (const line of wrap(b.text, usable, 9)) ops.push({ font: 'F1', size: 9, lead: 13, text: line });
      ops.push({ gap: 4 });
    } else {
      ops.push({ gap: 4 });
      if (b.caption !== undefined) ops.push({ font: 'F2', size: 9, lead: 13, text: b.caption });
      // Columns as wide as their longest text (within bounds), so a long path is not cut beside short counts.
      const columns = Math.max(1, b.header.length);
      const weights = Array.from({ length: columns }, (_, c) =>
        Math.min(60, Math.max(6, (b.header[c] ?? '').length, ...b.rows.map((r) => (r[c] ?? '').length))));
      const total = weights.reduce((x, y) => x + y, 0);
      const widths = weights.map((w) => (usable * w) / total);
      const header: Op = { cells: b.header, widths, bold: true };
      tableHeaders.set(ops.length, header);
      ops.push(header);
      for (const row of b.rows) { tableHeaders.set(ops.length, header); ops.push({ cells: row, widths, bold: false }); }
      if (b.note !== undefined) for (const line of wrap(b.note, usable, 8)) ops.push({ font: 'F1', size: 8, lead: 12, text: line });
      ops.push({ gap: 6 });
    }
  }
  const top = PORTRAIT.height - PORTRAIT.margin;
  const pages: string[] = [];
  let out = '';
  let y = 0;
  const startPage = () => {
    out = `BT /F2 8 Tf ${PORTRAIT.margin} ${top} Td (${pdfText(fit(markings, usable))}) Tj ET\n`;
    y = top - 20;
  };
  startPage();
  ops.forEach((op, i) => {
    const lead = 'gap' in op ? op.gap : 'cells' in op ? 12 : op.lead;
    if (y - lead < PORTRAIT.margin + 16) {
      pages.push(out);
      startPage();
      // A table carried over repeats its header.
      const header = tableHeaders.get(i);
      if (header !== undefined && header !== op && 'cells' in header) {
        let x = PORTRAIT.margin;
        header.cells.forEach((cell, c) => { out += `BT /F2 8 Tf ${x.toFixed(2)} ${y} Td (${pdfText(fit(cell, header.widths[c]!))}) Tj ET\n`; x += header.widths[c]!; });
        y -= 12;
      }
    }
    if ('gap' in op) { y -= op.gap; return; }
    if ('cells' in op) {
      let x = PORTRAIT.margin;
      op.cells.forEach((cell, c) => { out += `BT /${op.bold ? 'F2' : 'F1'} 8 Tf ${x.toFixed(2)} ${y} Td (${pdfText(fit(cell, op.widths[c]!))}) Tj ET\n`; x += op.widths[c]!; });
      if (op.bold) out += `${PORTRAIT.margin} ${(y - 3).toFixed(2)} m ${(PORTRAIT.margin + usable).toFixed(2)} ${(y - 3).toFixed(2)} l 0.5 w S\n`;
      y -= 12;
      return;
    }
    out += `BT /${op.font} ${op.size} Tf ${PORTRAIT.margin} ${y} Td (${pdfText(op.text)}) Tj ET\n`;
    y -= op.lead;
  });
  pages.push(out);
  const streams = pages.map((body, index) => {
    const footer = `${input.name} - page ${index + 1} of ${pages.length} - ${markings}`;
    return deflateSync(Buffer.from(`${body}BT /F1 8 Tf ${PORTRAIT.margin} ${PORTRAIT.margin - 14} Td (${pdfText(fit(footer, usable))}) Tj ET\n`, 'latin1'));
  });
  return pdfFile(input.name, streams, undefined, PORTRAIT);
}

