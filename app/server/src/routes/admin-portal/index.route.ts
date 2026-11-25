// admin-portal (spec 7 catalogue, 13; docs/siloServiceCatalogue.doc.md): the Silo staff
// console for operations and break-glass access. Every action on a tenant is visible to
// that customer.
//
// Two listeners. Staff use the portal's own (ADMIN_PORTAL_PUBLIC_PORT), signed in through
// the staff identity provider only; the customer gateway never reaches it. The process's
// service listener carries the customer's side of break-glass, which the gateway forwards,
// and the orchestrator's probes. A worker expires running sessions.

import { readFileSync } from 'node:fs';
import { required } from '../../config/index.config.ts';
import * as c from '../../contracts/admin-portal/operatorAccess.contract.ts';
import * as st from '../../contracts/admin-portal/supportTicket.contract.ts';
import { STAFF_ROUTES } from '../../contracts/admin-portal/staffApi.contract.ts';
import { operatorAccessController } from '../../controllers/admin-portal/operatorAccess.controller.ts';
import { supportTicketController } from '../../controllers/admin-portal/supportTicket.controller.ts';
import { createStaffApp } from '../../controllers/admin-portal/staff.controller.ts';
import { staffHandlers } from '../../controllers/admin-portal/staffHandlers.controller.ts';
import { createEgress } from '../../infra/egress.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createBreakGlass } from '../../services/admin-portal/breakGlass.service.ts';
import type { AdminPortalDeps } from '../../services/admin-portal/deps.service.ts';
import { createOperations } from '../../services/admin-portal/operations.service.ts';
import { createSovereignTerms } from '../../services/admin-portal/sovereignTerms.service.ts';
import { createSupportTickets } from '../../services/admin-portal/supportTickets.service.ts';
import { createOperators } from '../../services/admin-portal/operators.service.ts';
import { createStaffLimiter } from '../../middleware/rateLimit.middleware.ts';
import { createStaffAuth } from '../../services/admin-portal/staffAuth.service.ts';
import { openPublicListener } from '../../services/gateway/listener.service.ts';
import { expiryWorker } from '../../workers/admin-portal/expiry.worker.ts';

export interface AdminPortalOptions {
  /** Called with the staff listener's port once it listens (port 0 takes any free port). */
  onListening?: (port: number) => void;
  now?: () => Date;
  /** False in tests that sweep by hand. */
  sweep?: boolean;
}

export function createAdminPortalService(options: AdminPortalOptions = {}): ServiceDefinition {
  return defineService({
    name: 'admin-portal',
    // The reporting replica where the deployment gives one: tenant_read sessions read there (13.3).
    needs: (config) => ({ postgres: config.postgres.reportUrl === undefined ? ['control'] : ['control', 'report'], redis: ['session', 'data'] }),
    async create(deps) {
      const { config, logger } = deps;
      const portal = config.adminPortal;
      const publicOrigin = required(portal.publicOrigin, 'ADMIN_PORTAL_PUBLIC_ORIGIN');
      const identifierKey = required(config.security.identifierHashKey, 'IDENTIFIER_HASH_KEY');
      const shared: AdminPortalDeps = {
        databases: deps.databases, services: deps.services, logger, config: portal,
        cell: { id: config.cell.id, sovereign: config.cell.buildTarget === 'sovereign' },
        sessions: deps.redis.session!, data: deps.redis.data!,
        // The staff identity provider is a fixed, configured issuer; private addresses and
        // plain HTTP only where ADMIN_PORTAL_IDP_ALLOW_INSECURE (development and tests).
        egress: createEgress({
          egressAllowPrivate: portal.idp.allowInsecure, egressAllowHttp: portal.idp.allowInsecure,
          egressTimeoutMs: config.connect.egressTimeoutMs, egressMaxResponseBytes: 1024 * 1024,
        }),
        ...(options.now ? { now: options.now } : {}),
      };
      const auth = createStaffAuth(shared);
      const breakGlass = createBreakGlass(shared);
      const supportTickets = createSupportTickets(shared);
      const app = createStaffApp({
        config: portal, publicOrigin, trustProxyHops: config.http.trustProxyHops, maxBodyBytes: 16 * 1024 * 1024, logger, auth,
        limiter: createStaffLimiter(deps.redis.data!, identifierKey, portal.rateLimits), routes: STAFF_ROUTES,
        handlers: staffHandlers({
          auth, operators: createOperators(shared), breakGlass, operations: createOperations(shared, breakGlass), sovereignTerms: createSovereignTerms(shared),
          supportTickets,
        }),
      });
      const tls = portal.tls === undefined ? undefined : { cert: readFileSync(portal.tls.certFile), key: readFileSync(portal.tls.keyFile) };
      const listener = await openPublicListener({
        host: portal.publicHost, port: portal.publicPort, tls, handler: app, requestTimeoutMs: config.http.requestTimeoutMs,
        upgrade: (_req, socket) => socket.destroy(),
      });
      logger.info('staff listener started', { event: 'admin_portal.listening', count: STAFF_ROUTES.length });
      options.onListening?.(listener.port);

      const h = operatorAccessController(breakGlass);
      const tickets = supportTicketController(supportTickets);
      let stopping: Promise<boolean> | undefined;
      const stop = (): Promise<boolean> => (stopping ??= listener.close(config.http.shutdownTimeoutMs));
      return {
        routes: [
          route(c.listOperatorAccessSessions, h.list), route(c.getOperatorAccessSession, h.get),
          route(c.decideOperatorAccessSession, h.decide), route(c.revokeOperatorAccessSession, h.revoke),
          route(c.getOperatorAccessPolicy, h.policy), route(c.setOperatorAccessPolicy, h.setPolicy),
          route(st.raiseSupportTicket, tickets.raise), route(st.listSupportTickets, tickets.list), route(st.readSupportTicket, tickets.read),
          route(st.replyToSupportTicket, tickets.reply), route(st.closeSupportTicket, tickets.close),
        ],
        workers: [
          ...(options.sweep === false ? [] : [expiryWorker(breakGlass, portal.sweepSeconds * 1000, logger)]),
          {
            name: 'admin-portal-staff',
            async run(signal) {
              if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
              await stop();
            },
          },
        ],
        close: async () => { await stop(); },
      };
    },
  });
}

export const service: ServiceDefinition = createAdminPortalService();
