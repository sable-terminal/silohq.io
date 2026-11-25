'use client';

// Who may do what, and where (spec 55, 56): roles as sets of permissions (a system role fixed,
// the organisation's own changed or retired, each naming the roles its holders may grant) and the
// grants an issuer lost the authority for; scopes as a tree of teams and areas, each with its
// members; service principals (non-human identities for integrations and automations, with their
// roles, a secret shown once); and SCIM provisioning (tokens for the identity provider, and its
// groups mapped to roles in scopes).

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { CopyButton } from '../../components/copy.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { humanise, plural } from '../../utils/format.util.ts';
import { idFrom } from '../studio/kit.view.tsx';
import styles from './settings.view.module.css';

type Role = Output<'listRoles'>['roles'][number];
type Scope = Output<'listScopes'>['scopes'][number];
const crumbs = [{ label: 'Settings', href: '/settings/' }];

/** The permissions there are, with what each allows: from the person's own permission read. */
function usePermissionCatalogue() {
  const held = useQuery('readMyPermissions', {}, { staleMs: 5 * 60_000 });
  return held.data?.permissions ?? [];
}

/** /settings/roles/: roles and what each may do; grants whose issuer lost the authority. */
export function Roles() {
  const say = useToast();
  const roles = useQuery('listRoles', {});
  const orphans = useQuery('listOrphanedGrants', {});
  const people = useDirectory();
  const retire = useMutation('retireRole', { invalidates: ['listRoles'] });
  const revoke = useMutation('revokeRole', { invalidates: ['listOrphanedGrants'] });
  const [editing, setEditing] = useState<Role | 'new' | undefined>();
  const [retiring, setRetiring] = useState<Role | undefined>();
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name ?? 'a role';
  return (
    <Page title="Roles" description="What each role may do. A system role is fixed; your own roles change as you need." crumbs={crumbs} width="full"
      actions={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New role</Button>}>
      <div className={styles.stack}>
        <QueryView query={roles} what="Roles">
          {(d) => (
            <DataTable label="Roles" rows={d.roles} rowKey={(r) => r.id} columns={[
              { id: 'name', header: 'Role', primary: true, cell: (r) => <span className={styles.row}>{r.name}{r.systemRole ? <Badge>System</Badge> : null}{r.retiredAt !== null ? <Badge>Retired</Badge> : null}</span> },
              { id: 'perms', header: 'May', cell: (r) => plural(r.permissions.length, 'permission') },
              { id: 'grants', header: 'May grant', cell: (r) => r.grantableRoleIds.map(roleName).join(', ') || '—' },
              { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (r) => (r.systemRole || r.retiredAt !== null ? <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>View</Button> : (
                <Menu label={r.name} items={[
                  { label: 'Change what it may do', icon: 'edit', onSelect: () => setEditing(r) },
                  { label: 'Retire', icon: 'trash', tone: 'danger', blocked: retire.blocked, onSelect: () => setRetiring(r) },
                ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`${r.name} actions`} icon="more" />} />
              )) },
            ]} />
          )}
        </QueryView>
        <Section title="Grants without authority" description="Grants whose issuer has since lost the right to make them. Review each: revoke it, or grant it again yourself.">
          <QueryView query={orphans} what="Grants without authority" isEmpty={(d) => d.assignments.length === 0} empty={<p className={styles.muted}>None.</p>}>
            {(d) => (
              <DataTable label="Grants without authority" rows={d.assignments} rowKey={(a) => a.id} columns={[
                { id: 'who', header: 'Held by', primary: true, cell: (a) => people.nameOf(a.membershipId) },
                { id: 'role', header: 'Role', cell: (a) => roleName(a.roleId) },
                { id: 'by', header: 'Granted by', cell: (a) => people.nameOf(a.grantedBy) },
                { id: 'when', header: 'Granted', width: 'sm', cell: (a) => <Time value={a.grantedAt} /> },
                { id: 'act', header: <span className="visually-hidden">Revoke</span>, align: 'end', cell: (a) => <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => void revoke.run({ params: { assignmentId: a.id } }).then((r) => r.ok && say('Revoked'))}>Revoke</Button> },
              ]} />
            )}
          </QueryView>
        </Section>
      </div>
      {editing !== undefined ? <RoleDialog role={editing === 'new' ? undefined : editing} roles={roles.data?.roles ?? []} onClose={() => setEditing(undefined)} /> : null}
      <ConfirmDialog open={retiring !== undefined} onClose={() => setRetiring(undefined)} title={`Retire ${retiring?.name ?? 'the role'}?`} confirmLabel="Retire" tone="danger"
        onConfirm={() => retire.run({ params: { roleId: retiring!.id } }).then((r) => {
          if (r.ok) say('Retired');
          return r;
        })}><p>It can no longer be granted. Grants of it already made end.</p></ConfirmDialog>
    </Page>
  );
}

