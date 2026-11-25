// The Warehouse as a planner source (spec 69.6; decision 2026-11-14): its coverage, and its
// answers as of an instant, rebuilt from its history table. Read in the reader's own request:
// warehouse-schema checks the same gates the Object Index does (type and properties visible
// in full, connections reached, every marking on what the Warehouse holds satisfied).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const WAREHOUSE_DECLINE_REASONS = ['not_held', 'withheld', 'no_access', 'before_history', 'bounded'] as const;

const instant = z.string();

const filters = z.array(z.strictObject({
  property: z.uuid(), op: z.enum(['eq', 'neq', 'in', 'lt', 'lte', 'gt', 'gte', 'is_null', 'not_null']),
  value: z.union([z.string().max(1000), z.number(), z.boolean(), z.array(z.union([z.string().max(1000), z.number()])).max(1000)]).optional(),
})).max(50);

/** The types the organisation's active Warehouse holds: the properties held, its watermark and how far back its history goes. */
export const warehouseCoverage = defineContract({
  // buildProgram runs in the planner (explaining) and the executor (running).
  service: 'warehouse-schema', name: 'warehouseCoverage', method: 'POST', path: '/v1/warehouse-coverage', callers: ['planner', 'executor'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectTypeIds: z.array(z.uuid()).min(1).max(100), linkTypeIds: z.array(z.uuid()).max(20).optional() }),
  response: z.object({
    types: z.array(z.object({ objectTypeId: z.uuid(), held: z.array(z.uuid()), watermark: instant, historyFrom: instant, rowCount: z.int().min(0) })),
    /** The link types asked about that the Warehouse holds a table of (69.14), with when it was last written. */
    links: z.array(z.object({ linkTypeId: z.uuid(), watermark: instant })).optional(),
  }),
});

/**
 * The executor's read of one type as it stood at an instant (69.6): the objects first observed
 * by then, each property as it was, filtered in the engine over a bounded read. Declined (and
 * why) where the Warehouse does not hold it, the reader may not see it, or its history does
 * not reach back that far; an as-of question then has no other source and is refused.
 */
export const readWarehouseAsOf = defineContract({
  service: 'warehouse-schema', name: 'readWarehouseAsOf', method: 'POST', path: '/v1/warehouse-as-of-reads', callers: ['executor'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    properties: z.array(z.uuid()).min(1).max(200),
    filters,
    asOf: z.iso.datetime({ offset: true }),
    limit: z.int().min(1).max(100_000),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('read'), asOf: instant, watermark: instant,
      rows: z.array(z.object({ objectId: z.uuid(), values: z.record(z.string(), z.json()), disputed: z.array(z.string()) })),
    }),
    z.object({ outcome: z.literal('declined'), reason: z.enum(WAREHOUSE_DECLINE_REASONS) }),
  ]),
});

/**
 * The executor's history read (69.16): every change, in a half-open period, to these
 * properties of these objects, from the Warehouse's history table, oldest first. Declined
 * where the Warehouse does not hold them, the reader may not see them, its history starts
 * after the period does, or the changes pass the bound; a history question is then refused.
 */
export const readWarehouseHistory = defineContract({
  service: 'warehouse-schema', name: 'readWarehouseHistory', method: 'POST', path: '/v1/warehouse-history-reads', callers: ['executor'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    properties: z.array(z.uuid()).min(1).max(200),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    objectIds: z.array(z.uuid()).max(100_000),
    limit: z.int().min(1).max(100_000),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('read'), watermark: instant,
      changes: z.array(z.object({ objectId: z.uuid(), property: z.string(), at: instant, previous: z.json(), value: z.json() })),
    }),
    z.object({ outcome: z.literal('declined'), reason: z.enum(WAREHOUSE_DECLINE_REASONS) }),
  ]),
});

/**
 * The executor's large aggregate over current state (69.6): computed in the Warehouse with the
 * engine's rules for disputes, as of its watermark. Declined where the Warehouse does not hold
 * it, the reader may not see it, or the groups pass the bound; the sources are then read.
 */
export const aggregateWarehouse = defineContract({
  service: 'warehouse-schema', name: 'aggregateWarehouse', method: 'POST', path: '/v1/warehouse-aggregates', callers: ['executor'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    groupBy: z.array(z.uuid()).max(5),
    measures: z.array(z.strictObject({
      as: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), fn: z.enum(['count', 'count_distinct', 'sum', 'avg', 'min', 'max']), property: z.uuid().optional(),
      /** 1: over the linked type, across the hop (D116); each linked object once per group. */
      node: z.union([z.literal(0), z.literal(1)]).default(0),
    })).min(1).max(20),
    filters,
    limit: z.int().min(1).max(100_000),
    /** Across one link (D116): the link type, the type at its other end, and whether the root is the link's to side. */
    hop: z.strictObject({ linkTypeId: z.uuid(), objectTypeId: z.uuid(), reverse: z.boolean() }).optional(),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('read'), watermark: instant, population: z.int().min(0), excludedByDispute: z.int().min(0),
      groups: z.array(z.object({
        key: z.record(z.string(), z.json()), objects: z.int().min(0),
        measures: z.record(z.string(), z.number().nullable()), excluded: z.record(z.string(), z.int().min(0)),
      })),
      values: z.record(z.string(), z.int().min(0)), disputed: z.record(z.string(), z.int().min(0)),
    }),
    z.object({ outcome: z.literal('declined'), reason: z.enum(WAREHOUSE_DECLINE_REASONS) }),
  ]),
});
