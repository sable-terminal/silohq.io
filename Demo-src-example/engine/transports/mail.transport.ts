import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import type { TransportV2 } from '../../schemas/manifest.schema';
import { nodeTls, socketLookup } from '../../infra/network.infra';
import { bounds, isAppError, refusal, upstream } from '../../utils/error.util';
import { bytesOf, WIRE_CONTENT_TYPE } from '../formats/wire.format';
import type { AuthSurface, SocketAuth, Transport, WireRequest, WireResponse } from './contract.transport';

/**
 * A mailbox, read over IMAP.
 *
 * ── READ-ONLY, ALWAYS ─────────────────────────────────────────────────────
 *
 * The mailbox is opened with EXAMINE, never SELECT, so reading a message does
 * not mark it seen. Somebody's inbox after Silo has read it looks exactly as it
 * did before.
 *
 * ── NEWEST FIRST, IN BATCHES, AND RESUMABLE ───────────────────────────────
 *
 * The search runs on the server; the matching UIDs are read from the highest
 * down, a batch at a time. When more remain the response says where to carry on
 * in `x-silo-next` — the mailbox's UIDVALIDITY and the lowest UID read — and the
 * connector's paging sends it back as `body.position`. If the mailbox was rebuilt
 * in between (a new UIDVALIDITY) the UIDs mean something else, and the read is
 * refused rather than continued from the wrong place.
 *
 * ── WHAT A MESSAGE IS ─────────────────────────────────────────────────────
 *
 * The envelope always; the text, the HTML and the attachments when `parts` asks
 * for them. An attachment's bytes come back as a blob a later step can parse —
 * the CSV a bank emails every morning is read like any other file.
 */

export interface MailWire extends WireRequest {
  kind: 'imap';
  host: string;
  port: number;
  security: 'implicit' | 'starttls' | 'none';
  mailbox: string;
  search: SearchObject;
  parts: Array<'envelope' | 'text' | 'html' | 'attachments'>;
  /** `<uidvalidity>:<uid>` — read only UIDs below this one. */
  position: string | null;
}

/** Messages per page when bodies are read, and when only envelopes are. */
const BATCH_WITH_BODIES = 50;
const BATCH_ENVELOPES = 500;
const TIMEOUT_MS = 20_000;

/** The search keys IMAP defines and imapflow encodes. Anything else in a document is refused by name. */
const FLAGS = new Set(['answered', 'deleted', 'draft', 'flagged', 'seen', 'all', 'new', 'old', 'recent']);
const TEXTS = new Set(['from', 'to', 'cc', 'bcc', 'body', 'subject', 'text', 'keyword', 'unKeyword', 'uid', 'seq', 'emailId', 'threadId', 'gmraw']);
const NUMBERS = new Set(['larger', 'smaller']);
const DATES = new Set(['before', 'on', 'since', 'sentBefore', 'sentOn', 'sentSince']);

function unbuildable(message: string): never {
  throw refusal({ message, code: 'refusal.request_unbuildable' });
}

/** A document's `search` as imapflow takes it, every key checked and every date parsed. */
export function searchOf(tree: unknown, depth = 0): SearchObject {
  if (tree === undefined || tree === null) return { all: true };
  if (depth > 8 || typeof tree !== 'object' || Array.isArray(tree)) unbuildable('An IMAP search is an object of criteria, such as { "since": "2026-09-01", "from": "bank.example" }.');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (FLAGS.has(key)) out[key] = value === true || value === 'true';
    else if (TEXTS.has(key)) out[key] = String(value).slice(0, 1_000);
    else if (NUMBERS.has(key)) out[key] = Number(value);
    else if (DATES.has(key)) {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) unbuildable(`The IMAP search's ${key} came to "${String(value).slice(0, 40)}", which is not a date.`);
      out[key] = date;
    } else if (key === 'header') {
      if (typeof value !== 'object' || Array.isArray(value)) unbuildable('An IMAP header search is { "Header-Name": "value" }.');
      out.header = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([h, v]) => [h, typeof v === 'boolean' ? v : String(v)]));
    } else if (key === 'not') out.not = searchOf(value, depth + 1);
    else if (key === 'or') {
      if (!Array.isArray(value) || value.length < 2) unbuildable('An IMAP "or" is a list of at least two searches.');
      out.or = value.map((one) => searchOf(one, depth + 1));
    } else unbuildable(`"${key}" is not an IMAP search criterion.`);
  }
  return Object.keys(out).length === 0 ? { all: true } : (out as SearchObject);
}

