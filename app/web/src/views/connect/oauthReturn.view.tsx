'use client';

// The return from a provider's sign-in (spec 15.3): the cell's one OAuth callback. The state and
// code are handed to Silo once (the state is single use, so a reload never sends them again),
// then removed from the address, and the person is told what was granted, or why it was not,
// with the way back to the connection.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Banner } from '../../components/banner.component.tsx';
import { LinkButton } from '../../components/button.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { ErrorState, Loading } from '../../components/states.component.tsx';
import { useData } from '../../data/query.data.ts';
import { hrefWith } from '../../utils/href.util.ts';

type Outcome = { ok: true; data: Output<'completeOAuthFlow'> } | { ok: false; error: unknown } | { ok: false; missing: true };

export function OAuthReturn() {
  const { api } = useData();
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const params = new URLSearchParams(window.location.search);
    const state = params.get('state');
    const code = params.get('code');
    const error = params.get('error');
    // The code is single use and a credential while it lives: it leaves the address and the history at once.
    window.history.replaceState(null, '', window.location.pathname);
    if (state === null) {
      setOutcome({ ok: false, missing: true });
      return;
    }
    api.call('completeOAuthFlow', { body: { state, ...(code === null ? {} : { code }), ...(error === null ? {} : { error: error.slice(0, 200) }) } }).then(
      (data) => setOutcome({ ok: true, data }),
      (e: unknown) => setOutcome({ ok: false, error: e }),
    );
  }, [api]);

  return (
    <Page title="Signing in to the system" width="narrow" crumbs={[{ label: 'Connect' }, { label: 'Connections', href: '/connect/connections/' }]}>
      {outcome === undefined ? <Loading label="Finishing the sign-in" /> : outcome.ok ? (
        <Banner tone="ok" title="Signed in"
          action={<LinkButton href={hrefWith('/connect/connections/', { connection: outcome.data.connectionId, tab: 'setup' })} variant="primary">Back to the connection</LinkButton>}>
          {outcome.data.grantedScopes.length > 0 ? `It allowed: ${outcome.data.grantedScopes.join(', ')}.` : 'The system allowed access.'} Test the connection next.
        </Banner>
      ) : 'missing' in outcome ? (
        <Banner tone="warn" title="Nothing to finish" action={<Link href="/connect/connections/">Connections</Link>}>
          This address carries no sign-in. Start again from the connection's Settings and credentials.
        </Banner>
      ) : (
        <ErrorState error={outcome.error} what="The sign-in" />
      )}
    </Page>
  );
}
