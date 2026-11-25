'use client';

// Who may use a connection (spec 14.7, 44.4): its grants, to a person, a scope (and, unless
// said otherwise, the scopes beneath it), a role or a service principal, to read or to write,
// optionally until a date; a grant to someone suspended or removed is silenced, not deleted,
// so reinstating them restores it. And who sets the approval policy for writes through it: the
// owner, one named admin, or super admins only.

import { useMemo, useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, RadioGroup, SelectField, TextField } from '../../components/field.component.tsx';
import { Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermit, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParam } from '../../hooks/params.hook.ts';
import type { Connection } from './words.view.ts';
import styles from './connect.view.module.css';

type Grant = Output<'listConnectionGrants'>['grants'][number];
type GranteeKind = Input<'grantConnection'>['body']['grantee']['kind'];
type Authority = Connection['policyAuthority'];

const KIND: Record<GranteeKind, string> = { membership: 'A person', scope: 'A scope', role: 'A role', service_principal: 'A service principal' };

const AUTHORITY: Record<Authority, { label: string; hint: string }> = {
  owner_set: { label: 'Its owner', hint: 'The connection\'s owner sets who approves writes through it.' },
  delegated: { label: 'A named admin', hint: 'One admin you name sets it. Approval policies already written stay if the delegation ends.' },
  locked: { label: 'Super admins only', hint: 'Nobody else may change who approves writes through it.' },
};

/** Names for grantees: people and scopes from the directory; roles and principals when the reader may list them. */
function useGranteeNames() {
  const people = useDirectory();
  const rolesPermit = usePermit('listRoles');
  const principalsPermit = usePermit('listServicePrincipals');
  const roles = useQuery('listRoles', rolesPermit.allowed === true ? {} : null, { staleMs: 5 * 60_000 });
  const principals = useQuery('listServicePrincipals', principalsPermit.allowed === true ? {} : null, { staleMs: 5 * 60_000 });
  return useMemo(() => ({
    people,
    roles: (roles.data?.roles ?? []).filter((r) => r.retiredAt === null),
    principals: (principals.data?.servicePrincipals ?? []).filter((p) => p.revokedAt === null),
    rolesBlocked: rolesPermit.blocked?.message,
    principalsBlocked: principalsPermit.blocked?.message,
    nameOf(g: Grant): { kind: string; name: string } {
      if (g.granteeMembershipId !== null) return { kind: 'Person', name: people.nameOf(g.granteeMembershipId) };
      if (g.granteeScopeId !== null) return { kind: 'Scope', name: people.scopeName(g.granteeScopeId) };
      if (g.granteeRoleId !== null) return { kind: 'Role', name: roles.data?.roles.find((r) => r.id === g.granteeRoleId)?.name ?? 'a role' };
      return { kind: 'Service principal', name: principals.data?.servicePrincipals.find((p) => p.id === g.granteeServicePrincipalId)?.name ?? 'a service principal' };
    },
  }), [people, roles.data, principals.data, rolesPermit.blocked, principalsPermit.blocked]);
}

function GrantDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const say = useToast();
  const names = useGranteeNames();
  const grant = useMutation('grantConnection', { invalidates: ['listConnectionGrants'] });
  const [kind, setKind] = useState<GranteeKind>('membership');
  const [id, setId] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [descendants, setDescendants] = useState(true);
  const [until, setUntil] = useState('');
  const options = kind === 'membership' ? names.people.members.filter((m) => m.status === 'active').map((m) => ({ value: m.membershipId, label: m.displayName }))
    : kind === 'scope' ? names.people.scopes.map((s) => ({ value: s.id, label: s.name }))
    : kind === 'role' ? names.roles.map((r) => ({ value: r.id, label: r.name }))
    : names.principals.map((p) => ({ value: p.id, label: p.name }));
  const kindBlocked = kind === 'role' ? names.rolesBlocked : kind === 'service_principal' ? names.principalsBlocked : undefined;
  const expiresAt = until === '' ? undefined : new Date(`${until}T23:59:59`).toISOString();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await grant.run({
      body: { connectionId: connection.id, grantee: { kind, id }, access, ...(kind === 'scope' ? { includeDescendants: descendants } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) },
    });
    if (r.ok) {
      say(`Access granted to ${options.find((o) => o.value === id)?.label ?? 'them'}`);
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Who may use ${connection.name}`} size="md" busy={grant.pending}
      description="Reading through a connection is still decided per object and field by your organisation's policies; a grant lets someone use the connection at all.">
      <form onSubmit={submit} className={styles.form}>
        <RadioGroup name="grantee-kind" label="Grant to" value={kind} onChange={(k) => {
          setKind(k);
          setId('');
        }} options={(Object.keys(KIND) as GranteeKind[]).map((k) => ({ value: k, label: KIND[k] }))} />
        <SelectField label={KIND[kind].replace(/^An? /, '').replace(/^./, (c) => c.toUpperCase())} required value={id} onChange={(e) => setId(e.target.value)}
          options={options} placeholder={kindBlocked ?? (options.length === 0 ? 'None to choose' : 'Choose')} disabled={kindBlocked !== undefined}
          error={fieldError(grant.error, 'grantee.id')} />
        {kind === 'scope' ? <Checkbox label="Include the scopes beneath it" checked={descendants} onChange={() => setDescendants(!descendants)} /> : null}
        <RadioGroup name="grant-access" label="Access" value={access} onChange={setAccess} options={[
          { value: 'read', label: 'Read', hint: 'Query it, as themselves.' },
          { value: 'write', label: 'Write', hint: 'Also propose Actions that change records in it, once writes are enabled.' },
        ]} />
        <TextField label="Until (optional)" type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)}
          hint="Ends at the close of that day. Leave empty to keep it until revoked." error={fieldError(grant.error, 'expiresAt')} />
        {grant.error !== undefined && fieldError(grant.error, 'grantee.id') === undefined ? <ErrorMessage error={grant.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={grant.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={grant.pending} blocked={grant.blocked} disabled={id === ''}>Grant</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function Grants({ connection }: { connection: Connection }) {
  const say = useToast();
  const names = useGranteeNames();
  const [ended, setEnded] = useParam('ended');
  const grants = useQuery('listConnectionGrants', { query: { connectionId: connection.id, ...(ended === '1' ? { includeEnded: 'true' as const } : {}) } });
  const revoke = useMutation('revokeConnectionGrant', { invalidates: ['listConnectionGrants'] });
  const grantBlocked = useBlocked('grantConnection');
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<Grant | undefined>(undefined);
  const live = (g: Grant) => g.revokedAt === null && (g.expiresAt === null || Date.parse(g.expiresAt) > Date.now());
  return (
    <Section title="Who may use it"
      actions={connection.status === 'revoked' ? undefined : <Button icon="plus" blocked={grantBlocked} onClick={() => setGranting(true)}>Grant access</Button>}>
      <Toolbar>
        <Checkbox label="Show ended grants" checked={ended === '1'} onChange={() => setEnded(ended === '1' ? undefined : '1')} />
      </Toolbar>
      <QueryView query={grants} what="Its grants" isEmpty={(d) => d.grants.length === 0}
        empty={<EmptyState icon="people" title="No grants">Only its owner and admins of the scope that owns it may use it.</EmptyState>}>
        {(d) => (
          <DataTable label="Grants" rows={d.grants} rowKey={(g) => g.id} columns={[
            { id: 'who', header: 'Who', primary: true, sortValue: (g) => names.nameOf(g).name, cell: (g) => names.nameOf(g).name },
            { id: 'kind', header: 'Kind', width: 'md', cell: (g) => `${names.nameOf(g).kind}${g.granteeScopeId !== null && g.includeDescendants ? ' and beneath' : ''}` },
            { id: 'access', header: 'Access', width: 'sm', cell: (g) => (g.access === 'write' ? <Badge tone="accent">Write</Badge> : <Badge>Read</Badge>) },
            { id: 'state', header: 'State', width: 'md', cell: (g) => (g.revokedAt !== null ? <Badge>Revoked</Badge>
              : g.silencedAt !== null ? <Badge tone="warn" title="Its holder is suspended or removed; reinstating them restores it">Silenced</Badge>
              : !live(g) ? <Badge>Expired</Badge>
              : g.expiresAt !== null ? <span>Until <Time value={g.expiresAt} /></span> : <Badge tone="ok">Active</Badge>) },
            { id: 'by', header: 'Granted', width: 'md', sortValue: (g) => g.grantedAt, cell: (g) => <span>{names.people.nameOf(g.grantedBy)}, <Time value={g.grantedAt} /></span> },
            { id: 'revoke', header: <span className="visually-hidden">Revoke</span>, width: 'sm', align: 'end', cell: (g) => (g.revokedAt === null
              ? <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => setRevoking(g)}>Revoke</Button> : null) },
          ]} />
        )}
      </QueryView>
      {granting ? <GrantDialog connection={connection} open onClose={() => setGranting(false)} /> : null}
      <ConfirmDialog open={revoking !== undefined} onClose={() => setRevoking(undefined)} title={`Revoke access for ${revoking === undefined ? '' : names.nameOf(revoking).name}?`}
        confirmLabel="Revoke" tone="danger" onConfirm={async () => {
          const r = await revoke.run({ params: { grantId: revoking!.id } });
          if (r.ok) say('Access revoked');
          return r;
        }}>
        <p>They can no longer use the connection. Queries already answered stay as they were.</p>
      </ConfirmDialog>
    </Section>
  );
}

function PolicyAuthorityDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const set = useMutation('setConnectionPolicyAuthority', { invalidates: ['listConnections'] });
  const [mode, setMode] = useState<Authority>(connection.policyAuthority);
  const [delegate, setDelegate] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await set.run({ params: { connectionId: connection.id }, body: { mode, version: connection.version, ...(mode === 'delegated' ? { delegateMembershipId: delegate } : {}) } });
    if (r.ok) {
      say('Approval policy authority changed');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Who sets its approval policy" size="md" busy={set.pending}>
      <form onSubmit={submit} className={styles.form}>
        <RadioGroup name="authority" label="Set by" value={mode} onChange={setMode}
          options={(Object.keys(AUTHORITY) as Authority[]).map((a) => ({ value: a, label: AUTHORITY[a].label, hint: AUTHORITY[a].hint }))} />
        {mode === 'delegated' ? (
          <SelectField label="The admin" required value={delegate} onChange={(e) => setDelegate(e.target.value)} placeholder="Choose a person"
            options={people.members.filter((m) => m.status === 'active').map((m) => ({ value: m.membershipId, label: m.displayName }))}
            error={fieldError(set.error, 'delegateMembershipId')} />
        ) : null}
        {set.error !== undefined && fieldError(set.error, 'delegateMembershipId') === undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={set.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked}
            disabled={(mode === 'delegated' && delegate === '') || (mode === connection.policyAuthority && mode !== 'delegated')}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function PolicyAuthority({ connection }: { connection: Connection }) {
  const blocked = useBlocked('setConnectionPolicyAuthority');
  const [changing, setChanging] = useState(false);
  return (
    <Section title="Approval policy" description="Who decides which approvals a write through this connection needs.">
      <Panel>
        <div className={styles.next}>
          <Properties columns={1} items={[['Set by', AUTHORITY[connection.policyAuthority].label]]} />
          {connection.status !== 'revoked' ? <Button blocked={blocked} onClick={() => setChanging(true)}>Change</Button> : null}
        </div>
        <p className={styles.muted}>{AUTHORITY[connection.policyAuthority].hint}</p>
      </Panel>
      {changing ? <PolicyAuthorityDialog connection={connection} open onClose={() => setChanging(false)} /> : null}
    </Section>
  );
}

export function Access({ connection }: { connection: Connection }) {
  return (
    <div className={styles.stack}>
      <Grants connection={connection} />
      <PolicyAuthority connection={connection} />
    </div>
  );
}
