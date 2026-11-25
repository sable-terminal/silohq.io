'use client';

// What every page in the workspace knows: the session, the person, their organisations, where
// the organisation lives, their preferences, the active Lens (spec 38.9), and what the page has
// told the shell about itself (the Ask scope, its status line, its commands for search).
//
// The session is handled here once (guarantee 4): when any request finds it ended, every read is
// forgotten and the person signs in again and comes back to the same page; signing out or
// switching organisation in one tab does the same in every other tab.

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Input, Output } from '../api/client.api.ts';
import { useClientStatus, useData, useMutation, useQuery } from '../data/query.data.ts';
import { readStored, writeStored } from '../hooks/storage.hook.ts';
import { here, signInHref } from '../utils/href.util.ts';

export type AskScope = NonNullable<NonNullable<Input<'createAskThread'>['body']>['scope']>;

/** A command a page offers to search (spec 33.5: "product commands run against the page context"). */
export interface PageCommand {
  id: string;
  label: string;
  run: () => void;
  keywords?: readonly string[];
  disabled?: string | undefined;
}

/** What a page tells the shell about itself. */
export interface PageContext {
  /** What Ask is scoped to on this page (spec 33.6): references, never values. */
  scope?: AskScope | undefined;
  /** How the scope reads: "Pump P-101", "the Approvals queue". */
  scopeLabel?: string | undefined;
  /** The status line: freshness and incompleteness (spec 33.2). */
  status?: string | undefined;
  commands?: readonly PageCommand[] | undefined;
}

export type PanelName = 'search' | 'create' | 'notifications' | 'help' | 'tickets' | 'profile' | 'lens';

export interface PanelRequest {
  name: PanelName;
  /** Search: the text to start with. Tickets: a request to quote. */
  query?: string | undefined;
  correlationId?: string | undefined;
  route?: string | undefined;
}

export interface Lens { id: string; name: string }

export interface Workspace {
  session: Output<'currentSession'>;
  person: Output<'readOwnProfile'>;
  memberships: Output<'listMyMemberships'>['memberships'];
  rail: Output<'readRail'>['items'];
  preferences: Output<'readPreferences'>;
  setPreferences(changes: { railCollapsed?: boolean; askPanelOpen?: boolean }): void;
  /** Absent when the person may not read it, or it could not be read. */
  residency: Output<'getResidency'> | undefined;
  lens: Lens | undefined;
  setLens(lens: Lens | undefined): void;
  page: PageContext;
  setPage(page: PageContext | undefined): void;
  panel: PanelRequest | undefined;
  openPanel(request: PanelRequest | PanelName): void;
  closePanel(): void;
  signOut(): Promise<void>;
  switchOrganisation(organisationId: string): Promise<void>;
  /** Opens the Ask panel with a question for this page (search's last entry, spec 33.5). */
  askAboutPage(question: string): void;
  /** The question waiting for the Ask panel, taken once. */
  pendingQuestion: string | undefined;
  takePendingQuestion(): string | undefined;
}

const WorkspaceContext = createContext<Workspace | undefined>(undefined);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (workspace === undefined) throw new Error('useWorkspace is for pages inside the workspace');
  return workspace;
}

/** The workspace if this page is inside it: components shared with the pages before sign-in use this. */
export const useMaybeWorkspace = (): Workspace | undefined => useContext(WorkspaceContext);

/** Tells the shell about this page while it is shown. */
export function usePageContext(page: PageContext): void {
  const { setPage } = useWorkspace();
  const key = JSON.stringify({ scope: page.scope, scopeLabel: page.scopeLabel, status: page.status, commands: page.commands?.map((c) => [c.id, c.label, c.disabled]) });
  const latest = useRef(page);
  latest.current = page;
  useEffect(() => {
    setPage(latest.current);
  }, [key, setPage]);
  useEffect(() => () => setPage(undefined), [setPage]);
}

type TabMessage = { type: 'signed-out' } | { type: 'switched'; organisationId: string };
const CHANNEL = 'silo.session';

function lensKey(membershipId: string): string {
  return `silo.lens.${membershipId}`;
}

export type Opening = { state: 'opening' } | { state: 'failed'; error: unknown; retry: () => void } | { state: 'open'; workspace: Workspace };

