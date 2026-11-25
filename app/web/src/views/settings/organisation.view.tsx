'use client';

// The organisation (spec 33.4): how it appears (its logo), its calendar (the time zone and the
// financial year Crons, schedules, reports and lead times read), the email domains it owns (each
// proved by a DNS record before it is trusted), and its own words for types, links and Actions.

import { useEffect, useRef, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { CopyButton } from '../../components/copy.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useOrganisationLogo } from '../../hooks/organisationLogo.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { useWorkspace } from '../../shell/context.shell.tsx';
import { formatBytes } from '../../utils/format.util.ts';
import { base64Of } from '../files/transfer.view.ts';
import styles from './settings.view.module.css';

const crumbs = [{ label: 'Settings', href: '/settings/' }];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** /settings/profile/: the organisation's name, and its logo as people see it in the header. */
export function OrganisationProfile() {
  const say = useToast();
  const workspace = useWorkspace();
  const logo = useOrganisationLogo();
  const set = useMutation('setOrganisationLogo', { invalidates: ['readOrganisationLogo'] });
  const input = useRef<HTMLInputElement>(null);
  const name = workspace.memberships.find((m) => m.organisationId === workspace.session.organisationId)?.organisationName ?? 'Your organisation';
  return (
    <Page title="Name and logo" description="How your organisation appears in Silo." crumbs={crumbs} width="narrow">
      <div className={styles.stack}>
        <Panel>
          <Properties columns={1} items={[['Name', name], ['Address', workspace.memberships.find((m) => m.current)?.organisationSlug ?? '—']]} />
        </Panel>
        <Section title="Logo" description="Shown in the header for everyone in the organisation. PNG, JPEG, WebP or SVG.">
          <div className={styles.stack}>
            {logo.url !== undefined ? <img src={logo.url} alt={`${name} logo`} className={styles.logo} /> : logo.status === 'none' ? <p className={styles.muted}>No logo yet.</p> : null}
            <form className={styles.rowEnd} onSubmit={async (e) => {
              e.preventDefault();
              const file = input.current?.files?.[0];
              if (file === undefined) return;
              const r = await set.run({ body: { contentBase64: await base64Of(file) } });
              if (r.ok) {
                say(`Logo set: ${r.data.width ?? '?'} × ${r.data.height ?? '?'}, ${formatBytes(r.data.bytes)}`);
                if (input.current !== null) input.current.value = '';
              }
            }}>
              <label className={styles.stackTight}><span>Image</span><input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" required className={styles.fileInput} aria-label="Logo image" /></label>
              <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked}>Set the logo</Button>
            </form>
            {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
          </div>
        </Section>
      </div>
    </Page>
  );
}

/** /settings/calendar/: the time zone, week and financial year everything scheduled reads. */
export function Calendar() {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('readOrganisationCalendar', {});
  const set = useMutation('setOrganisationCalendar', { invalidates: ['readOrganisationCalendar'] });
  const [form, setForm] = useState<Output<'readOrganisationCalendar'> | undefined>();
  useEffect(() => {
    if (read.data !== undefined) setForm(read.data);
  }, [read.data]);
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [form?.timeZone ?? 'Europe/London'];
  return (
    <Page title="Calendar" description="The time zone, week and financial year that Crons, schedules, reports and lead times use." crumbs={crumbs} width="narrow">
      <QueryView query={read} what="The calendar">
        {(c) => form === undefined ? null : (
          <form className={styles.form} onSubmit={async (e) => {
            e.preventDefault();
            const r = await set.run({ body: {
              timeZone: form.timeZone, financialYearStartMonth: form.financialYearStartMonth, financialYearStartDay: form.financialYearStartDay,
              weekStartDay: form.weekStartDay, financialYearLabel: form.financialYearStartMonth === null ? null : form.financialYearLabel ?? 'end_year', version: c.version,
            } });
            if (r.ok) say('Saved');
          }}>
            <SelectField label="Time zone" value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} options={zones.map((z) => ({ value: z, label: z.replaceAll('_', ' ') }))} />
            <SelectField label="Weeks start on" value={String(form.weekStartDay)} onChange={(e) => setForm({ ...form, weekStartDay: Number(e.target.value) })} options={DAYS.map((d, i) => ({ value: String(i), label: d }))} />
            <SelectField label="Financial year" value={form.financialYearStartMonth === null ? '' : String(form.financialYearStartMonth)} onChange={(e) => setForm({ ...form, financialYearStartMonth: e.target.value === '' ? null : Number(e.target.value) })}
              options={[{ value: '', label: 'The calendar year' }, ...MONTHS.map((m, i) => ({ value: String(i + 1), label: `Starts in ${m}` }))]} />
            {form.financialYearStartMonth !== null ? (
              <div className={styles.fields}>
                <TextField label="On day" type="number" min={1} max={31} value={form.financialYearStartDay} onChange={(e) => setForm({ ...form, financialYearStartDay: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })} />
                <SelectField label="A year is named by" value={form.financialYearLabel ?? 'end_year'} onChange={(e) => setForm({ ...form, financialYearLabel: e.target.value as 'end_year' | 'start_year' })}
                  options={[{ value: 'end_year', label: 'The year it ends in' }, { value: 'start_year', label: 'The year it starts in' }]} />
              </div>
            ) : null}
            {c.updatedAt !== null ? <p className={styles.muted}>Last changed <Time value={c.updatedAt} />{c.updatedBy !== null ? ` by ${people.nameOf(c.updatedBy)}` : ''}.</p> : null}
            {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
            <FormActions><Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked}>Save</Button></FormActions>
          </form>
        )}
      </QueryView>
    </Page>
  );
}

