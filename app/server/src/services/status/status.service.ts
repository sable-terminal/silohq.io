// The status service (spec 7.2, 13.2): the latest report from each cell, the notices,
// and the public document built from them.
//
// Which cells the page shows comes from the cell registry in the directory database:
// shared commercial cells on the shared page, sovereign cells on the sovereign page, and
// never a dedicated cell or a self-managed install, whose identifier names its customer.
// A notice may name only cells the page shows, for the same reason.
//
// State lives in the status tables of the global database, so every replica reads and
// writes the same reports and notices: a report is compared with the cell's last one under
// a per-cell lock, a notice is written under its own lock, and the page is published under
// a lock in the order it was read, so a slower replica never publishes an older page over
// a newer one. If the writer stops the page goes stale, which the page shows by its
// generation time (spec 7.2: "On failure: Page stale").

import {
  COMPONENT_LABELS, INCIDENT_STATES, MAINTENANCE_STATES, STATUS_COMPONENTS,
  type PublicStatusDocument, type PublishedNotice,
} from '../../contracts/status/status.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { Cell } from '../../models/directory/cell.model.ts';
import type { Notice } from '../../models/status/notice.model.ts';
import type { NoticeUpdate } from '../../models/status/noticeUpdate.model.ts';
import { cellRepo } from '../../repos/directory/index.repo.ts';
import {
  cellReportRepo, componentStateRepo, noticeRepo, noticeUpdateRepo, statusLockRepo,
} from '../../repos/status/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';

type Component = (typeof STATUS_COMPONENTS)[number];
type ComponentState = PublicStatusDocument['cells'][number]['components'][number]['state'];
type NoticeState = PublishedNotice['state'];

/** A report may run this far ahead of the status host's clock. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const SHOWN: readonly Cell['status'][] = ['active', 'closed_to_placement', 'draining'];
const CLOSING: ReadonlySet<NoticeState> = new Set(['resolved', 'completed']);

export interface CellReport {
  reportedAt: string;
  components: Map<Component, { state: Exclude<ComponentState, 'unknown'>; since: string }>;
}

/** One form for every time the page shows: ISO 8601 in UTC with milliseconds, as the cells send them. */
const iso = (value: string): string => new Date(Date.parse(value)).toISOString();

function noticeView(row: Notice, updates: readonly NoticeUpdate[]): PublishedNotice {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    cellIds: [...row.cellIds],
    components: row.components as Component[],
    state: row.state as NoticeState,
    startedAt: iso(row.startedAt),
    resolvedAt: row.resolvedAt === null ? null : iso(row.resolvedAt),
    window: row.windowStartsAt !== null && row.windowEndsAt !== null
      ? { startsAt: iso(row.windowStartsAt), endsAt: iso(row.windowEndsAt) } : null,
    updates: updates.map((u) => ({ id: u.id, state: u.state as NoticeState, message: u.message, postedAt: iso(u.postedAt) })),
  };
}

export interface StatusDeps {
  databases: Databases;
  logger: Logger;
  /** The sovereign build publishes the sovereign page. */
  sovereign: boolean;
  staleAfterSeconds: number;
  noticeRetentionDays: number;
  now?: () => number;
}

export interface NoticeInput {
  postedBy: string;
  kind: PublishedNotice['kind'];
  severity?: PublishedNotice['severity'] | undefined;
  title: string;
  cellIds: string[];
  components: Component[];
  window?: { startsAt: string; endsAt: string } | undefined;
}

export interface StatusBoard {
  report(cellId: string, reportedAt: string, components: { component: Component; state: Exclude<ComponentState, 'unknown'> }[])
    : Promise<{ accepted: boolean }>;
  putNotice(noticeId: string, input: NoticeInput): Promise<PublishedNotice>;
  putNoticeUpdate(noticeId: string, updateId: string, state: NoticeState, message: string, postedBy: string): Promise<PublishedNotice>;
  /** The document as the page should show it now. */
  document(): Promise<PublicStatusDocument>;
  /**
   * Reads the document and hands it to publish under the publishing lock, so replicas
   * publish one at a time, each the newest it could read.
   */
  publish(publish: (document: PublicStatusDocument) => Promise<void>): Promise<PublicStatusDocument>;
  /** Called after any change, so the publisher can publish without waiting for its interval. */
  onChange(listener: () => void): void;
}

