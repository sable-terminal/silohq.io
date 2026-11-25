// The object view's read (spec 34.2, 34.3): one object, with everything known and permitted
// about it, read live from its systems now under the reader's access.
//
// An object is opened by a source reference (a system's record: its connection and the
// identifier the record has there, as Actions name targets) or by its Silo object id.
// - By reference: that system is read for the record by its identifier (pushed down where the
//   system can; otherwise within the step bound and kept by the engine), and for a type merged
//   across systems every system is read within bounds and the record's object found by the
//   entity graph.
// - By Silo id alone (a favourite, a finding): the id cannot be turned back into a record (the
//   entity graph keeps identifiers only as keyed hashes; a single-source id is a hash of its
//   identifier), so the type is read within bounds and the object found among its population.
//   A type over the bounds is refused, saying so: open the object by its reference instead.
//
// The view carries
//   markings     the banner: every marking on the type and on the properties shown (their own
//                and their source fields'). The reader holds them all, or would not see them.
//   binding      how its records are bound to it (34.3's resolution rule): a single system's
//                identifier, or the type's match key with each key's declared normalisation.
//   properties   every property the reader may see, in the generated layout's order (the
//                primary first, then as the type declares them, 34.6): the decided value
//                and its state (declared under field authority, agreed, only, disputed,
//                empty, unchecked), the system it came from, the field authority deciding it
//                with who declared it, and each system's own reading (connection, source
//                object, field, connector version, read time, its value under the reader's
//                field policy, and for a value extracted from a document the extraction's
//                method, document, location and the model's score). A disagreement shows every
//                system's value, never one chosen (34.3). A property one of whose systems did
//                not answer is partial, and says so.
//   withheld     properties hidden from the reader by a field policy, by name only ("not
//                visible to you"). A property whose existence a marking restricts is omitted
//                without statement (34.3, chapter 58).
//   references   the records it was read from, one per system.
//   links        each link type joining the type that the reader may see, by direction: how
//                many objects it reaches and the first of them with their titles, or the
//                bound that stopped it, or why it could not be followed. One link's refusal
//                never spoils the rest.
//   incomplete   systems that did not answer, each with why; the rest still shown, partial.
//   actions      each confirmed Action type targeting the type that the reader may see (34.5),
//                with its submission criteria checked against the record it writes as just
//                read: one whose criteria fail is listed disabled, naming the criterion. The
//                view never writes; submitting enters the mutation path, which checks again.
// Values are record values for the reader only, never logged, cached or stored.
// object_view_opened is recorded for each read: the object, the reader and how many properties
// were withheld, never a value (34 events).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { parameterDefinition, REVERT_BEHAVIOURS, RISK_CLASSES } from '../actions/actionType.contract.ts';
import { DATA_TYPES } from '../ontology/manifest.contract.ts';
import { refusal } from '../planner/plan.contract.ts';
import { VALUE_STATES } from '../resolution/resolve.contract.ts';
import { EXECUTOR_CALLERS, RUN_TIMEOUT_MS } from './result.contract.ts';

export const objectReference = z.union([
  z.strictObject({ objectId: z.uuid() }),
  z.strictObject({ connectionId: z.uuid(), reference: z.string().min(1).max(500) }),
]);
export type ObjectReference = z.infer<typeof objectReference>;

/** A value read from a document (68.4): how sure the reading is, and where it was read. */
export const extractionFlag = z.object({
  siloId: z.uuid(),
  extractionId: z.uuid(),
  /** near or inferred: uncertain until a person confirms it; certain once confirmed. */
  method: z.enum(['certain', 'near', 'inferred']),
  /** The document's file name. */
  document: z.string(),
  /** Page, cell or offset of the source text. */
  location: z.string(),
  /** The model's score, shown as such: never a computed figure. */
  modelScore: z.number().nullable(),
  confirmed: z.boolean(),
});

const reading = z.object({
  connectionId: z.uuid(),
  sourceObject: z.string(),
  fieldPath: z.string(),
  connectorVersion: z.string(),
  readAt: z.string(),
  /** The system's own value, under the reader's field policy (masked: the last characters only; redacted: null). */
  value: z.json(),
  /** Set where the value was extracted from a document. */
  extraction: extractionFlag.nullable(),
});

const recordReference = z.object({ connectionId: z.uuid(), sourceObject: z.string(), reference: z.string() });

const linkedObject = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  /** The linked object's title where the reader may see it; null otherwise (the type name stands in). */
  title: z.json(),
  references: z.array(recordReference),
});

