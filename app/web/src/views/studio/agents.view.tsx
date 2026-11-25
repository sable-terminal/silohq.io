'use client';

// AI agents (D236): assistants with tools you choose. A builder writes what the agent is for and
// how to read the questions put to it (its brief), chooses the object types it works with and what
// it may do, and shares it. Anyone holding it talks to it in an Ask thread, where it answers under
// their own access and proposes nothing that is done without a person. Its brief is shown to
// everyone who may ask it: what shapes an answer is never hidden.

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { ConfirmDialog } from '../../components/dialog.component.tsx';
import { Checkbox, TextArea, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { useTab } from '../../components/tabs.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { threadHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { valuesIn } from '../../utils/values.util.ts';
import { Directory, FILTERS, HELD, idFrom, NameDialog, NotFound, sharesFor } from './kit.view.tsx';
import styles from './studio.view.module.css';

type Agent = Output<'getAiAgent'>;
type Tool = Agent['tools'][number];
type Definition = Pick<Agent, 'name' | 'description' | 'brief' | 'objectTypeIds' | 'tools'>;
const agentHref = (id: string) => hrefWith('/studio/agents/', { agent: id });
const MAX_BRIEF = 8_000;

export const TOOL_LABEL: Record<Tool, string> = {
  answer: 'Answer questions', find_objects: 'Find objects', propose_action: 'Propose changes (a person submits them)', propose_cron: 'Propose Crons (a person saves them)',
};
const TOOLS = Object.keys(TOOL_LABEL) as Tool[];
const ACCESS = [
  { value: 'view' as const, label: 'Ask it', hint: 'Talk to it in Ask, and read its brief' },
  { value: 'copy' as const, label: 'Ask or copy it', hint: 'And make an agent of their own from it' },
];

/** /studio/agents/: the directory, or an agent open. The earlier address's ?aiAgent= is read too. */
export function AiAgents() {
  const [params] = useParams();
  const open = params.get('agent') ?? params.get('aiAgent');
  if (open === null) return <AgentDirectory />;
  const id = idFrom(open);
  return id === undefined ? <NotFound title="AI agents" what="an AI agent" icon="agent" href="/studio/agents/" /> : <AgentEditor key={id} aiAgentId={id} />;
}

function AgentDirectory() {
  const router = useRouter();
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listAiAgents', { query: { filter } }, { keepPrevious: true });
  const create = useMutation('createAiAgent', { invalidates: ['listAiAgents'] });
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'AI agents' });
  return (
    <Directory title="AI agents" what="AI agent" icon="agent" description="Agents for a purpose: a brief in your words, the types they work with and what they may do. Each answers in Ask under the permissions of whoever asks it."
      filter={filter} onFilter={setFilter} query={list} rows={(d) => d.aiAgents} hrefOf={agentHref}
      columns={[{ id: 'what', header: 'For', cell: (a) => a.description || '—' }]}
      createBlocked={create.blocked} createPending={create.pending} createError={create.error}
      onCreate={(name) => void create.run({ body: { name, tools: ['answer', 'find_objects'] } }).then((r) => r.ok && router.push(agentHref(r.data.id) as never))}
      emptyMine="An agent answers questions about your data in your organisation's own words, under the access of whoever asks it." />
  );
}