function RoleDialog({ role, roles, onClose }: { role: Role | undefined; roles: readonly Role[]; onClose: () => void }) {
  const say = useToast();
  const catalogue = usePermissionCatalogue();
  const create = useMutation('createRole', { invalidates: ['listRoles'] });
  const setPermissions = useMutation('setRolePermissions', { invalidates: ['listRoles'] });
  const [name, setName] = useState(role?.name ?? '');
  const [chosen, setChosen] = useState<string[]>(role?.permissions ?? []);
  const [grantable, setGrantable] = useState<string[]>(role?.grantableRoleIds ?? []);
  const fixed = role !== undefined && (role.systemRole || role.retiredAt !== null);
  const groups = new Map<string, typeof catalogue>();
  for (const p of catalogue) groups.set(p.id.split('.')[0]!, [...(groups.get(p.id.split('.')[0]!) ?? []), p]);
  const pending = create.pending || setPermissions.pending;
  return (
    <Dialog open onClose={onClose} title={role === undefined ? 'New role' : role.name} size="lg" busy={pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = role === undefined ? await create.run({ body: { name: name.trim(), permissions: chosen, grantableRoleIds: grantable } })
          : await setPermissions.run({ params: { roleId: role.id }, body: { permissions: chosen } });
        if (r.ok) {
          say(role === undefined ? 'Role made' : 'Saved: its holders may do this now');
          onClose();
        }
      }}>
        {role === undefined ? <TextField label="Name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /> : null}
        {fixed ? <Banner tone="info" title={role.systemRole ? 'A system role' : 'Retired'}>What it may do is fixed.</Banner> : null}
        <fieldset className={styles.fieldset} disabled={fixed}>
          <legend>It may</legend>
          <div className={styles.stack}>{[...groups.entries()].map(([group, perms]) => (
            <div key={group} className={styles.stackTight}>
              <strong>{humanise(group)}</strong>
              <div className={styles.checks}>{perms.map((p) => (
                <Checkbox key={p.id} label={p.id} hint={p.description} checked={chosen.includes(p.id)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))} />
              ))}</div>
            </div>
          ))}</div>
        </fieldset>
        {role === undefined ? (
          <fieldset className={styles.fieldset}>
            <legend>Its holders may grant</legend>
            <div className={styles.checks}>{roles.filter((r) => r.retiredAt === null).map((r) => (
              <Checkbox key={r.id} label={r.name} checked={grantable.includes(r.id)} onChange={(e) => setGrantable(e.target.checked ? [...grantable, r.id] : grantable.filter((x) => x !== r.id))} />
            ))}</div>
          </fieldset>
        ) : null}
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        {setPermissions.error !== undefined ? <ErrorMessage error={setPermissions.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>{fixed ? 'Close' : 'Cancel'}</Button>
          {!fixed ? <Button type="submit" variant="primary" pending={pending} disabled={(role === undefined && name.trim() === '') || chosen.length === 0}>{role === undefined ? 'Make the role' : 'Save'}</Button> : null}
        </FormActions>
      </form>
    </Dialog>
  );
}