export const objectView = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  /** The object type version read: what lineage records. */
  typeVersionId: z.uuid(),
  ontologyVersionId: z.uuid(),
  readAt: z.string(),
  /** The title property's shown value, where the reader may see it. */
  title: z.json(),
  markings: z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.enum(['classification', 'compartment', 'purpose']) })),
  binding: z.discriminatedUnion('kind', [
    /** A single-source type: a record is its object, by its identifier. */
    z.object({ kind: z.literal('identifier') }),
    /** A resolvable type: records with equal match keys are one object (23.1). */
    z.object({
      kind: z.literal('match_key'),
      keys: z.array(z.object({ identityId: z.uuid(), apiName: z.string(), normalisation: z.string().nullable() })),
    }),
  ]),
  references: z.array(recordReference),
  /** The record stood alone for want of a full match key. */
  unmatched: z.boolean(),
  properties: z.array(z.object({
    identityId: z.uuid(),
    apiName: z.string(),
    displayName: z.string(),
    dataType: z.enum(DATA_TYPES),
    effect: z.enum(['allow', 'mask', 'redact']),
    state: z.enum(VALUE_STATES),
    /** The decided value as shown: null when disputed, unchecked, empty or redacted. */
    value: z.json(),
    /** The system the decided value came from; null when agreed by several, or undecided. */
    from: z.uuid().nullable(),
    /** The field authority that decided it (23.4), with who declared it and why. */
    authority: z.object({
      id: z.uuid(), winningConnectionId: z.uuid(), condition: z.string().nullable(), reason: z.string(),
      declaredBy: z.uuid(), declaredAt: z.string(),
    }).nullable(),
    readings: z.array(reading),
    /** A system holding this property did not answer: what is shown may not be all there is. */
    partial: z.boolean(),
    /** A computed property (spec 21.11): computed from the object's own properties. */
    computed: z.boolean(),
  })),
  withheld: z.array(z.object({ identityId: z.uuid(), apiName: z.string(), displayName: z.string() })),
  links: z.array(z.object({
    linkTypeId: z.uuid(),
    /** forward: this type is the link's from side; reverse: its to side. */
    direction: z.enum(['forward', 'reverse']),
    /** The link's name read from this side. */
    name: z.string(),
    otherTypeId: z.uuid(),
    /** How many objects it reaches; null where it could not be followed. */
    count: z.int().nullable(),
    /** The first of them, by id. */
    objects: z.array(linkedObject),
    /** Why it was not followed, where it was not: a bound reached, a system not answering. */
    refusal: refusal.nullable(),
  })),
  incomplete: z.array(z.object({ connectionId: z.uuid(), sourceObject: z.string(), reason: z.string() })),
  /** null where the Action types could not be listed just now: the rest of the view stands. */
  actions: z.array(z.object({
    actionTypeId: z.uuid(),
    apiName: z.string(),
    displayName: z.string(),
    version: z.int(),
    riskClass: z.enum(RISK_CLASSES),
    /** Physical actuation (chapter 47): the physical effect between execution and revert cannot be undone. */
    physical: z.boolean(),
    revertBehaviour: z.enum(REVERT_BEHAVIOURS),
    /** The record it writes: the object's record in a system the type may write through; null where it has none. */
    target: z.object({ connectionId: z.uuid(), reference: z.string() }).nullable(),
    /**
     * available; criteria_failed: disabled, naming the criterion; checked_on_submit: the criteria
     * read the parameters, so they are checked when submitted; no_record: the object has no record
     * in a system the type writes through.
     */
    state: z.enum(['available', 'criteria_failed', 'checked_on_submit', 'no_record']),
    criterion: z.string().nullable(),
    /** The parameter form's declarations (34.5: typed inputs, object pickers, defaults). */
    parameters: z.array(parameterDefinition),
  })).nullable(),
});
export type ObjectView = z.infer<typeof objectView>;

export const readObjectView = defineContract({
  service: 'executor', name: 'readObjectView', method: 'POST', path: '/v1/object-views',
  callers: ['gateway', ...EXECUTOR_CALLERS],
  // A read changes nothing but the audit record of the opening.
  // Read within the executor's wall-time bound.
  timeoutMs: RUN_TIMEOUT_MS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    object: objectReference,
    purposeSessionIds: z.array(z.uuid()).max(16).optional(),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('object'), view: objectView }),
    /** No such object, or none the reader may see: one answer, so existence is never disclosed. */
    z.object({ outcome: z.literal('not_found') }),
    z.object({ outcome: z.literal('refusal'), refusal }),
  ]),
  maxBodyBytes: 4096,
});
