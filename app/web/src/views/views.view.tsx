// Each place's view, by its address: the page a sidebar section, a settings page or an account page opens.

import type { ComponentType } from 'react';
import { Allowance } from './account/allowance.view.tsx';
import { Devices } from './account/devices.view.tsx';
import { Organisations } from './account/organisations.view.tsx';
import { Profile } from './account/profile.view.tsx';
import { Security } from './account/security.view.tsx';
import { Dashboard } from './ask/dashboard.view.tsx';
import { Threads } from './ask/threads.view.tsx';
import { EstateMap } from './clones/estate.view.tsx';
import { CanvasPlace, SavedCanvases } from './clones/saved.view.tsx';
import { Spatial } from './clones/spatial.view.tsx';
import { StateRules } from './clones/states.view.tsx';
import { Agents } from './connect/agents.view.tsx';
import { Builder } from './connect/builder.view.tsx';
import { Connections } from './connect/connections.view.tsx';
import { Discovery } from './connect/discovery.view.tsx';
import { Fde } from './connect/fde.view.tsx';
import { Industrial } from './connect/industrial.view.tsx';
import { OAuthApps } from './connect/oauthApps.view.tsx';
import { Webhooks } from './connect/webhooks.view.tsx';
import { SavedViews } from './ask/views.view.tsx';
import { Approvals } from './governance/approvals.view.tsx';
import { AuditLog } from './governance/audit.view.tsx';
import { Changes } from './governance/changes.view.tsx';
import { Crons } from './governance/crons.view.tsx';
import { Declassifications } from './governance/declassifications.view.tsx';
import { Lineage } from './governance/lineage.view.tsx';
import { Purposes } from './governance/purposes.view.tsx';
import { StaffAccess } from './governance/staff.view.tsx';
import { ActionTypes } from './ontology/actions.view.tsx';
import { Aliases } from './ontology/aliases.view.tsx';
import { Branches } from './ontology/branches.view.tsx';
import { Derive } from './ontology/derive.view.tsx';
import { Detectors } from './ontology/detectors.view.tsx';
import { Model } from './ontology/model.view.tsx';
import { Proposals } from './ontology/proposals.view.tsx';
import { Resolution } from './ontology/resolution.view.tsx';
import { Versions } from './ontology/versions.view.tsx';
import { Analyses } from './explorer/analysis.view.tsx';
import { Findings } from './explorer/findings.view.tsx';
import { Lenses } from './explorer/lenses.view.tsx';
import { Search } from './explorer/search.view.tsx';
import { ObjectSets } from './explorer/sets.view.tsx';
import { ObjectTypes } from './explorer/types.view.tsx';
import { AllFiles, Folders, SharedFiles } from './files/files.view.tsx';
import { MediaSets } from './files/media.view.tsx';
import { ScenarioBranches } from './scenarios/branches.view.tsx';
import { Capture } from './siloes/capture.view.tsx';
import { Charges } from './siloes/charges.view.tsx';
import { ImportSiloes } from './siloes/import.view.tsx';
import { ObjectIndex } from './siloes/index.view.tsx';
import { Overview } from './siloes/overview.view.tsx';
import { Purges } from './siloes/purges.view.tsx';
import { WarehousePage } from './siloes/warehouse.view.tsx';
import { Graph } from './scenarios/graph.view.tsx';
import { LeadTimes } from './scenarios/leadTimes.view.tsx';
import { Scenarios } from './scenarios/scenarios.view.tsx';
import { Billing, Contracts, Tokens } from './settings/billing.view.tsx';
import { ApprovalRouting, ChangePolicy } from './settings/change.view.tsx';
import { CellMigration, DiscoverySettings, InferenceSettings, OrgExport, SiloesSetting } from './settings/data.view.tsx';
import { Calendar, Domains, OrganisationProfile, Terminology } from './settings/organisation.view.tsx';
import { Members, Seats } from './settings/people.view.tsx';
import { Roles, Scim, Scopes, ServicePrincipals } from './settings/access.view.tsx';
import { Declassifiers, FieldPolicies, Markings, PurposeDefinitions, StaffAccessSettings } from './settings/security.view.tsx';
import { AskWeb, SharingPolicy } from './settings/sharing.view.tsx';
import { SingleSignOn } from './settings/signin.view.tsx';
import { AiAgents } from './studio/agents.view.tsx';
import { Apps } from './studio/apps.view.tsx';
import { Layouts } from './studio/layouts.view.tsx';
import { Models } from './studio/models.view.tsx';
import { Notebooks } from './studio/notebooks.view.tsx';
import { Pipelines } from './studio/pipelines.view.tsx';
import { Processes } from './studio/processes.view.tsx';
import { Reports } from './studio/reports.view.tsx';
import { Workbooks } from './studio/workbooks.view.tsx';

