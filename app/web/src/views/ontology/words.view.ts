// The ontology in words (spec 21, 25): kinds, statuses, change classes and data types, the same on
// every Ontology page, in proposals and in notifications.

import type { Output } from '../../api/client.api.ts';
import type { Tone } from '../../components/badge.component.tsx';

export type Manifest = Output<'readOntology'>;
export type ObjectType = Manifest['objectTypes'][number];
export type LinkType = Manifest['linkTypes'][number];
export type ElementKind = 'object_type' | 'link_type' | 'shared_property' | 'interface' | 'function';
export type DataType = ObjectType['properties'][number]['dataType'];
export type ChangeClass = 'additive' | 'compatible' | 'breaking';
export type Proposal = Output<'readOntologyProposal'>;
export type Branch = Output<'readOntologyBranch'>;

export const KIND: Record<ElementKind, { one: string; many: string }> = {
  object_type: { one: 'Object type', many: 'Object types' },
  link_type: { one: 'Link type', many: 'Link types' },
  shared_property: { one: 'Shared property', many: 'Shared properties' },
  interface: { one: 'Interface', many: 'Interfaces' },
  function: { one: 'Function', many: 'Functions' },
};

export const ELEMENT_STATUS: Record<'active' | 'deprecated' | 'proposed' | 'retired', { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' },
  deprecated: { label: 'Deprecated', tone: 'warn' },
  proposed: { label: 'Proposed', tone: 'info' },
  retired: { label: 'Retired', tone: 'neutral' },
};

export const CHANGE_CLASS: Record<ChangeClass, { label: string; hint: string; tone: Tone }> = {
  additive: { label: 'Adds only', hint: 'Nothing that exists changes.', tone: 'ok' },
  compatible: { label: 'Compatible', hint: 'Results may differ for what depends on it.', tone: 'warn' },
  breaking: { label: 'Breaking', hint: 'Some dependants will fail; merging also needs ontology.manage.', tone: 'danger' },
};

export const PROPOSAL_STATUS: Record<Proposal['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  in_review: { label: 'In review', tone: 'info' },
  approved: { label: 'Approved: ready to merge', tone: 'ok' },
  merged: { label: 'Merged', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

export const ORIGIN: Record<Proposal['origin'], string> = { person: 'A person', derivation: 'Derivation', ai_fde: 'The AI FDE', rollback: 'A rollback' };

export const OPERATION: Record<'create' | 'change' | 'retire', string> = { create: 'New', change: 'Changed', retire: 'Retired' };

export const DATA_TYPES: readonly DataType[] = ['string', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'duration', 'money', 'enum', 'geopoint', 'geoshape', 'array', 'struct'];

export const DATA_TYPE: Record<DataType, string> = {
  string: 'Text', integer: 'Whole number', decimal: 'Decimal', boolean: 'Yes or no', date: 'Date', timestamp: 'Date and time', duration: 'Duration',
  money: 'Money', enum: 'One of a list', geopoint: 'Point on a map', geoshape: 'Area on a map', array: 'List', struct: 'Structure',
};

export const CARDINALITY: Record<LinkType['cardinality'], string> = { one_to_one: 'One to one', one_to_many: 'One to many', many_to_many: 'Many to many' };

export const EVIDENCE: Record<'schema' | 'declared_fk' | 'naming' | 'template' | 'profile' | 'overlap', string> = {
  schema: 'the declared schema', declared_fk: 'a declared foreign key', naming: 'naming', template: 'a concept template', profile: 'field profiles', overlap: 'value overlap',
};

export const EFFECT: Record<'unaffected' | 'results_may_differ' | 'will_fail', { label: string; tone: Tone }> = {
  unaffected: { label: 'Unaffected', tone: 'ok' }, results_may_differ: { label: 'Results may differ', tone: 'warn' }, will_fail: { label: 'Will fail', tone: 'danger' },
};

/** At or above this, a derivation's decision is a skimmable line (22.5: confident decisions collapse). */
export const CONFIDENT = 0.85;

/** An API name from words: lower case, digits and underscores, starting with a letter. */
export function apiNameOf(words: string): string {
  const base = words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(base) ? base.slice(0, 63) : `x_${base}`.slice(0, 63);
}
