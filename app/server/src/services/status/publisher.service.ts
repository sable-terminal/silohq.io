// Where the public status page lives: static hosting apart from every cell (spec 7.2,
// 13.2). The service writes two files, status.json for the page's script and index.html,
// which reads without a script, and the host serves them as they are.
//
// This build writes them to a directory (STATUS_PUBLISH_DIR), which any static web server
// serves; a self-managed install publishes this way. The hosted page's bucket needs a
// public-read bucket in the object storage adapter, which today refuses to make anything
// public (README: global tier). Each file is written whole and renamed into place, so a
// reader never sees half a document. The state is in the status tables; the files are
// only what the host serves.

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PublicStatusDocument } from '../../contracts/status/status.contract.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface StatusPublisher {
  publish(document: PublicStatusDocument): Promise<void>;
}

const STATE_LABELS: Readonly<Record<string, string>> = {
  operational: 'Operational', degraded: 'Degraded', partial_outage: 'Partial outage', major_outage: 'Major outage',
  maintenance: 'Maintenance', unknown: 'No recent report', investigating: 'Investigating', identified: 'Identified',
  monitoring: 'Monitoring', resolved: 'Resolved', scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed',
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page, readable with no script. Every value is escaped; nothing is fetched from elsewhere. */
export function renderStatusPage(document: PublicStatusDocument): string {
  const e = escapeHtml;
  const label = (state: string): string => e(STATE_LABELS[state] ?? state);
  const cells = document.cells.map((cell) => `
    <section>
      <h2>${e(cell.id)} <small>(${e(cell.residency.toUpperCase())})</small></h2>
      ${cell.stale ? `<p class="stale">No report from this cell${cell.reportedAt ? ` since ${e(cell.reportedAt)}` : ''}.</p>` : ''}
      <table>
        ${cell.components.map((c) => `<tr><th scope="row">${e(c.label)}</th><td class="${e(c.state)}">${label(c.state)}</td></tr>`).join('')}
      </table>
    </section>`).join('');
  const notices = document.notices.map((notice) => `
    <article>
      <h3>${e(notice.title)} <small>${label(notice.state)}${notice.severity ? `, ${e(notice.severity.toUpperCase())}` : ''}</small></h3>
      <p>Cells: ${notice.cellIds.map(e).join(', ')}${notice.window ? `. Window: ${e(notice.window.startsAt)} to ${e(notice.window.endsAt)}` : ''}</p>
      <ol reversed>${[...notice.updates].reverse().map((u) => `<li><time>${e(u.postedAt)}</time> ${label(u.state)}: ${e(u.message)}</li>`).join('')}</ol>
    </article>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Silo status</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:48rem;padding:1rem;color:#1a1a1a;background:#fff}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.25rem .5rem;border-bottom:1px solid #ddd}
.operational{color:#1a7f37}.degraded,.maintenance{color:#9a6700}.partial_outage,.major_outage{color:#cf222e}.unknown,.stale{color:#57606a}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#111}th,td{border-color:#333}}
</style>
</head>
<body>
<h1>Silo status</h1>
<p>Updated <time>${e(document.generatedAt)}</time>.</p>
${document.notices.length > 0 ? `<h2>Notices</h2>${notices}` : ''}
${cells}
</body>
</html>
`;
}

export function directoryPublisher(dir: string): StatusPublisher {
  const write = async (name: string, body: string): Promise<void> => {
    const temporary = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o644 });
      await rename(temporary, path.join(dir, name));
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new AppError('unavailable', 'the status page could not be written', { code: 'status.publish_failed', cause });
    }
  };
  return {
    async publish(document) {
      await mkdir(dir, { recursive: true });
      // The document first: the page is the newer of the two only for a moment.
      await write('status.json', `${JSON.stringify(document)}\n`);
      await write('index.html', renderStatusPage(document));
    },
  };
}
