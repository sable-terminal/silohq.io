import { AsyncLocalStorage } from 'node:async_hooks';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, Socket, type LookupFunction } from 'node:net';
import type { AllowedHost } from './frame.relay';
import { alwaysRefused, hostMatches, permitted, targetsOf, type Target } from './targets.relay';
import type { Job } from './frame.relay';

/**
 * The agent's own guard: what it will connect to, checked by it and not by Silo
 * (MANIFEST-V2 §9.2, finding F21).
 *
 * ── TWO LISTS, AND THE INTERSECTION ───────────────────────────────────────
 *
 * Silo sends the hosts an admin confirmed for each connection. The agent keeps
 * its own list — written on the machine it runs on, by the people who run that
 * machine — and a target must be on BOTH. A compromised Silo cannot widen what
 * the agent reaches, and a mistaken local entry cannot reach a connection Silo
 * did not route here.
 *
 * ── ENFORCED AT THE SOCKET, FOR EVERY DRIVER ──────────────────────────────
 *
 * Checking the wire request names the host a job asks for; it does not see
 * the next hop a driver takes on its own — an Oracle SCAN listener redirecting
 * to a node, SQL Server's browser naming a port, a Kafka cluster advertising
 * brokers. So while a job runs, every socket the process opens is checked
 * against the same lists, by name and by every address it resolves to. A job
 * is the only context in which the agent opens anything but its channel.
 *
 * ── SOME ADDRESSES NO LIST OPENS ──────────────────────────────────────────
 *
 * Loopback, link-local (where every cloud's metadata service lives) and the
 * unspecified address are refused whatever either list says — unless the
 * person who installed the agent said, in its own configuration, that the
 * system it serves runs on the same machine.
 */

export interface LocalEntry {
  host: string;
  portFrom: number;
  portTo: number;
}

export class JobRefused extends Error {
  constructor(
    readonly kind: 'not_allowed' | 'blocked',
    message: string,
  ) {
    super(message);
    this.name = 'JobRefused';
  }
}

interface Scope {
  connectionId: string;
  silo: AllowedHost[];
  local: LocalEntry[];
  allowLoopback: boolean;
}

const scope = new AsyncLocalStorage<Scope>();

export class Guard {
  private silo: AllowedHost[] = [];

  constructor(
    private local: LocalEntry[],
    private readonly allowLoopback = false,
  ) {}

  /** What Silo says the admin confirmed — replaced whole each time it is sent. */
  useSiloHosts(hosts: AllowedHost[]): void {
    this.silo = hosts;
  }

  useLocal(entries: LocalEntry[]): void {
    this.local = entries;
  }

  /** Whether one target may be reached for one connection. */
  allows(connectionId: string, target: Target): boolean {
    return allowed({ connectionId, silo: this.silo, local: this.local, allowLoopback: this.allowLoopback }, target);
  }

  /** A job's own targets, checked before anything is opened. */
  check(job: Pick<Job, 'kind' | 'wire' | 'connectionId'>): void {
    const targets = targetsOf(job.kind, job.wire);
    if (targets.length === 0) throw new JobRefused('not_allowed', 'The agent could not tell where this job would connect, so it did not run it.');
    for (const target of targets) {
      if (!this.allowLoopback && alwaysRefused(target.host)) throw new JobRefused('blocked', `${target.host} is this machine or its cloud's metadata service, which the agent never contacts.`);
      if (!this.allows(job.connectionId, target)) {
        throw new JobRefused('not_allowed', `${target.host}:${target.port} is not on this agent's own list and Silo's confirmed list for the connection. Add it with: silo-agent allow ${target.host}:${target.port}`);
      }
    }
  }

  /** Run `work` with every socket it opens held to this connection's lists. */
  within<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
    return scope.run({ connectionId, silo: this.silo, local: this.local, allowLoopback: this.allowLoopback }, work);
  }
}

function allowed(s: Scope, target: Target): boolean {
  const silo = s.silo.filter((h) => h.connectionId === s.connectionId);
  return permitted(target, silo) && s.local.some((e) => hostMatches(e.host, target.host) && target.port >= e.portFrom && target.port <= e.portTo);
}

/* ── The socket layer ───────────────────────────────────────────────────── */

let installed = false;

/**
 * Hold every socket opened inside a job to that job's lists. Installed once,
 * in the agent process only; outside a job (the channel to Silo itself) it
 * does nothing.
 */
export function installSocketGuard(): void {
  if (installed) return;
  installed = true;
  const connect = Socket.prototype.connect as (...args: unknown[]) => Socket;

  Socket.prototype.connect = function guardedConnect(this: Socket, ...args: unknown[]): Socket {
    const s = scope.getStore();
    if (!s) return connect.apply(this, args);

    /*
     * THREE SHAPES ARRIVE HERE. `net.connect` and `tls.connect` pass Node's own
     * normalised array — `[options, callback]` — as the only argument; a
     * library calling `socket.connect` passes an options object, or a port and
     * a host. The options object is checked and given the checking lookup IN
     * PLACE, so Node's normalised form reaches the original untouched.
     */
    const first = args[0];
    let options: Record<string, unknown>;
    let call: unknown[] = args;
    if (Array.isArray(first) && typeof first[0] === 'object' && first[0] !== null) {
      options = first[0] as Record<string, unknown>;
    } else if (typeof first === 'object' && first !== null) {
      options = first as Record<string, unknown>;
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      options = { port: Number(first), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
      const callback = args.find((a) => typeof a === 'function');
      call = callback ? [options, callback] : [options];
    } else {
      options = { path: first };
    }

    const refuse = (message: string, kind: 'blocked' | 'not_allowed') => {
      process.nextTick(() => this.destroy(new JobRefused(kind, message)));
      return this;
    };

    if (options.path !== undefined) {
      /* A Unix socket or a named pipe is this machine by definition. */
      if (!s.allowLoopback) return refuse('A local socket is this machine, which the agent never contacts.', 'blocked');
      return connect.apply(this, call);
    }

    const host = String(options.host ?? 'localhost').replace(/^\[|\]$/g, '');
    const port = Number(options.port);
    if (!s.allowLoopback && alwaysRefused(host)) return refuse(`${host} is this machine or its cloud's metadata service, which the agent never contacts.`, 'blocked');
    if (!allowed(s, { host, port })) return refuse(`The job tried to reach ${host}:${port}, which is not on both lists for this connection.`, 'not_allowed');

    /* The name was allowed; every address it resolves to must not be one no list opens. */
    if (!isIP(host) && !s.allowLoopback) {
      const inner = (options.lookup as LookupFunction | undefined) ?? dnsLookup;
      const checked: LookupFunction = (hostname, lookupOptions, cb) => {
        (inner as (h: string, o: unknown, c: (...r: unknown[]) => void) => void)(hostname, lookupOptions, (error: unknown, address: unknown, family: unknown) => {
          if (error) return (cb as (...r: unknown[]) => void)(error, address, family);
          const addresses = Array.isArray(address) ? (address as Array<{ address: string }>).map((a) => a.address) : [String(address)];
          const bad = addresses.find((a) => alwaysRefused(a));
          if (bad) return (cb as (...r: unknown[]) => void)(new JobRefused('blocked', `${hostname} resolves to ${bad}, which the agent never contacts.`), address, family);
          return (cb as (...r: unknown[]) => void)(null, address, family);
        });
      };
      options.lookup = checked;
    }
    return connect.apply(this, call);
  } as typeof Socket.prototype.connect;
}