/** /settings/domains/: email domains the organisation owns, each proved by a DNS TXT record. */
export function Domains() {
  const say = useToast();
  const list = useQuery('listDomains', {});
  const add = useMutation('addDomain', { invalidates: ['listDomains'] });
  const verify = useMutation('verifyDomain', { invalidates: ['listDomains'] });
  const remove = useMutation('removeDomain', { invalidates: ['listDomains'] });
  const [domain, setDomain] = useState('');
  const [removing, setRemoving] = useState<string | undefined>();
  return (
    <Page title="Domains" description="Email domains your organisation owns. A verified domain lets people with its addresses join and sign in with your single sign-on." crumbs={crumbs}>
      <div className={styles.stack}>
        <form className={styles.rowEnd} aria-label="Add a domain" onSubmit={async (e) => {
          e.preventDefault();
          const r = await add.run({ body: { domain: domain.trim().toLowerCase() } });
          if (r.ok) {
            setDomain('');
            say('Added: publish its TXT record, then verify it');
          }
        }}>
          <TextField label="Domain" value={domain} placeholder="example.com" onChange={(e) => setDomain(e.target.value)} />
          <Button type="submit" icon="plus" pending={add.pending} blocked={add.blocked} disabled={domain.trim() === ''}>Add it</Button>
        </form>
        {add.error !== undefined ? <ErrorMessage error={add.error} /> : null}
        {verify.error !== undefined ? <ErrorMessage error={verify.error} /> : null}
        <QueryView query={list} what="Domains" isEmpty={(d) => d.domains.length === 0} empty={<EmptyState icon="globe" title="No domains yet">Add the domains your people's email addresses use.</EmptyState>}>
          {(d) => (
            <DataTable label="Domains" rows={d.domains} rowKey={(x) => x.id} columns={[
              { id: 'domain', header: 'Domain', primary: true, cell: (x) => <span className={styles.mono}>{x.domain}</span> },
              { id: 'state', header: 'State', width: 'sm', cell: (x) => (x.status === 'verified' ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Waiting for its record</Badge>) },
              { id: 'record', header: 'DNS TXT record', cell: (x) => (x.status === 'verified' ? <span className={styles.muted}>Verified <Time value={x.verifiedAt ?? x.createdAt} /></span> : (
                <span className={styles.stackTight}>
                  <span className={styles.row}><span className={styles.mono}>{x.txtName}</span><CopyButton value={x.txtName} label="Copy the name" /></span>
                  <span className={styles.row}><span className={styles.mono}>{x.txtValue}</span><CopyButton value={x.txtValue} label="Copy the value" /></span>
                </span>
              )) },
              { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (x) => (
                <Menu label={x.domain} items={[
                  { label: 'Check its record now', icon: 'refresh', disabled: x.status === 'verified', blocked: verify.blocked,
                    onSelect: () => void verify.run({ params: { domainId: x.id } }).then((r) => r.ok && say(r.data.status === 'verified' ? 'Verified' : 'Its record is not there yet')) },
                  { label: 'Remove', icon: 'trash', tone: 'danger', blocked: remove.blocked, onSelect: () => setRemoving(x.id) },
                ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`${x.domain} actions`} icon="more" />} />
              ) },
            ]} />
          )}
        </QueryView>
      </div>
      <ConfirmDialog open={removing !== undefined} onClose={() => setRemoving(undefined)} title="Remove the domain?" confirmLabel="Remove" tone="danger"
        onConfirm={() => remove.run({ params: { domainId: removing! } }).then((r) => {
          if (r.ok) say('Removed');
          return r;
        })}><p>People with its addresses no longer join by it; members already in stay.</p></ConfirmDialog>
    </Page>
  );
}

type Skin = Output<'listTerminologySkins'>['skins'][number];
type Target = Skin['target'];

/** /settings/terminology/: the organisation's own words for types, their states, links and Actions. */
export function Terminology() {
  const say = useToast();
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const actions = useQuery('listActionTypes', { query: {} });
  const list = useQuery('listTerminologySkins', {});
  const supersede = useMutation('supersedeTerminologySkin', { invalidates: ['listTerminologySkins', 'readVocabulary'] });
  const [making, setMaking] = useState(false);
  const targetName = (t: Target) => (t.kind === 'object_type' ? `${lookup?.typeName(t.objectTypeId) ?? 'A type'}${t.stateValue !== undefined ? `, in state ${t.stateValue}` : ''}`
    : t.kind === 'link_type' ? (lookup?.links.get(t.linkTypeId)?.forwardName ?? 'A link')
      : actions.data?.actionTypes.find((a) => a.id === t.actionTypeId)?.displayName ?? 'An Action');
  const live = (list.data?.skins ?? []).filter((s) => s.supersededAt === null);
  return (
    <Page title="Terminology" description="Your own words for types, their states, links and Actions, shown everywhere in place of the ontology's." crumbs={crumbs}
      actions={<Button variant="primary" icon="plus" onClick={() => setMaking(true)}>New word</Button>}>
      <QueryView query={list} what="Terminology" isEmpty={() => live.length === 0} empty={<EmptyState icon="edit" title="The ontology's own words">Choose your own word for any type, state, link or Action.</EmptyState>}>
        {() => (
          <DataTable label="Your words" rows={live} rowKey={(s) => s.id} columns={[
            { id: 'for', header: 'For', primary: true, cell: (s) => targetName(s.target) },
            { id: 'word', header: 'Shown as', cell: (s) => `${s.labelSingular}${s.labelPlural !== null ? ` / ${s.labelPlural}` : ''}` },
            { id: 'by', header: 'Set by', cell: (s) => people.nameOf(s.setBy) },
            { id: 'when', header: 'Since', width: 'sm', cell: (s) => <Time value={s.setAt} /> },
            { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (s) => (
              <Button size="sm" variant="ghost" blocked={supersede.blocked} onClick={() => void supersede.run({ params: { skinId: s.id } }).then((r) => r.ok && say('The ontology\'s own word is back'))}>Go back to the ontology&apos;s word</Button>
            ) },
          ]} />
        )}
      </QueryView>
      {supersede.error !== undefined ? <ErrorMessage error={supersede.error} /> : null}
      {making ? <WordDialog actions={actions.data?.actionTypes ?? []} onClose={() => setMaking(false)} /> : null}
    </Page>
  );
}

function WordDialog({ actions, onClose }: { actions: Output<'listActionTypes'>['actionTypes']; onClose: () => void }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const set = useMutation('setTerminologySkin', { invalidates: ['listTerminologySkins', 'readVocabulary'] });
  const [kind, setKind] = useState<Target['kind']>('object_type');
  const [id, setId] = useState('');
  const [state, setState] = useState('');
  const [singular, setSingular] = useState('');
  const [pluralWord, setPluralWord] = useState('');
  const options = kind === 'object_type' ? (vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.displayName }))
    : kind === 'link_type' ? (vocabulary?.linkTypes ?? []).map((l) => ({ value: l.id, label: l.forwardName }))
      : actions.map((a) => ({ value: a.id, label: a.displayName }));
  const target: Target = kind === 'object_type' ? { kind, objectTypeId: id, ...(state.trim() === '' ? {} : { stateValue: state.trim() }) } : kind === 'link_type' ? { kind, linkTypeId: id } : { kind, actionTypeId: id };
  return (
    <Dialog open onClose={onClose} title="Your own word" size="md" busy={set.pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await set.run({ body: { target, labelSingular: singular.trim(), ...(pluralWord.trim() === '' ? {} : { labelPlural: pluralWord.trim() }) } });
        if (r.ok) {
          say('Saved: it shows everywhere now');
          onClose();
        }
      }}>
        <div className={styles.fields}>
          <SelectField label="For" value={kind} onChange={(e) => {
            setKind(e.target.value as Target['kind']);
            setId('');
          }} options={[{ value: 'object_type', label: 'A type' }, { value: 'link_type', label: 'A link' }, { value: 'action_type', label: 'An Action' }]} />
          <SelectField label="Which" required value={id} placeholder="Choose one" onChange={(e) => setId(e.target.value)} options={options} />
          {kind === 'object_type' ? <TextField label="Only in the state (optional)" value={state} onChange={(e) => setState(e.target.value)} hint="Its state's value, such as overdue." /> : null}
        </div>
        <div className={styles.fields}>
          <TextField label="Shown as" required maxLength={100} value={singular} onChange={(e) => setSingular(e.target.value)} />
          {kind !== 'action_type' ? <TextField label="More than one (optional)" maxLength={100} value={pluralWord} onChange={(e) => setPluralWord(e.target.value)} /> : null}
        </div>
        {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked} disabled={id === '' || singular.trim() === ''}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