function AgentEditor({ aiAgentId }: { aiAgentId: string }) {
  const router = useRouter();
  const say = useToast();
  const { lookup, data: vocabulary } = useVocabulary();
  const read = useQuery('getAiAgent', { params: { aiAgentId } });
  const save = useMutation('saveAiAgent', { invalidates: ['getAiAgent', 'listAiAgents'] });
  const talk = useMutation('createAskThread', { invalidates: ['listAskThreads'] });
  const copy = useMutation('copyAiAgent', { invalidates: ['listAiAgents'] });
  const archive = useMutation('archiveAiAgent', { invalidates: ['listAiAgents', 'getAiAgent'] });
  const shares = useQuery('listAiAgentShares', read.data?.access === 'owner' ? { params: { aiAgentId } } : null);
  const share = useMutation('shareAiAgent', { invalidates: ['listAiAgentShares', 'getAiAgent'] });
  const revoke = useMutation('revokeAiAgentShare', { invalidates: ['listAiAgentShares', 'getAiAgent'] });
  const [draft, setDraft] = useState<Definition | undefined>();
  const [base, setBase] = useState<number | undefined>();
  const [edited, setEdited] = useState(false);
  const [dialog, setDialog] = useState<'share' | 'copy' | 'archive' | undefined>();
  const a = read.data;
  // The agent as read, taken while nothing is changed here.
  useEffect(() => {
    if (a === undefined || edited) return;
    if (base !== undefined && a.lockVersion <= base) return;
    setDraft({ name: a.name, description: a.description, brief: a.brief, objectTypeIds: a.objectTypeIds, tools: a.tools });
    setBase(a.lockVersion);
  }, [a, edited, base]);
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: a?.name ?? 'an AI agent' });
  if (a === undefined || draft === undefined) {
    return <Page title="AI agent" crumbs={[{ label: 'Studio' }, { label: 'AI agents', href: '/studio/agents/' }]}><QueryView query={read} what="The AI agent">{() => null}</QueryView></Page>;
  }
  const owner = a.access === 'owner';
  const archived = a.archivedAt !== null;
  const editable = owner && !archived;
  const change = (d: Partial<Definition>) => {
    setDraft({ ...draft, ...d });
    setEdited(true);
  };
  const briefWarning = valuesIn(draft.brief).length === 0 ? undefined
    : 'This looks like it holds a record value, such as an email address or an account number. A brief goes to a model with every question, so the cell refuses one: describe the value instead.';
  const stale = edited && base !== undefined && a.lockVersion > base;
  return (
    <Page title={a.name} documentTitle={a.name} crumbs={[{ label: 'Studio' }, { label: 'AI agents', href: '/studio/agents/' }]}
      description="It answers in Ask under the permissions of whoever asks it: it sees only what they may see, and proposes nothing that is done without a person."
      meta={<span className={styles.row}>{archived ? <Badge>Archived</Badge> : null}{!owner ? <Badge tone="info">{HELD[a.access]}</Badge> : null}{edited ? <Badge tone="warn">Unsaved changes</Badge> : null}</span>}
      actions={
        <div className={styles.row}>
          {editable ? (
            <Button variant="primary" icon="check" pending={save.pending} disabled={!edited} blocked={draft.name.trim() === '' ? 'Give it a name' : draft.tools.length === 0 ? 'Choose what it may do' : save.blocked}
              onClick={() => void save.run({ params: { aiAgentId }, body: { ...draft, lockVersion: base ?? a.lockVersion } }).then((r) => {
                if (!r.ok) return;
                setEdited(false);
                setBase(r.data.lockVersion);
                say('Saved: threads with it use this from their next question');
              })}>Save</Button>
          ) : null}
          {!archived ? (
            <Button variant={editable ? 'secondary' : 'primary'} icon="ask" pending={talk.pending} blocked={edited ? 'Save your changes first' : talk.blocked}
              onClick={() => void talk.run({ body: { aiAgentId } }).then((r) => r.ok && router.push(threadHref(r.data.id) as never))}>Talk to it</Button>
          ) : null}
          {owner ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Make a copy', icon: 'copy', disabled: !(owner || a.access === 'copy'), blocked: copy.blocked, onSelect: () => setDialog('copy') },
            { separator: true },
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: !owner || archived, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(x) => <IconButton {...x} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        {archived ? <Banner tone="info" title="Archived">It is asked no more.</Banner> : null}
        {stale ? <Banner tone="warn" title="Saved elsewhere since you opened it">Saving now would be refused. Copy what you changed, then open it again.</Banner> : null}
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        {talk.error !== undefined ? <ErrorMessage error={talk.error} /> : null}
        {editable ? (
          <>
            <Section title="What it is">
              <div className={styles.form}>
                <TextField label="Name" required value={draft.name} maxLength={200} onChange={(e) => change({ name: e.target.value })} />
                <TextField label="Description" value={draft.description} maxLength={2000} onChange={(e) => change({ description: e.target.value })} hint="Shown in the list and to whoever may ask it." />
                <TextArea label="Brief" rows={10} value={draft.brief} maxLength={MAX_BRIEF} onChange={(e) => change({ brief: e.target.value })}
                  error={briefWarning}
                  hint={`What it is for, and what your words mean here ("open means sent and not yet paid"). It goes to a model with every question, so it may not hold a record value such as an email address or an account number. ${formatNumber(draft.brief.length)} of ${formatNumber(MAX_BRIEF)} characters.`} />
              </div>
            </Section>
            <Section title="Object types it works with" description={draft.objectTypeIds.length === 0 ? 'None chosen: every type the person asking may see.' : 'Only these, of those the person asking may see.'}>
              <div className={styles.checks}>
                {(vocabulary?.objectTypes ?? []).map((t) => (
                  <Checkbox key={t.id} label={t.pluralName} checked={draft.objectTypeIds.includes(t.id)}
                    onChange={(e) => change({ objectTypeIds: e.target.checked ? [...draft.objectTypeIds, t.id] : draft.objectTypeIds.filter((x) => x !== t.id) })} />
                ))}
                {draft.objectTypeIds.filter((id) => lookup?.types.has(id) === false).map((id) => (
                  <Checkbox key={id} label="A type you may not see" checked onChange={() => change({ objectTypeIds: draft.objectTypeIds.filter((x) => x !== id) })} />
                ))}
              </div>
            </Section>
            <Section title="What it may do" description={draft.tools.length === 0 ? 'Choose at least one.' : undefined}>
              <div className={styles.checks}>
                {TOOLS.map((tool) => (
                  <Checkbox key={tool} label={TOOL_LABEL[tool]} checked={draft.tools.includes(tool)}
                    onChange={(e) => change({ tools: e.target.checked ? TOOLS.filter((x) => x === tool || draft.tools.includes(x)) : draft.tools.filter((x) => x !== tool) })} />
                ))}
              </div>
            </Section>
          </>
        ) : (
          <>
            {a.description !== '' ? <p>{a.description}</p> : null}
            <Panel>
              <Properties columns={1} items={[
                ['Works with', a.objectTypeIds.length === 0 ? 'Every type you may see' : a.objectTypeIds.map((id) => lookup?.typeName(id, true) ?? '…').join(', ')],
                ['May', a.tools.map((t) => TOOL_LABEL[t]).join('; ')],
              ]} />
            </Panel>
            <Section title="Its brief" description="What shapes its answers, as its builder wrote it.">
              {a.brief === '' ? <p className={styles.muted}>No brief.</p> : <p className={styles.prose}>{a.brief}</p>}
            </Section>
          </>
        )}
      </div>
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${a.name}`} what="this AI agent" access={ACCESS}
        shares={sharesFor(shares.data?.shares)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee, access) => share.run({ params: { aiAgentId }, body: { grantee, access } })}
        onRevoke={(shareId) => revoke.run({ params: { aiAgentId, shareId } })} />
      <NameDialog open={dialog === 'copy'} title="Copy the AI agent" initial={`${a.name} (copy)`.slice(0, 200)} action="Make the copy" pending={copy.pending} error={copy.error}
        onClose={() => setDialog(undefined)}
        onSave={(name) => void copy.run({ params: { aiAgentId }, body: { name } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          router.push(agentHref(r.data.id) as never);
        })} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${a.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { aiAgentId } });
          if (r.ok) say('Archived: it is asked no more');
          return r;
        }}><p>Threads with it stay readable; it answers no new questions.</p></ConfirmDialog>
    </Page>
  );
}
