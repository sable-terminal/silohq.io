// A small reader of email messages (RFC 5322 and MIME, RFC 2045 to 2047), for email fallback
// (spec 14.4): enough of a message to know who sent it, its subject and its text. Not a mail
// client: no attachments are kept, nothing is rendered, nothing is fetched.
//
// - Headers unfolded; encoded words (=?charset?B|Q?...?=) in Subject and From decoded.
// - Bodies decoded from base64 or quoted-printable, in their charset (UTF-8, US-ASCII,
//   ISO-8859-1 and Windows-1252; another is read as UTF-8).
// - multipart/* walked to a bounded depth; the text is the first text/plain part, else the
//   first text/html part reduced to text (tags removed, block ends as line breaks, the common
//   entities decoded).
// - A forwarded message attached whole (message/rfc822) is the notification itself: it is
//   returned as `forwarded`, so a rule reads the system's own message, not the forwarding one.
// Bounded: at most MAX_PARTS parts and MAX_DEPTH nesting; text past MAX_TEXT is cut at a line.

const MAX_DEPTH = 5;
const MAX_PARTS = 50;
const MAX_TEXT = 64 * 1024;

export interface MailMessage {
  /** The address of From, lower-cased, without its display name. */
  from: string;
  subject: string;
  /** The Date header as an instant, where it reads as one. */
  date: string | undefined;
  /** The Message-ID, without its angle brackets: a repeat delivery carries the same one. */
  messageId: string | undefined;
  /** The message's text, line breaks as \n. */
  text: string;
  /** A message forwarded as an attachment: the notification it carries. */
  forwarded: MailMessage | undefined;
}

type Headers = Map<string, string>;

function splitHead(raw: string): { headers: Headers; body: string } {
  const normalised = raw.replace(/\r\n/g, '\n');
  const end = normalised.indexOf('\n\n');
  const head = end === -1 ? normalised : normalised.slice(0, end);
  const body = end === -1 ? '' : normalised.slice(end + 2);
  const headers: Headers = new Map();
  let current: string | undefined;
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && current !== undefined) {
      headers.set(current, `${headers.get(current)!} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    // The first of a repeated header stands (a Received chain is not ours to read).
    if (!headers.has(current)) headers.set(current, line.slice(colon + 1).trim());
    else current = undefined;
  }
  return { headers, body };
}

function decoderFor(charset: string | undefined): TextDecoder {
  const name = (charset ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  const known: Record<string, string> = { 'us-ascii': 'utf-8', ascii: 'utf-8', 'utf-8': 'utf-8', utf8: 'utf-8', 'iso-8859-1': 'latin1', latin1: 'latin1', 'windows-1252': 'windows-1252' };
  return new TextDecoder(known[name] ?? 'utf-8', { fatal: false });
}

function quotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  const soft = text.replace(/=\n/g, '');
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i]!;
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words, as in a Subject or a From display name. */
export function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset: string, encoding: string, data: string) => {
    const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : quotedPrintable(data.replace(/_/g, ' '));
    return decoderFor(charset).decode(bytes);
  });
}

function parameter(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const m = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(header);
  return m === null ? undefined : (m[2] ?? m[1]);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€' };

/** HTML reduced to its text: scripts and styles dropped, blocks ending lines, entities decoded. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
      if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
      return ENTITIES[entity.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function addressOf(from: string | undefined): string {
  if (from === undefined) return '';
  const angle = /<([^>]+)>/.exec(from);
  const raw = angle !== null ? angle[1]! : from;
  const m = /[^\s"<>,;]+@[^\s"<>,;]+/.exec(raw);
  return m === null ? '' : m[0].toLowerCase();
}

interface Walked { plain: string | undefined; html: string | undefined; forwarded: MailMessage | undefined; parts: number }

function walk(headers: Headers, body: string, depth: number, state: Walked): void {
  if (state.parts >= MAX_PARTS || depth > MAX_DEPTH) return;
  state.parts += 1;
  const type = (headers.get('content-type') ?? 'text/plain').toLowerCase();
  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase().trim();
  const disposition = (headers.get('content-disposition') ?? '').toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = parameter(headers.get('content-type'), 'boundary');
    if (boundary === undefined) return;
    const pieces = body.split(`--${boundary}`);
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith('--')) break;
      const part = splitHead(piece.replace(/^\n/, ''));
      walk(part.headers, part.body, depth + 1, state);
    }
    return;
  }
  if (type.startsWith('message/rfc822')) {
    if (state.forwarded === undefined) state.forwarded = readMessage(body, depth + 1);
    return;
  }
  if (disposition.startsWith('attachment')) return;
  const bytes = encoding === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : encoding === 'quoted-printable' ? quotedPrintable(body) : Buffer.from(body, 'utf8');
  const text = decoderFor(parameter(headers.get('content-type'), 'charset')).decode(bytes);
  if (type.startsWith('text/plain') && state.plain === undefined) state.plain = text;
  else if (type.startsWith('text/html') && state.html === undefined) state.html = text;
}

function bounded(text: string): string {
  const clean = text.replace(/\r\n/g, '\n');
  if (clean.length <= MAX_TEXT) return clean;
  const cut = clean.lastIndexOf('\n', MAX_TEXT);
  return clean.slice(0, cut > 0 ? cut : MAX_TEXT);
}

function readMessage(raw: string, depth: number): MailMessage {
  const { headers, body } = splitHead(raw);
  const state: Walked = { plain: undefined, html: undefined, forwarded: undefined, parts: 0 };
  walk(headers, body, depth, state);
  const date = headers.get('date') === undefined ? undefined : new Date(headers.get('date')!);
  const messageId = /<([^>]{1,200})>/.exec(headers.get('message-id') ?? '')?.[1];
  return {
    from: addressOf(decodeWords(headers.get('from') ?? '')),
    subject: decodeWords(headers.get('subject') ?? '').trim(),
    date: date === undefined || Number.isNaN(date.getTime()) ? undefined : date.toISOString(),
    messageId,
    text: bounded(state.plain ?? (state.html === undefined ? '' : htmlText(state.html))),
    forwarded: state.forwarded,
  };
}

export function parseMessage(raw: string): MailMessage {
  return readMessage(raw, 0);
}
