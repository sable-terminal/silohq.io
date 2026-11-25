// The live connection (spec 30.1 to 30.6): one WebSocket per page through the gateway, the
// session cookie its credential. A subscription to a saved set; its snapshot in pages; deltas
// acknowledged as applied; a gap in the sequence answered by asking for a resync, never papered
// over; heartbeats returned; a dropped socket reopened with backoff, except when the session ended
// or the subscription is not allowed. Values live in page memory only (30.7).

import type { ServerFrame } from '../../../server/src/contracts/gateway/live.contract.ts';

export type { ServerFrame };
export type Frame = ServerFrame;

export interface Subscription {
  ref: string;
  set: { kind: 'object_set' | 'view'; id: string };
  properties: string[];
}

export interface LiveHandlers {
  frame: (frame: ServerFrame) => void;
  /** The socket is open (true) or not (false), and why when it will not reopen. */
  connection: (open: boolean, final?: string) => void;
}

const SIGN_IN_AGAIN = 4401;
const FORBIDDEN = 4403;

export class Live {
  private socket: WebSocket | undefined;
  private readonly subscription: Subscription;
  private readonly handlers: LiveHandlers;
  private sub: string | undefined;
  private lastSeq: number | undefined;
  private backoff = 1000;
  private closed = false;

  constructor(subscription: Subscription, handlers: LiveHandlers) {
    this.subscription = subscription;
    this.handlers = handlers;
    this.open();
  }

  private open(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/live`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.backoff = 1000;
      this.handlers.connection(true);
      socket.send(JSON.stringify({ type: 'subscribe', ...this.subscription, ...(this.lastSeq === undefined ? {} : { lastSeq: this.lastSeq }) }));
    };
    socket.onmessage = (event) => {
      let frame: ServerFrame;
      try { frame = JSON.parse(String(event.data)) as ServerFrame; } catch { return; }
      if (frame.type === 'heartbeat') { socket.send(JSON.stringify({ type: 'heartbeat' })); return; }
      if (frame.type === 'subscribed') this.sub = frame.sub;
      if (frame.type === 'snapshot' || frame.type === 'delta') {
        // A frame past the next expected one means some were lost: ask for the state again rather than show a gap as current.
        if (frame.type === 'delta' && this.lastSeq !== undefined && frame.seq > this.lastSeq + 1 && this.sub !== undefined) {
          socket.send(JSON.stringify({ type: 'resync_required', sub: this.sub, lastSeq: this.lastSeq }));
        }
        this.lastSeq = Math.max(this.lastSeq ?? 0, frame.seq);
      }
      this.handlers.frame(frame);
      if (frame.type === 'delta' && this.sub !== undefined) socket.send(JSON.stringify({ type: 'ack', sub: this.sub, seq: frame.seq }));
    };
    socket.onclose = (event) => {
      this.handlers.connection(false, event.code === SIGN_IN_AGAIN ? 'Your session ended: sign in again.' : event.code === FORBIDDEN ? 'You may not see this set live.' : undefined);
      if (this.closed || event.code === SIGN_IN_AGAIN || event.code === FORBIDDEN) return;
      setTimeout(() => { if (!this.closed) this.open(); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
  }

  close(): void {
    this.closed = true;
    if (this.sub !== undefined && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'unsubscribe', sub: this.sub }));
    this.socket?.close(1000);
  }
}
