'use client';

// The page an identity provider sends the person back to (spec 55.4): it proves this tab started
// the flow (the binding kept in the tab's session storage), hands the provider's answer to the
// gateway once, clears it from the address, and goes on to the page asked for, or to the second
// factor when the organisation asks for one.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Banner } from '../../components/banner.component.tsx';
import { useData } from '../../data/query.data.ts';
import { safeNext } from '../../utils/href.util.ts';
import { EntryFrame } from './frame.view.tsx';
import { entryProblem, SSO_FLOW_KEY } from './signIn.view.tsx';

const FAILURES: Record<string, string> = {
  'sso.acs_unreadable': 'The identity provider\'s answer could not be read.',
};

export function SsoReturn({ protocol }: { protocol: 'oidc' | 'saml' }) {
  const router = useRouter();
  const { api, cache, status } = useData();
  const [problem, setProblem] = useState<string | undefined>();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let flow: { binding: string; next: string } | undefined;
    try {
      flow = JSON.parse(window.sessionStorage.getItem(SSO_FLOW_KEY) ?? 'null') ?? undefined;
      window.sessionStorage.removeItem(SSO_FLOW_KEY);
    } catch {
      flow = undefined;
    }
    // The fragment and query are read once and cleared from the address bar.
    const query = window.location.search.slice(1);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, '', window.location.pathname);
    if (flow === undefined) {
      setProblem('This sign-in was started in another tab or has expired. Start again.');
      return;
    }
    const failure = fragment.get('error');
    if (protocol === 'saml' && failure !== null) {
      setProblem(FAILURES[failure] ?? 'Your identity provider did not sign you in. Start again.');
      return;
    }
    void (async () => {
      try {
        const session = protocol === 'oidc'
          ? await api.call('completeOidc', { body: { callbackQuery: query, binding: flow.binding } })
          : await api.call('completeSaml', { body: { ticket: fragment.get('ticket') ?? '', binding: flow.binding } });
        const next = safeNext(flow.next);
        cache.clear();
        status.live();
        router.replace((session.mfa === 'satisfied' || session.mfa === 'not_required' ? next : `/sign-in/?step=mfa&next=${encodeURIComponent(next)}`) as never);
      } catch (error) {
        setProblem(entryProblem(error));
      }
    })();
  }, [protocol, router, api, cache, status]);

  return (
    <EntryFrame title="Signing you in">
      {problem === undefined ? <p role="status">Signing you in…</p> : (
        <>
          <Banner tone="danger" title="Not signed in" urgent>{problem}</Banner>
          <Link href="/sign-in/">Back to sign in</Link>
        </>
      )}
    </EntryFrame>
  );
}
