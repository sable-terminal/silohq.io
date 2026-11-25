'use client';

// The dashboard (spec 37.6): the person's favourited saved views as tiles, Ask's conversation
// hidden. Each tile runs again on open, unmetered, under the viewer's permissions, and says when it
// ran. Each tile is the view's archetype, rendered smaller; below that archetype's minimum legible
// size, or where it would not be legible at all, a one-row, one-measure answer is a figure and any
// other a table, said on the tile and recorded (dashboard_tile_fallback). Tiles move with
// their arrow buttons (the keyboard's way). A dashboard is personal; one for a team is a Studio app.

import Link from 'next/link';
import type { Output } from '../../api/client.api.ts';
import { IconButton } from '../../components/button.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { viewHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { ResultByRef } from '../../results/result.result.tsx';
import { humanise, plural } from '../../utils/format.util.ts';
import grid from '../studio/grid.view.module.css';
import styles from './dashboard.view.module.css';

type Tile = Output<'readDashboard'>['tiles'][number];

const REFUSED: Record<string, string> = {
  bound_exceeded: 'it reads more than a view may', capability_missing: 'a system it needs cannot answer it', invalid_manifest: 'the ontology changed under it',
  unavailable: 'a system it reads is unavailable', unsupported: 'it is not supported',
};

function TileBody({ viewId, kind, tile }: { viewId: string; kind: string; tile: { w: number; h: number } }) {
  // Re-run on open, at no metered cost (37.6); the tile draws the view's archetype where it is legible.
  const { api } = useData();
  const ran = useQuery('runWorkspaceView', { params: { viewId } }, { staleMs: 60_000 });
  const run = ran.data?.run;
  if (ran.status === 'error') return <ErrorMessage error={ran.error} onRetry={ran.refetch} />;
  if (run === undefined) return <Loading label="Running" block={false} />;
  if (run.outcome === 'refused') return <p className={styles.muted}>Not shown: {REFUSED[run.reason] ?? humanise(run.reason)}.</p>;
  return (
    <>
      <ResultByRef queryId={run.resultRef} label="Tile" tile={tile} openHref={viewHref(viewId, kind)}
        onTileFallback={(f) => void api.call('recordWorkspaceInteraction', { body: { event: 'dashboard_tile_fallback', savedViewId: viewId, from: f.from, to: f.to, reason: f.reason } }).catch(() => undefined)} />
      <p className={styles.muted}>
        Ran <Time value={run.ranAt} />{run.reduced ? ' · some values are not visible to you' : ''}
        {run.incompleteSources.length > 0 ? ` · ${plural(run.incompleteSources.length, 'source')} did not answer` : ''}
      </p>
    </>
  );
}

export function Dashboard() {
  const dashboard = useQuery('readDashboard', {});
  const move = useMutation('moveDashboardTile');
  const remove = useMutation('unfavouriteWorkspaceView', { invalidates: ['readDashboard'] });
  usePageContext({ scope: { kind: 'page', page: 'ask' }, scopeLabel: 'your dashboard' });

  const shift = (t: Tile, dc: number, dr: number) => {
    const [c, r, w, h] = t.grid;
    const next: [number, number, number, number] = [Math.min(Math.max(1, c + dc), 13 - w), Math.max(1, r + dr), w, h];
    if (next[0] !== c || next[1] !== r) void move.run({ params: { tileId: t.tileId }, body: { grid: next } });
  };

  return (
    <Page title="Dashboard" description="Your favourited saved views, run again each time you open them. A dashboard is yours; one for a team is a Studio app." width="full">
      {move.error !== undefined ? <ErrorMessage error={move.error} /> : null}
      {remove.error !== undefined ? <ErrorMessage error={remove.error} /> : null}
      <QueryView query={dashboard} what="Your dashboard" isEmpty={(d) => d.tiles.length === 0}
        empty={<EmptyState icon="chart" title="Your dashboard is empty" action={<Link href="/ask/views/">Your saved views</Link>}>
          Favourite a saved view in Explorer or Ask to add it here.
        </EmptyState>}>
        {(d) => (
          <div className={grid.grid}>
            {d.tiles.map((t) => {
              const [c, r, w, h] = t.grid;
              return (
                <section key={t.tileId} aria-labelledby={`tile-${t.tileId}`}
                  className={[grid.cell, grid[`c${Math.min(c, 12)}`], grid[`w${Math.min(w, 12)}`], grid[`r${Math.min(r, 200)}`], grid[`h${Math.min(h, 50)}`], styles.tile].join(' ')}>
                  <div className={styles.tileHead}>
                    <h2 id={`tile-${t.tileId}`} className={styles.tileTitle}>{t.view.name}</h2>
                    <span className={styles.controls} role="group" aria-label={`Move ${t.view.name}`}>
                      <IconButton size="sm" label="Move left" icon="arrowLeft" onClick={() => shift(t, -1, 0)} blocked={move.blocked} />
                      <IconButton size="sm" label="Move right" icon="arrowRight" onClick={() => shift(t, 1, 0)} blocked={move.blocked} />
                      <IconButton size="sm" label="Move up" icon="chevronUp" onClick={() => shift(t, 0, -1)} blocked={move.blocked} />
                      <IconButton size="sm" label="Move down" icon="chevronDown" onClick={() => shift(t, 0, 1)} blocked={move.blocked} />
                      <IconButton size="sm" label={`Remove ${t.view.name} from the dashboard`} icon="close" blocked={remove.blocked}
                        onClick={() => void remove.run({ params: { viewId: t.view.id } })} />
                    </span>
                  </div>
                  <TileBody viewId={t.view.id} kind={t.view.kind} tile={{ w, h }} />
                </section>
              );
            })}
          </div>
        )}
      </QueryView>
    </Page>
  );
}
