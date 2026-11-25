import type { TransportKindV2 } from '../../schemas/manifest.schema';
import type { SendOptions, WireRequest, WireResponse } from '../transports/contract.transport';

/**
 * What crosses the channel between Silo and an agent (MANIFEST-V2 §3.4, §9.9).
 *
 * ── JSON FRAMES, SEALED PAYLOADS, ONE MEGABYTE AT A TIME ──────────────────
 *
 * Every frame is a JSON text message. A job and its result are sealed
 * (`seal.relay.ts`) and cut into parts of at most a megabyte, so one large
 * answer never has to fit in one WebSocket message and the channel's own
 * bound can be small. Nothing about a job is written to Postgres.
 */

/** A part of a sealed payload is at most this many bytes before base64. */
const PART_BYTES = 1_048_576;
/** More parts than this is not a payload anybody meant to send (32 MB and change). */
const MAX_PARTS = 40;

/** One `host` (or `*.suffix`) and a port range the admin confirmed for a connection. */
export interface AllowedHost {
  connectionId: string;
  host: string;
  portFrom: number;
  portTo: number;
}

/** Silo to agent. */
export type SiloFrame =
  | { type: 'welcome'; agentId: string; hosts: AllowedHost[]; instanceKey: string }
  | { type: 'hosts'; hosts: AllowedHost[] }
  | { type: 'job'; id: string; part: number; parts: number; data: string }
  | { type: 'cancel'; id: string }
  | { type: 'tap'; connectionId: string; part: number; parts: number; data: string }
  | { type: 'untap'; connectionId: string }
  | { type: 'pong' };

/** Why an agent did not run a job, in the words the requester raises. */
export type FailureKind = 'not_allowed' | 'blocked' | 'busy' | 'timeout' | 'network' | 'too_large' | 'unsupported';

/** Agent to Silo. */
export type AgentFrame =
  | { type: 'hello'; version: string; hostname: string }
  | { type: 'ping' }
  | { type: 'result'; id: string; part: number; parts: number; data: string }
  | { type: 'failed'; id: string; kind: FailureKind; message: string }
  | { type: 'tapped'; connectionId: string; messages: Array<{ subject: string; headers: Record<string, string>; value: unknown; receivedAt: string }> }
  | { type: 'tap_failed'; connectionId: string; message: string };

/**
 * What a job is, inside the seal. The credential, where auth put it, is in here
 * and nowhere else. `http` is a bare request auth makes for itself — a token
 * endpoint, a session login — on a connection reached through the agent.
 */
export interface Job {
  id: string;
  kind: TransportKindV2 | 'http';
  connectionId: string;
  wire: WireRequest;
  options: Omit<SendOptions, 'signal' | 'inAgent'>;
  /** The public key of the instance that asked: the result is sealed to it. */
  replyTo: string;
}

/** What a result is, inside the seal. */
export type Outcome =
  | { ok: true; response: Omit<WireResponse, 'body'> & { body: string } }
  | { ok: false; error: { kind: string; code: string; message: string; detail?: Record<string, unknown> } };

/** A sealed payload as the parts a channel sends. */
export function partsOf(sealed: Buffer): Array<{ part: number; parts: number; data: string }> {
  const parts = Math.max(1, Math.ceil(sealed.length / PART_BYTES));
  if (parts > MAX_PARTS) throw new Error('A payload larger than the relay carries.');
  return Array.from({ length: parts }, (_, part) => ({ part, parts, data: sealed.subarray(part * PART_BYTES, (part + 1) * PART_BYTES).toString('base64') }));
}

/**
 * Parts back into one payload, in any order. `add` answers the whole payload
 * once every part is in, and null until then. A payload whose parts disagree
 * about how many there are, or that grows past the bound, is refused.
 */
export class Assembler {
  private readonly pending = new Map<string, { parts: number; received: Map<number, Buffer>; bytes: number }>();

  add(key: string, frame: { part: number; parts: number; data: string }): Buffer | null {
    if (!Number.isInteger(frame.parts) || frame.parts < 1 || frame.parts > MAX_PARTS || frame.part < 0 || frame.part >= frame.parts) {
      throw new Error('A frame part that does not fit its payload.');
    }
    const entry = this.pending.get(key) ?? { parts: frame.parts, received: new Map(), bytes: 0 };
    if (entry.parts !== frame.parts) throw new Error('Frame parts that disagree about their payload.');
    const bytes = Buffer.from(frame.data, 'base64');
    if (bytes.length > PART_BYTES) throw new Error('A frame part larger than a part may be.');
    entry.bytes += bytes.length;
    entry.received.set(frame.part, bytes);
    this.pending.set(key, entry);
    if (entry.received.size < entry.parts) return null;
    this.pending.delete(key);
    return Buffer.concat(Array.from({ length: entry.parts }, (_, i) => entry.received.get(i)!));
  }

  forget(key: string): void {
    this.pending.delete(key);
  }
}