const str = (v: unknown, fallback = ''): string => (v === null || v === undefined ? fallback : String(v));

function positionOf(body: unknown): string | null {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).position : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw);
  if (!/^\d+:\d+$/.test(text)) unbuildable('An IMAP position is what x-silo-next said: <uidvalidity>:<uid>.');
  return text;
}

function socketOnly(where: string): never {
  throw refusal({ message: `A mailbox takes its credential on the connection, not at ${where}.`, code: 'refusal.auth_place_unsupported' });
}

const surface = (socket: SocketAuth): AuthSurface => ({
  setHeader: (n) => socketOnly(`header:${n}`),
  setQuery: (n) => socketOnly(`query:${n}`),
  setBodyPath: (p) => socketOnly(`body:${p}`),
  setCookie: (n) => socketOnly(`cookie:${n}`),
  setForm: (n) => socketOnly(`form:${n}`),
  setSoapHeader: (p) => socketOnly(`soap:${p}`),
  socket,
});

const addresses = (value: AddressObject | AddressObject[] | undefined): Array<{ name: string; address: string }> =>
  (Array.isArray(value) ? value : value ? [value] : []).flatMap((one) => one.value.map((a) => ({ name: a.name ?? '', address: a.address ?? '' })));

function failure(code: string, message: string, started: number): WireResponse {
  return { status: null, code, message: message.slice(0, 500), headers: {}, body: Buffer.alloc(0), contentType: null, durationMs: Date.now() - started };
}

/** What an IMAP server's failure means. Its response codes, where it sent one; its words otherwise. */
function codeOf(error: unknown): string {
  const e = error as { authenticationFailed?: boolean; serverResponseCode?: string; code?: string; message?: string };
  if (e?.authenticationFailed) return 'AUTHENTICATIONFAILED';
  const code = (e?.serverResponseCode ?? '').toUpperCase();
  if (code) return code;
  if (e?.code === 'ETIMEDOUT' || /timed? ?out/i.test(e?.message ?? '')) return 'TIMEOUT';
  if (/mailbox.*(not exist|doesn.t exist|unknown)|no such mailbox/i.test(e?.message ?? '')) return 'NONEXISTENT';
  return 'ERROR';
}

const FLOOR: Record<string, 'auth' | 'not_found' | 'bounds' | 'rate_limit' | 'upstream'> = {
  AUTHENTICATIONFAILED: 'auth',
  AUTHORIZATIONFAILED: 'auth',
  EXPIRED: 'auth',
  PRIVACYREQUIRED: 'auth',
  NONEXISTENT: 'not_found',
  TRYCREATE: 'not_found',
  LIMIT: 'rate_limit',
  OVERQUOTA: 'rate_limit',
  UNAVAILABLE: 'upstream',
  TIMEOUT: 'bounds',
  ERROR: 'upstream',
};

