// Files (spec 41): the largest export, how long exports are kept, and how often the
// retention sweep runs.
//
// Exports have their own retention per organisation, defaulting to indefinite (spec 41.5);
// the organisation's own setting has no column yet, so FILES_EXPORT_RETENTION_DAYS sets
// one for the cell meanwhile (unset: indefinite). The largest export is bounded by the
// gateway's response bound, since a download returns the document in one reply.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

/**
 * The largest export, in bytes. Its base64 (with the JSON around it) must fit the gateway's
 * response bound (8 MiB), so a download never needs a second path; FILES_MAX_EXPORT_BYTES may
 * lower it. The files process raises HTTP_MAX_BODY_BYTES to take one.
 */
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

const schema = z.object({
  /** The basemap archive in the tiles bucket (decision 2026-11-14): Protomaps PMTiles. */
  mapTilesKey: z.string().regex(/^[A-Za-z0-9._/-]{1,512}\.pmtiles$/).default('basemap.pmtiles'),
  mapTilesAttribution: z.string().min(1).max(300).default('© OpenStreetMap contributors · Protomaps'),
  maxExportBytes: zPositiveInt(MAX_EXPORT_BYTES).default(MAX_EXPORT_BYTES),
  exportRetentionDays: zPositiveInt(36_500).optional(),
  sweepSeconds: zPositiveInt(86_400).default(3_600),
});

export interface FilesConfig {
  mapTilesKey: string;
  mapTilesAttribution: string;
  maxExportBytes: number;
  /** Undefined: exports are kept until deleted. */
  exportRetentionDays: number | undefined;
  /** How often expired exports are deleted. */
  sweepSeconds: number;
}

export function loadFilesConfig(env: Env, problems: string[]): FilesConfig | undefined {
  const parsed = parseSection(schema, {
    mapTilesKey: read(env, 'MAP_TILES_KEY'),
    mapTilesAttribution: read(env, 'MAP_TILES_ATTRIBUTION'),
    maxExportBytes: read(env, 'FILES_MAX_EXPORT_BYTES'),
    exportRetentionDays: read(env, 'FILES_EXPORT_RETENTION_DAYS'),
    sweepSeconds: read(env, 'FILES_SWEEP_SECONDS'),
  }, {
    mapTilesKey: 'MAP_TILES_KEY', mapTilesAttribution: 'MAP_TILES_ATTRIBUTION',
    maxExportBytes: 'FILES_MAX_EXPORT_BYTES', exportRetentionDays: 'FILES_EXPORT_RETENTION_DAYS', sweepSeconds: 'FILES_SWEEP_SECONDS',
  }, problems);
  return parsed && { ...parsed, exportRetentionDays: parsed.exportRetentionDays };
}