export const VIEWS: Readonly<Record<string, ComponentType>> = {
  '/account/profile/': Profile,
  '/account/security/': Security,
  '/account/devices/': Devices,
  '/account/allowance/': Allowance,
  '/account/organisations/': Organisations,
  '/ask/threads/': Threads,
  '/ask/dashboard/': Dashboard,
  '/ask/views/': SavedViews,
  '/connect/connections/': Connections,
  '/connect/agents/': Agents,
  '/connect/webhooks/': Webhooks,
  '/connect/oauth-apps/': OAuthApps,
  '/connect/industrial/': Industrial,
  '/connect/discovery/': Discovery,
  '/connect/builder/': Builder,
  '/connect/fde/': Fde,
  '/ontology/model/': Model,
  '/ontology/actions/': ActionTypes,
  '/ontology/resolution/': Resolution,
  '/ontology/derive/': Derive,
  '/ontology/detectors/': Detectors,
  '/ontology/proposals/': Proposals,
  '/ontology/branches/': Branches,
  '/ontology/versions/': Versions,
  '/ontology/aliases/': Aliases,
  '/governance/approvals/': Approvals,
  '/clones/canvas/': CanvasPlace,
  '/clones/saved/': SavedCanvases,
  '/clones/estate/': EstateMap,
  '/clones/states/': StateRules,
  '/clones/spatial/': Spatial,
  '/files/all/': AllFiles,
  '/files/folders/': Folders,
  '/files/shared/': SharedFiles,
  '/files/media/': MediaSets,
  '/siloes/overview/': Overview,
  '/siloes/capture/': Capture,
  '/siloes/import/': ImportSiloes,
  '/siloes/index/': ObjectIndex,
  '/siloes/warehouse/': WarehousePage,
  '/siloes/purges/': Purges,
  '/siloes/charges/': Charges,
  '/scenarios/list/': Scenarios,
  '/scenarios/branches/': ScenarioBranches,
  '/scenarios/graph/': Graph,
  '/scenarios/lead-times/': LeadTimes,
  '/studio/apps/': Apps,
  '/studio/workbooks/': Workbooks,
  '/studio/reports/': Reports,
  '/studio/notebooks/': Notebooks,
  '/studio/processes/': Processes,
  '/studio/pipelines/': Pipelines,
  '/studio/agents/': AiAgents,
  '/studio/models/': Models,
  '/studio/layouts/': Layouts,
  '/governance/changes/': Changes,
  '/governance/crons/': Crons,
  '/governance/lineage/': Lineage,
  '/governance/purposes/': Purposes,
  '/governance/declassifications/': Declassifications,
  '/governance/audit/': AuditLog,
  '/governance/staff/': StaffAccess,
  '/explorer/findings/': Findings,
  '/explorer/lenses/': Lenses,
  '/explorer/sets/': ObjectSets,
  '/explorer/analyses/': Analyses,
  '/explorer/types/': ObjectTypes,
  '/explorer/search/': Search,
  '/settings/profile/': OrganisationProfile,
  '/settings/calendar/': Calendar,
  '/settings/domains/': Domains,
  '/settings/terminology/': Terminology,
  '/settings/people/': Members,
  '/settings/seats/': Seats,
  '/settings/roles/': Roles,
  '/settings/scopes/': Scopes,
  '/settings/principals/': ServicePrincipals,
  '/settings/scim/': Scim,
  '/settings/sso/': SingleSignOn,
  '/settings/markings/': Markings,
  '/settings/declassifiers/': Declassifiers,
  '/settings/field-policies/': FieldPolicies,
  '/settings/purposes/': PurposeDefinitions,
  '/settings/staff-access/': StaffAccessSettings,
  '/settings/approval-routing/': ApprovalRouting,
  '/settings/change-policy/': ChangePolicy,
  '/settings/sharing/': SharingPolicy,
  '/settings/ask-web/': AskWeb,
  '/settings/siloes/': SiloesSetting,
  '/settings/inference/': InferenceSettings,
  '/settings/discovery/': DiscoverySettings,
  '/settings/export/': OrgExport,
  '/settings/migration/': CellMigration,
  '/settings/billing/': Billing,
  '/settings/tokens/': Tokens,
  '/settings/contracts/': Contracts,
};
