'use client';

// The organisations the person belongs to, and switching between them. Each organisation is
// separate: switching signs in to the other one, and everything read for this one is forgotten.

import { useState } from 'react';
import { Badge } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';

export function Organisations() {
  const workspace = useWorkspace();
  const [switching, setSwitching] = useState<string | undefined>(undefined);
  usePageContext({});
  return (
    <Page title="Organisations" description="The organisations you belong to. Each is separate: what you see and do in one stays in it." width="narrow">
      <DataTable label="Organisations" rows={workspace.memberships} rowKey={(m) => m.organisationId} columns={[
        { id: 'name', header: 'Organisation', primary: true, cell: (m) => m.organisationName },
        { id: 'slug', header: 'Short name', cell: (m) => m.organisationSlug },
        { id: 'state', header: 'State', cell: (m) => (m.current ? <Badge tone="ok">Signed in</Badge> : m.status === 'invited' ? <Badge tone="warn">Invited</Badge> : <Badge>Member</Badge>) },
        { id: 'switch', header: <span className="visually-hidden">Switch</span>, align: 'end', cell: (m) => (m.current || m.status !== 'active' ? null : (
          <Button size="sm" pending={switching === m.organisationId} onClick={() => {
            setSwitching(m.organisationId);
            void workspace.switchOrganisation(m.organisationId).finally(() => setSwitching(undefined));
          }}>Switch to it</Button>
        )) },
      ]} />
    </Page>
  );
}
