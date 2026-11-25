'use client';

// Sharing something (a Lens, a saved view, a workbook, an app): with a person, a team (a scope)
// or everyone in the organisation, at one of its access levels; and the shares it has now, each
// revocable. People and teams come from the organisation's directory (readDirectory), so any
// member can name a colleague. What may be shared with whom is the organisation's sharing policy:
// the server refuses what it does not allow, and the refusal is shown here.

import { useMemo, useState, type FormEvent } from 'react';
import type { Blocked, MutationResult } from '../data/query.data.ts';
import { useDirectory } from '../hooks/directory.hook.ts';
import { Button } from './button.component.tsx';
import { Dialog } from './dialog.component.tsx';
import { RadioGroup, SelectField } from './field.component.tsx';
import { ErrorMessage } from './states.component.tsx';
import { Time } from './time.component.tsx';
import { formatDate } from '../utils/format.util.ts';
import styles from './share.component.module.css';

export type Grantee = { kind: 'membership'; membershipId: string } | { kind: 'scope'; scopeId: string } | { kind: 'organisation' };

export interface Share<A extends string> {
  id: string;
  grantee: Grantee;
  access: A;
  createdAt?: string | undefined;
  revokedAt?: string | null | undefined;
  /** What the recipient could see when it was shared, where the service states it (a Lens's coverage). */
  note?: string | undefined;
}

export function ShareDialog<A extends string>({ open, onClose, title, what, access, shares, onShare, onRevoke, shareBlocked, revokeBlocked, kinds }: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What is shared, as a person reads it: "this Lens". */
  what: string;
  access: readonly { value: A; label: string; hint?: string }[];
  shares: readonly Share<A>[] | undefined;
  onShare: (grantee: Grantee, access: A) => Promise<MutationResult<unknown>>;
  onRevoke: (shareId: string) => Promise<MutationResult<unknown>>;
  shareBlocked?: Blocked | undefined;
  revokeBlocked?: Blocked | undefined;
  /** Who it may be shared with; all three by default. */
  kinds?: readonly Grantee['kind'][];
}) {
  const people = useDirectory();
  const allowed = kinds ?? ['membership', 'scope', 'organisation'];
  const [kind, setKind] = useState<Grantee['kind']>(allowed[0]!);
  const [who, setWho] = useState('');
  const [level, setLevel] = useState<A>(access[0]!.value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [revoking, setRevoking] = useState<string | undefined>(undefined);

  const live = (shares ?? []).filter((s) => s.revokedAt === null || s.revokedAt === undefined);
  const describe = (g: Grantee) => (g.kind === 'membership' ? people.nameOf(g.membershipId) : g.kind === 'scope' ? `Everyone in ${people.scopeName(g.scopeId)}` : 'Everyone in the organisation');
  const accessLabel = (a: A) => access.find((x) => x.value === a)?.label ?? a;
  const members = useMemo(() => people.members.filter((m) => m.status === 'active').sort((a, b) => a.displayName.localeCompare(b.displayName)), [people.members]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const grantee: Grantee | undefined = kind === 'organisation' ? { kind } : who === '' ? undefined
      : kind === 'membership' ? { kind, membershipId: who } : { kind, scopeId: who };
    if (grantee === undefined) return;
    setPending(true);
    setError(undefined);
    const outcome = await onShare(grantee, level);
    setPending(false);
    if (outcome.ok) setWho('');
    else setError(outcome.error);
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} description={`Who may see ${what}, and what they may do with it.`} size="md" busy={pending}>
      <div className={styles.body}>
        <section aria-labelledby="share-now">
          <h3 id="share-now" className={styles.heading}>Shared with</h3>
          {shares === undefined ? <p className={styles.muted}>Reading its shares…</p> : live.length === 0 ? <p className={styles.muted}>Only you.</p> : (
            <ul className={styles.list}>
              {live.map((s) => (
                <li key={s.id} className={styles.row}>
                  <span className={styles.who}>
                    <strong>{describe(s.grantee)}</strong>
                    <span className={styles.muted}>{accessLabel(s.access)}{s.createdAt !== undefined ? <> · since <Time value={s.createdAt} /></> : null}{s.note !== undefined ? ` · ${s.note}` : ''}</span>
                  </span>
                  <Button size="sm" variant="ghost" blocked={revokeBlocked} pending={revoking === s.id} onClick={() => {
                    setRevoking(s.id);
                    setError(undefined);
                    void onRevoke(s.id).then((r) => {
                      setRevoking(undefined);
                      if (!r.ok) setError(r.error);
                    });
                  }}>Stop sharing</Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <form className={styles.form} onSubmit={(e) => void submit(e)}>
          <h3 className={styles.heading}>Share with</h3>
          {allowed.length > 1 ? (
            <RadioGroup<Grantee['kind']> name="grantee" label="Who" value={kind} onChange={(k) => {
              setKind(k);
              setWho('');
            }} options={allowed.map((k) => ({ value: k, label: k === 'membership' ? 'A person' : k === 'scope' ? 'A team' : 'Everyone in the organisation' }))} />
          ) : null}
          {kind === 'membership' ? (
            <SelectField label="Person" value={who} onChange={(e) => setWho(e.target.value)} placeholder={people.ready ? 'Choose a person…' : 'Reading the directory…'}
              options={members.map((m) => ({ value: m.membershipId, label: m.displayName }))} />
          ) : null}
          {kind === 'scope' ? (
            <SelectField label="Team" value={who} onChange={(e) => setWho(e.target.value)} placeholder={people.ready ? 'Choose a team…' : 'Reading the directory…'}
              options={people.scopes.map((s) => ({ value: s.id, label: `${'  '.repeat(s.depth)}${s.name}` }))} />
          ) : null}
          {access.length > 1 ? (
            <RadioGroup<A> name="access" label="They may" value={level} onChange={setLevel} options={access.map((a) => ({ value: a.value, label: a.label, hint: a.hint }))} />
          ) : null}
          {error !== undefined ? <ErrorMessage error={error} /> : null}
          <div className={styles.actions}>
            <Button onClick={onClose}>Done</Button>
            <Button type="submit" variant="primary" icon="share" pending={pending} blocked={shareBlocked} disabled={kind !== 'organisation' && who === ''}>Share</Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

interface ShareRow<A extends string> {
  id: string;
  grantee: Grantee;
  access: A;
  sharedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  state: 'live' | 'revoked' | 'expired' | 'suspended' | 'forbidden_by_policy';
}

/** Shares as the share dialog lists them: revoked and expired ones gone; suspended and forbidden ones with why. */
export function sharesFor<A extends string>(shares: readonly ShareRow<A>[] | undefined): Share<A>[] | undefined {
  return shares?.map((s) => ({
    id: s.id, grantee: s.grantee, access: s.access, createdAt: s.sharedAt,
    revokedAt: s.state === 'revoked' || s.state === 'expired' ? (s.revokedAt ?? s.expiresAt ?? s.sharedAt) : null,
    note: s.state === 'suspended' ? 'suspended: it grants nothing until it is reviewed'
      : s.state === 'forbidden_by_policy' ? 'grants nothing: the sharing policy no longer allows it'
        : s.expiresAt !== null ? `until ${formatDate(s.expiresAt)}` : undefined,
  }));
}

