// connect-registry: a connection still being built follows its draft (spec 16.3, 16.4).
//
// The build routes write a new manifest version for every draft they probe, since a version
// never changes once it has been read (spec 14.3), and the sandbox connection moves to it.
// Only a draft or probing connection moves, and only within its own connector: a verified
// or active connection changes version through self-heal's reviewed path, never here.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { connectionView } from './connection.contract.ts';

export const setDraftConnectionVersion = defineContract({
  service: 'connect-registry', name: 'setDraftConnectionVersion', method: 'PUT', path: '/v1/connections/:connectionId/manifest',
  callers: ['connector-builder', 'visual-builder'],
  // At the version read; moving to the version it already runs changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid() }),
  body: z.strictObject({ manifestId: z.uuid(), version: z.int().min(1) }),
  response: connectionView,
  maxBodyBytes: 1_024,
});
