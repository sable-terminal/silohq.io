// Email fallback's extraction (spec 14.4): a notification a system with no API sent, read by
// the rules its connector declares. Pure, deterministic and bounded: a rule matches when every
// condition's text is in the sender, subject or text (ignoring case); a field is the text after
// its label, to the end of the line, the next word, or a closing text. No regular expression a
// person or a model wrote ever runs, so a message cannot make extraction slow.
//
// A message is taken only from a declared sender (an address, or @domain); a forwarded one is
// read as the notification it carries. Unmatched, from another sender, or without its record's
// identifier, it is set aside and counted; it changes nothing.

import type { ChangeEmailBlock, FieldType, ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import type { MailMessage } from '../../utils/mime.util.ts';
import type { ChangeDeltaDraft } from '../expression-evaluator/evaluator.service.ts';

export type SetAside = 'sender' | 'no_rule' | 'identifier_missing';

const lower = (s: string) => s.toLocaleLowerCase('en-GB');

export function senderAllowed(senders: readonly string[], from: string): boolean {
  const address = lower(from);
  return address !== '' && senders.some((s) => (s.startsWith('@') ? address.endsWith(lower(s)) : address === lower(s)));
}

/** The text after a label: to the line's end, the next word, or a closing text (or the line's end without one). */
export function after(text: string, label: string, until: string): string | undefined {
  const at = lower(text).indexOf(lower(label));
  if (at === -1) return undefined;
  let rest = text.slice(at + label.length).replace(/^[ \t]+/, '');
  const lineEnd = rest.indexOf('\n');
  const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
  if (until === 'line') rest = line;
  else if (until === 'word') rest = /^\S*/.exec(line)![0];
  else {
    const close = lower(line).indexOf(lower(until));
    rest = close === -1 ? line : line.slice(0, close);
  }
  const value = rest.trim();
  return value === '' ? undefined : value.slice(0, 2_000);
}

/** A field's text as its declared type; text that does not read as the type stays text for the field to refuse. */
export function typed(text: string, type: FieldType): unknown {
  switch (type) {
    case 'integer': {
      const n = Number(text.replace(/[,\s£$€]/g, ''));
      return Number.isInteger(n) ? n : text;
    }
    case 'number': {
      const n = Number(text.replace(/[,\s£$€]/g, ''));
      return Number.isFinite(n) ? n : text;
    }
    case 'boolean': return /^(yes|true|y|1)$/i.test(text) ? true : /^(no|false|n|0)$/i.test(text) ? false : text;
    case 'date': {
      const d = new Date(text);
      return Number.isNaN(d.getTime()) ? text : d.toISOString().slice(0, 10);
    }
    case 'date-time': {
      const d = new Date(text);
      return Number.isNaN(d.getTime()) ? text : d.toISOString();
    }
    default: return text;
  }
}

export function extractNotification(block: ChangeEmailBlock, objects: readonly ManifestObject[], received: MailMessage)
  : { draft: ChangeDeltaDraft; rule: number } | { setAside: SetAside } {
  const message = received.forwarded ?? received;
  if (!senderAllowed(block.senders, message.from)) return { setAside: 'sender' };
  const where = { from: message.from, subject: message.subject, body: message.text };
  const index = block.rules.findIndex((r) => r.when.every((c) => lower(where[c.on]).includes(lower(c.contains))));
  if (index === -1) return { setAside: 'no_rule' };
  const rule = block.rules[index]!;
  const object = objects.find((o) => o.name === rule.object)!;
  const values: Record<string, unknown> = {};
  for (const f of rule.fields) {
    const text = after(f.on === 'subject' ? message.subject : message.text, f.after, f.until);
    if (text === undefined) continue;
    const field = object.fields.find((x) => x.name === f.field)!;
    values[f.field] = typed(text, field.type);
  }
  const keys = object.identifier.map((id) => values[id]);
  if (keys.some((k) => k === undefined || k === null || k === '')) return { setAside: 'identifier_missing' };
  const entityRef = keys.length === 1 ? String(keys[0]) : JSON.stringify(Object.fromEntries(object.identifier.map((id, i) => [id, keys[i]])));
  return {
    rule: index,
    draft: {
      object: object.name, entityRef, operation: rule.op === 'delete' ? 'delete' : 'update', ...(rule.op === 'delete' ? {} : { changed: values as Record<string, string | number | boolean> }),
      ...(message.date === undefined ? {} : { sourceAt: message.date }),
      // A repeat delivery (a rule forwarding twice) carries the same Message-ID: the stream drops it.
      ...(message.messageId === undefined ? {} : { sourceSeq: message.messageId }),
    },
  };
}