export function WorkspaceProvider({ children, fallback }: { children: ReactNode; fallback: (opening: Exclude<Opening, { state: 'open' }>) => ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { cache } = useData();
  const status = useClientStatus();

  const session = useQuery('currentSession', {}, { staleMs: 60_000 });
  const complete = session.data !== undefined && session.data.mfa !== 'required' && session.data.mfa !== 'enrolment_required';
  const person = useQuery('readOwnProfile', complete ? {} : null, { staleMs: 5 * 60_000 });
  const memberships = useQuery('listMyMemberships', complete ? {} : null, { staleMs: 5 * 60_000 });
  const rail = useQuery('readRail', complete ? {} : null, { staleMs: 5 * 60_000 });
  const preferences = useQuery('readPreferences', complete ? {} : null, { staleMs: 5 * 60_000 });
  const residency = useQuery('getResidency', complete ? {} : null, { staleMs: 5 * 60_000 });
  // Read early, so controls know what the person may use by the time the page draws.
  useQuery('readMyPermissions', complete ? {} : null, { staleMs: 5 * 60_000 });
  const savePreferences = useMutation('updatePreferences');
  const signOutCall = useMutation('signOut', { refresh: false });
  const singleLogout = useMutation('signOutWithProvider', { refresh: false });
  const leaving = useRef(false);
  const switchCall = useMutation('switchMembership');

  const [page, setPageState] = useState<PageContext>({});
  const [panel, setPanel] = useState<PanelRequest | undefined>(undefined);
  const [lens, setLensState] = useState<Lens | undefined>(undefined);
  const [localPreferences, setLocalPreferences] = useState<{ railCollapsed?: boolean; askPanelOpen?: boolean }>({});
  const [pendingQuestion, setPendingQuestion] = useState<string | undefined>(undefined);

  const toSignIn = useCallback((step?: 'mfa') => {
    // Signing out sends the person to sign in itself, without a page to come back to.
    if (leaving.current) return;
    cache.clear();
    router.replace(signInHref(here(), step) as never);
  }, [cache, router]);

  // The session ended (any request found it so), or needs its second factor. Acted on once this
  // workspace's own session read has answered: a state from before it opened (the sign-in page
  // asking whether anyone was signed in) is not the session it opened with.
  const sessionAnswered = session.status === 'success' || session.status === 'error';
  useEffect(() => {
    if (!sessionAnswered) return;
    if (status.session === 'ended') toSignIn();
    else if (status.session === 'mfa') toSignIn('mfa');
  }, [sessionAnswered, status.session, toSignIn]);

  // The session read says the second factor is outstanding.
  useEffect(() => {
    if (session.data !== undefined && !complete) toSignIn('mfa');
  }, [session.data, complete, toSignIn]);

  // Another tab signed out or switched organisation.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      if (event.data?.type === 'signed-out') toSignIn();
      if (event.data?.type === 'switched') {
        cache.clear();
        window.location.assign('/');
      }
    };
    return () => channel.close();
  }, [cache, toSignIn]);

  const membershipId = session.data?.membershipId ?? undefined;
  useEffect(() => {
    if (membershipId !== undefined) setLensState(readStored<Lens | undefined>(lensKey(membershipId), undefined));
  }, [membershipId]);

  // A migration's read-only window known from the residency read, before any write is refused.
  const { status: statusStore } = useData();
  const readOnly = residency.data?.migration?.readOnlyAt != null && residency.data.migration.status !== 'completed' && residency.data.migration.status !== 'aborted';
  useEffect(() => {
    if (readOnly) statusStore.pause();
  }, [readOnly, statusStore]);

  // A page's status and commands belong to that page.
  useEffect(() => {
    setPanel((p) => (p?.name === 'search' || p?.name === 'create' ? undefined : p));
  }, [pathname]);

  const setPage = useCallback((next: PageContext | undefined) => setPageState(next ?? {}), []);

  const ready = session.data !== undefined && complete && person.data !== undefined && memberships.data !== undefined && rail.data !== undefined && preferences.data !== undefined;
  const firstError = [session, person, memberships, rail, preferences].find((q) => q.data === undefined && q.status === 'error')?.error;

  const workspace = useMemo<Workspace | undefined>(() => {
    if (!ready) return undefined;
    return {
      session: session.data!,
      person: person.data!,
      memberships: memberships.data!.memberships,
      rail: rail.data!.items,
      preferences: { ...preferences.data!, ...localPreferences },
      setPreferences(changes) {
        setLocalPreferences((p) => ({ ...p, ...changes }));
        void savePreferences.run({ body: changes });
      },
      residency: residency.data,
      lens,
      setLens(next) {
        setLensState(next);
        if (membershipId !== undefined) writeStored(lensKey(membershipId), next);
      },
      page,
      setPage,
      panel,
      openPanel(request) {
        setPanel(typeof request === 'string' ? { name: request } : request);
      },
      closePanel() {
        setPanel(undefined);
      },
      async signOut() {
        leaving.current = true;
        // Signed in through single sign-on: the provider's session ends too where it offers single
        // logout (spec 55.5). If that cannot be started, the session here still ends.
        let logoutUrl: string | null = null;
        if (session.data?.authMethod === 'sso') {
          const ended = await singleLogout.run({});
          if (ended.ok) logoutUrl = ended.data.logoutUrl;
          else await signOutCall.run({});
        } else {
          await signOutCall.run({});
        }
        try {
          new BroadcastChannel(CHANNEL).postMessage({ type: 'signed-out' } satisfies TabMessage);
        } catch {
          // Other tabs find out on their next request.
        }
        cache.clear();
        if (logoutUrl !== null) window.location.assign(logoutUrl);
        else router.replace('/sign-in/' as never);
      },
      askAboutPage(question) {
        setPendingQuestion(question);
        setLocalPreferences((p) => ({ ...p, askPanelOpen: true }));
        void savePreferences.run({ body: { askPanelOpen: true } });
      },
      pendingQuestion,
      takePendingQuestion() {
        const question = pendingQuestion;
        setPendingQuestion(undefined);
        return question;
      },
      async switchOrganisation(organisationId) {
        const outcome = await switchCall.run({ body: { organisationId } });
        if (!outcome.ok) return;
        try {
          new BroadcastChannel(CHANNEL).postMessage({ type: 'switched', organisationId } satisfies TabMessage);
        } catch {
          // Other tabs find out on their next request.
        }
        // Everything held belongs to the other organisation now.
        cache.clear();
        window.location.assign('/');
      },
    };
  }, [ready, session.data, person.data, memberships.data, rail.data, preferences.data, localPreferences, residency.data, lens, membershipId, page, setPage, panel,
    pendingQuestion, savePreferences, signOutCall, singleLogout, switchCall, cache, router]);

  if (workspace === undefined) {
    if (firstError !== undefined) {
      return <>{fallback({ state: 'failed', error: firstError, retry: () => [session, person, memberships, rail, preferences].forEach((q) => q.refetch()) })}</>;
    }
    return <>{fallback({ state: 'opening' })}</>;
  }
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}
