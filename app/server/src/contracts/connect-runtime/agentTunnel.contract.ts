// The agent tunnel (spec 10.2): "one long-lived HTTP/2 connection carrying work from the cell
// as multiplexed streams". The agent opens it to agent.<cell> with its client certificate;
// the cell never connects inward. The Go agent (agent/) speaks the same frames.
//
//   POST /v1/tunnel        held open. The request body carries the agent's frames up
//                          (heartbeats, every 10 seconds); the response body carries the
//                          cell's frames down (work, and close).
//   POST /v1/work/:workId  one per piece of work, opened by the agent that was given it; its
//                          body carries the result frames up, in order, ending with done or
//                          error. Its own stream, so a large result has its own flow control.
//   POST /v1/cdc/:slotId   one per change capture the cell leased to the agent (cdc.start),
//                          held open while it reads: its body carries the captured changes
//                          up, a transaction at a time; the cell acknowledges each position
//                          down the tunnel (cdc.ack) once it has taken it in (spec 10.3, 10.4).
//
// Frames are newline-delimited JSON, one object per line, at most MAX_FRAME_BYTES each.

import { z } from 'zod';
import { semver } from '../fleet-control/release.contract.ts';
import { recordValue } from '../../utils/recordValue.util.ts';
import { GRANT_REFUSALS } from '../actions/grant.contract.ts';
import { scanEnd, scanFinding, scanProbe } from '../discovery/scan.contract.ts';

export const TUNNEL_PATH = '/v1/tunnel';
export const WORK_PATH_PREFIX = '/v1/work/';
export const CDC_PATH_PREFIX = '/v1/cdc/';
/** Spec 10.7: an agent runs at most 16 change capture readers. */
export const MAX_CDC_READERS = 16;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Agent to cell, on the tunnel. */
export const heartbeatFrame = z.strictObject({
  type: z.literal('heartbeat'),
  version: semver,
  activeCalls: z.int().min(0).max(10_000),
  cdcReaders: z.int().min(0).max(1_000),
  /** Local configuration has switched discovery off (spec 10.5), whatever the cell authorises. */
  discoveryDisabled: z.boolean(),
  /** The slots the agent reads, which it goes on reading while its tunnel is down (spec 10.6). */
  cdcSlots: z.array(z.uuid()).max(16).optional(),
  /** Spools holding what only they have: records the source let go of, or gap records. */
  cdcSpooled: z.array(z.uuid()).max(64).optional(),
  /** The signed actuation allow-lists held, by connection and digest (spec 47.4). */
  allowlists: z.array(z.strictObject({ connectionId: z.uuid(), digest: z.string().regex(/^[0-9a-f]{64}$/) })).max(1_000).optional(),
});
export type HeartbeatFrame = z.infer<typeof heartbeatFrame>;

export const WORK_KINDS = ['ping', 'sql.read', 'sql.transaction', 'discovery.scan', 'http.send', 'mqtt.snapshot', 'opcua.read', 'opcua.probe', 'opcua.write', 'opcua.call', 'mqtt.publish', 'files.list', 'files.read', 'sftp.list', 'sftp.read'] as const;

/**
 * Why an agent did not take the login the cell sealed for a piece of work (spec 10.7): it has no
 * key to open it, it does not open as sealed for this agent, connection and work, it has
 * expired, or it names a system the host's owner does not let the cell send the agent to.
 */
export const LOGIN_REFUSALS = ['no_key', 'sealing', 'expired', 'target'] as const;
/**
 * Why an industrial server refused (source_refused): the login; the application certificate,
 * which it does not trust; its own certificate, not the one pinned; or the security asked for,
 * which it does not offer.
 */
/** Why a source refused the agent: its login, an untrusted or mismatched certificate, its policy; a file share's missing path or denied read. */
export const SOURCE_REFUSALS = ['login', 'untrusted', 'server_certificate', 'policy', 'not_found', 'permission'] as const;
/**
 * Why an agent refused a physical webhook (actuation_refused, 47.4, 47.5): its action is not in
 * the agent's signed allow-list, is listed as something other than a command, was sent within
 * its entry's interval, or the connection's physical writes a minute are spent.
 */
