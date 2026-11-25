// The shapes of the information architecture (guarantee 1): every place in the client, what it
// is for, and the capabilities (public routes) it is the home of.

import type { RouteName } from '../api/client.api.ts';
import type { IconName } from '../components/icon.component.tsx';

export interface Place {
  /** Unique within its parent. */
  id: string;
  label: string;
  /** This client's page for it. */
  href: string;
  /** One sentence: what the person does here. */
  purpose: string;
  /** What can be done here, as a person would say it: shown in the help centre and found by search. */
  does: readonly string[];
  /** Other words a person might search for. */
  keywords?: readonly string[];
  /** The capabilities this place is the home of: each route has exactly one home (tests/navigation.test.ts). */
  routes: readonly RouteName[];
  icon?: IconName;
}

export interface Area {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  /** The rail's tooltip (spec 33.3). */
  tip: string;
  sections: readonly Place[];
  /** Only when the organisation has switched Siloes on (spec 33.3). */
  needsSiloes?: boolean;
}

export interface SettingsGroup {
  id: string;
  label: string;
  items: readonly Place[];
}
