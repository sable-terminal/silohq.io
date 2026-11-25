import type { DefinitionObject } from '../../schemas/siloDefinition.schema';
import type { ProseAnswer } from '../../schemas/proseAnswer.schema';
import type { DocumentPage, DocumentTextItem, TextSpan, ValueLocation } from '../../models/document.model';
import type { ExtractedRow } from '../../models/rowStore.model';
import { coerce } from './tabular.extraction';
import { boxOf, linesOf, type DocumentOutcome, type Located } from './document.extraction';

/**
 * §3 — prose: a model reads the text, and nothing it says is taken on trust.
 *
 * ── Inferred, with the passage ─────────────────────────────────────────────
 *
 * Every value carries `inferred`, the model's score, and where its passage sits
 * — a box on a page for a PDF, a span of the text for a Word document — so the
 * flag can show the sentence the figure came from.
 *
 * ── Anchored, or refused ───────────────────────────────────────────────────
 *
 * The model is told to copy the passage exactly. The passage is then looked for
 * in the document, allowing only for differences in whitespace, and a value
 * whose passage is not there is refused. A model that invents a figure has to
 * invent the sentence it came from too, and that sentence is not in the file.
 *
 * ── Still typed ────────────────────────────────────────────────────────────
 *
 * A value the model gives is coerced like a spreadsheet cell, and refused the
 * same way when it does not fit.
 */

/** The questions a definition asks of a document, one per field. */
export function proseQuestions(object: DefinitionObject): Array<{ name: string; type: string; question: string }> {
  return object.fields.flatMap((f) =>
    f.extraction.method === 'prose' ? [{ name: f.name, type: f.type, question: f.extraction.question }] : [],
  );
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a passage sits in a text, allowing only for differences in whitespace. */
export function locateQuote(text: string, quote: string): TextSpan | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const match = new RegExp(words.map(escape).join('\\s+')).exec(text);
  return match ? { offset: match.index, length: match[0].length } : null;
}

/**
 * A PDF's text as the model is given it — line by line, page by page — with
 * where each line sits in that text, so a passage found in it can be put back
 * on its page.
 */
export function textOfPages(pages: DocumentPage[]): {
  text: string;
  lines: Array<{ page: number; start: number; end: number; items: DocumentTextItem[] }>;
} {
  let text = '';
  const lines: Array<{ page: number; start: number; end: number; items: DocumentTextItem[] }> = [];

  for (const page of pages) {
    for (const line of linesOf(page)) {
      const written = line.items.map((item) => item.text).join(' ');
      lines.push({ page: page.page, start: text.length, end: text.length + written.length, items: line.items });
      text += `${written}\n`;
    }
    text += '\n';
  }

  return { text, lines };
}

/** The lines a passage covers, on the page it starts on. */
function placeOnPage(layout: ReturnType<typeof textOfPages>, span: TextSpan): ValueLocation | null {
  const end = span.offset + span.length;
  const covered = layout.lines.filter((line) => line.start < end && line.end > span.offset);
  if (covered.length === 0) return null;
  const page = covered[0]!.page;
  return boxOf(page, covered.filter((line) => line.page === page).flatMap((line) => line.items));
}

/**
 * One record per document, from the model's answer to its questions.
 *
 * The answer has already passed `proseAnswer` and named only the fields that
 * were asked about; this decides, value by value, whether it is kept.
 */
export function acceptProse(input: {
  object: DefinitionObject;
  answer: ProseAnswer;
  /** Exactly the text the model was given. */
  text: string;
  /** For a PDF: the pages that text was built from. */
  pages?: DocumentPage[];
}): DocumentOutcome {
  const rowRef = 'document';
  const layout = input.pages ? textOfPages(input.pages) : null;
  const identifiers = new Set(input.object.identifier);

  const values: Record<string, unknown> = {};
  const methods: ExtractedRow['methods'] = {};
  const located: Located[] = [];

  const refuse = (field: string, reason: string): DocumentOutcome => ({
    rows: [],
    rejected: [{ rowRef, field, reason }],
    missingColumns: [],
    rowsRead: 1,
    located: [],
  });

  for (const f of input.object.fields) {
    if (f.extraction.method !== 'prose') continue;

    const given = input.answer.fields[f.name];
    let value: unknown = null;

    if (given && given.value !== null) {
      if (!given.quote) return refuse(f.name, 'The model gave no passage for this value.');

      const span = locateQuote(layout ? layout.text : input.text, given.quote);
      if (!span) return refuse(f.name, 'The passage the model quoted is not in the document.');

      const outcome = coerce(given.value, f);
      if (!outcome.ok) return refuse(f.name, outcome.reason);
      value = outcome.value;

      if (value !== null) {
        const location = layout ? placeOnPage(layout, span) : null;
        methods[f.name] = 'inferred';
        located.push({
          rowRef,
          field: f.name,
          method: 'inferred',
          confidence: given.confidence,
          ...(location ? { location } : { span }),
        });
      }
    }

    if (value === null && (!f.nullable || identifiers.has(f.name))) {
      return refuse(f.name, identifiers.has(f.name) ? 'An identifier is empty.' : 'A required value is empty.');
    }
    values[f.name] = value;
  }

  return { rows: [{ rowRef, values, methods }], rejected: [], missingColumns: [], rowsRead: 1, located };
}
