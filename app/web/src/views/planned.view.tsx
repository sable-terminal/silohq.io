'use client';

// A section whose page this rebuild has not reached yet (docs/siloWebClient.doc.md): it says what
// the section is for, what will be done here, and which stage builds it, so the path to every
// capability is visible from the first stage.

import { Badge } from '../components/badge.component.tsx';
import { Page } from '../components/page.component.tsx';
import { EmptyState } from '../components/states.component.tsx';
import type { Where } from '../navigation/places.navigation.ts';
import { trailOf } from '../navigation/places.navigation.ts';

const STAGES: Record<string, string> = {
  home: 'U5', account: 'U5', explorer: 'U6', ask: 'U7', connect: 'U8', ontology: 'U9', governance: 'U10', clones: 'U11', studio: 'U12',
  scenarios: 'U13', files: 'U14', siloes: 'U14', settings: 'U15',
};

export function stageOf(where: Where): string {
  return STAGES[where.kind === 'section' ? where.area.id : where.kind] ?? 'U16';
}

export function Planned({ where }: { where: Where }) {
  const trail = trailOf(where);
  return (
    <Page title={where.place.label} description={where.place.purpose}
      crumbs={trail.slice(0, -1).map((label) => ({ label }))}
      meta={<Badge tone="info">Being built in stage {stageOf(where)}</Badge>}>
      <EmptyState icon={where.place.icon ?? 'info'} title="What you will do here">
        <ul>{where.place.does.map((d) => <li key={d}>{d}</li>)}</ul>
      </EmptyState>
    </Page>
  );
}
