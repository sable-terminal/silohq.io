'use client';

// Where the person's notifications go beyond Silo itself: the phones and tablets the Silo mobile
// app registered for push. A device is registered from the app on it; here the person sees them
// and removes one they no longer use (spec 85, D85). Push messages carry a title, a count and a
// link only, never a value.

import { useState } from 'react';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog } from '../../components/dialog.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { usePageContext } from '../../shell/context.shell.tsx';

export function Devices() {
  const say = useToast();
  const devices = useQuery('listPushDevices', {});
  const remove = useMutation('removePushDevice');
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  usePageContext({});
  return (
    <Page title="Notifications and devices" description="Silo tells you what needs you in the bell at the top of every page. The Silo mobile app can also send them to your phone." width="narrow">
      <Section title="Devices that receive notifications" description="Register a device by signing in to the Silo mobile app on it and allowing notifications.">
        <QueryView query={devices} what="Your devices" isEmpty={(d) => d.devices.length === 0}
          empty={<EmptyState icon="bell" title="No devices">Notifications reach you in Silo only.</EmptyState>}>
          {(d) => (
            <DataTable label="Devices" rows={d.devices} rowKey={(x) => x.id} columns={[
              { id: 'platform', header: 'Device', primary: true, cell: (x) => (x.platform === 'apns' ? 'Apple device' : 'Android device') },
              { id: 'registered', header: 'Registered', cell: (x) => <Time value={x.registeredAt} /> },
              { id: 'sent', header: 'Last sent to', cell: (x) => (x.lastSentAt === null ? 'Not yet' : <Time value={x.lastSentAt} />) },
              { id: 'remove', header: <span className="visually-hidden">Remove</span>, align: 'end', cell: (x) => (
                <Button size="sm" variant="ghost" blocked={remove.blocked} onClick={() => setRemoving(x.id)}>Remove</Button>
              ) },
            ]} />
          )}
        </QueryView>
      </Section>
      <ConfirmDialog open={removing !== undefined} onClose={() => setRemoving(undefined)} title="Stop sending notifications to this device?" confirmLabel="Remove" tone="danger"
        onConfirm={async () => {
          const outcome = await remove.run({ params: { deviceId: removing! } });
          if (outcome.ok) say('Device removed');
          return outcome;
        }}>
        <p>It will no longer receive push notifications. Signing in to the app on it again registers it again.</p>
      </ConfirmDialog>
    </Page>
  );
}