const stateFits = (kind: PublishedNotice['kind'], state: NoticeState): boolean =>
  (kind === 'incident' ? INCIDENT_STATES as readonly string[] : MAINTENANCE_STATES as readonly string[]).includes(state);

/** The page's cells and notices from the registry and the state. Pure, for tests. */
export function buildDocument(input: {
  cells: readonly Cell[];
  reports: ReadonlyMap<string, CellReport>;
  notices: Iterable<PublishedNotice>;
  now: number;
  sovereign: boolean;
  staleAfterSeconds: number;
  noticeRetentionDays: number;
}): PublicStatusDocument {
  const shown = input.cells.filter((cell) => SHOWN.includes(cell.status) && cell.kind === (input.sovereign ? 'sovereign' : 'commercial'));
  const retainedAfter = input.now - input.noticeRetentionDays * 86_400_000;
  const notices = [...input.notices]
    .filter((notice) => notice.resolvedAt === null || Date.parse(notice.resolvedAt) >= retainedAfter)
    .sort((a, b) => Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null) || b.startedAt.localeCompare(a.startedAt));
  return {
    schema: 'silo.status.v1',
    generatedAt: new Date(input.now).toISOString(),
    cells: shown.map((cell) => {
      const report = input.reports.get(cell.id);
      const stale = report === undefined || Date.parse(report.reportedAt) < input.now - input.staleAfterSeconds * 1000;
      return {
        id: cell.id,
        residency: cell.residency,
        reportedAt: report?.reportedAt ?? null,
        stale,
        components: STATUS_COMPONENTS.map((component) => {
          const current = stale ? undefined : report.components.get(component);
          return { component, label: COMPONENT_LABELS[component], state: current?.state ?? 'unknown', since: current?.since ?? null };
        }),
      };
    }),
    notices,
  };
}