export const ACTUATION_REFUSALS = ['not_listed', 'kind', 'interval', 'rate'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Cell to agent, on the tunnel. */
export const workFrame = z.strictObject({
  type: z.literal('work'),
  id: z.uuid(),
  kind: z.enum(WORK_KINDS),
  /** The agent stops and reports a timeout at this moment. */
  deadline: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
});
export const closeFrame = z.strictObject({
  type: z.literal('close'),
  /** Why the cell is ending the tunnel: revoked, certificate_expired, replaced, shutting_down. */
  reason: z.enum(['revoked', 'certificate_expired', 'replaced', 'shutting_down']),
});

/** Where a captured source's log stands: an LSN, a binlog file and offset, a change version. Never a record value. */
export const logPosition = z.string().min(1).max(100).regex(/^[\x21-\x7e]+$/);
const slotName = z.string().regex(/^[a-z0-9_]{1,63}$/);
export const CDC_METHODS = ['logical_replication', 'binlog', 'change_tracking', 'mqtt', 'opcua'] as const;

const sealedFrameValue = z.strictObject({ sealed: z.string().max(65_536), expiresAt: z.iso.datetime({ offset: true }) });

/** opcua (spec 20.3): one value the server published, naming its object, instance and browse path. */
export const capturedSample = z.strictObject({
  object: z.string().min(1).max(64),
  browseName: z.string().max(1_000),
  nodeId: z.string().max(1_300),
  path: z.string().min(1).max(1_000),
  value: z.unknown(),
  status: z.enum(['good', 'uncertain', 'bad']),
  sourceAt: z.iso.datetime({ offset: true }).optional(),
  serverAt: z.iso.datetime({ offset: true }).optional(),
});
export type CapturedSample = z.infer<typeof capturedSample>;

/** Read the slot and send its changes up POST /v1/cdc/:slotId, from the acknowledged position (absent: where the slot stands, made if missing). */
export const cdcStartFrame = z.strictObject({
  type: z.literal('cdc.start'),
  slotId: z.uuid(),
  connectionId: z.uuid(),
  method: z.enum(CDC_METHODS),
  slotName,
  /** logical_replication: the publication the customer made. */
  publication: slotName.optional(),
  /** binlog and change_tracking: the tables the capture reads, by schema and name; the source's other tables stay on the host. */
  tables: z.array(z.strictObject({ schema: z.string().min(1).max(128), table: z.string().min(1).max(128) })).max(500).optional(),
  position: logPosition.optional(),
  /**
   * mqtt (spec 20.2, 20.6): the broker (the connection's industrial endpoint), the topic filters
   * the streamed objects read, and the login sealed to this agent for this capture (absent for an
   * anonymous broker). Messages go up as they arrive and are never spooled: telemetry stays off disk.
   */
  mqtt: z.strictObject({
    endpointUrl: z.string().min(1).max(500),
    topics: z.array(z.strictObject({ filter: z.string().min(1).max(1_024), qos: z.union([z.literal(0), z.literal(1), z.literal(2)]) })).min(1).max(500),
    credential: z.strictObject({ sealed: z.string().max(65_536), expiresAt: z.iso.datetime({ offset: true }) }).optional(),
  }).optional(),
  /**
   * opcua (spec 20.3): the server (the connection's active industrial endpoint), reached as a read
   * reaches it, with the key and login sealed to this agent for this capture; and per streamed
   * object the instances under its root and the browse paths it monitors, sampled as declared.
   */
  opcua: z.strictObject({
    endpointUrl: z.string().min(1).max(500),
    securityPolicy: z.string().min(1).max(200),
    certificate: z.string().max(16_384).optional(),
    serverThumbprint: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
    applicationKey: sealedFrameValue.optional(),
    credential: sealedFrameValue.optional(),
    objects: z.array(z.strictObject({
      object: z.string().min(1).max(64),
      root: z.string().min(1).max(1_300),
      typeDefinition: z.string().min(1).max(1_300).optional(),
      paths: z.array(z.string().min(1).max(1_000)).min(1).max(500),
      samplingMs: z.number().min(0),
      queueSize: z.int().min(1),
      deadband: z.strictObject({ type: z.enum(['absolute', 'percent']), value: z.number().min(0) }).optional(),
    })).min(1).max(500),
  }).optional(),
});
/** A spool record's id, "<segment>.<index>": the agent's spool lets it go once the cell has it. */
const spoolId = z.string().regex(/^\d{1,20}\.\d{1,10}$/);
/**
 * The cell has taken in everything up to this position (the source may let its log go), and has
 * the spool record received with all before it (the agent's spool may let them go, a part of a
 * large transaction included).
 */
export const cdcAckFrame = z.strictObject({ type: z.literal('cdc.ack'), slotId: z.uuid(), position: logPosition.optional(), received: spoolId.optional() })
  .refine((f) => f.position !== undefined || f.received !== undefined, 'a position, a receipt or both');
/** The cell has the gap record. */
export const cdcGapAckFrame = z.strictObject({ type: z.literal('cdc.gap_ack'), slotId: z.uuid(), gapId: z.uuid() });
/** Stop reading the slot (its lease ended, or it is being dropped). */
export const cdcStopFrame = z.strictObject({ type: z.literal('cdc.stop'), slotId: z.uuid() });
/** Drop the slot on the customer's database (a person asked, with stream.manage), then report it dropped. */
export const cdcDropFrame = z.strictObject({
  type: z.literal('cdc.drop'), slotId: z.uuid(), connectionId: z.uuid(), method: z.enum(CDC_METHODS), slotName,
});
/**
 * A connection's whole signed actuation allow-list (spec 47.4): each entry's canonical text as
 * the control plane signed it, the key's id and the signature (base64url). None ends the list.
 */
export const allowlistFrame = z.strictObject({
  type: z.literal('allowlist'),
  connectionId: z.uuid(),
  entries: z.array(z.strictObject({ entry: z.string().max(8_192), keyId: z.string().max(100), signature: z.string().max(200) })).max(500),
});
export const downFrame = z.discriminatedUnion('type', [workFrame, closeFrame, cdcStartFrame, cdcAckFrame, cdcGapAckFrame, cdcStopFrame, cdcDropFrame, allowlistFrame]);
export type DownFrame = z.infer<typeof downFrame>;

/** Agent to cell, on a work stream. */
export const resultFrame = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('pong'), version: semver }),
  z.strictObject({ type: z.literal('rows'), rows: z.array(z.record(z.string(), z.unknown())).max(10_000) }),
  z.strictObject({ type: z.literal('done'), rowCount: z.int().min(0), truncated: z.boolean().default(false), rowCounts: z.array(z.int().min(0)).optional() }),
  // http.send: an outbound webhook's status code, and a status endpoint's reported state (spec 20.4). Never a body.
  z.strictObject({ type: z.literal('http_result'), status: z.int().min(100).max(599), state: z.enum(['applied', 'pending', 'failed']).optional() }),
  z.strictObject({
    type: z.literal('error'),
    /** source_unreachable, timeout, bounds, integrity, or the source's own refusal. */
    category: z.enum(['source_unreachable', 'timeout', 'bounds', 'integrity', 'source_refused', 'row_count_mismatch', 'grant_refused',
      'login_refused', 'target_refused', 'actuation_refused', 'internal']),
    /**
     * grant_refused: why the agent refused the write's execution grant (spec 10.4); login_refused:
     * why it did not take the sealed login or key (spec 10.7); source_refused: why an industrial server refused (20.2, 20.3).
     */
    reason: z.union([z.enum(GRANT_REFUSALS), z.enum(LOGIN_REFUSALS), z.enum(SOURCE_REFUSALS), z.enum(ACTUATION_REFUSALS)]).optional(),
    /** The source's SQLSTATE, never its message text. */
    sqlstate: z.string().regex(/^[0-9A-Z]{5}$/).optional(),
    index: z.int().min(0).optional(),
    rows: z.int().min(0).optional(),
  }),
  // discovery.scan: what the scan did, as it goes, then its end (contracts/discovery/scan.contract.ts).
  scanProbe, scanFinding, scanEnd,
]);
export type ResultFrame = z.infer<typeof resultFrame>;

