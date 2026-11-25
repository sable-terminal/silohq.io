import { randomUUID } from 'node:crypto';
import * as amqp from 'amqplib';
import mqtt from 'mqtt';
import { nodeTls } from '../../infra/network.infra';
import { refusal } from '../../utils/error.util';
import { bytesOf } from '../formats/wire.format';
import type { SocketAuth } from './contract.transport';

/**
 * Listening to a queue without taking from it — the agent's half of `queue_tap`.
 *
 * ── A TAP, NOT A CONSUMER ─────────────────────────────────────────────────
 *
 * Consuming a message from somebody's queue removes it: their own consumer
 * never sees it. So Silo never reads a queue. For AMQP it binds a queue of its
 * own — exclusive, deleted when the agent disconnects, capped in length — to
 * the EXCHANGE, and receives a copy of what is routed there. For MQTT a
 * subscription is already a copy; a shared subscription (`$share/…`) is not, and
 * is refused. Whatever arrives is handed to `deliver`, which forwards it to the
 * inbound store under the connection's retention.
 *
 * RUNS ONLY IN THE AGENT. A queue is inside the customer's network, and a
 * subscription is a long-lived socket; neither belongs on Silo's servers.
 */

export interface TapWire {
  protocol: 'amqp' | 'mqtt';
  url: string;
  source: string;
}

export interface Tapped {
  /** The exchange's routing key, or the MQTT topic the message was published to. */
  subject: string;
  headers: Record<string, string>;
  value: unknown;
  receivedAt: string;
}

export interface Tap {
  close(): Promise<void>;
}

/** The most a tap's own queue holds before the oldest is dropped: the agent is behind, not the customer. */
const TAP_QUEUE_LENGTH = 10_000;

const utf8 = new TextDecoder('utf-8', { fatal: true });

function valueOf(payload: Buffer): unknown {
  let text: string;
  try {
    text = utf8.decode(payload);
  } catch {
    return bytesOf(payload);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const headersOf = (raw: Record<string, unknown> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'object' ? JSON.stringify(v) : String(v)]));

/** `exchange` or `exchange/routing.key.#`. A bare queue is refused: reading it would take from it. */
export function amqpSource(source: string): { exchange: string; routingKey: string } {
  if (/^queue:/i.test(source)) {
    throw refusal({
      message: 'Silo listens to an exchange, never a queue: taking from a queue takes messages away from whoever else reads it.',
      code: 'refusal.request_unbuildable',
    });
  }
  const at = source.indexOf('/');
  const exchange = at === -1 ? source : source.slice(0, at);
  const routingKey = at === -1 ? '#' : source.slice(at + 1) || '#';
  if (!exchange) throw refusal({ message: 'Name the exchange to listen to.', code: 'refusal.request_unbuildable' });
  return { exchange, routingKey };
}

export async function openTap(wire: TapWire, socket: SocketAuth, deliver: (message: Tapped) => Promise<void>): Promise<Tap> {
  const tls = nodeTls(socket.tls, true);

  if (wire.protocol === 'amqp') {
    const { exchange, routingKey } = amqpSource(wire.source);
    const url = new URL(wire.url);
    const connection = await amqp.connect(
      {
        protocol: url.protocol.replace(':', ''),
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        vhost: decodeURIComponent(url.pathname.replace(/^\//, '')) || '/',
        username: socket.username ?? 'guest',
        password: socket.password ?? 'guest',
        heartbeat: 30,
      },
      { ...tls, servername: socket.tls.servername ?? url.hostname },
    );
    const channel = await connection.createChannel();
    await channel.checkExchange(exchange);
    const { queue } = await channel.assertQueue('', {
      exclusive: true,
      autoDelete: true,
      durable: false,
      arguments: { 'x-max-length': TAP_QUEUE_LENGTH, 'x-overflow': 'drop-head' },
    });
    await channel.bindQueue(queue, exchange, routingKey);
    await channel.prefetch(100);
    await channel.consume(queue, (msg) => {
      if (!msg) return;
      deliver({
        subject: msg.fields.routingKey,
        headers: headersOf(msg.properties.headers as Record<string, unknown> | undefined),
        value: valueOf(msg.content),
        receivedAt: new Date().toISOString(),
      }).then(
        () => channel.ack(msg),
        () => channel.nack(msg, false, true),
      );
    });
    return {
      async close() {
        await channel.close().catch(() => {});
        await connection.close().catch(() => {});
      },
    };
  }

  if (wire.source.startsWith('$share/')) {
    throw refusal({
      message: 'A shared MQTT subscription divides messages between its members, so Silo joining one would take messages from your consumers. Use the plain topic filter.',
      code: 'refusal.request_unbuildable',
    });
  }
  const client = await mqtt.connectAsync(wire.url, {
    clientId: `silo-tap-${randomUUID().slice(0, 8)}`,
    clean: true,
    username: socket.username,
    password: socket.password,
    ca: tls.ca,
    cert: tls.cert,
    key: tls.key,
    servername: socket.tls.servername,
    rejectUnauthorized: true,
    reconnectPeriod: 5_000,
  });
  await client.subscribeAsync(wire.source, { qos: 1 });
  client.on('message', (topic, payload, packet) => {
    const props = (packet as { properties?: { userProperties?: Record<string, unknown> } }).properties;
    void deliver({ subject: topic, headers: headersOf(props?.userProperties), value: valueOf(payload), receivedAt: new Date().toISOString() }).catch(() => {});
  });
  return {
    async close() {
      await client.endAsync().catch(() => {});
    },
  };
}
