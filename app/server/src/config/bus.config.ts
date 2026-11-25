// The two buses of a cell (spec 9.1): bus-live (NATS core, non-persistent, carries
// values) and bus-durable (Pub/Sub in commercial cells, NATS JetStream in the sovereign
// cell and self-managed installs; persists, so carries no values).

import { z } from 'zod';
import { parseSection, read, type Env } from './env.config.ts';

const natsUrl = z.string().regex(/^(nats|tls):\/\/.+/, 'must be a nats:// or tls:// URL');

const schema = z.object({
  liveUrl: natsUrl.optional(),
  durable: z.enum(['pubsub', 'jetstream']).optional(),
  durableUrl: natsUrl.optional(),
  pubsubProjectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'must be a GCP project id').optional(),
  natsCredentialsFile: z.string().optional(),
  natsCaFile: z.string().optional(),
});

export type BusConfig = z.output<typeof schema>;

export function loadBusConfig(env: Env, problems: string[]): BusConfig | undefined {
  const parsed = parseSection(schema, {
    liveUrl: read(env, 'NATS_LIVE_URL'),
    durable: read(env, 'DURABLE_BUS'),
    durableUrl: read(env, 'NATS_DURABLE_URL'),
    pubsubProjectId: read(env, 'PUBSUB_PROJECT_ID'),
    natsCredentialsFile: read(env, 'NATS_CREDENTIALS_FILE'),
    natsCaFile: read(env, 'NATS_CA_FILE'),
  }, {
    liveUrl: 'NATS_LIVE_URL', durable: 'DURABLE_BUS', durableUrl: 'NATS_DURABLE_URL',
    pubsubProjectId: 'PUBSUB_PROJECT_ID', natsCredentialsFile: 'NATS_CREDENTIALS_FILE', natsCaFile: 'NATS_CA_FILE',
  }, problems);
  if (!parsed) return undefined;
  if (parsed.durable === 'pubsub' && parsed.pubsubProjectId === undefined) {
    problems.push('PUBSUB_PROJECT_ID: required when DURABLE_BUS=pubsub');
  }
  if (parsed.durable === 'jetstream' && parsed.durableUrl === undefined && parsed.liveUrl === undefined) {
    problems.push('NATS_DURABLE_URL: required when DURABLE_BUS=jetstream');
  }
  return { ...parsed, durableUrl: parsed.durableUrl ?? (parsed.durable === 'jetstream' ? parsed.liveUrl : undefined) };
}