/**
 * One row's change as the agent read it from the source's log: the table it is in, the
 * column values it carries (a delete carries the key), and where it sits in the log, which
 * orders the slot's changes as text.
 */
export const capturedChange = z.strictObject({
  op: z.enum(['insert', 'update', 'delete']),
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  position: logPosition,
  values: recordValue(z.record(z.string().min(1).max(128), z.json())),
});
export type CapturedChange = z.infer<typeof capturedChange>;

// target_refused and login_refused: an MQTT subscription (20.6) the host's owner does not allow, or whose sealed login the agent did not take.
export const CAPTURE_FAILURES = ['source_unreachable', 'source_refused', 'not_configured', 'source_not_configured', 'capacity', 'internal', 'target_refused', 'login_refused'] as const;
export const SPOOL_GAP_REASONS = ['spool_bound', 'spool_age', 'spool_damaged', 'resumed_ahead'] as const;
export type SpoolGapReason = (typeof SPOOL_GAP_REASONS)[number];
export type CaptureFailure = (typeof CAPTURE_FAILURES)[number];

/** Agent to cell, on a capture stream. */
export const captureFrame = z.discriminatedUnion('type', [
  /**
   * Changes of one committed transaction, in log order. A large transaction comes in several
   * frames: only its last carries position, the point to acknowledge.
   */
  z.strictObject({
    type: z.literal('changes'),
    /** The spool record it came from: the cell receipts it. */
    spoolId: spoolId.optional(),
    committedAt: z.iso.datetime({ offset: true }),
    position: logPosition.optional(),
    changes: z.array(capturedChange).max(1_000),
  }),
  /** The reader is streaming from the source's log. */
  z.strictObject({ type: z.literal('started') }),
  /** opcua: values as the server published them (each item's first is the backfill, 18.5); never spooled. */
  z.strictObject({ type: z.literal('samples'), samples: z.array(capturedSample).max(1_000) }),
  /** mqtt: messages as the broker delivered them (a retained one is the backfill, 18.5); never spooled. */
  z.strictObject({
    type: z.literal('messages'),
    messages: z.array(z.strictObject({
      topic: z.string().min(1).max(65_535), payload: z.string().max(4 * 1024 * 1024), retained: z.boolean(), receivedAt: z.iso.datetime({ offset: true }),
    })).max(1_000),
  }),
  /**
   * What the agent's spool dropped at its bound or age, or lost to damage, or what a resumed
   * reader found the source no longer holds (spec 10.6): counts and a time range, or positions,
   * never values. The cell answers cdc.gap_ack.
   */
  z.strictObject({
    type: z.literal('gap'),
    id: z.uuid(),
    reason: z.enum(SPOOL_GAP_REASONS),
    records: z.int().min(0).optional(),
    changes: z.int().min(0).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    fromPosition: logPosition.optional(),
    toPosition: logPosition.optional(),
  }),
  /** The slot is gone or invalidated on the source: what it held is lost, and only a new capture resumes. */
  z.strictObject({ type: z.literal('lost') }),
  /** The slot was dropped on the source (cdc.drop). */
  z.strictObject({ type: z.literal('dropped') }),
  /** The reader stopped, or never started: why, by kind, and the source's SQLSTATE, never its text. */
  z.strictObject({
    type: z.literal('error'),
    category: z.enum(CAPTURE_FAILURES),
    sqlstate: z.string().regex(/^[0-9A-Z]{5}$/).optional(),
  }),
]);
export type CaptureFrame = z.infer<typeof captureFrame>;
