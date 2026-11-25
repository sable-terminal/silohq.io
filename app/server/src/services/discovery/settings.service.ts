// The organisation's discovery switch (spec 19.1): off by default; only discovery.manage, held
// organisation-wide (a super admin), turns it on or off. It is kept on discovery's own row and
// mirrored on the organisation (iam.organisations.discovery_enabled), in one transaction.
// Turning it off stops the organisation's scans in progress.

import type { settingsView } from '../../contracts/discovery/discovery.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { DiscoverySetting } from '../../models/connect/discoverySetting.model.ts';
import { discoverySettingRepo } from '../../repos/connect/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { demand, memberOf, recordDiscoveryEvent, type Context, type DiscoveryDeps } from './deps.service.ts';

type SettingsView = typeof settingsView._output;

const viewOf = (row: DiscoverySetting | undefined): SettingsView => ({
  enabled: row?.enabled ?? false, enabledBy: row?.enabledBy ?? null, enabledAt: row?.enabledAt ?? null, disabledAt: row?.disabledAt ?? null,
});

export function createSettings(deps: DiscoveryDeps, onDisabled: (db: Queryable, ctx: Context) => Promise<void>) {
  const control = deps.databases.pool('control');
  const manage = { permission: 'discovery.manage', organisationWide: true } as const;
  return {
    async get(ctx: Context): Promise<SettingsView> {
      await demand(deps, ctx, [manage, 'discovery.authorise', 'discovery.review']);
      return viewOf(await inTransaction(control, ctx.request, (db) => discoverySettingRepo.findByOrganisationId(db, ctx.request.organisationId!), { readOnly: true }));
    },

    async set(ctx: Context, enabled: boolean): Promise<SettingsView> {
      const membershipId = memberOf(ctx);
      await demand(deps, ctx, [manage]);
      const organisationId = ctx.request.organisationId!;
      const now = new Date().toISOString();
      const row = await inTransaction(control, ctx.request, async (db) => {
        const current = await discoverySettingRepo.findByOrganisationId(db, organisationId);
        if ((current?.enabled ?? false) === enabled) return current;
        const changes = enabled ? { enabled, enabledBy: membershipId, enabledAt: now, disabledAt: null } : { enabled, disabledAt: now };
        const saved = current === undefined
          ? await discoverySettingRepo.insert(db, { organisationId, ...changes })
          : await discoverySettingRepo.update(db, organisationId, { ...changes, version: current.version + 1 });
        await organisationRepo.update(db, organisationId, { discoveryEnabled: enabled });
        await recordDiscoveryEvent(db, {
          organisationId, correlationId: ctx.correlationId, request: ctx.request, event: enabled ? 'discovery_enabled' : 'discovery_disabled', resource: null,
        });
        // Off means unreachable: scans in progress stop with it.
        if (!enabled) await onDisabled(db, ctx);
        return saved;
      });
      return viewOf(row);
    },
  };
}

export type Settings = ReturnType<typeof createSettings>;
