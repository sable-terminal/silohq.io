// The delta (spec 18.2): every source of change decodes into this one shape, published by
// change-stream on bus-live, subject chg.<organisation>.<connection>.<source object>, for
// the state plane. It carries values, so it travels only on the non-persistent bus (NATS
// core) and in memory: never the durable bus, a log, a trace or Postgres (spec 18.2
// binding rule). Only fields the manifest declares for the object are carried.
//
// Structurally a LiveMessage (infra/bus.infra.ts), declared here so publisher and
// consumer share it.

import { z } from 'zod';
import { CHANGE_OPERATIONS } from '../connect/manifest.contract.ts';
import { recordValue } from '../../utils/recordValue.util.ts';

const objectName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const timestamp = z.iso.datetime({ offset: true });

export const sourceChangeSchema = z.strictObject({
  organisationId: z.uuid(),
  connectionId: z.uuid(),
  /** The connector manifest version the connection ran when the change was decoded. */
  manifestVersion: z.string().max(100),
  object: objectName,
  /** The source identifier, as the manifest's identifier fields give it. A record value. */
  entityRef: recordValue(z.string().min(1).max(512)),
  operation: z.enum(CHANGE_OPERATIONS),
  /** Only fields that changed, only fields the manifest declares: field name to value. */
  changed: recordValue(z.record(z.string().min(1).max(500), z.json())),
  /** When Silo observed the change. */
  observedAt: timestamp,
  /** When the source says it changed. */
  sourceAt: timestamp.nullable(),
  /** LSN, binlog position, event id or sequence; for ordering where the manifest orders by it. */
  sourceSeq: z.string().max(200).nullable(),
  /** How the manifest orders this object's changes (spec 18.6). */
  ordering: z.enum(['source_sequence', 'observed_at']),
  /** The source of change that produced it. */
  source: z.enum(['webhook', 'cdc', 'poll', 'email', 'mqtt', 'opcua']),
  markings: z.array(z.uuid()).max(50),
});
export type SourceChange = z.infer<typeof sourceChangeSchema>;

export const sourceChange = {
  bus: 'live',
  family: 'chg',
  name: 'source_change',
  schema: sourceChangeSchema,
} as const;
