// Connections in words (spec 14.7, 17, 18): the same everywhere a status, a test or a change is
// shown, so a person reads one vocabulary across the list, the page and the notifications.

import type { Output } from '../../api/client.api.ts';
import type { Tone } from '../../components/badge.component.tsx';

export type Connection = Output<'getConnection'>;
export type ConnectionStatus = Connection['status'];
export type Move = 'probe' | 'confirm' | 'activate' | 'halt' | 'resume' | 'revoke';

export const STATUS: Record<ConnectionStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  probing: { label: 'Being tested', tone: 'info' },
  verified: { label: 'Tested', tone: 'info' },
  active: { label: 'Active', tone: 'ok' },
  halted: { label: 'Halted', tone: 'warn' },
  revoked: { label: 'Revoked', tone: 'danger' },
};

/** What a person does next from each status, and the move that does it. */
export const NEXT: Record<ConnectionStatus, { move: Exclude<Move, 'revoke'>; label: string; hint: string } | undefined> = {
  draft: { move: 'probe', label: 'Test it', hint: 'Fill in its settings and credentials, then test it: Silo reads a little from each object to check it works.' },
  probing: { move: 'confirm', label: 'Confirm it', hint: 'Its tests run against the system. Someone who may verify connectors confirms it once they pass.' },
  verified: { move: 'activate', label: 'Activate', hint: 'It passed its tests. Activating it lets people query it.' },
  active: { move: 'halt', label: 'Halt', hint: 'It answers queries. Halting it stops every read and write until it is resumed.' },
  halted: { move: 'resume', label: 'Resume', hint: 'It serves nothing until it is resumed.' },
  revoked: undefined,
};

export type TestClass = Output<'getConformanceRun'>['tests'][number]['class'];

export const TEST_CLASS: Record<TestClass, string> = {
  read: 'Reading',
  pagination: 'Paging',
  filter_pushdown: 'Filtering at the source',
  error: 'Errors',
  change_stream: 'Change stream',
  write_verify_undo: 'Write, verify and undo',
};

export const TRIGGER: Record<Output<'getConformanceRun'>['trigger'], string> = {
  build: 'When it was built',
  manual: 'Run by a person',
  release: 'On a new connector version',
  self_heal: 'After the source refused a request',
  weekly: 'Weekly',
};

type HealChange = Output<'getHealProposal'>['changes'][number];

/** A proposed repair, in a sentence. */
export function describeChange(c: HealChange): string {
  switch (c.op) {
    case 'rename_field': return `${c.object}.${c.field} is read from ${c.toPath} instead of ${c.fromPath}`;
    case 'widen_type': return `${c.object}.${c.field} widens from ${c.from} to ${c.to}`;
    case 'add_field': return `${c.object} gains ${c.field} (${c.type})`;
    case 'remove_filter': return `${c.object}.${c.field} is no longer filtered at the source (${c.ops.join(', ')})`;
    case 'remove_sort': return `${c.object}.${c.field} is no longer sorted at the source`;
    case 'remove_aggregate': return `${c.object} no longer computes ${c.function} at the source`;
  }
}

export const DISPOSITION: Record<Output<'getHealProposal'>['disposition'], { label: string; tone: Tone }> = {
  awaiting_review: { label: 'Waiting for review', tone: 'warn' },
  applied: { label: 'Applied', tone: 'ok' },
  auto_applied: { label: 'Applied automatically', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  halted: { label: 'Halted the connection', tone: 'danger' },
};

export const CHANGE_KIND: Record<Output<'getHealProposal'>['changeKind'], string> = {
  new_field: 'A new field',
  object_removed: 'An object was removed',
  pushdown_lost: 'The source stopped filtering',
  rename: 'A field was renamed',
  semantic: 'A field changed meaning',
  type_changed: 'A field changed type',
};

type StreamObject = Output<'readStream'>['objects'][number];

export const STREAM_STATE: Record<StreamObject['status'], { label: string; tone: Tone }> = {
  live: { label: 'Live', tone: 'ok' },
  delayed: { label: 'Delayed', tone: 'warn' },
  stale: { label: 'Stale', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  not_streamed: { label: 'Read when asked', tone: 'neutral' },
};

export const SOURCE: Record<StreamObject['inUse'], string> = {
  cdc: 'change data capture',
  email: 'forwarded email',
  mqtt: 'MQTT',
  opcua: 'OPC UA',
  poll: 'polling',
  webhook: 'webhook',
  none: 'nothing',
};

export const STREAM_TEST: Record<StreamObject['failedTests'][number], string> = {
  delta: 'an edit produced a change',
  ordered: 'changes arrived in order',
  deduplicated: 'a repeat was discarded',
  resumable: 'it resumed from where it was',
  deletes: 'a delete was seen',
  signature: 'an unsigned delivery was refused',
};

/** How an object stays current, never calling a polled object live (decision 2026-11-15). */
export function currency(o: StreamObject): string {
  if (o.mode === 'live') return `Live, by ${SOURCE[o.inUse]}`;
  if (o.mode === 'polled') return o.refreshEverySeconds === null ? 'Polled (not live)' : `Polled every ${Math.max(1, Math.round(o.refreshEverySeconds / 60))} min (not live)`;
  return 'Read when asked';
}

export const GAP: Record<NonNullable<NonNullable<Output<'readStream'>['capture']>['lastGap']>['reason'], string> = {
  resumed_ahead: 'the reader resumed past changes it had not read',
  spool_age: 'changes waited too long on the agent',
  spool_bound: 'the agent\'s store of changes filled up',
  spool_damaged: 'the agent\'s store of changes was damaged',
};

export const CAPTURE_METHOD: Record<NonNullable<Output<'readStream'>['capture']>['method'], string> = {
  binlog: 'MySQL binary log',
  change_tracking: 'SQL Server change tracking',
  logical_replication: 'Postgres logical replication',
  mqtt: 'MQTT subscription',
  opcua: 'OPC UA subscription',
};

/** A slot name Silo proposes from the connection's name: lower case, digits and underscores, at most 63. */
export function proposedSlot(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `silo_${base === '' ? 'capture' : base}`.slice(0, 63).replace(/_+$/, '');
}
