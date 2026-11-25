// The files engine (spec 14.4: "SFTP and file share", discovered from the file header), for
// SFTP and for a file share alike. Generic: the manifest names the directory, a file name
// pattern and the format; for SFTP the credential service runs the session (it holds the
// login), for a file share the Silo Agent reads its host's files beneath its owner's roots;
// either way the engine parses.
//
// - The files are the directory's regular files whose names match the pattern (* any run of
//   characters, ? one), read in name order. More than maxFiles, or a file over maxFileBytes,
//   is refused, never truncated; so are rows past the step's bound.
// - CSV: the header row names the columns; each field's path (its name by default) names its
//   column; an empty cell is null. JSON Lines: one JSON object a line, read by the fields'
//   paths. A line that is not an object is refused with its file and line.
// - Files are read whole: there is no native pushdown, so the step's filters, sort and limit
//   are applied after the source (engine.service residual).

import type { FileShareSource, ManifestField, ManifestObject, SftpSource } from '../../../../contracts/connect/manifest.contract.ts';
import { parseDelimited } from '../../../../utils/delimited.util.ts';
import { AppError } from '../../../../utils/errors.util.ts';
import { coerce, getPath, rowsBound, type ProtocolEngine, type ReadContext, type Row } from '../../engine.service.ts';

/** A file name pattern as a whole-name match: * any run, ? one character, everything else literal. */
export function patternMatcher(pattern: string): (name: string) => boolean {
  const source = [...pattern].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.\\+^$()[\]{}|-]/g, '\\$&'))).join('');
  const regex = new RegExp(`^${source}$`);
  return (name) => regex.test(name);
}

function recordsOf(source: SftpSource | FileShareSource, name: string, bytes: Buffer): Record<string, unknown>[] {
  if (source.format === 'csv') {
    return parseDelimited(bytes, source.delimiter).rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === '' ? null : v])));
  }
  const records: Record<string, unknown>[] = [];
  bytes.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new AppError('validation', `line ${i + 1} of ${name} is not a JSON object`, { code: 'sftp.line_invalid', details: { file: name.slice(0, 200), line: i + 1 } });
    }
    records.push(value as Record<string, unknown>);
  });
  return records;
}

export const sftpEngine: ProtocolEngine = {
  async read(ctx: ReadContext, object: ManifestObject, _native, fields: readonly ManifestField[]): Promise<Row[]> {
    const source = object.source as SftpSource | FileShareSource;
    const listed = await ctx.files({ kind: 'list', directory: source.directory });
    if (listed.kind !== 'list') throw new AppError('integrity', 'the mediator answered a list with a file', { code: 'sftp.reply_unexpected' });
    const matches = patternMatcher(source.pattern);
    const files = listed.entries.filter((e) => matches(e.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (files.length > source.maxFiles) {
      throw new AppError('bounds', `more than ${source.maxFiles} files match; narrow the pattern or raise maxFiles`, {
        code: 'sftp.too_many_files', details: { bound: 'max_files', limit: source.maxFiles },
      });
    }
    const rows: Row[] = [];
    for (const file of files) {
      if (ctx.signal.aborted || performance.now() > ctx.deadline) throw new AppError('bounds', 'the files took longer than a step may', { code: 'connect.wall_time', retryable: true });
      if (file.size > source.maxFileBytes) {
        throw new AppError('bounds', `${file.name} is larger than ${source.maxFileBytes} bytes`, { code: 'sftp.file_too_large', details: { bound: 'max_file_bytes', limit: source.maxFileBytes } });
      }
      const read = await ctx.files({ kind: 'read', directory: source.directory, name: file.name, maxBytes: source.maxFileBytes });
      if (read.kind !== 'read') throw new AppError('integrity', 'the mediator answered a read with a list', { code: 'sftp.reply_unexpected' });
      ctx.stats.pages += 1;
      for (const record of recordsOf(source, file.name, Buffer.from(read.contentBase64, 'base64'))) {
        ctx.stats.sourceRows += 1;
        const row: Row = {};
        for (const field of fields) row[field.name] = coerce(getPath(record, field.path ?? field.name), field.type, ctx.stats);
        rows.push(row);
        if (rows.length > ctx.maxRows) throw rowsBound(ctx);
      }
    }
    return rows;
  },
};