/** /settings/scopes/: the tree of teams and areas; a scope opens (?scope=) with its members. */
export function Scopes() {
  const say = useToast();
  const [params, set] = useParams();
  const scopes = useQuery('listScopes', { query: {} });
  const types = useQuery('listScopeTypes', {});
  const create = useMutation('createScope', { invalidates: ['listScopes', 'readDirectory'] });
  const createType = useMutation('createScopeType', { invalidates: ['listScopeTypes'] });
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [parentId, setParentId] = useState('');
  const [typeName, setTypeName] = useState('');
  const all = (scopes.data?.scopes ?? []).filter((s) => s.archivedAt === null);
  const children = (parent: string | null) => all.filter((s) => s.parentScopeId === parent).sort((a, b) => a.name.localeCompare(b.name));
  const tree = (parent: string | null): React.ReactNode => {
    const list = children(parent);
    if (list.length === 0) return null;
    return (
      <ul className={styles.tree}>{list.map((s) => (
        <li key={s.id}>
          <div className={styles.treeRow}>
            <button type="button" className={styles.linkButton} onClick={() => set({ scope: s.id })}>{s.name}</button>
            <span className={styles.muted}>{types.data?.scopeTypes.find((t) => t.id === s.scopeTypeId)?.name ?? ''}</span>
          </div>
          {tree(s.id)}
        </li>
      ))}</ul>
    );
  };
  const open = idFrom(params.get('scope'));
  return (
    <Page title="Scopes" description="Teams and areas of responsibility. A role granted in a scope applies within it and every scope beneath it." crumbs={crumbs}>
      <div className={styles.stack}>
        <QueryView query={scopes} what="Scopes" isEmpty={() => all.length === 0} empty={<EmptyState icon="ontology" title="No scopes yet">Scopes give roles a place: a team, a site, a department.</EmptyState>}>
          {() => tree(null)}
        </QueryView>
        <Section title="New scope">
          <form className={styles.rowEnd} aria-label="New scope" onSubmit={async (e) => {
            e.preventDefault();
            const r = await create.run({ body: { name: name.trim(), scopeTypeId: typeId, ...(parentId === '' ? {} : { parentScopeId: parentId }) } });
            if (r.ok) {
              say(`${name.trim()} created.`);
              setName('');
            }
          }}>
            <TextField label="New scope" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            <SelectField label="Of type" required value={typeId} placeholder="Choose…" onChange={(e) => setTypeId(e.target.value)} options={(types.data?.scopeTypes ?? []).map((t) => ({ value: t.id, label: t.name }))} />
            <SelectField label="Beneath" value={parentId} onChange={(e) => setParentId(e.target.value)} options={[{ value: '', label: 'The top level' }, ...all.map((s) => ({ value: s.id, label: s.name }))]} />
            <Button type="submit" pending={create.pending} blocked={create.blocked} disabled={name.trim() === '' || typeId === ''}>Create</Button>
          </form>
          {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
          <form className={styles.rowEnd} aria-label="New scope type" onSubmit={async (e) => {
            e.preventDefault();
            const r = await createType.run({ body: { name: typeName.trim() } });
            if (r.ok) {
              say(`${typeName.trim()} added.`);
              setTypeName('');
            }
          }}>
            <TextField label="New scope type" maxLength={100} placeholder="Department, Site…" value={typeName} onChange={(e) => setTypeName(e.target.value)} />
            <Button type="submit" pending={createType.pending} blocked={createType.blocked} disabled={typeName.trim() === ''}>Add</Button>
          </form>
          {createType.error !== undefined ? <ErrorMessage error={createType.error} /> : null}
        </Section>
      </div>
      {open !== undefined ? <ScopeDrawer scope={(scopes.data?.scopes ?? []).find((s) => s.id === open)} all={all} onClose={() => set({ scope: undefined })} /> : null}
    </Page>
  );
}

function ScopeDrawer({ scope, all, onClose }: { scope: Scope | undefined; all: readonly Scope[]; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const members = useQuery('listScopeMembers', scope === undefined ? null : { params: { scopeId: scope.id } });
  const update = useMutation('updateScope', { invalidates: ['listScopes', 'readDirectory'] });
  const archive = useMutation('archiveScope', { invalidates: ['listScopes', 'readDirectory'] });
  const add = useMutation('addScopeMember', { invalidates: ['listScopeMembers', 'listMembers'] });
  const remove = useMutation('removeScopeMember', { invalidates: ['listScopeMembers', 'listMembers'] });
  const [name, setName] = useState(scope?.name ?? '');
  const [parentId, setParentId] = useState(scope?.parentScopeId ?? '');
  const [who, setWho] = useState('');
  const [primary, setPrimary] = useState(false);
  const [archiving, setArchiving] = useState(false);
  if (scope === undefined) return null;
  /** It and the scopes beneath it: where it may not be moved. */
  const beneath = (id: string): string[] => [id, ...all.filter((s) => s.parentScopeId === id).flatMap((s) => beneath(s.id))];
  const held = new Set((members.data?.members ?? []).map((m) => m.membershipId));
  return (
    <Dialog open onClose={onClose} drawer title={scope.name}>
      <div className={styles.stack}>
        <form className={styles.form} aria-label="Rename or move" onSubmit={async (e) => {
          e.preventDefault();
          const r = await update.run({ params: { scopeId: scope.id }, body: { version: scope.version, name: name.trim(), parentScopeId: parentId === '' ? null : parentId } });
          if (r.ok) say('Saved');
        }}>
          <div className={styles.fields}>
            <TextField label="Name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            <SelectField label="Beneath" value={parentId} onChange={(e) => setParentId(e.target.value)}
              options={[{ value: '', label: 'The top level' }, ...all.filter((s) => !beneath(scope.id).includes(s.id)).map((s) => ({ value: s.id, label: s.name }))]} />
          </div>
          {update.error !== undefined ? <ErrorMessage error={update.error} /> : null}
          <FormActions>
            <Button variant="ghost" icon="trash" blocked={archive.blocked} onClick={() => setArchiving(true)}>Archive</Button>
            <Button type="submit" pending={update.pending} blocked={update.blocked}>Save</Button>
          </FormActions>
        </form>
        <Section title="Members">
          <QueryView query={members} what="Its members" isEmpty={(d) => d.members.length === 0} empty={<p className={styles.muted}>No one is in it directly.</p>}>
            {(d) => (
              <DataTable label="Scope members" rows={d.members} rowKey={(m) => m.id} columns={[
                { id: 'who', header: 'Member', primary: true, cell: (m) => <span className={styles.row}>{people.nameOf(m.membershipId)}{m.isPrimary ? <Badge>Primary</Badge> : null}</span> },
                { id: 'act', header: <span className="visually-hidden">Remove</span>, align: 'end', cell: (m) => <Button size="sm" variant="ghost" blocked={remove.blocked} onClick={() => void remove.run({ params: { scopeMembershipId: m.id } }).then((r) => r.ok && say('Removed from the scope'))}>Remove</Button> },
              ]} />
            )}
          </QueryView>
          <form className={styles.rowEnd} aria-label="Add a member" onSubmit={async (e) => {
            e.preventDefault();
            const r = await add.run({ body: { membershipId: who, scopeId: scope.id, isPrimary: primary } });
            if (r.ok) {
              setWho('');
              say('Added to the scope');
            }
          }}>
            <SelectField label="Add" value={who} placeholder="Choose a member" onChange={(e) => setWho(e.target.value)}
              options={people.members.filter((m) => m.status === 'active' && !held.has(m.membershipId)).map((m) => ({ value: m.membershipId, label: m.displayName }))} />
            <Checkbox label="Their primary scope" checked={primary} onChange={(e) => setPrimary(e.target.checked)} />
            <Button type="submit" pending={add.pending} blocked={add.blocked} disabled={who === ''}>Add</Button>
          </form>
          {add.error !== undefined ? <ErrorMessage error={add.error} /> : null}
          {remove.error !== undefined ? <ErrorMessage error={remove.error} /> : null}
        </Section>
      </div>
      <ConfirmDialog open={archiving} onClose={() => setArchiving(false)} title={`Archive ${scope.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={() => archive.run({ params: { scopeId: scope.id }, body: { version: scope.version } }).then((r) => {
          if (r.ok) {
            say(`${scope.name} archived.`);
            onClose();
          }
          return r;
        })}><p>Roles granted in it stop applying; what belonged to it goes to the scope above.</p></ConfirmDialog>
    </Dialog>
  );
}

/** /settings/principals/: non-human identities, their roles, and the secret shown once. */
export function ServicePrincipals() {
  const say = useToast();
  const people = useDirectory();
  const principals = useQuery('listServicePrincipals', {});
  const roles = useQuery('listRoles', {});
  const scopes = useQuery('listScopes', { query: {} });
  const create = useMutation('createServicePrincipal', { invalidates: ['listServicePrincipals'] });
  const revoke = useMutation('revokeServicePrincipal', { invalidates: ['listServicePrincipals'] });
  const grant = useMutation('grantPrincipalRole', { invalidates: ['listServicePrincipals'] });
  const removeRole = useMutation('removePrincipalRole', { invalidates: ['listServicePrincipals'] });
  const [making, setMaking] = useState(false);
  const [kind, setKind] = useState<'api_client' | 'automation'>('api_client');
  const [name, setName] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [secret, setSecret] = useState<string | undefined>();
  const [revoking, setRevoking] = useState<string | undefined>();
  const [roleFor, setRoleFor] = useState<{ id: string; roleId: string } | undefined>();
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name ?? 'a role';
  const error = grant.error ?? removeRole.error;
  return (
    <Page title="Service principals" description="Identities for integrations and automations: each acts only with the roles it holds, never more than its owner." crumbs={crumbs} width="full"
      actions={<Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => setMaking(true)}>New principal</Button>}>
      <div className={styles.stack}>
        {secret !== undefined ? (
          <Banner tone="warn" title="Its secret, shown this once" action={<CopyButton value={secret} label="Copy the secret" />}>
            <span className={styles.mono}>{secret}</span>
          </Banner>
        ) : null}
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <QueryView query={principals} what="Service principals" isEmpty={(d) => d.servicePrincipals.length === 0} empty={<EmptyState icon="agent" title="None yet">An API client or an automation acts with roles you give it.</EmptyState>}>
          {(d) => (
            <DataTable label="Service principals" rows={d.servicePrincipals} rowKey={(p) => p.id} columns={[
              { id: 'name', header: 'Name', primary: true, cell: (p) => <span className={styles.row}>{p.name}{p.revokedAt !== null ? <Badge>Revoked</Badge> : null}</span> },
              { id: 'kind', header: 'Kind', width: 'sm', cell: (p) => humanise(p.kind) },
              { id: 'owner', header: 'Owner', cell: (p) => people.nameOf(p.ownerMembershipId) },
              { id: 'roles', header: 'Roles', cell: (p) => <span className={styles.row}>{p.roleIds.map((r) => (
                <span key={r} className={styles.row}>{roleName(r)}{p.revokedAt === null ? <IconButton size="sm" icon="close" label={`Remove ${roleName(r)}`} onClick={() => void removeRole.run({ params: { servicePrincipalId: p.id, roleId: r } }).then((x) => x.ok && say('Role removed'))} /> : null}</span>
              ))}{p.roleIds.length === 0 ? '—' : null}</span> },
              { id: 'expires', header: 'Expires', width: 'sm', cell: (p) => (p.expiresAt === null ? '—' : <Time value={p.expiresAt} />) },
              { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (p) => (p.revokedAt !== null ? null : (
                <Menu label={p.name} items={[
                  { label: 'Give it a role', icon: 'key', blocked: grant.blocked, onSelect: () => setRoleFor({ id: p.id, roleId: '' }) },
                  { label: 'Revoke', icon: 'trash', tone: 'danger', blocked: revoke.blocked, onSelect: () => setRevoking(p.id) },
                ]} renderTrigger={(x) => <IconButton {...x} size="sm" label={`${p.name} actions`} icon="more" />} />
              )) },
            ]} />
          )}
        </QueryView>
      </div>
      <Dialog open={making} onClose={() => setMaking(false)} title="New service principal" size="sm" busy={create.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.run({ body: { kind, name: name.trim(), ...(scopeId === '' ? {} : { scopeId }) } });
          if (r.ok) {
            setMaking(false);
            setName('');
            setSecret(r.data.secret);
            say('Made: give it a role');
          }
        }}>
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} options={[{ value: 'api_client', label: 'An API client' }, { value: 'automation', label: 'An automation' }]} />
          <TextField label="Name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <SelectField label="Within" value={scopeId} onChange={(e) => setScopeId(e.target.value)} options={[{ value: '', label: 'The organisation' }, ...(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
          <FormActions><Button onClick={() => setMaking(false)}>Cancel</Button><Button type="submit" variant="primary" pending={create.pending} disabled={name.trim() === ''}>Make it</Button></FormActions>
        </form>
      </Dialog>
      <Dialog open={roleFor !== undefined} onClose={() => setRoleFor(undefined)} title="Give it a role" size="sm" busy={grant.pending}>
        {roleFor !== undefined ? (
          <form className={styles.form} onSubmit={async (e) => {
            e.preventDefault();
            const r = await grant.run({ params: { servicePrincipalId: roleFor.id }, body: { roleId: roleFor.roleId } });
            if (r.ok) {
              setRoleFor(undefined);
              say('Role given');
            }
          }}>
            <SelectField label="Role" required value={roleFor.roleId} placeholder="Choose a role" onChange={(e) => setRoleFor({ ...roleFor, roleId: e.target.value })}
              options={(roles.data?.roles ?? []).filter((r) => r.retiredAt === null).map((r) => ({ value: r.id, label: r.name }))} />
            {grant.error !== undefined ? <ErrorMessage error={grant.error} /> : null}
            <FormActions><Button onClick={() => setRoleFor(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={grant.pending} disabled={roleFor.roleId === ''}>Give it</Button></FormActions>
          </form>
        ) : null}
      </Dialog>
      <ConfirmDialog open={revoking !== undefined} onClose={() => setRevoking(undefined)} title="Revoke the principal?" confirmLabel="Revoke" tone="danger"
        onConfirm={() => revoke.run({ params: { servicePrincipalId: revoking! } }).then((r) => {
          if (r.ok) say('Revoked: its secret no longer works');
          return r;
        })}><p>Its secret stops working at once; anything using it fails from now on.</p></ConfirmDialog>
    </Page>
  );
}

/** /settings/scim/: tokens the identity provider provisions with, and its groups mapped to roles. */
export function Scim() {
  const say = useToast();
  const people = useDirectory();
  const tokens = useQuery('listScimTokens', {});
  const groups = useQuery('listScimGroups', {});
  const roles = useQuery('listRoles', {});
  const scopes = useQuery('listScopes', { query: {} });
  const issue = useMutation('issueScimToken', { invalidates: ['listScimTokens'] });
  const revoke = useMutation('revokeScimToken', { invalidates: ['listScimTokens'] });
  const map = useMutation('createScimGroupMapping', { invalidates: ['listScimGroups'] });
  const unmap = useMutation('removeScimGroupMapping', { invalidates: ['listScimGroups'] });
  const [mapping, setMapping] = useState<{ groupId: string; roleId: string; scopeId: string } | undefined>();
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name ?? 'a role';
  const scopeName = (id: string | null) => (id === null ? 'everywhere' : `in ${scopes.data?.scopes.find((s) => s.id === id)?.name ?? 'a scope'}`);
  return (
    <Page title="SCIM provisioning" description="Your identity provider adds, changes and removes people, and its groups grant roles in scopes." crumbs={crumbs} width="full">
      <div className={styles.stack}>
        <Section title="Tokens" actions={<Button icon="plus" pending={issue.pending} blocked={issue.blocked} onClick={() => void issue.run({}).then((r) => r.ok && say('Issued: copy it into your identity provider now'))}>Issue a token</Button>}>
          {issue.data !== undefined ? (
            <Banner tone="warn" title="The token, shown this once" action={<CopyButton value={issue.data.token} label="Copy the token" />}>
              <span className={styles.mono}>{issue.data.token}</span>
            </Banner>
          ) : null}
          <QueryView query={tokens} what="Tokens" isEmpty={(d) => d.tokens.length === 0} empty={<p className={styles.muted}>No token yet.</p>}>
            {(d) => (
              <DataTable label="SCIM tokens" rows={d.tokens} rowKey={(t) => t.tokenId} columns={[
                { id: 'made', header: 'Issued', primary: true, cell: (t) => <span><Time value={t.createdAt} /> by {people.nameOf(t.createdBy)}</span> },
                { id: 'used', header: 'Last used', width: 'sm', cell: (t) => (t.lastUsedAt === null ? 'Never' : <Time value={t.lastUsedAt} />) },
                { id: 'state', header: 'State', width: 'sm', cell: (t) => (t.revokedAt === null ? <Badge tone="ok">Live</Badge> : <Badge>Revoked</Badge>) },
                { id: 'act', header: <span className="visually-hidden">Revoke</span>, align: 'end', cell: (t) => (t.revokedAt === null ? <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => void revoke.run({ params: { tokenId: t.tokenId } }).then((r) => r.ok && say('Revoked'))}>Revoke</Button> : null) },
              ]} />
            )}
          </QueryView>
        </Section>
        <Section title="Groups" description="Groups your identity provider sends. A mapping grants its members a role in a scope, and takes it away when they leave the group.">
          {map.error !== undefined ? <ErrorMessage error={map.error} /> : null}
          {unmap.error !== undefined ? <ErrorMessage error={unmap.error} /> : null}
          <QueryView query={groups} what="Groups" isEmpty={(d) => d.groups.length === 0} empty={<p className={styles.muted}>Your identity provider has sent no group yet.</p>}>
            {(d) => (
              <DataTable label="SCIM groups" rows={d.groups} rowKey={(g) => g.id} columns={[
                { id: 'group', header: 'Group', primary: true, cell: (g) => g.displayName },
                { id: 'members', header: 'Members', width: 'sm', align: 'end', cell: (g) => String(g.memberCount) },
                { id: 'grants', header: 'Grants', cell: (g) => <span className={styles.stackTight}>{g.mappings.map((m) => (
                  <span key={m.id} className={styles.row}>{roleName(m.roleId)} {scopeName(m.scopeId)}<IconButton size="sm" icon="close" label="Remove the mapping" onClick={() => void unmap.run({ params: { mappingId: m.id } }).then((r) => r.ok && say('Mapping removed'))} /></span>
                ))}{g.mappings.length === 0 ? '—' : null}</span> },
                { id: 'act', header: <span className="visually-hidden">Map</span>, align: 'end', cell: (g) => <Button size="sm" blocked={map.blocked} onClick={() => setMapping({ groupId: g.id, roleId: '', scopeId: '' })}>Map to a role</Button> },
              ]} />
            )}
          </QueryView>
        </Section>
      </div>
      <Dialog open={mapping !== undefined} onClose={() => setMapping(undefined)} title="Map the group to a role" size="sm" busy={map.pending}>
        {mapping !== undefined ? (
          <form className={styles.form} onSubmit={async (e) => {
            e.preventDefault();
            const r = await map.run({ body: { groupId: mapping.groupId, roleId: mapping.roleId, scopeId: mapping.scopeId === '' ? null : mapping.scopeId } });
            if (r.ok) {
              setMapping(undefined);
              say(`Mapped: ${plural(r.data.granted, 'member')} granted${r.data.refused > 0 ? `, ${r.data.refused} refused` : ''}`);
            }
          }}>
            <SelectField label="Role" required value={mapping.roleId} placeholder="Choose a role" onChange={(e) => setMapping({ ...mapping, roleId: e.target.value })}
              options={(roles.data?.roles ?? []).filter((r) => r.retiredAt === null).map((r) => ({ value: r.id, label: r.name }))} />
            <SelectField label="Where" value={mapping.scopeId} onChange={(e) => setMapping({ ...mapping, scopeId: e.target.value })}
              options={[{ value: '', label: 'Everywhere' }, ...(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
            {map.error !== undefined ? <ErrorMessage error={map.error} /> : null}
            <FormActions><Button onClick={() => setMapping(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={map.pending} disabled={mapping.roleId === ''}>Map it</Button></FormActions>
          </form>
        ) : null}
      </Dialog>
    </Page>
  );
}
