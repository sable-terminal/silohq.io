import { checkCount, FormatError, type FormatParser } from './contract.format';

/**
 * The interchange formats of trade and healthcare: EDI (X12 and EDIFACT) and
 * HL7 version 2.
 *
 * ── STRUCTURE, NOT MEANING ────────────────────────────────────────────────
 *
 * These are delimited segment formats whose delimiters are declared inside
 * each message, and whose meaning lives in thousands of transaction-set
 * definitions. The parser reads the delimiters and returns the structure —
 * interchanges, groups, transactions or messages, segments, elements and
 * components — and the connector's expressions say which segment is a record:
 * `{{ response.transactions.segments[tag = 'CLM'] }}`. A new transaction set is
 * a document, never a parser.
 */

type Element = string | string[] | Array<string | string[]>;
export interface Segment {
  tag: string;
  /** `elements[0]` is the standard's element 01 — the tag is not counted. */
  elements: Element[];
}

interface Separators {
  element: string;
  component: string;
  repetition: string | null;
  /** EDIFACT's release character; X12 has none. */
  release: string | null;
}

/**
 * Split on one separator, leaving release sequences untouched so the level
 * below can still see them. Only a leaf value is unescaped.
 */
function split(text: string, separator: string, release: string | null): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (release && c === release && i + 1 < text.length) {
      current += c + text[++i];
      continue;
    }
    if (c === separator) {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

const literal = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const unrelease = (text: string, release: string | null): string =>
  release ? text.replace(new RegExp(`${literal(release)}(.)`, 'gs'), '$1') : text;

/**
 * An element as it reads: a plain value; a composite as its components; a
 * repeated element as its repetitions. One component is the value itself, so
 * `elements[1]` is `'125.50'` and not `['125.50']`.
 */
function element(raw: string, sep: Separators): Element {
  const repetitions = sep.repetition ? split(raw, sep.repetition, sep.release) : [raw];
  const read = repetitions.map((rep) => {
    const parts = split(rep, sep.component, sep.release).map((p) => unrelease(p, sep.release));
    return parts.length > 1 ? parts : parts[0]!;
  });
  return read.length > 1 ? (read as Element) : read[0]!;
}

function segmentsOf(body: string, terminator: string, sep: Separators): Segment[] {
  return split(body, terminator, sep.release)
    .map((s) => s.replace(/^[\r\n\s]+/, '').replace(/[\r\n]+$/, ''))
    .filter(Boolean)
    .map((s) => {
      const [raw, ...rest] = split(s, sep.element, sep.release);
      const tag = unrelease(raw!, sep.release).trim();
      /* The envelope header declares the separators, so its own elements are read as written. */
      return { tag, elements: tag === 'ISA' ? rest : rest.map((r) => element(r, sep)) };
    });
}

const first = (e: Element | undefined): string => {
  if (e === undefined) return '';
  if (typeof e === 'string') return e;
  const head = e[0];
  return typeof head === 'string' ? head : (head?.[0] ?? '');
};

/* ── X12 ───────────────────────────────────────────────────────────────── */

function x12(text: string) {
  const body = text.replace(/^\uFEFF/, '');
  if (!body.startsWith('ISA') || body.length < 106) throw new FormatError('edi', 'An X12 interchange starts with a 106-character ISA segment.');
  const elementSep = body[3]!;
  const componentSep = body[104]!;
  const terminator = body[105]!;
  /* ISA11 is the repetition separator from version 00402 on; before that it is the standards identifier `U`. */
  const isa11 = body.split(elementSep)[11] ?? 'U';
  const repetition = isa11.length === 1 && isa11 !== 'U' && isa11 !== elementSep && isa11 !== componentSep ? isa11 : null;
  const segments = segmentsOf(body, terminator, { element: elementSep, component: componentSep, repetition, release: null });

  const isa = segments[0]!;
  const groups: Array<{ code: string; control: string; transactions: Array<{ type: string; control: string; segments: Segment[] }> }> = [];
  let group: (typeof groups)[number] | null = null;
  let transaction: (typeof groups)[number]['transactions'][number] | null = null;
  for (const s of segments.slice(1)) {
    if (s.tag === 'GS') {
      group = { code: first(s.elements[0]), control: first(s.elements[5]), transactions: [] };
      groups.push(group);
    } else if (s.tag === 'ST') {
      transaction = { type: first(s.elements[0]), control: first(s.elements[1]), segments: [] };
      (group ?? (group = { code: '', control: '', transactions: [] }, groups.push(group), group)).transactions.push(transaction);
    } else if (s.tag === 'SE') {
      transaction = null;
    } else if (s.tag === 'GE' || s.tag === 'IEA') {
      if (s.tag === 'GE') group = null;
    } else if (transaction) {
      transaction.segments.push(s);
    }
  }
  const transactions = groups.flatMap((g) => g.transactions);
  checkCount('edi', segments.length);
  return {
    standard: 'x12',
    interchange: {
      sender: first(isa.elements[5]).trim(),
      receiver: first(isa.elements[7]).trim(),
      date: first(isa.elements[8]),
      time: first(isa.elements[9]),
      control: first(isa.elements[12]),
    },
    groups,
    transactions,
    segments,
  };
}

/* ── EDIFACT ───────────────────────────────────────────────────────────── */

function edifact(text: string) {
  let body = text.replace(/^\uFEFF/, '');
  let component = ':';
  let elementSep = '+';
  let release: string | null = '?';
  let terminator = "'";
  /* Syntax version 4 repeats with `*`; version 3 has no repetition, and a `*` there is data. */
  let repetition: string | null = /^\s*UNB\+[A-Z]{4}:4/.test(body) ? '*' : null;
  if (body.startsWith('UNA')) {
    component = body[3]!;
    elementSep = body[4]!;
    release = body[6] === ' ' ? null : body[6]!;
    /* UNA5 is the repetition separator in syntax version 4 and reserved (a space) before it. */
    repetition = body[7] === ' ' ? null : body[7]!;
    terminator = body[8]!;
    body = body.slice(9);
  }
  if (!/^\s*UNB/.test(body)) throw new FormatError('edi', 'An EDIFACT interchange starts with UNA or UNB.');
  const segments = segmentsOf(body, terminator, { element: elementSep, component, repetition, release });
  const messages: Array<{ type: string; reference: string; segments: Segment[] }> = [];
  let message: (typeof messages)[number] | null = null;
  for (const s of segments) {
    if (s.tag === 'UNH') {
      message = { type: first(s.elements[1]), reference: first(s.elements[0]), segments: [] };
      messages.push(message);
    } else if (s.tag === 'UNT') {
      message = null;
    } else if (message) {
      message.segments.push(s);
    }
  }
  const unb = segments.find((s) => s.tag === 'UNB');
  checkCount('edi', segments.length);
  return {
    standard: 'edifact',
    interchange: { sender: first(unb?.elements[1]), receiver: first(unb?.elements[2]), control: first(unb?.elements[4]) },
    messages,
    transactions: messages,
    segments,
  };
}

export const edi: FormatParser = {
  name: 'edi',
  contentTypes: ['application/edi-x12', 'application/edifact', 'application/edi-consent'],
  binary: false,
  parse({ input, options }) {
    const text = String(input);
    const standard = options.standard ?? (text.replace(/^\uFEFF/, '').trimStart().startsWith('ISA') ? 'x12' : 'edifact');
    return standard === 'x12' ? x12(text.trimStart()) : edifact(text.trimStart());
  },
};

/* ── HL7 version 2 ─────────────────────────────────────────────────────── */

/**
 * `fields[n]` IS HL7 FIELD n. MSH is the standard's awkward case — its first
 * field is the field separator itself — and is numbered the way the standard
 * numbers it, so MSH-9 is `fields[9]` in every segment type alike.
 */
export const hl7: FormatParser = {
  name: 'hl7',
  contentTypes: ['x-application/hl7-v2+er7', 'application/hl7-v2'],
  binary: false,
  parse({ input }) {
    const text = String(input).replace(/^\uFEFF/, '').replace(/^\x0b/, '').replace(/\x1c\r?$/, '');
    if (!text.startsWith('MSH')) throw new FormatError('hl7', 'An HL7 message starts with an MSH segment.');
    const fieldSep = text[3]!;
    const encoding = text.slice(4, 8);
    const component = encoding[0] ?? '^';
    const repetition = encoding[1] ?? '~';
    const escapeChar = encoding[2] ?? '\\';
    const sub = encoding[3] ?? '&';

    /* \\F\\ \\S\\ \\R\\ \\T\\ \\E\\ are the delimiters themselves; \\Xhh..\\ is hex; \\.br\\ is a line break. */
    const e = literal(escapeChar);
    const escapes = new RegExp(`${e}(F|S|R|T|E|X[0-9A-Fa-f]*|\\.br)${e}`, 'g');
    const unescape = (value: string) =>
      value.replace(escapes, (_all, code: string) => {
        if (code === 'F') return fieldSep;
        if (code === 'S') return component;
        if (code === 'R') return repetition;
        if (code === 'T') return sub;
        if (code === 'E') return escapeChar;
        if (code === '.br') return '\n';
        return Buffer.from(code.slice(1), 'hex').toString('latin1');
      });

    const value = (raw: string): unknown => {
      const reps = raw.split(repetition).map((rep) => {
        const comps = rep.split(component).map((c) => {
          const subs = c.split(sub).map(unescape);
          return subs.length > 1 ? subs : subs[0]!;
        });
        return comps.length > 1 ? comps : comps[0]!;
      });
      return reps.length > 1 ? reps : reps[0]!;
    };

    const segments = text
      .split(/\r\n|\r|\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const parts = line.split(fieldSep);
        const type = parts[0]!;
        const fields: unknown[] =
          type === 'MSH' ? [type, fieldSep, encoding, ...parts.slice(2).map(value)] : [type, ...parts.slice(1).map(value)];
        return { type, fields };
      });

    const messages: Array<{ type: string; control: string; segments: typeof segments }> = [];
    for (const segment of segments) {
      if (segment.type === 'MSH') {
        const kind = segment.fields[9];
        messages.push({ type: Array.isArray(kind) ? (kind as unknown[]).join('^') : String(kind ?? ''), control: String(segment.fields[10] ?? ''), segments: [segment] });
      } else {
        messages.at(-1)?.segments.push(segment);
      }
    }
    checkCount('hl7', segments.length);
    return { messages, segments };
  },
};
