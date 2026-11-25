'use client';

// Sharing and web context (spec 37.4, 36.7): the organisation's ceiling on sharing saved views,
// apps and scenarios (a scope may narrow it for its members, never widen it), and whether Ask may
// search the web for outside context, shown apart from the organisation's data and cited. In a
// scope, web context may be off, or on within domain lists; where the scope holds marked data it
// stays off unless an admin holding every marking there turns it on despite it.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, Switch, TextArea } from '../../components/field.component.tsx';
import { Page, Panel, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import styles from './settings.view.module.css';

type Level = Output<'readSharingPolicy'>['organisation']['viewSharingPolicy'];
type WebScope = Output<'readAskWebPolicy'>['scopes'][number];
const crumbs = [{ label: 'Settings', href: '/settings/' }];
const LEVELS: Record<Level, string> = {
  open: 'Open: with people, scopes or everyone',
  scope_only: 'Within scopes only',
  explicit_only: 'Only with named people',
  disabled: 'No sharing',
};
const NARROWER: Level[] = ['open', 'scope_only', 'explicit_only', 'disabled'];
const indent = (depth: number) => ' '.repeat(depth * 2);

/** /settings/sharing/: the organisation's ceiling on sharing, and where scopes narrow it. */
export function SharingPolicy() {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('readSharingPolicy', {});
  const setOrg = useMutation('setOrganisationSharingPolicy', { invalidates: ['readSharingPolicy'], onSuccess: () => say('Saved') });
  const setScope = useMutation('setScopeSharingPolicy', { invalidates: ['readSharingPolicy'] });
  const narrowable = useQuery('listMyPermittedScopes', { query: { permission: 'scope.sharing.narrow' } });
  const [narrowing, setNarrowing] = useState<{ scopeId: string; level: Level } | undefined>();
  return (
    <Page title="Sharing policy" description="What saved views, apps and scenarios may be shared, and with whom. A scope can narrow this for its members, never widen it." crumbs={crumbs} width="narrow"
      actions={(narrowable.data?.scopes.length ?? 0) > 0 ? <Button onClick={() => setNarrowing({ scopeId: '', level: 'scope_only' })}>Narrow in a scope</Button> : undefined}>
      <QueryView query={read} what="The sharing policy">
        {(p) => (
          <div className={styles.stack}>
            {setOrg.error !== undefined ? <ErrorMessage error={setOrg.error} /> : null}
            <Section title="Your organisation">
              <div className={styles.form}>
                <SelectField label="Sharing saved views, apps and scenarios" value={p.organisation.viewSharingPolicy} disabled={setOrg.pending || setOrg.blocked !== undefined}
                  hint={setOrg.blocked?.message ?? 'A scope can narrow this for its members, never widen it.'}
                  onChange={(e) => void setOrg.run({ body: { viewSharingPolicy: e.target.value as Level, orgWideSharingPermitted: p.organisation.orgWideSharingPermitted } })}
                  options={NARROWER.map((l) => ({ value: l, label: LEVELS[l] }))} />
                <Checkbox label="Something may be shared with everyone in the organisation at once" checked={p.organisation.orgWideSharingPermitted} disabled={setOrg.pending || setOrg.blocked !== undefined}
                  onChange={(e) => void setOrg.run({ body: { viewSharingPolicy: p.organisation.viewSharingPolicy, orgWideSharingPermitted: e.target.checked } })} />
              </div>
            </Section>
            <Panel>
              <span className={styles.muted}>For you, where you work now: {LEVELS[p.effective.viewSharingPolicy].toLowerCase()}{p.effective.orgWideSharingPermitted ? ', and with everyone at once' : ''}.</span>
            </Panel>
            <Section title="Narrower in scopes">
              {p.scopes.length === 0 ? <p className={styles.muted}>No scope narrows it.</p> : (
                <DataTable label="Scope sharing policies" rows={p.scopes} rowKey={(s) => s.scopeId} columns={[
                  { id: 'scope', header: 'Scope', primary: true, cell: (s) => people.scopeName(s.scopeId) },
                  { id: 'level', header: 'Sharing', cell: (s) => LEVELS[s.viewSharingPolicy] },
                  { id: 'by', header: 'Set', cell: (s) => <span>{people.nameOf(s.setBy)}, <Time value={s.setAt} /></span> },
                  { id: 'act', header: <span className="visually-hidden">Change</span>, align: 'end', cell: (s) => (narrowable.data?.scopes.some((x) => x.id === s.scopeId) === true
                    ? <Button size="sm" variant="ghost" onClick={() => setNarrowing({ scopeId: s.scopeId, level: s.viewSharingPolicy })}>Change</Button> : null) },
                ]} />
              )}
            </Section>
          </div>
        )}
      </QueryView>
      <Dialog open={narrowing !== undefined} onClose={() => { setNarrowing(undefined); setScope.reset(); }} title="Sharing in a scope" size="sm" busy={setScope.pending}
        description="Members of the scope, and of the scopes under it, may share no more widely than this.">
        {narrowing !== undefined ? (
          <form className={styles.form} onSubmit={async (e) => {
            e.preventDefault();
            const r = await setScope.run({ params: { scopeId: narrowing.scopeId }, body: { viewSharingPolicy: narrowing.level } });
            if (r.ok) {
              setNarrowing(undefined);
              say('Saved');
            }
          }}>
            <SelectField label="Scope" required value={narrowing.scopeId} placeholder="Choose a scope" onChange={(e) => setNarrowing({ ...narrowing, scopeId: e.target.value })}
              options={(narrowable.data?.scopes ?? []).map((s) => ({ value: s.id, label: `${indent(s.depth)}${s.name}` }))} />
            <SelectField label="Sharing there" value={narrowing.level} onChange={(e) => setNarrowing({ ...narrowing, level: e.target.value as Level })}
              options={NARROWER.map((l) => ({ value: l, label: LEVELS[l] }))} hint="Wider than the organisation's own policy has no effect." />
            {setScope.error !== undefined ? <ErrorMessage error={setScope.error} /> : null}
            <FormActions><Button onClick={() => setNarrowing(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={setScope.pending} disabled={narrowing.scopeId === ''}>Save</Button></FormActions>
          </form>
        ) : null}
      </Dialog>
    </Page>
  );
}

const domainsOf = (text: string) => [...new Set(text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter((d) => d !== ''))];

/** /settings/ask-web/: whether Ask may search the web, for the organisation and in each scope. */
export function AskWeb() {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('readAskWebPolicy', {});
  const set = useMutation('setAskWebPolicy', { invalidates: ['readAskWebPolicy'] });
  const manageable = useQuery('listMyPermittedScopes', { query: { permission: 'ask.web.manage' } });
  const [editing, setEditing] = useState<WebScope | 'new' | undefined>();
  return (
    <Page title="Ask and the web" description="Whether Ask may search the web for outside context. What it finds is shown apart from your data, each source cited, and only the search words leave the organisation." crumbs={crumbs} width="narrow"
      actions={(manageable.data?.scopes.length ?? 0) > 0 ? <Button onClick={() => setEditing('new')}>Set for a scope</Button> : undefined}>
      <QueryView query={read} what="The web context policy">
        {(p) => (
          <div className={styles.stack}>
            {!p.available ? <Banner tone="info" title="No web search on this cell">Ask cannot search the web here, whatever is set; the policy applies if a provider is added.</Banner> : null}
            {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
            <Panel>
              <Switch label="Ask may search the web" checked={p.enabled} disabled={set.pending} blocked={set.blocked}
                hint="Off here turns it off everywhere in the organisation. On, a scope may still turn it off or limit its domains."
                onChange={(on) => void set.run({ body: { enabled: on } }).then((r) => r.ok && say(r.data.enabled ? 'Ask may search the web' : 'Ask will not search the web'))} />
            </Panel>
            <Section title="In scopes" description="Off in any scope a member sits in or under turns it off for them.">
              {p.scopes.length === 0 ? <p className={styles.muted}>No scope sets its own.</p> : (
                <DataTable label="Web context in scopes" rows={p.scopes} rowKey={(s) => s.scopeId} columns={[
                  { id: 'scope', header: 'Scope', primary: true, cell: (s) => people.scopeName(s.scopeId) },
                  { id: 'on', header: 'Web search', width: 'sm', cell: (s) => (s.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>) },
                  { id: 'domains', header: 'Domains', cell: (s) => (s.allowedDomains.length > 0 ? `Only ${s.allowedDomains.join(', ')}` : s.blockedDomains.length > 0 ? `Not ${s.blockedDomains.join(', ')}` : 'Any') },
                  { id: 'marked', header: 'Marked data', cell: (s) => (!s.markedData ? '—' : s.coveredMarkings > 0 ? `On despite ${s.coveredMarkings} marking${s.coveredMarkings === 1 ? '' : 's'}` : 'Held: off') },
                  { id: 'by', header: 'Set', cell: (s) => <span>{people.nameOf(s.updatedBy)}, <Time value={s.updatedAt} /></span> },
                  { id: 'act', header: <span className="visually-hidden">Change</span>, align: 'end', cell: (s) => (manageable.data?.scopes.some((x) => x.id === s.scopeId) === true
                    ? <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Change</Button> : null) },
                ]} />
              )}
            </Section>
          </div>
        )}
      </QueryView>
      {editing !== undefined ? <WebScopeDialog current={editing === 'new' ? undefined : editing} scopes={manageable.data?.scopes ?? []} onClose={() => setEditing(undefined)} /> : null}
    </Page>
  );
}

function WebScopeDialog({ current, scopes, onClose }: { current: WebScope | undefined; scopes: Output<'listMyPermittedScopes'>['scopes']; onClose: () => void }) {
  const say = useToast();
  const set = useMutation('setAskWebScopePolicy', { invalidates: ['readAskWebPolicy'] });
  const [f, setF] = useState({
    scopeId: current?.scopeId ?? '', enabled: current?.enabled ?? true, allowed: current?.allowedDomains.join(', ') ?? '',
    blocked: current?.blockedDomains.join(', ') ?? '', cover: (current?.coveredMarkings ?? 0) > 0,
  });
  return (
    <Dialog open onClose={onClose} title="Web search in a scope" size="sm" busy={set.pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await set.run({ params: { scopeId: f.scopeId }, body: { enabled: f.enabled, allowedDomains: domainsOf(f.allowed), blockedDomains: domainsOf(f.blocked), coverMarkedData: f.enabled && f.cover } });
        if (r.ok) {
          say(r.data.enabled ? 'Saved: web search is on in this scope, within its domains' : 'Saved: web search is off in this scope');
          onClose();
        }
      }}>
        <SelectField label="Scope" required value={f.scopeId} placeholder="Choose a scope" disabled={current !== undefined} onChange={(e) => setF({ ...f, scopeId: e.target.value })}
          options={scopes.map((s) => ({ value: s.id, label: `${indent(s.depth)}${s.name}` }))} />
        <Switch label="Web search on in this scope" checked={f.enabled} onChange={(on) => setF({ ...f, enabled: on })} />
        {f.enabled ? (
          <>
            <TextArea label="Only these domains (optional)" rows={2} value={f.allowed} onChange={(e) => setF({ ...f, allowed: e.target.value })} hint="Separated by commas or spaces, such as gov.uk, ons.gov.uk." />
            <TextArea label="Never these domains (optional)" rows={2} value={f.blocked} onChange={(e) => setF({ ...f, blocked: e.target.value })} />
            <Checkbox label="On despite marked data in this scope" checked={f.cover} onChange={(e) => setF({ ...f, cover: e.target.checked })} hint="You must hold every marking held there now." />
          </>
        ) : null}
        {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={set.pending} disabled={f.scopeId === ''}>Save for this scope</Button></FormActions>
      </form>
    </Dialog>
  );
}
