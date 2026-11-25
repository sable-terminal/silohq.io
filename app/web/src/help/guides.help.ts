// The help centre's guides: how to do the things people come to Silo to do, step by step, each
// pointing at the places it involves. Shipped with the client (no outside help site), so they work
// on every cell. Written for the people who use Silo, in the words its pages use.

export interface Guide {
  id: string;
  title: string;
  summary: string;
  /** The places it involves, by href: the help centre lists a page's guides from these. */
  places: readonly string[];
  steps: readonly string[];
  keywords?: readonly string[];
}

export const GUIDES: readonly Guide[] = [
  {
    id: 'connect-a-system',
    title: 'Connect your first system',
    summary: 'Give Silo read access to a system your organisation uses, so its records appear as objects.',
    places: ['/connect/connections/', '/connect/agents/'],
    keywords: ['integration', 'source', 'credentials', 'oauth', 'catalogue'],
    steps: [
      'Press + New at the top of any page and choose Connection, or go to Connect › Connections.',
      'Pick the system from the catalogue. If it is inside your network, set up an agent pool under Connect › Agents first.',
      'Name the connection and choose which scope owns it. Enter its credentials, or sign in with the provider when it uses OAuth. Silo seals them: nobody sees a secret again.',
      'Press Test it. The connection becomes ready when its checks pass; its health stays on the connection\'s page.',
      'To change how quickly changes arrive, open the connection and look at its change stream.',
    ],
  },
  {
    id: 'find-an-object',
    title: 'Find an object and see where its values come from',
    summary: 'Search across every system at once, open an object, and see each system\'s value side by side.',
    places: ['/explorer/types/', '/explorer/search/'],
    keywords: ['search', 'object view', 'disagree', 'values', 'lookup'],
    steps: [
      'Press / and type part of a name. Objects matching their title appear first; press Enter to open one.',
      'On the object\'s page, each property shows the value every system holds. Where systems disagree, Silo says so rather than choosing.',
      'Links take you to related objects; the timeline shows what changed, and findings show what Recognition noticed about it.',
      'To browse a whole type instead, go to Explorer › Object types and narrow it with the facets on the left.',
    ],
  },
  {
    id: 'ask-a-question',
    title: 'Ask a question about your data',
    summary: 'Ask in plain language and get an answer that says where every figure came from.',
    places: ['/ask/threads/', '/ask/views/', '/ask/dashboard/'],
    keywords: ['ai', 'question', 'natural language', 'answer', 'chat'],
    steps: [
      'Open the Ask panel on the right of any page (Ctrl J), or go to Ask › Threads.',
      'Type your question as you would ask a colleague. A question asked from a page is scoped to what that page shows.',
      'If Silo is not sure what you meant, it asks; choose the option you meant.',
      'An answer you want again can be saved as a view; favourite a saved view to put it on your dashboard.',
    ],
  },
  {
    id: 'propose-a-change',
    title: 'Propose a change and get it approved',
    summary: 'Change a record in a connected system through an Action, reviewed before anything is written.',
    places: ['/explorer/types/', '/governance/approvals/', '/governance/changes/'],
    keywords: ['action', 'write back', 'edit', 'approval', 'revert'],
    steps: [
      'Open the object you want to change and choose the Action from its Actions list.',
      'Fill in the Action\'s form. Silo shows exactly what would change in each system before you submit it.',
      'Approvers are told; they see the change and its reach under Governance › Approvals.',
      'Once approved and carried out, the receipt is under Governance › Changes, where the change can also be reverted.',
    ],
  },
  {
    id: 'watch-with-a-cron',
    title: 'Watch for something with a Cron',
    summary: 'Run a saved view on a schedule and be told, or act, when its result crosses a line.',
    places: ['/governance/crons/', '/ask/views/'],
    keywords: ['alert', 'schedule', 'monitor', 'notify', 'automation'],
    steps: [
      'Save the question you want watched as a view.',
      'Press + New and choose Cron. Pick the saved view, when it runs, and what counts as the condition being met.',
      'Choose what happens: notify people, deliver a report, or propose an Action for someone to approve.',
      'Each run is listed on the Cron; people who follow it see its runs on their Home briefing.',
    ],
  },
  {
    id: 'invite-your-team',
    title: 'Invite your team and give them roles',
    summary: 'Add people to your organisation and decide what each of them may do.',
    places: ['/settings/people/', '/settings/roles/', '/settings/scopes/', '/settings/seats/'],
    keywords: ['users', 'members', 'permissions', 'roles', 'access'],
    steps: [
      'Open Settings (the cog at the top right) › People › Members and invitations.',
      'Invite each person by email, with a role and, if their access should be limited to part of the organisation, a scope.',
      'They receive an email with a link; opening it lets them choose a password and join.',
      'Change what a role may do under Settings › People › Roles. Anything a person may not use appears disabled, naming the permission it needs.',
    ],
  },
  {
    id: 'single-sign-on',
    title: 'Turn on single sign-on',
    summary: 'Let your people sign in with your identity provider, and optionally require it.',
    places: ['/settings/sso/', '/settings/domains/', '/settings/scim/'],
    keywords: ['saml', 'oidc', 'entra', 'okta', 'google', 'sso', 'scim'],
    steps: [
      'Verify your email domain under Settings › Organisation › Domains.',
      'Under Settings › Sign-in › Single sign-on, add your identity provider (OIDC or SAML) with the details it gives you.',
      'Test it by signing in through it yourself before requiring it for everyone.',
      'To create and remove people automatically, issue a SCIM token under Settings › People › SCIM provisioning.',
    ],
  },
  {
    id: 'keep-history',
    title: 'Keep the history of fields with a capture Silo',
    summary: 'Silo reads your systems where they are; a capture Silo keeps a history of the fields you choose.',
    places: ['/settings/siloes/', '/siloes/capture/', '/siloes/overview/'],
    keywords: ['history', 'time travel', 'storage', 'retention', 'audit'],
    steps: [
      'Switch Siloes on under Settings › Data › Siloes, after reading what Silo will then keep.',
      'Under Siloes › Capture, create a capture Silo and choose the types and fields to keep history for, and for how long.',
      'Each object\'s timeline then shows how those fields changed; the capture ledger lists every change kept.',
    ],
  },
  {
    id: 'what-if',
    title: 'Test a change before you make it',
    summary: 'Run a scenario over your dependency graph to see what a failure or a change would reach.',
    places: ['/scenarios/list/', '/scenarios/graph/', '/scenarios/branches/'],
    keywords: ['simulation', 'impact', 'what if', 'monte carlo', 'dependencies'],
    steps: [
      'Make sure the dependencies that matter are confirmed under Scenarios › Dependency graph: Silo only walks edges a person confirmed.',
      'Press + New and choose Scenario. Say what fails or changes, and when.',
      'Run it. The result lists what it reaches through hard edges, and what it would delay through soft ones.',
      'To try Actions safely, stage them in a branch under Scenarios › Branches and compare the branch before promoting anything.',
    ],
  },
  {
    id: 'get-help',
    title: 'Get help from Silo support',
    summary: 'Raise a support ticket from inside Silo, and follow its replies.',
    places: ['/help/'],
    keywords: ['support', 'ticket', 'contact', 'problem', 'bug'],
    steps: [
      'Press the ticket icon at the top right, then New ticket. If something just failed, its reference is filled in for you.',
      'Describe what happened and what you expected. Refer to things in Silo by choosing them: never paste record values, emails or account numbers.',
      'Support replies in the ticket; you are told in your notifications. If support needs to look inside your organisation, they ask under Governance › Silo staff access, naming the ticket.',
    ],
  },
];
