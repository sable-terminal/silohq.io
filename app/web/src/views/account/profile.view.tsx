'use client';

// The person's profile: who they are in this organisation, and changing their password. The
// name and address come from their invitation or identity provider; a password change asks for
// the current one, and ends the person's other sessions.

import { useState, type FormEvent } from 'react';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { FormActions, fieldError, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import styles from './account.view.module.css';

export function Profile() {
  const workspace = useWorkspace();
  const identities = useQuery('listIdentities', {});
  const change = useMutation('changeOwnPassword');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  usePageContext({});
  const person = workspace.person;
  const organisation = workspace.memberships.find((m) => m.current);
  const mismatch = again !== '' && again !== next;
  const usesPassword = identities.data?.password !== false;
  const ssoOnly = identities.data?.ssoRequired === true;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mismatch || next === '' || current === '') return;
    setDone(false);
    const outcome = await change.run({ body: { currentPassword: current, newPassword: next } });
    if (outcome.ok) {
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
    }
  };

  return (
    <Page title="Profile" description="Who you are in Silo, and your password." width="narrow">
      <Section title="You">
        <Panel>
          <Properties items={[
            ['Name', `${person.firstName} ${person.lastName}`],
            ['Email', person.email],
            ['Organisation', organisation === undefined ? undefined : `${organisation.organisationName} (${organisation.organisationSlug})`],
            ['Signed in with', workspace.session.authMethod === 'sso' ? 'Single sign-on' : 'Password'],
          ]} />
        </Panel>
      </Section>
      <Section title="Password" description={ssoOnly ? 'Your organisation signs in through its identity provider only, so you have no Silo password to change.'
        : 'Changing it signs you out everywhere else.'}>
        {ssoOnly || !usesPassword ? null : (
          <Panel>
            <form className={styles.enrol} onSubmit={(e) => void submit(e)}>
              {done ? <Banner tone="ok" title="Password changed">Your other sessions have ended.</Banner> : null}
              <TextField label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)}
                error={fieldError(change.error, 'currentPassword')} />
              <TextField label="New password" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)}
                hint="A long passphrase is best. Silo refuses passwords known from breaches." error={fieldError(change.error, 'newPassword')} />
              <TextField label="The same again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)}
                error={mismatch ? 'The two do not match' : undefined} />
              {change.error !== undefined && fieldError(change.error, 'currentPassword') === undefined && fieldError(change.error, 'newPassword') === undefined
                ? <ErrorMessage error={change.error} /> : null}
              <FormActions>
                <Button type="submit" variant="primary" pending={change.pending} blocked={change.blocked} disabled={current === '' || next === '' || mismatch}>Change password</Button>
              </FormActions>
            </form>
          </Panel>
        )}
      </Section>
    </Page>
  );
}
