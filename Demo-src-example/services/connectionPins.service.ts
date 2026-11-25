import type { Executor } from '../infra/db.infra';
import { log as writeAudit } from './audit.service';
import { pinsFor, type Pins } from '../engine/read/pins.read';
import { paramsFor } from '../engine/read/params.read';
import type { Credential } from '../engine/auth/credential.auth';
import * as connectionRepo from '../repos/connection.repo';
import * as connectorRepo from '../repos/connector.repo';

/**
 * Pinning what the person connecting confirmed (MANIFEST-V2 §9.2, F20).
 *
 * WRITTEN WHEN A CONNECTION IS MADE, by the act of making it. The connect form
 * says where the credential will go and which statements will run; giving the
 * credential, finishing OAuth, or setting the parameters that decide an
 * address is the confirmation, and what it confirmed is written here in the
 * same transaction.
 */
export async function pinConnection(
  db: Executor,
  input: { organisationId: string; membershipId: string; connectionId: string; credential: Credential | null },
): Promise<Pins> {
  const [connection] = await connectorRepo.load(db, [input.connectionId]);
  if (!connection) return { origins: [], statements: [] };
  const pins = await pinsFor(connection.manifest, paramsFor(connection.manifest, connection.parameters, input.credential));
  await connectionRepo.replacePins(db, { organisationId: input.organisationId, connectionId: input.connectionId, ...pins, confirmedBy: input.membershipId });
  await writeAudit(db, {
    event: 'connection_pins_confirmed',
    organisationId: input.organisationId,
    membershipId: input.membershipId,
    userId: null,
    detail: { connectionId: input.connectionId, origins: pins.origins, statements: pins.statements.length },
  });
  return pins;
}
