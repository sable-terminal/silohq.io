// The AI builder's email fallback (spec 14.4, 16.1): a draft from sample notifications of a
// system with no API. Deterministic and in the cell, never a model: a notification holds
// record values, and spec 62.5 allows no carve-out but Siloes Import extraction, so nothing of
// a sample reaches a model, and nothing of one is kept. What is recorded are counts.
//
// - Samples are read as notifications (a forwarded one as the message it carries); their
//   senders become the connector's senders.
// - Samples are grouped by their subject's shape (digits and #references set aside). Each
//   group becomes a rule: its condition the longest run of words every subject in the group
//   shares; its fields the "Label: value" lines most of its samples carry, typed from what
//   they hold (a common unit closing a number, as "kg", ends the field there).
// - The record's identifier is the #reference every subject carries, else a label naming an
//   identifier (ID, reference, number) every sample carries. A group with neither is left out
//   and named; with no group left, the draft is refused.
// - The rules are tried on the samples: a field extracted from fewer than half of its group's
//   samples is left out. Deletions (a cancellation) are the person's to declare.

import type { FieldType, ManifestInput } from '../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { parseMessage, type MailMessage } from '../../utils/mime.util.ts';
import { extractNotification } from '../change-stream/emailRules.service.ts';
import { toName } from '../schema-inference/infer.service.ts';

