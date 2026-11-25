// The routing table of the public API (spec 7.3). The edge serves exactly these routes;
// a service that gains a browser-facing endpoint adds its public route definition and
// lists it here.

import { acceptInvitation, createInvitation, requestPasswordReset, resetPassword } from './accounts.contract.ts';
import { ACTION_ROUTES } from './actionRoutes.contract.ts';
import { ADMIN_ROUTES } from './adminRoutes.contract.ts';
import { listAuditEvents, listAuthEvents, listChainHeads, listCredentialUnwraps, listPartitionSeals, readAuditChain } from './auditRoutes.contract.ts';
import {
  buySeats, listSiloCharges, listTokenLedger, openBillingPortal, setAutoTopup, paymentWebhook, purchase, readBilling, readContractUsage, readContracts, readEngagementCost,
  readMemberAllowance, readOwnAllowance, startCheckout,
} from './billingRoutes.contract.ts';
import { CLONE_ROUTES } from './cloneRoutes.contract.ts';
import { STUDIO_ROUTES } from './studioRoutes.contract.ts';
import { BUILDER_ROUTES } from './builderRoutes.contract.ts';
import { CONNECT_ROUTES } from './connectRoutes.contract.ts';
import { DISCOVERY_ROUTES } from './discoveryRoutes.contract.ts';
import { MAINTENANCE_ROUTES } from './maintenanceRoutes.contract.ts';
import { LINEAGE_ROUTES } from './lineageRoutes.contract.ts';
import {
  acknowledgeNotification, listNotifications, listPushDevices, markNotificationRead, readNotification, registerPushDevice, removePushDevice,
} from './notificationRoutes.contract.ts';
import { ONTOLOGY_ROUTES } from './ontologyRoutes.contract.ts';
import { QUERY_ROUTES } from './queryRoutes.contract.ts';
import type { PublicRoute } from './publicRoute.contract.ts';
import { RESOLUTION_ROUTES } from './resolutionRoutes.contract.ts';
import { SEARCH_ROUTES } from './searchRoutes.contract.ts';
import { confirmTotpEnrolment, currentSession, signIn, signOut, signOutWithProvider, startTotpEnrolment, verifyMfa } from './sessions.contract.ts';
import { SSO_ROUTES } from './ssoRoutes.contract.ts';
import { STREAM_ROUTES } from './streamRoutes.contract.ts';
import { ASK_ROUTES } from './askRoutes.contract.ts';
import { WORKSPACE_ROUTES } from './workspaceRoutes.contract.ts';
import { SCHEDULER_ROUTES } from './schedulerRoutes.contract.ts';
import { FILE_ROUTES } from './fileRoutes.contract.ts';
import { RECOGNITION_ROUTES } from './recognitionRoutes.contract.ts';
import { SIMULATION_ROUTES } from './simulationRoutes.contract.ts';
import { ACCOUNT_ROUTES } from './accountRoutes.contract.ts';
import { SIGNUP_ROUTES } from './signupRoutes.contract.ts';
import { WAREHOUSE_ROUTES } from './warehouseRoutes.contract.ts';
import { OBJECT_INDEX_ROUTES } from './objectIndexRoutes.contract.ts';
import { SILOES_ROUTES } from './siloesRoutes.contract.ts';
import { CONNECTION_ROUTES } from './connectionRoutes.contract.ts';
import { GOVERNANCE_READ_ROUTES } from './governanceReadRoutes.contract.ts';
import { SEAT_ROUTES } from './seatRoutes.contract.ts';
import { TENANCY_ROUTES } from './tenancyRoutes.contract.ts';
import { FDE_ROUTES } from './fdeRoutes.contract.ts';
import { OPERATOR_ACCESS_ROUTES } from './operatorAccessRoutes.contract.ts';
import { SUPPORT_ROUTES } from './supportRoutes.contract.ts';

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  signIn, currentSession, signOut, signOutWithProvider, verifyMfa, startTotpEnrolment, confirmTotpEnrolment,
  requestPasswordReset, resetPassword, createInvitation, acceptInvitation,
  listAuditEvents, listAuthEvents, listCredentialUnwraps, listChainHeads, readAuditChain, listPartitionSeals,
  listNotifications, readNotification, markNotificationRead, acknowledgeNotification, registerPushDevice, listPushDevices, removePushDevice,
  readBilling, listSiloCharges, buySeats, setAutoTopup, startCheckout, openBillingPortal, purchase, readOwnAllowance, readMemberAllowance, listTokenLedger, readEngagementCost,
  readContracts, readContractUsage,
  paymentWebhook,
  ...SSO_ROUTES,
  ...ONTOLOGY_ROUTES,
  ...LINEAGE_ROUTES,
  ...SEARCH_ROUTES,
  ...QUERY_ROUTES,
  ...RESOLUTION_ROUTES,
  ...CONNECT_ROUTES,
  ...BUILDER_ROUTES,
  ...MAINTENANCE_ROUTES,
  ...DISCOVERY_ROUTES,
  ...STREAM_ROUTES,
  ...ADMIN_ROUTES,
  ...WORKSPACE_ROUTES,
  ...SCHEDULER_ROUTES,
  ...FILE_ROUTES,
  ...ASK_ROUTES,
  ...ACTION_ROUTES,
  ...CLONE_ROUTES,
  ...STUDIO_ROUTES,
  ...RECOGNITION_ROUTES,
  ...SIMULATION_ROUTES,
  ...ACCOUNT_ROUTES,
  ...SIGNUP_ROUTES,
  ...WAREHOUSE_ROUTES,
  ...OBJECT_INDEX_ROUTES,
  ...SILOES_ROUTES,
  ...CONNECTION_ROUTES,
  ...GOVERNANCE_READ_ROUTES,
  ...SEAT_ROUTES,
  ...TENANCY_ROUTES,
  ...FDE_ROUTES,
  ...OPERATOR_ACCESS_ROUTES,
  ...SUPPORT_ROUTES,
];
