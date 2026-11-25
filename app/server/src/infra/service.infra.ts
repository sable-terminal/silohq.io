// A service (docs/siloServiceCatalogue.doc.md): it declares what it needs (databases,
// Redis instances, buses) and, given those, returns its routes and workers. The process
// that opens what its services need and runs them is src/process.ts.

import type { Config } from '../config/index.config.ts';
import type { RedisInstance } from '../config/redis.config.ts';
import type { ServiceName } from '../config/service.config.ts';
import type { DurableBus, LiveBus } from './bus.infra.ts';
import type { RouteBinding } from './http.infra.ts';
import type { Logger } from './logger.infra.ts';
import type { Databases, PostgresTarget } from './postgres.infra.ts';
import type { RedisStore } from './redis.infra.ts';
import type { ServiceClient } from './serviceClient.infra.ts';
import type { RequestSignals } from './signals.infra.ts';

export interface ServiceNeeds {
  postgres?: readonly PostgresTarget[];
  redis?: readonly RedisInstance[];
  bus?: readonly ('live' | 'durable')[];
}

export interface ServiceDependencies {
  readonly config: Config;
  readonly logger: Logger;
  readonly databases: Databases;
  readonly redis: Readonly<Partial<Record<RedisInstance, RedisStore>>>;
  readonly liveBus: LiveBus | undefined;
  readonly durableBus: DurableBus | undefined;
  /** Calls other services as this service. */
  readonly services: ServiceClient;
  /** The process's health signals: a service may keep a gauge in them (spec 11.2). */
  readonly signals: RequestSignals;
}

/** A loop that runs until its signal aborts: an outbox relay, a sweep, a consumer. */
export interface Worker {
  readonly name: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface ServiceParts {
  routes: readonly RouteBinding[];
  workers?: readonly Worker[];
  /** Releases what the service opened itself (a KMS client), after its workers stop. */
  close?: () => Promise<void>;
}

export interface ServiceDefinition {
  readonly name: ServiceName;
  /** What the process opens for it; from the configuration where the service has more than one role (fleet-control). */
  readonly needs: ServiceNeeds | ((config: Config) => ServiceNeeds);
  create(deps: ServiceDependencies): ServiceParts | Promise<ServiceParts>;
}

export function defineService(definition: ServiceDefinition): ServiceDefinition {
  return definition;
}
