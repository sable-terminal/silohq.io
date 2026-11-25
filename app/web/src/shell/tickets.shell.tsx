'use client';

// Support tickets (the header's ticket icon): the person's tickets, raising a new one, and a
// ticket's conversation, all in the panel. A failure anywhere ("Contact support") opens a new
// ticket here with its reference attached. The support page has the same with more room.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { NewTicket, TicketList, TicketView } from '../views/support/tickets.view.tsx';
import { useWorkspace } from './context.shell.tsx';
import styles from './help.shell.module.css';

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'ticket'; id: string };

export function TicketsPanel() {
  const workspace = useWorkspace();
  const request = workspace.panel;
  const [view, setView] = useState<View>(request?.query === 'new' ? { kind: 'new' } : { kind: 'list' });
  useEffect(() => {
    if (request?.name === 'tickets' && request.query === 'new') setView({ kind: 'new' });
  }, [request]);
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.title}>Support tickets</h2>
        <Link href={view.kind === 'ticket' ? `/support/?ticket=${view.id}` : '/support/'} onClick={() => workspace.closePanel()}>Open full page</Link>
      </div>
      {view.kind === 'list' ? <TicketList onOpen={(id) => setView({ kind: 'ticket', id })} onNew={() => setView({ kind: 'new' })} /> : null}
      {view.kind === 'new' ? (
        <NewTicket correlationId={request?.correlationId} route={request?.route}
          onRaised={(id) => setView({ kind: 'ticket', id })} onCancel={() => setView({ kind: 'list' })} />
      ) : null}
      {view.kind === 'ticket' ? <TicketView ticketId={view.id} onBack={() => setView({ kind: 'list' })} /> : null}
    </div>
  );
}
