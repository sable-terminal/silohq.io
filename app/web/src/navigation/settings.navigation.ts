// Settings (the header's cog): the organisation's configuration, grouped as an administrator
// thinks of it. The person's own settings are the account pages (account.navigation.ts).

import type { Place, SettingsGroup } from './types.navigation.ts';

export const SETTINGS: readonly SettingsGroup[] = [
  {
    id: 'organisation', label: 'Organisation',
    items: [
      {
        id: 'profile', label: 'Name and logo', href: '/settings/profile/', icon: 'building', purpose: 'How your organisation appears in Silo.',
        does: ['Set the logo'], keywords: ['branding', 'logo'], routes: ['setOrganisationLogo'],
      },
      {
        id: 'calendar', label: 'Calendar', href: '/settings/calendar/', icon: 'calendar', purpose: 'Working days and hours that Crons, schedules and lead times use.',
        does: ['Set working days, hours and holidays'], keywords: ['working hours', 'holidays', 'business days', 'time zone'],
        routes: ['readOrganisationCalendar', 'setOrganisationCalendar'],
      },
      {
        id: 'domains', label: 'Domains', href: '/settings/domains/', icon: 'globe', purpose: 'Email domains your organisation owns.',
        does: ['Add and verify domains', 'Remove a domain'], keywords: ['dns', 'verification', 'email domain'],
        routes: ['listDomains', 'addDomain', 'verifyDomain', 'removeDomain'],
      },
      {
        id: 'terminology', label: 'Terminology', href: '/settings/terminology/', icon: 'edit', purpose: 'Your own words for types and fields.',
        does: ['Set and supersede terminology skins'], keywords: ['vocabulary', 'labels', 'skin', 'rename'],
        routes: ['listTerminologySkins', 'setTerminologySkin', 'supersedeTerminologySkin'],
      },
    ],
  },
  {
    id: 'people', label: 'People',
    items: [
      {
        id: 'people', label: 'Members and invitations', href: '/settings/people/', icon: 'people', purpose: 'Who is in your organisation.',
        does: ['Invite people', 'Suspend, reinstate and remove members'], keywords: ['users', 'members', 'invite', 'team'],
        routes: ['listMembers', 'createInvitation', 'suspendMember', 'reinstateMember', 'removeMember'],
      },
      {
        id: 'seats', label: 'Seats', href: '/settings/seats/', icon: 'user', purpose: 'Who holds a seat, and your seat pool.',
        does: ['Assign and release seats', 'Allocate a seat pool', 'Buy seats'], keywords: ['licences', 'licenses'],
        routes: ['listSeats', 'assignSeat', 'unassignSeat', 'releaseSeat', 'allocateSeatPool', 'buySeats'],
      },
      {
        id: 'roles', label: 'Roles', href: '/settings/roles/', icon: 'key', purpose: 'What each role may do.',
        does: ['Create roles and set their permissions', 'Grant and revoke roles', 'Find grants left behind'], keywords: ['permissions', 'rbac', 'access'],
        routes: ['listRoles', 'createRole', 'setRolePermissions', 'retireRole', 'grantRole', 'revokeRole', 'listRoleAssignments', 'listOrphanedGrants'],
      },
      {
        id: 'scopes', label: 'Scopes', href: '/settings/scopes/', icon: 'ontology', purpose: 'Teams and areas of responsibility.',
        does: ['Create scopes and scope types', 'Add and remove members', 'Delegated administration'], keywords: ['teams', 'departments', 'sites', 'hierarchy'],
        routes: ['listScopes', 'createScope', 'updateScope', 'archiveScope', 'listScopeTypes', 'createScopeType', 'listScopeMembers', 'addScopeMember', 'removeScopeMember'],
      },
      {
        id: 'principals', label: 'Service principals', href: '/settings/principals/', icon: 'agent', purpose: 'Non-human identities for integrations.',
        does: ['Create and revoke service principals', 'Grant and remove their roles'], keywords: ['api clients', 'service accounts', 'machine'],
        routes: ['listServicePrincipals', 'createServicePrincipal', 'revokeServicePrincipal', 'grantPrincipalRole', 'removePrincipalRole'],
      },
      {
        id: 'scim', label: 'SCIM provisioning', href: '/settings/scim/', icon: 'refresh', purpose: 'People and groups from your identity provider.',
        does: ['Issue and revoke SCIM tokens', 'Map groups to roles'], keywords: ['provisioning', 'okta', 'entra', 'groups'],
        routes: ['listScimTokens', 'issueScimToken', 'revokeScimToken', 'listScimGroups', 'createScimGroupMapping', 'removeScimGroupMapping'],
      },
    ],
  },
  {
    id: 'signin', label: 'Sign-in',
    items: [
      {
        id: 'sso', label: 'Single sign-on', href: '/settings/sso/', icon: 'lock', purpose: 'How your people sign in.',
        does: ['Configure OIDC and SAML providers', 'Require single sign-on'], keywords: ['saml', 'oidc', 'entra', 'google', 'okta', 'identity provider'],
        routes: ['listIdentityProviders', 'readIdentityProvider', 'configureIdentityProvider'],
      },
    ],
  },
  {
    id: 'security', label: 'Security',
    items: [
      {
        id: 'markings', label: 'Markings and clearances', href: '/settings/markings/', icon: 'shield', purpose: 'Who may see marked data.',
        does: ['Create and retire markings', 'Apply markings to resources', 'Grant and revoke clearances'], keywords: ['classification', 'clearance', 'mandatory access'],
        routes: ['listMarkings', 'createMarking', 'retireMarking', 'applyMarking', 'listResourceMarkings', 'listClearances', 'grantClearance', 'revokeClearance'],
      },
      {
        id: 'declassifiers', label: 'Declassifiers', href: '/settings/declassifiers/', icon: 'key', purpose: 'Who may remove a marking.',
        does: ['Grant, approve and revoke declassifiers'], keywords: ['declassify'],
        routes: ['listDeclassifiers', 'grantDeclassifier', 'approveDeclassifier', 'revokeDeclassifier'],
      },
      {
        id: 'fieldpolicies', label: 'Field policies', href: '/settings/field-policies/', icon: 'eye', purpose: 'Rules that hide or mask fields.',
        does: ['Create and retire field policies'], keywords: ['masking', 'redaction', 'column security', 'pii'],
        routes: ['listFieldPolicies', 'createFieldPolicy', 'retireFieldPolicy'],
      },
      {
        id: 'purposedefs', label: 'Purposes', href: '/settings/purposes/', icon: 'document', purpose: 'The purposes people may declare.',
        does: ['Define and approve purposes', 'Grant and revoke eligibility'], keywords: ['purpose based access'],
        routes: ['listPurposeDefinitions', 'createPurposeDefinition', 'approvePurposeDefinition', 'setPurposeDefinitionStatus', 'listPurposeEligibility', 'grantPurposeEligibility', 'revokePurposeEligibility'],
      },
      {
        id: 'staffpolicy', label: 'Silo staff access', href: '/settings/staff-access/', icon: 'lock', purpose: 'When Silo staff may ask for access, and who approves.',
        does: ['Set the staff access policy'], keywords: ['break glass', 'support access', 'operator'],
        routes: ['getOperatorAccessPolicy', 'setOperatorAccessPolicy'],
      },
    ],
  },
  {
    id: 'change', label: 'Approvals and change',
    items: [
      {
        id: 'routing', label: 'Approval routing', href: '/settings/approval-routing/', icon: 'check', purpose: 'Who approves which changes.',
        does: ['Create and supersede approval policies', 'Set the policy floor'], keywords: ['approvers', 'four eyes', 'workflow'],
        routes: ['listApprovalPolicies', 'createApprovalPolicy', 'supersedeApprovalPolicy', 'setPolicyFloor'],
      },
      {
        id: 'changepolicy', label: 'Change policy and freezes', href: '/settings/change-policy/', icon: 'calendar', purpose: 'When releases may reach a dedicated cell.',
        does: ['Set windows and freezes', 'Approve a security fix during a freeze'], keywords: ['maintenance window', 'freeze', 'release'],
        routes: ['getChangePolicy', 'setChangePolicy', 'setChangeFreeze', 'endChangeFreeze', 'approveFreezeException'],
      },
    ],
  },
  {
    id: 'sharing', label: 'Sharing',
    items: [
      {
        id: 'sharing', label: 'Sharing policy', href: '/settings/sharing/', icon: 'share', purpose: 'What may be shared, and with whom.',
        does: ['Organisation and scope sharing policies'], keywords: ['external sharing'],
        routes: ['readSharingPolicy', 'setOrganisationSharingPolicy', 'setScopeSharingPolicy'],
      },
      {
        id: 'web', label: 'Ask and the web', href: '/settings/ask-web/', icon: 'globe', purpose: 'Whether Ask may read the public web.',
        does: ['Set the web context policy for the organisation and for scopes'], keywords: ['internet', 'web search'],
        routes: ['readAskWebPolicy', 'setAskWebPolicy', 'setAskWebScopePolicy'],
      },
    ],
  },
  {
    id: 'data', label: 'Data',
    items: [
      {
        id: 'siloes', label: 'Siloes', href: '/settings/siloes/', icon: 'siloes', purpose: 'Whether your organisation keeps any data in Silo.',
        does: ['Switch Siloes on, after reading the disclosure'], keywords: ['storage', 'data residency'],
        routes: ['getSiloesSetting', 'setSiloesEnabled'],
      },
      {
        id: 'inference', label: 'Inference', href: '/settings/inference/', icon: 'chart', purpose: 'Opt-in statistical inference.',
        does: ['Switch Bayesian inference on or off for each use'], keywords: ['bayesian', 'probability'],
        routes: ['getInferenceSettings', 'setInferenceSettings'],
      },
      {
        id: 'discovery', label: 'Discovery', href: '/settings/discovery/', icon: 'search', purpose: 'Whether agents may scan your network.',
        does: ['Switch discovery on or off'], keywords: ['network scan'],
        routes: ['getDiscoverySettings', 'setDiscoveryEnabled'],
      },
      {
        id: 'export', label: 'Organisation export', href: '/settings/export/', icon: 'download', purpose: 'Everything your organisation has in Silo, as files.',
        does: ['Request an export', 'Download it'], keywords: ['takeout', 'backup', 'portability'],
        routes: ['requestOrgExport', 'listOrgExports', 'getOrgExport', 'downloadOrgExport'],
      },
      {
        id: 'migration', label: 'Cell migration', href: '/settings/migration/', icon: 'arrowRight', purpose: 'Moving your organisation to another cell.',
        does: ['Request or withdraw a migration', 'Respond to a rebalancing'], keywords: ['move region', 'residency'],
        routes: ['listTenantMigrations', 'getTenantMigration', 'requestTenantMigration', 'withdrawTenantMigration', 'respondToRebalancing'],
      },
    ],
  },
  {
    id: 'billing', label: 'Billing',
    items: [
      {
        id: 'billing', label: 'Plan and invoices', href: '/settings/billing/', icon: 'document', purpose: 'Your plan, payment and invoices.',
        does: ['Read billing', 'Change plan at checkout', 'Open the billing portal'], keywords: ['invoice', 'payment', 'plan', 'subscription'],
        routes: ['readBilling', 'openBillingPortal', 'startCheckout', 'purchase'],
      },
      {
        id: 'tokens', label: 'Tokens and allowances', href: '/settings/tokens/', icon: 'chart', purpose: 'Model usage and daily limits.',
        does: ['Read the token ledger', 'Read a member\'s allowance', 'Automatic top-up'], keywords: ['ai usage', 'credits', 'limits'],
        routes: ['listTokenLedger', 'readMemberAllowance', 'setAutoTopup'],
      },
      {
        id: 'contracts', label: 'Contracts', href: '/settings/contracts/', icon: 'document', purpose: 'Enterprise contracts and their use.',
        does: ['Read contracts and usage'], keywords: ['enterprise', 'commitment'],
        routes: ['readContracts', 'readContractUsage'],
      },
    ],
  },
];

export const SETTINGS_ITEMS: readonly Place[] = SETTINGS.flatMap((g) => g.items);
