/**
 * A tenant.
 *
 * EVERY POLICY DEFAULT HERE IS THE RESTRICTIVE ONE. Storage off, MFA not
 * required, sharing at its narrowest useful setting. A customer who never opens
 * the settings gets the safe configuration, and turning something on is a
 * deliberate act with an audit row against it.
 */

import type { SharingPolicy } from './map.model';

export type Plan = 'standard' | 'business' | 'enterprise';
export type BillingStatus = 'active' | 'past_due' | 'suspended' | 'cancelled';

export interface Organisation {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  ssoRequired: boolean;
  mfaRequired: boolean;
  storageEnabled: boolean;
  logoObjectKey: string | null;
  logoContentType: string | null;
  logoUploadedBy: string | null;
  logoUploadedAt: Date | null;
  billingStatus: BillingStatus;
  /**
   * Which cell holds this tenant's data. Stamped at creation, never changed.
   *
   * READ ON EVERY AUTHENTICATED REQUEST so a process cannot serve a tenant that
   * is not its own. `cell.config` has described this boundary since the first
   * week and nothing enforced it: `CELL_ID` was validated at boot and then never
   * consulted again.
   */
  cellId: string;
  /**
   * §7.3 — the calendar a question about time is measured against.
   *
   * NOT A PRESENTATION SETTING. "Last quarter" resolves to a different pair of
   * instants under a financial year starting in April than under one starting
   * in January, and the figures that come back are real, correctly totalled,
   * and three months out. The failure is invisible because the answer looks
   * reasonable.
   */
  calendar: Calendar;
  /**
   * §6.1 — the ceiling on who a view may be shared with.
   *
   * ENFORCED SINCE 036 AND SETTABLE BY NOTHING, so every organisation has been
   * on the default since the column existed. A policy that cannot be changed is
   * not a policy, it is a constant with a settings-shaped name.
   */
  sharingPolicy: SharingPolicy;
  /** BILLING §2 — the organisation's own daily ceiling, never looser than the plan's. Null follows the plan. */
  dailyTokenLimit: number | null;
  createdAt: Date;
}

/**
 * An organisation's own calendar.
 *
 * THE DEFAULT IS A GUESS AND IT IS STATED AS ONE. UTC with a January year
 * start is what an organisation gets until somebody says otherwise — correct
 * for many, silently wrong for the rest, which is why the answer names the
 * period it resolved rather than assuming agreement.
 */
export interface Calendar {
  /** IANA zone. Midnight is midnight there, not where the server runs. */
  timeZone: string;
  /** 1-12. The month the financial year begins. */
  yearStartsInMonth: number;
}

/**
 * The canonical name of a zone this runtime knows, or nothing.
 *
 * CHECKED AT THE WRITE, BECAUSE THE READ CANNOT REFUSE. `offsetOf` falls back
 * to UTC for a zone it does not recognise — the honest fallback at read time,
 * since failing a question over a settings typo helps nobody, but it means a
 * mistyped zone would answer in UTC forever without saying so. The place to
 * catch it is the one moment a person is looking at the field.
 *
 * `Intl` IS THE SAME ZONE DATABASE THE RESOLVER USES, so this cannot accept
 * something the resolver would then reject.
 */
export function canonicalTimeZone(zone: string): string | null {
  try {
    /*
     * RETURNS THE CANONICAL SPELLING, which is the reason this returns a string
     * rather than a boolean. `Intl` matches case-insensitively and follows
     * aliases, so `europe/london` and `US/Eastern` are both accepted and would
     * be STORED AS TYPED — two organisations on the same clock holding
     * different strings, and a settings screen showing a person their own typo
     * back. Normalising here means the stored value is the one the zone
     * database calls it.
     */
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * What billing status permits.
 *
 * SUSPENSION IS READ-ONLY, NOT LOCKED OUT, AND NEVER DELETES. A customer who
 * misses an invoice keeps their history, their exports and their saved views;
 * what stops is writing. Locking them out entirely turns a billing problem into a
 * business outage and makes the recovery adversarial.
 */
export interface Capabilities {
  canQuery: boolean;
  canMutate: boolean;
  canExport: boolean;
  cronsRun: boolean;
  banner: string | null;
}

export function capabilitiesFor(status: BillingStatus): Capabilities {
  switch (status) {
    case 'active':
      return { canQuery: true, canMutate: true, canExport: true, cronsRun: true, banner: null };

    case 'past_due':
      return {
        canQuery: true,
        canMutate: true,
        canExport: true,
        cronsRun: true,
        banner: 'A payment has failed. Update your billing details to avoid interruption.',
      };

    case 'suspended':
      return {
        canQuery: true,
        canMutate: false,
        canExport: true,
        // Paused, not cancelled. A cron that fires during suspension would make a
        // write nobody is watching, under a billing state the customer disputes.
        cronsRun: false,
        banner: 'This account is suspended. Queries and exports work; changes are paused.',
      };

    case 'cancelled':
      return {
        canQuery: false,
        canMutate: false,
        // Export survives cancellation for the retention window. Taking away
        // somebody's ability to get their own data out is not a billing lever.
        canExport: true,
        cronsRun: false,
        banner: 'This account is cancelled. Your data is available to export for 30 days.',
      };
  }
}

/** Whether a Silo may be created at all, whatever the Silo itself says. */
export function storageAllowed(organisation: Pick<Organisation, 'storageEnabled'>): boolean {
  return organisation.storageEnabled;
}
