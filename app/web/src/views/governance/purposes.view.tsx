'use client';

// Purpose sessions (spec 57.6): data marked for a purpose is read only inside a declared session
// for that purpose: a definition the organisation approved, a justification where it asks for
// one, a time limit, and a second person's approval where its use is beyond analysis. Your
// sessions, starting one, ending one early, and approving someone else's.

import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import styles from './governance.view.module.css';

type Session = Output<'listPurposeSessions'>['purposeSessions'][number];

const USE: Record<'analysis' | 'export' | 'external_sharing' | 'write_back' | 'ai_or_simulation', string> = {
  analysis: 'Analysis', export: 'Export', external_sharing: 'Sharing outside', write_back: 'Changing records', ai_or_simulation: 'AI or simulation',
};
const ENDED: Record<NonNullable<Session['endedReason']>, string> = {
  ended_by_user: 'Ended', expired: 'Ran out', definition_suspended: 'Its purpose was suspended', eligibility_revoked: 'Eligibility revoked', membership_removed: 'Member removed', session_revoked: 'Signed out',
};

function state(s: Session): { label: string; tone: 'ok' | 'warn' | 'neutral' | 'info' } {
  if (s.endedAt !== null) return { label: s.endedReason === null ? 'Ended' : ENDED[s.endedReason], tone: 'neutral' };
  if (Date.parse(s.expiresAt) <= Date.now()) return { label: 'Ran out', tone: 'neutral' };
  if (s.requiresApproval && s.approvedAt === null) return { label: 'Waiting for approval', tone: 'warn' };
  return { label: 'Open', tone: 'ok' };
}

function DeclareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const say = useToast();
  const definitions = useQuery('listPurposeDefinitions', {});
  const declare = useMutation('declarePurpose', { invalidates: ['listPurposeSessions'] });
  const [definitionId, setDefinitionId] = useState('');
  const [justification, setJustification] = useState('');
  const [minutes, setMinutes] = useState('');
  const approved = (definitions.data?.purposeDefinitions ?? []).filter((d) => d.status === 'approved');
  const def = approved.find((d) => d.id === definitionId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await declare.run({ body: { purposeDefinitionId: definitionId, ...(justification.trim() !== '' ? { justification: justification.trim() } : {}), ...(minutes !== '' ? { minutes: Number(minutes) } : {}) } });
    if (r.ok) {
      say(r.data.requiresApproval ? 'Declared: it opens once someone approves it' : 'Declared: data marked for it is open to you until it ends');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Declare a purpose" size="md" busy={declare.pending}
      description="Data marked for a purpose is open to you only inside a session for it. Everything you read is recorded against the session.">
      <form className={styles.form} onSubmit={submit}>
        <SelectField label="Purpose" required value={definitionId} onChange={(e) => setDefinitionId(e.target.value)} placeholder={approved.length === 0 ? 'None you may declare' : 'Choose a purpose'}
          options={approved.map((d) => ({ value: d.id, label: `${d.name} (${USE[d.use]})` }))} />
        {def !== undefined ? <p className={styles.muted}>{def.description}{def.lawfulBasis !== null ? ` Lawful basis: ${def.lawfulBasis}.` : ''}</p> : null}
        {def?.requiresApproval ? <Banner tone="info">Someone who may approve purposes approves it before it opens.</Banner> : null}
        <TextArea label={def?.requiresJustification ? 'Why' : 'Why (optional)'} required={def?.requiresJustification} rows={3} value={justification} onChange={(e) => setJustification(e.target.value)}
          hint="Your reason, in words; never values from the data." />
        <TextField label="For how long (minutes)" type="number" min={1} max={def?.maxSessionMinutes} value={minutes} onChange={(e) => setMinutes(e.target.value)}
          hint={def !== undefined ? `At most ${def.maxSessionMinutes}.` : undefined} />
        {declare.error !== undefined ? <ErrorMessage error={declare.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={declare.pending} blocked={declare.blocked}
          disabled={definitionId === '' || (def?.requiresJustification === true && justification.trim() === '')}>Declare</Button></FormActions>
      </form>
    </Dialog>
  );
}

export function Purposes() {
  const say = useToast();
  const people = useDirectory();
  const [params, set] = useParams();
  const sessions = useQuery('listPurposeSessions', {}, { refreshMs: 60_000 });
  const definitions = useQuery('listPurposeDefinitions', {}, { staleMs: 10 * 60_000 });
  const approve = useMutation('approvePurposeSession', { invalidates: ['listPurposeSessions'] });
  const end = useMutation('endPurposeSession', { invalidates: ['listPurposeSessions'] });
  const blocked = useBlocked('declarePurpose');
  usePageContext({ scope: { kind: 'page', page: 'governance' }, scopeLabel: 'Purpose sessions' });
  const nameOf = (id: string) => definitions.data?.purposeDefinitions.find((d) => d.id === id)?.name ?? 'a purpose';
  return (
    <Page title="Purpose sessions" description="Data marked for a purpose opens only inside a session declared for it, for a limited time, recorded against the session."
      crumbs={[{ label: 'Governance' }]} actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>Declare a purpose</Button>}>
      <QueryView query={sessions} what="Purpose sessions" isEmpty={(d) => d.purposeSessions.length === 0}
        empty={<EmptyState icon="key" title="No purpose session">Declare one when you need data marked for a purpose.</EmptyState>}>
        {(d) => (
          <DataTable label="Purpose sessions" rows={d.purposeSessions} rowKey={(s) => s.id} columns={[
            { id: 'purpose', header: 'Purpose', primary: true, cell: (s) => nameOf(s.purposeDefinitionId) },
            { id: 'state', header: 'State', width: 'md', cell: (s) => <Badge tone={state(s).tone}>{state(s).label}</Badge> },
            { id: 'from', header: 'Declared', width: 'md', cell: (s) => <Time value={s.declaredAt} /> },
            { id: 'until', header: 'Until', width: 'md', cell: (s) => <Time value={s.expiresAt} exact /> },
            { id: 'approved', header: 'Approved', width: 'md', cell: (s) => (!s.requiresApproval ? 'Not needed' : s.approvedAt === null ? '—' : <span>{people.nameOf(s.approvedBy)}, <Time value={s.approvedAt} /></span>) },
            { id: 'act', header: <span className="visually-hidden">Act</span>, width: 'md', align: 'end', cell: (s) => (s.endedAt !== null || Date.parse(s.expiresAt) <= Date.now() ? null : (
              <span className={styles.row}>
                {s.requiresApproval && s.approvedAt === null ? <Button size="sm" pending={approve.pending} blocked={approve.blocked} onClick={async () => {
                  const r = await approve.run({ params: { purposeSessionId: s.id } });
                  if (r.ok) say('Approved: it is open now');
                }}>Approve</Button> : null}
                <Button size="sm" variant="ghost" blocked={end.blocked} onClick={async () => {
                  const r = await end.run({ params: { purposeSessionId: s.id } });
                  if (r.ok) say('Ended');
                }}>End</Button>
              </span>
            )) },
          ]} />
        )}
      </QueryView>
      {approve.error ?? end.error ? <ErrorMessage error={approve.error ?? end.error} /> : null}
      {params.get('new') !== null ? <DeclareDialog open onClose={() => set({ new: undefined })} /> : null}
    </Page>
  );
}
