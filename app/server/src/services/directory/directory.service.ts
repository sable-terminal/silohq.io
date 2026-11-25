// The directory (spec 6.2, 6.4, 55.1): registration from the cells and routing for the
// login page. Holds slugs, keyed email hashes, cell identifiers and statuses, and nothing
// else; nothing here logs a slug or a hash, only cell identifiers and outcomes.
//
// Rules:
// - A cell keeps its identifier, kind, residency and hostname for life (spec 12.3); only
//   its status moves, along CELL_TRANSITIONS. A retired cell routes nothing.
// - A new organisation is placed only in an active cell (placement is open). The slug is
//   global and never changes; its entry changes cell only by moveOrganisation, the
//   directory_updated stage of a tenant migration, and only from the cell it is in. Only
//   the cell that holds an organisation changes its status, and closed is final.
// - "No sovereign user's email hash exists in the shared directory" (spec 6.5): the shared
//   directory refuses entries for sovereign cells; the sovereign cell runs its own.
// - Login routing by address: the address is hashed under every key version still in use
//   and the cells found are returned. One cell: go there. Several: ask for the
//   organisation. None: route to a decoy chosen from the hash among the shared commercial
//   cells, where the login fails as any wrong password does, so the answer does not say
//   whether an address is registered. Only "known in several cells" is distinguishable.

import type { DirectoryKey } from '../../config/globalTier.config.ts';
import type {
  LoginRouteRequest, LoginRouteResponse, SignupPlaceResponse,
} from '../../contracts/directory/registration.contract.ts';
import { CELL_LIMITS } from '../../contracts/directory/registration.contract.ts';
import type { KeyManagement } from '../../infra/kms.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import { cellRepo, identityRoutingRepo, organisationDirectoryRepo } from '../../repos/directory/index.repo.ts';
import type { Cell } from '../../models/directory/cell.model.ts';
import type { OrganisationDirectory } from '../../models/directory/organisationDirectory.model.ts';
import { emailRoutingInput } from '../../utils/email.util.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';

type CellStatus = Cell['status'];
type OrganisationStatus = OrganisationDirectory['status'];

export const CELL_TRANSITIONS: Readonly<Record<CellStatus, readonly CellStatus[]>> = {
  provisioning: ['active', 'retired'],
  active: ['closed_to_placement', 'draining'],
  closed_to_placement: ['active', 'draining'],
  draining: ['retired'],
  retired: [],
};

/** Cells a login may be routed to. */
const ROUTABLE: readonly CellStatus[] = ['active', 'closed_to_placement', 'draining'];

export interface DirectoryKeys {
  /** Registrations are hashed under this version. */
  current: DirectoryKey;
  /** The current version and every earlier one still accepted. */
  all: readonly DirectoryKey[];
}

export interface DirectoryDeps {
  databases: Databases;
  kms: KeyManagement;
  keys: DirectoryKeys;
  logger: Logger;
  /** This directory serves a sovereign deployment (it runs the sovereign build). */
  sovereign: boolean;
}

export interface CellRegistration {
  kind: Cell['kind'];
  residency: Cell['residency'];
  hostname: string;
  status: CellStatus;
  /** The cell's live connections, where its Fleet agent counted them (D203). */
  connectionCount?: number | undefined;
}

export interface OrganisationEntry {
  organisationSlug: string;
  cellId: string;
  status: OrganisationStatus;
}

export interface Directory {
  registerCell(cellId: string, registration: CellRegistration): Promise<Cell>;
  registerOrganisation(organisationSlug: string, cellId: string, status: OrganisationStatus): Promise<OrganisationEntry>;
  moveOrganisation(organisationSlug: string, fromCellId: string, toCellId: string): Promise<OrganisationEntry>;
  registerIdentity(cellId: string, emailHash: Buffer, hashKeyVersion: number): Promise<{ created: boolean }>;
  findOrganisation(organisationSlug: string): Promise<OrganisationEntry & { hostname: string }>;
  routeLogin(request: LoginRouteRequest): Promise<LoginRouteResponse>;
  /** Where a self-serve sign-up goes (decision 2026-11-14; spec 6.4). */
  placeSignup(residency: string): Promise<SignupPlaceResponse>;
}

const entryOf = (row: OrganisationDirectory): OrganisationEntry =>
  ({ organisationSlug: row.organisationSlug, cellId: row.cellId, status: row.status });

/** The cell's login page: app.<cell hostname>, as the cell names its own entry (config/cell.config.ts). */
export function loginUrl(cell: Pick<Cell, 'hostname'>, organisationSlug?: string): string {
  const url = new URL(`https://app.${cell.hostname}/login`);
  if (organisationSlug !== undefined) url.searchParams.set('organisation', organisationSlug);
  return url.toString();
}