export const imap: Transport<MailWire> = {
  kind: 'imap',
  writes: false,
  answersWire: true,

  prepare({ transport, request }) {
    const t = transport as Extract<TransportV2, { kind: 'imap' }>;
    const port = Number(request.connection.port ?? 993);
    const parts = (request.parts ?? ['envelope', 'text']) as MailWire['parts'];
    return {
      kind: 'imap',
      host: str(request.connection.host),
      port,
      security: t.security ?? (port === 993 ? 'implicit' : 'starttls'),
      mailbox: str(request.mailbox, 'INBOX'),
      search: searchOf(request.search),
      parts: parts.includes('envelope') ? parts : ['envelope', ...parts],
      position: positionOf(request.body),
    };
  },

  authSurface: (_wire, socket) => surface(socket),

  async send(wire, options) {
    const started = Date.now();
    const inAgent = options.inAgent === true;
    const { socket } = options;
    if (wire.security === 'none' && !inAgent) {
      throw refusal({ message: 'An unencrypted mailbox is only reached through the Silo agent.', code: 'refusal.plaintext' });
    }
    if (socket.tls.fingerprint) {
      throw refusal({
        message: 'A mailbox is trusted by its certificate authority, not a pinned fingerprint. Give the connection the CA certificate instead.',
        code: 'refusal.tls_pin_unsupported',
      });
    }
    if (!socket.username || (!socket.password && !socket.accessToken)) {
      throw refusal({ message: 'This mailbox connection has no username and password or token.', code: 'refusal.credential_missing' });
    }

    const client = new ImapFlow({
      host: wire.host,
      port: wire.port,
      secure: wire.security === 'implicit',
      doSTARTTLS: wire.security === 'starttls' ? true : wire.security === 'none' ? false : undefined,
      servername: socket.tls.servername ?? wire.host,
      auth: socket.accessToken ? { user: socket.username, accessToken: socket.accessToken } : { user: socket.username, pass: socket.password! },
      tls: nodeTls(socket.tls, inAgent),
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: Math.max(options.timeoutMs, TIMEOUT_MS),
    });
    client.on('error', () => {});

    try {
      await client.connect();
      const box = await client.mailboxOpen(wire.mailbox, { readOnly: true });
      const validity = String(box.uidValidity);

      let below = Number.POSITIVE_INFINITY;
      if (wire.position) {
        const [was, uid] = wire.position.split(':');
        if (was !== validity) {
          throw upstream({
            message: `The mailbox ${wire.mailbox} was rebuilt while it was being read, so where Silo had got to no longer means anything. Ask again.`,
            code: 'upstream.mailbox_reset',
          });
        }
        below = Number(uid);
      }

      const found = await client.search(wire.search, { uid: true });
      const uids = (found || []).filter((uid) => uid < below).sort((a, b) => b - a);
      const bodies = wire.parts.some((p) => p !== 'envelope');
      const batch = uids.slice(0, bodies ? BATCH_WITH_BODIES : BATCH_ENVELOPES);

      const messages: Array<Record<string, unknown>> = [];
      let total = 0;
      if (batch.length > 0) {
        for await (const msg of client.fetch(batch, { uid: true, envelope: true, internalDate: true, flags: true, size: true, source: bodies }, { uid: true })) {
          total += msg.size ?? 0;
          if (total > options.maxBytes) {
            throw bounds({ message: `The messages in ${wire.mailbox} are larger than one question may read. Narrow the search.`, code: 'bounds.bytes', detail: { limit: options.maxBytes } });
          }
          const env = msg.envelope;
          const message: Record<string, unknown> = {
            uid: msg.uid,
            messageId: env?.messageId ?? null,
            subject: env?.subject ?? null,
            from: (env?.from ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' })),
            to: (env?.to ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' })),
            cc: (env?.cc ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' })),
            replyTo: (env?.replyTo ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' })),
            inReplyTo: env?.inReplyTo ?? null,
            date: env?.date ? new Date(env.date).toISOString() : null,
            received: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
            flags: [...(msg.flags ?? [])],
            size: msg.size ?? null,
          };
          if (bodies && msg.source) {
            const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
            if (wire.parts.includes('text')) message.text = parsed.text ?? null;
            if (wire.parts.includes('html')) message.html = typeof parsed.html === 'string' ? parsed.html : null;
            if (wire.parts.includes('attachments')) {
              message.attachments = parsed.attachments.map((a) => ({
                filename: a.filename ?? null,
                contentType: a.contentType,
                size: a.size,
                content: bytesOf(a.content),
              }));
            }
            if (message.from && (message.from as unknown[]).length === 0) message.from = addresses(parsed.from);
          }
          messages.push(message);
        }
        messages.sort((a, b) => Number(b.uid) - Number(a.uid));
      }

      const more = uids.length > batch.length;
      const lowest = batch.at(-1);
      return {
        status: null,
        code: null,
        message: null,
        headers: {
          'x-mailbox': wire.mailbox,
          'x-mailbox-uidvalidity': validity,
          ...(more && lowest !== undefined ? { 'x-silo-next': `${validity}:${lowest}` } : {}),
        },
        body: Buffer.from(JSON.stringify(messages)),
        contentType: WIRE_CONTENT_TYPE,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (isAppError(error)) throw error;
      return failure(codeOf(error), error instanceof Error ? error.message : String(error), started);
    } finally {
      await client.logout().catch(() => client.close());
    }
  },

  floor: (res) => (res.code === null ? null : { means: FLOOR[res.code] ?? 'upstream' }),
};
