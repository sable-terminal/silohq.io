// Siloes in words (Part X): the same everywhere a Silo, its state or a purge is shown.

import type { Output } from '../../api/client.api.ts';
import type { Tone } from '../../components/badge.component.tsx';
import { formatBytes } from '../../utils/format.util.ts';

export type Silo = Output<'listSiloes'>['siloes'][number];
export type SiloKind = Silo['kind'];
export type Purge = Output<'getPurge'>;

export const KIND: Record<SiloKind, { label: string; what: string; href: string }> = {
  capture: { label: 'Capture', what: 'keeps the history of chosen properties', href: '/siloes/capture/' },
  import: { label: 'Import', what: 'holds uploaded files and what was read from them', href: '/siloes/import/' },
  object_index: { label: 'Object Index', what: 'keeps a searchable copy of chosen properties', href: '/siloes/index/' },
  warehouse: { label: 'Warehouse', what: 'keeps a BigQuery copy for analysis', href: '/siloes/warehouse/' },
};

export const STATUS: Record<Silo['status'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' }, provisioning: { label: 'Being set up', tone: 'info' }, purging: { label: 'Being wiped', tone: 'warn' }, disabled: { label: 'Off', tone: 'neutral' },
};

export const PURGE_STATUS: Record<Purge['status'], { label: string; tone: Tone }> = {
  awaiting_approval: { label: 'Waiting for approval', tone: 'warn' }, approved: { label: 'Approved', tone: 'info' }, running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'ok' }, failed: { label: 'Failed', tone: 'danger' }, rejected: { label: 'Rejected', tone: 'neutral' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const PURGE_SCOPE: Record<Purge['scope'], string> = {
  silo: 'Everything it holds', index: 'Index entries', concept: 'Everything about a type', entity: 'One object', file: 'One file', object: 'One definition object',
};

/** A size the cell states as a decimal string of bytes. */
export const bytesOf = (b: string | null | undefined): string => (b === null || b === undefined ? '—' : formatBytes(Number(b)));