const VERSION = '0.1.0';
const MAX_GROUPS = 10;
const MAX_FIELDS = 60;
const LABEL_LINE = /^\s*([A-Za-z][A-Za-z0-9 ./()&'-]{0,40}?)\s*:\s+(\S.*?)\s*$/;
const REFERENCE = /(\S+\s)?#\s?([A-Za-z0-9][A-Za-z0-9-]*)/;
const IDENTIFIER_LABEL = /\b(id|ref|reference|number|no)\b\.?/i;

export interface EmailDraftCounts {
  samples: number;
  matched: number;
  rules: number;
  fields: { field: string; extracted: number; of: number }[];
}

const shapeOf = (subject: string) => subject.replace(/^((re|fw|fwd):\s*)+/i, '').replace(/#\s?[A-Za-z0-9-]+/g, '#').replace(/\d+([.,:/-]\d+)*/g, '0').trim().toLowerCase();

/** The longest run of words, none holding a digit, that every subject holds. */
function sharedWords(subjects: readonly string[]): string | undefined {
  const words = subjects[0]!.replace(/^((re|fw|fwd):\s*)+/i, '').split(/\s+/).filter((w) => w !== '');
  let best: string | undefined;
  for (let i = 0; i < words.length; i++) {
    for (let j = words.length; j > i; j--) {
      const run = words.slice(i, j);
      if (run.some((w) => /\d|#/.test(w))) continue;
      const text = run.join(' ');
      if (text.length < 4 || (best !== undefined && text.length <= best.length)) continue;
      if (subjects.every((s) => s.toLowerCase().includes(text.toLowerCase()))) best = text;
    }
  }
  return best?.slice(0, 200);
}

/** A type for what a label holds in every sample, and a unit that closes a number. */
function typeOf(values: readonly string[]): { type: FieldType; until: string } {
  const unit = /^-?[\d,]*\.?\d+\s*([A-Za-z%]{1,5})$/;
  const units = values.map((v) => unit.exec(v)?.[1]);
  if (units.every((u) => u !== undefined && u === units[0])) {
    const numbers = values.map((v) => v.replace(units[0]!, '').replace(/,/g, '').trim());
    return { type: numbers.every((n) => /^-?\d+$/.test(n)) ? 'integer' : 'number', until: units[0]! };
  }
  const plain = values.map((v) => v.replace(/[,£$€]/g, '').trim());
  if (plain.every((v) => /^-?\d+$/.test(v))) return { type: 'integer', until: 'line' };
  if (plain.every((v) => /^-?\d*\.\d+$|^-?\d+$/.test(v))) return { type: 'number', until: 'line' };
  if (values.every((v) => /^(yes|no|true|false)$/i.test(v))) return { type: 'boolean', until: 'line' };
  if (values.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return { type: 'date', until: 'line' };
  if (values.every((v) => !Number.isNaN(Date.parse(v)) && /\d{1,2}:\d{2}/.test(v))) return { type: 'date-time', until: 'line' };
  return { type: 'string', until: 'line' };
}

export function draftFromNotifications(samples: readonly string[], identity: { name: string; provider: string })
  : { document: ManifestInput; notes: string[]; counts: EmailDraftCounts } {
  const messages: MailMessage[] = samples.map((s) => parseMessage(s)).map((m) => m.forwarded ?? m).filter((m) => m.from !== '');
  if (messages.length === 0) throw new AppError('validation', 'no sample is a message with a sender', { code: 'build.email_no_samples' });
  const notes: string[] = ['deletions_not_described'];
  const senders = [...new Set(messages.map((m) => m.from))].slice(0, 20);
  const groups = new Map<string, MailMessage[]>();
  for (const m of messages) groups.set(shapeOf(m.subject), [...(groups.get(shapeOf(m.subject)) ?? []), m]);
  if (groups.size > MAX_GROUPS) notes.push(`subject_shapes_beyond_${MAX_GROUPS}_left_out`);

  const objectName = toName(identity.name).slice(0, 63) || 'notifications';
  const fields = new Map<string, { name: string; type: FieldType }>();
  const rules: { object: string; when: { on: 'subject' | 'from'; contains: string }[]; fields: { field: string; on: 'subject' | 'body'; after: string; until: string }[]; op: 'upsert' }[] = [];
  let identifier: string | undefined;
  const addField = (name: string, type: FieldType) => {
    const existing = fields.get(name);
    if (existing === undefined && fields.size < MAX_FIELDS) fields.set(name, { name, type });
    else if (existing !== undefined && existing.type !== type) existing.type = 'string';
  };

  [...groups.entries()].slice(0, MAX_GROUPS).forEach(([shape, group], g) => {
    const subjects = group.map((m) => m.subject);
    const contains = sharedWords(subjects);
    const when = contains !== undefined ? [{ on: 'subject' as const, contains }] : new Set(group.map((m) => m.from)).size === 1 ? [{ on: 'from' as const, contains: group[0]!.from }] : [];
    if (when.length === 0) { notes.push(`group_${g + 1}_has_no_shared_subject`); return; }
    const ruleFields: (typeof rules)[number]['fields'] = [];
    // The identifier: a #reference in every subject, after the word before it.
    const refs = subjects.map((s) => REFERENCE.exec(s));
    let groupId: string | undefined;
    if (refs.every((r) => r !== null) && new Set(refs.map((r) => `${r![1] ?? ''}#`)).size === 1) {
      groupId = 'reference';
      ruleFields.push({ field: groupId, on: 'subject', after: `${refs[0]![1] ?? ''}#`.trimStart(), until: 'word' });
      addField(groupId, 'string');
    }
    // Labelled lines most of the group's samples carry.
    const labels = new Map<string, { label: string; values: string[] }>();
    for (const m of group) {
      const seen = new Set<string>();
      for (const line of m.text.split('\n')) {
        const found = LABEL_LINE.exec(line);
        if (found === null) continue;
        const key = found[1]!.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = labels.get(key) ?? { label: found[1]!, values: [] };
        entry.values.push(found[2]!);
        labels.set(key, entry);
      }
    }
    for (const { label, values } of labels.values()) {
      if (values.length * 2 < group.length) continue;
      const name = toName(label).slice(0, 63);
      if (name === '' || ruleFields.some((f) => f.field === name)) continue;
      const { type, until } = typeOf(values);
      ruleFields.push({ field: name, on: 'body', after: `${label}:`, until });
      addField(name, type);
      if (groupId === undefined && values.length === group.length && IDENTIFIER_LABEL.test(label)) groupId = name;
    }
    if (groupId === undefined) { notes.push(`group_${g + 1}_has_no_identifier`); return; }
    if (identifier !== undefined && identifier !== groupId) { notes.push(`group_${g + 1}_identifies_records_differently`); return; }
    identifier = groupId;
    rules.push({ object: objectName, when, fields: ruleFields, op: 'upsert' });
    void shape;
  });
  if (rules.length === 0 || identifier === undefined) {
    throw new AppError('validation', 'no notification names its record (a #reference in the subject, or an ID line): declare the rules in the visual builder', {
      code: 'build.email_no_identifier', details: { notes: notes.join(';').slice(0, 300) },
    });
  }

  // Tried on the samples: a field seldom extracted is left out.
  const block = { senders, rules };
  const objects = [{ name: objectName, identifier: [identifier], fields: [...fields.values()].map((f) => ({ ...f, nullable: f.name !== identifier, provenance: 'observed' as const })) }];
  const extracted = new Map<string, number>();
  let matched = 0;
  for (const m of messages) {
    const out = extractNotification(block as never, objects as never, m);
    if (!('draft' in out)) continue;
    matched += 1;
    for (const f of Object.keys(out.draft.changed ?? {})) extracted.set(f, (extracted.get(f) ?? 0) + 1);
  }
  const kept = [...fields.values()].filter((f) => f.name === identifier || (extracted.get(f.name) ?? 0) * 2 >= matched);
  const keptNames = new Set(kept.map((f) => f.name));
  for (const f of fields.values()) if (!keptNames.has(f.name)) notes.push(`${f.name}_seldom_extracted`);
  const finalRules = rules.map((r) => ({ ...r, fields: r.fields.filter((f) => keptNames.has(f.field)) }));
  return {
    document: {
      schemaVersion: '1', identity: { ...identity, version: VERSION }, transport: { viaAgent: false }, protocol: { kind: 'email' },
      auth: { strategy: 'none', fields: [] },
      objects: [{ name: objectName, identifier: [identifier], fields: kept.map((f) => ({ name: f.name, type: f.type, nullable: f.name !== identifier, provenance: 'observed' })), source: { kind: 'email' } }],
      changeStream: { email: { senders, rules: finalRules }, objects: [{ object: objectName, sources: [{ kind: 'email' }] }] },
    } as ManifestInput,
    notes,
    counts: { samples: messages.length, matched, rules: finalRules.length, fields: kept.map((f) => ({ field: f.name, extracted: extracted.get(f.name) ?? 0, of: matched })) },
  };
}