export function createDirectory(deps: DirectoryDeps): Directory {
  const pool = deps.databases.pool('directory');
  const tx = <T>(work: (db: Queryable) => Promise<T>): Promise<T> => inTransaction(pool, {}, work);

  const refuseSovereignHere = (cell: Cell): void => {
    if (cell.kind === 'sovereign' && !deps.sovereign) {
      throw new AppError('forbidden', 'a sovereign cell registers in its own directory, never the shared one (spec 6.5)', {
        code: 'directory.sovereign_elsewhere',
      });
    }
  };
  const requireCell = (cell: Cell | undefined): Cell => {
    if (cell === undefined) throw new AppError('not_found', 'no such cell is registered', { code: 'directory.cell_unknown' });
    return cell;
  };
  const requirePlacement = (cell: Cell): void => {
    if (cell.status !== 'active') {
      throw new AppError('conflict', 'that cell is not open for placement', {
        code: 'directory.cell_not_open', details: { cellStatus: cell.status },
      });
    }
  };

  return {
    async registerCell(cellId, input) {
      const { connectionCount, ...registration } = input;
      const counts = connectionCount === undefined ? {} : { connectionCount, countsAt: new Date().toISOString() };
      return tx(async (db) => {
        const existing = await cellRepo.findForUpdate(db, cellId);
        if (existing === undefined) {
          if (registration.status !== 'provisioning' && registration.status !== 'active') {
            throw new AppError('validation', 'a cell is registered as provisioning or active', { code: 'directory.cell_status_invalid' });
          }
          try {
            const created = await cellRepo.insert(db, { id: cellId, ...registration, ...counts });
            deps.logger.info('cell registered', { event: 'directory.cell_registered', resourceType: 'cell', resourceId: cellId });
            return created;
          } catch (error) {
            const mapped = fromDatabaseError(error);
            if (mapped.category === 'conflict') {
              throw new AppError('conflict', 'another cell has that hostname', { code: 'directory.hostname_taken' });
            }
            throw mapped;
          }
        }
        if (existing.kind !== registration.kind || existing.residency !== registration.residency
          || existing.hostname !== registration.hostname) {
          throw new AppError('conflict', 'a cell keeps its kind, residency and hostname for life', { code: 'directory.cell_immutable' });
        }
        if (existing.status === registration.status) {
          return connectionCount === undefined ? existing : (await cellRepo.update(db, cellId, counts))!;
        }
        if (!CELL_TRANSITIONS[existing.status].includes(registration.status)) {
          throw new AppError('conflict', `a cell cannot go from ${existing.status} to ${registration.status}`, {
            code: 'directory.cell_transition', details: { from: existing.status, to: registration.status },
          });
        }
        const updated = (await cellRepo.update(db, cellId, { status: registration.status, ...counts }))!;
        deps.logger.info('cell status changed', {
          event: 'directory.cell_status_changed', resourceType: 'cell', resourceId: cellId, outcome: registration.status,
        });
        return updated;
      });
    },

    async registerOrganisation(organisationSlug, cellId, status) {
      return tx(async (db) => {
        const cell = requireCell(await cellRepo.findById(db, cellId));
        refuseSovereignHere(cell);
        const existing = await organisationDirectoryRepo.findForUpdate(db, organisationSlug);
        if (existing === undefined) {
          if (status === 'closed') {
            throw new AppError('validation', 'an organisation is registered active or suspended', { code: 'directory.organisation_status_invalid' });
          }
          requirePlacement(cell);
          try {
            const created = await organisationDirectoryRepo.insert(db, { organisationSlug, cellId, status });
            deps.logger.info('organisation placed', { event: 'directory.tenant_placed', resourceType: 'cell', resourceId: cellId });
            return entryOf(created);
          } catch (error) {
            // Registered concurrently: the caller retries and finds the entry.
            const mapped = fromDatabaseError(error);
            if (mapped.category === 'conflict') {
              throw new AppError('conflict', 'that slug was registered at the same moment; try again', {
                code: 'directory.slug_contended', retryable: true,
              });
            }
            throw mapped;
          }
        }
        if (existing.cellId !== cellId) {
          // The slug is taken, by an organisation elsewhere or by this one before a move.
          throw new AppError('conflict', 'that slug belongs to an organisation in another cell', { code: 'directory.slug_taken' });
        }
        if (existing.status === status) return entryOf(existing);
        if (existing.status === 'closed') {
          throw new AppError('conflict', 'a closed organisation stays closed; its slug is never reused', { code: 'directory.organisation_closed' });
        }
        const updated = (await organisationDirectoryRepo.update(db, organisationSlug, { status }))!;
        deps.logger.info('organisation status changed', {
          event: 'directory.directory_entry_changed', resourceType: 'cell', resourceId: cellId, outcome: status,
        });
        return entryOf(updated);
      });
    },

    async moveOrganisation(organisationSlug, fromCellId, toCellId) {
      if (fromCellId === toCellId) {
        throw new AppError('validation', 'a move goes to another cell', { code: 'directory.move_same_cell' });
      }
      return tx(async (db) => {
        const existing = await organisationDirectoryRepo.findForUpdate(db, organisationSlug);
        if (existing === undefined) throw new AppError('not_found', 'no such organisation', { code: 'directory.organisation_unknown' });
        if (existing.cellId === toCellId) return entryOf(existing);
        if (existing.cellId !== fromCellId) {
          throw new AppError('conflict', 'the organisation is not in the source cell', { code: 'directory.move_source_mismatch' });
        }
        if (existing.status === 'closed') {
          throw new AppError('conflict', 'a closed organisation is not moved', { code: 'directory.organisation_closed' });
        }
        const destination = requireCell(await cellRepo.findById(db, toCellId));
        refuseSovereignHere(destination);
        requirePlacement(destination);
        const moved = (await organisationDirectoryRepo.update(db, organisationSlug, { cellId: toCellId }))!;
        deps.logger.info('organisation moved', {
          event: 'directory.directory_entry_changed', resourceType: 'cell', resourceId: toCellId, reason: 'tenant_migration',
        });
        return entryOf(moved);
      });
    },

    async registerIdentity(cellId, emailHash, hashKeyVersion) {
      if (!deps.keys.all.some((key) => key.version === hashKeyVersion)) {
        throw new AppError('validation', 'the directory does not use that key version', {
          code: 'directory.key_version_unknown', details: { hashKeyVersion, current: deps.keys.current.version },
        });
      }
      return tx(async (db) => {
        const cell = requireCell(await cellRepo.findById(db, cellId));
        refuseSovereignHere(cell);
        if (cell.status === 'retired') {
          throw new AppError('conflict', 'a retired cell holds no users', { code: 'directory.cell_retired' });
        }
        const created = await identityRoutingRepo.insertIfAbsent(db, { emailHash, cellId, hashKeyVersion });
        return { created };
      });
    },

    async findOrganisation(organisationSlug) {
      return tx(async (db) => {
        const entry = await organisationDirectoryRepo.findByOrganisationSlug(db, organisationSlug);
        if (entry === undefined) throw new AppError('not_found', 'no such organisation', { code: 'directory.organisation_unknown' });
        const cell = (await cellRepo.findById(db, entry.cellId))!;
        return { ...entryOf(entry), hostname: cell.hostname };
      });
    },

    async placeSignup(residency) {
      // Sovereign is Enterprise, on contract: no self-serve placement there.
      if (deps.sovereign) return { next: 'unavailable' };
      const [best] = await tx((db) => cellRepo.placementCandidates(db, residency, CELL_LIMITS));
      if (best === undefined) return { next: 'unavailable' };
      return { next: 'cell', cellId: best.id, signupUrl: `https://app.${best.hostname}/signup` };
    },

    async routeLogin(request) {
      if ('organisationSlug' in request) {
        const found = await tx(async (db) => {
          const entry = await organisationDirectoryRepo.findByOrganisationSlug(db, request.organisationSlug);
          if (entry === undefined || entry.status === 'closed') return undefined;
          const cell = await cellRepo.findById(db, entry.cellId);
          return cell !== undefined && ROUTABLE.includes(cell.status) ? cell : undefined;
        });
        // A suspended organisation still routes: its cell says why it cannot be used.
        return found === undefined
          ? { next: 'unknown_organisation' }
          : { next: 'cell', cellId: found.id, loginUrl: loginUrl(found, request.organisationSlug) };
      }

      // Every key version is tried, the decoy path included, so both take the same work.
      const input = emailRoutingInput(request.email);
      const hashes = await Promise.all(deps.keys.all.map((key) => deps.kms.mac(key.keyUri, input)));
      const { cellIds, cells } = await tx(async (db) => ({
        cellIds: await identityRoutingRepo.cellsForHashes(db, hashes),
        cells: await cellRepo.list(db),
      }));
      if (cellIds.length > 1) return { next: 'organisation' };
      const byId = new Map(cells.map((cell) => [cell.id, cell]));
      const known = cellIds.length === 1 ? byId.get(cellIds[0]!) : undefined;
      if (known !== undefined && ROUTABLE.includes(known.status)) {
        return { next: 'cell', cellId: known.id, loginUrl: loginUrl(known) };
      }
      const decoys = cells.filter((cell) => (cell.status === 'active' || cell.status === 'closed_to_placement')
        && (deps.sovereign || cell.kind === 'commercial'));
      if (decoys.length === 0) return { next: 'organisation' };
      const current = hashes[deps.keys.all.findIndex((key) => key.version === deps.keys.current.version)]!;
      const decoy = decoys[current.readUInt32BE(0) % decoys.length]!;
      return { next: 'cell', cellId: decoy.id, loginUrl: loginUrl(decoy) };
    },
  };
}