export function createStatusBoard(deps: StatusDeps): StatusBoard {
  const now = deps.now ?? Date.now;
  const pool = deps.databases.pool('directory');
  const listeners: (() => void)[] = [];

  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const cells = (db: Queryable): Promise<Cell[]> => cellRepo.list(db);

  const publicCell = (cell: Cell | undefined): boolean =>
    cell !== undefined && SHOWN.includes(cell.status) && cell.kind === (deps.sovereign ? 'sovereign' : 'commercial');

  const readNotice = async (db: Queryable, noticeId: string): Promise<PublishedNotice | undefined> => {
    const row = await noticeRepo.findById(db, noticeId);
    return row === undefined ? undefined : noticeView(row, await noticeUpdateRepo.listForNotices(db, [noticeId]));
  };

  const readDocument = async (db: Queryable): Promise<PublicStatusDocument> => {
    const registry = await cells(db);
    const at = now();
    const reports = new Map<string, CellReport>();
    for (const row of await cellReportRepo.list(db)) reports.set(row.cellId, { reportedAt: iso(row.reportedAt), components: new Map() });
    for (const row of await componentStateRepo.list(db)) {
      reports.get(row.cellId)?.components.set(row.component, { state: row.state, since: iso(row.since) });
    }
    const rows = await noticeRepo.listShown(db, new Date(at - deps.noticeRetentionDays * 86_400_000).toISOString());
    const updates = await noticeUpdateRepo.listForNotices(db, rows.map((row) => row.id));
    const notices = rows.map((row) => noticeView(row, updates.filter((u) => u.noticeId === row.id)));
    return buildDocument({
      cells: registry, reports, notices, now: at, sovereign: deps.sovereign,
      staleAfterSeconds: deps.staleAfterSeconds, noticeRetentionDays: deps.noticeRetentionDays,
    });
  };

  return {
    async report(cellId, reportedAt, components) {
      if (Date.parse(reportedAt) > now() + MAX_CLOCK_SKEW_MS) {
        throw new AppError('validation', 'the report is from the future; check the cell\'s clock', { code: 'status.report_in_future' });
      }
      const accepted = await inTransaction(pool, {}, async (db) => {
        const cell = await cellRepo.findById(db, cellId);
        if (cell === undefined || cell.status === 'retired') {
          throw new AppError('not_found', 'no such cell is registered', { code: 'status.cell_unknown' });
        }
        await statusLockRepo.lock(db, `cell:${cellId}`);
        const previous = await cellReportRepo.findByCellId(db, cellId);
        if (previous !== undefined && Date.parse(reportedAt) <= Date.parse(previous.reportedAt)) return false;
        const before = new Map((await componentStateRepo.listByCell(db, cellId)).map((row) => [row.component, row]));
        const at = iso(reportedAt);
        await cellReportRepo.put(db, cellId, at);
        await componentStateRepo.replace(db, cellId, components.map(({ component, state }) => {
          const earlier = before.get(component);
          return { component, state, since: earlier?.state === state ? earlier.since : at };
        }));
        return true;
      });
      if (accepted) {
        deps.logger.debug('cell reported', { event: 'status.reported', resourceType: 'cell', resourceId: cellId, count: components.length });
        changed();
      }
      return { accepted };
    },

    async putNotice(noticeId, input) {
      const { notice, opened } = await inTransaction(pool, {}, async (db) => {
        const registry = await cells(db);
        const hidden = input.cellIds.filter((id) => !publicCell(registry.find((c) => c.id === id)));
        if (hidden.length > 0) {
          throw new AppError('validation', 'a notice names only cells the page shows; a dedicated cell would name its customer', {
            code: 'status.cell_not_public', details: { cells: hidden.join(',') },
          });
        }
        await statusLockRepo.lock(db, `notice:${noticeId}`);
        const existing = await noticeRepo.findById(db, noticeId);
        if (existing !== undefined && existing.kind !== input.kind) {
          throw new AppError('conflict', 'a notice keeps its kind', { code: 'status.notice_kind_fixed' });
        }
        const fields = {
          severity: input.kind === 'incident' ? input.severity ?? null : null,
          title: input.title,
          cellIds: [...input.cellIds].sort(),
          components: [...input.components],
          windowStartsAt: input.window?.startsAt ?? null,
          windowEndsAt: input.window?.endsAt ?? null,
        };
        if (existing === undefined) {
          await noticeRepo.insert(db, {
            id: noticeId, kind: input.kind, ...fields, state: input.kind === 'incident' ? 'investigating' : 'scheduled',
            startedAt: new Date(now()).toISOString(), postedBy: input.postedBy,
          });
        } else {
          await noticeRepo.update(db, noticeId, { ...fields, postedBy: input.postedBy });
        }
        return { notice: (await readNotice(db, noticeId))!, opened: existing === undefined };
      });
      deps.logger.info(opened ? 'notice opened' : 'notice changed', {
        event: opened ? 'status.notice_opened' : 'status.notice_changed', resourceType: 'notice', resourceId: noticeId,
      });
      changed();
      return notice;
    },

    async putNoticeUpdate(noticeId, updateId, state, message, postedBy) {
      const { notice, posted } = await inTransaction(pool, {}, async (db) => {
        await statusLockRepo.lock(db, `notice:${noticeId}`);
        const row = await noticeRepo.findById(db, noticeId);
        if (row === undefined) throw new AppError('not_found', 'no such notice', { code: 'status.notice_unknown' });
        const existing = await noticeUpdateRepo.findById(db, updateId);
        if (existing !== undefined) {
          if (existing.noticeId === noticeId && existing.state === state && existing.message === message) {
            return { notice: (await readNotice(db, noticeId))!, posted: false };
          }
          throw new AppError('conflict', 'that update was posted with other content', { code: 'status.update_changed' });
        }
        if (!stateFits(row.kind, state)) {
          throw new AppError('validation', `a${row.kind === 'incident' ? 'n incident' : ' maintenance notice'} cannot be ${state}`, {
            code: 'status.state_invalid',
          });
        }
        const postedAt = new Date(now()).toISOString();
        await noticeUpdateRepo.insert(db, { id: updateId, noticeId, state, message, postedAt, postedBy });
        const closing = CLOSING.has(state);
        await noticeRepo.update(db, noticeId, { state, resolvedAt: closing ? row.resolvedAt ?? postedAt : null });
        return { notice: (await readNotice(db, noticeId))!, posted: true };
      });
      if (posted) {
        deps.logger.info('notice updated', {
          event: CLOSING.has(state) ? 'status.notice_closed' : 'status.notice_updated', resourceType: 'notice', resourceId: noticeId,
          outcome: state,
        });
        changed();
      }
      return notice;
    },

    document() {
      return inTransaction(pool, {}, readDocument, { readOnly: true });
    },

    publish(publish) {
      return inTransaction(pool, {}, async (db) => {
        await statusLockRepo.lock(db, 'publish');
        const document = await readDocument(db);
        await publish(document);
        return document;
      });
    },

    onChange(listener) {
      listeners.push(listener);
    },
  };
}
