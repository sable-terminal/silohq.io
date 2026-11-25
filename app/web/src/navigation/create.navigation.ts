// The + menu: everything a person can make, grouped by what they are doing, each opening the
// place it is made in with its form open (?new=1). An item whose route the person may not call
// is shown disabled with the permission it needs.

import type { RouteName } from '../api/client.api.ts';
import type { IconName } from '../components/icon.component.tsx';

export interface Creatable {
  label: string;
  description: string;
  icon: IconName;
  href: string;
  /** The route that makes it: its permission decides whether the item is offered or disabled. */
  route: RouteName;
  keywords?: readonly string[];
}

export interface CreateGroup { label: string; items: readonly Creatable[] }

export const CREATE: readonly CreateGroup[] = [
  {
    label: 'Connect',
    items: [
      { label: 'Connection', description: 'Pick a system from the catalogue', icon: 'plug', href: '/connect/connections/?new=1', route: 'createConnection', keywords: ['integration', 'source'] },
      { label: 'Connector', description: 'Build one for a system the catalogue lacks', icon: 'edit', href: '/connect/builder/?new=1', route: 'draftConnector' },
      { label: 'Agent pool', description: 'For systems inside your network', icon: 'agent', href: '/connect/agents/?new=1', route: 'createAgentPool' },
      { label: 'Discovery scan', description: 'Find the systems on your network', icon: 'search', href: '/connect/discovery/?new=1', route: 'requestScanAuthorisation' },
      { label: 'AI FDE engagement', description: 'Let the AI engineer onboard a system', icon: 'sparkle', href: '/connect/fde/?new=1', route: 'startEngagement' },
      { label: 'Webhook', description: 'Send events to another system', icon: 'send', href: '/connect/webhooks/?new=1', route: 'registerOutboundWebhook' },
    ],
  },
  {
    label: 'Model',
    items: [
      { label: 'Object type', description: 'Proposed, then reviewed', icon: 'object', href: '/ontology/model/?new=object-type', route: 'putOntologyObjectType' },
      { label: 'Link type', description: 'How two types relate', icon: 'link', href: '/ontology/model/?new=link-type', route: 'putOntologyLinkType' },
      { label: 'Action type', description: 'A change people can propose', icon: 'play', href: '/ontology/actions/?new=1', route: 'proposeActionType' },
      { label: 'Ontology branch', description: 'Change the model safely', icon: 'branch', href: '/ontology/branches/?new=1', route: 'openOntologyBranch' },
      { label: 'State rule', description: 'Turn live values into states', icon: 'success', href: '/clones/states/?new=1', route: 'proposeStateRule' },
    ],
  },
  {
    label: 'Analyse',
    items: [
      { label: 'Question', description: 'Ask in plain language', icon: 'ask', href: '/ask/threads/?new=1', route: 'createAskThread' },
      { label: 'Workbook', description: 'A spreadsheet over objects', icon: 'table', href: '/studio/workbooks/?new=1', route: 'createWorkbook' },
      { label: 'Report', description: 'A document with live figures', icon: 'document', href: '/studio/reports/?new=1', route: 'createReport', keywords: ['note', 'notes', 'document'] },
      { label: 'Notebook', description: 'Cells over your data', icon: 'document', href: '/studio/notebooks/?new=1', route: 'createNotebook' },
      { label: 'Process analysis', description: 'Mine a process from history', icon: 'branch', href: '/studio/processes/?new=1', route: 'createProcess' },
      { label: 'Lens', description: 'Your private working layer', icon: 'lens', href: '/explorer/lenses/?new=1', route: 'createRecognitionLens' },
    ],
  },
  {
    label: 'Build and operate',
    items: [
      { label: 'App', description: 'An operational app in Studio', icon: 'studio', href: '/studio/apps/?new=1', route: 'createApp' },
      { label: 'Pipeline', description: 'Transform data on a schedule', icon: 'arrowRight', href: '/studio/pipelines/?new=1', route: 'createPipeline' },
      { label: 'AI agent', description: 'An assistant with tools', icon: 'agent', href: '/studio/agents/?new=1', route: 'createAiAgent' },
      { label: 'ML model', description: 'Train and predict', icon: 'chart', href: '/studio/models/?new=1', route: 'createMlModel' },
      { label: 'Cron', description: 'Watch, notify or act on a schedule', icon: 'cron', href: '/governance/crons/?new=1', route: 'createCron' },
      { label: 'Scenario', description: 'Test a change before you make it', icon: 'scenarios', href: '/scenarios/list/?new=1', route: 'saveSimulationScenario' },
    ],
  },
  {
    label: 'Files and storage',
    items: [
      { label: 'Upload', description: 'Add files', icon: 'upload', href: '/files/all/?new=upload', route: 'beginUploadToFiles' },
      { label: 'Folder', description: 'Organise files', icon: 'folder', href: '/files/folders/?new=1', route: 'createFolder' },
      { label: 'Media set', description: 'Images and documents on objects', icon: 'image', href: '/files/media/?new=1', route: 'createMediaSet' },
      { label: 'Import Silo', description: 'Read files into objects', icon: 'upload', href: '/siloes/import/?new=1', route: 'createImportSilo' },
    ],
  },
  {
    label: 'People and help',
    items: [
      { label: 'Invitation', description: 'Invite someone to your organisation', icon: 'people', href: '/settings/people/?new=1', route: 'createInvitation' },
    ],
  },
];
