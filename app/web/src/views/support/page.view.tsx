'use client';

// The support page: the person's tickets beside the open one, with room for a long conversation.
// ?ticket= opens one; ?new=1 starts one.

import { Page } from '../../components/page.component.tsx';
import { EmptyState } from '../../components/states.component.tsx';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { NewTicket, TicketList, TicketView } from './tickets.view.tsx';
import styles from './tickets.view.module.css';

export function SupportPage() {
  const [params, set] = useParams();
  const ticketId = params.get('ticket') ?? undefined;
  const making = params.get('new') !== null;
  usePageContext({});
  return (
    <Page title="Support tickets" description="Ask Silo support for help, and follow the replies. Describe what happened; never paste your data." width="wide"
      crumbs={[{ label: 'Help centre', href: '/help/' }]}>
      <div className={styles.page}>
        <TicketList current={ticketId} onOpen={(id) => set({ ticket: id, new: undefined }, { push: true })} onNew={() => set({ new: '1', ticket: undefined }, { push: true })} />
        <div>
          {making ? <NewTicket onRaised={(id) => set({ ticket: id, new: undefined })} onCancel={() => set({ new: undefined })} />
            : ticketId !== undefined ? <TicketView key={ticketId} ticketId={ticketId} />
            : <EmptyState icon="ticket" title="Choose a ticket">Or raise a new one.</EmptyState>}
        </div>
      </div>
    </Page>
  );
}
