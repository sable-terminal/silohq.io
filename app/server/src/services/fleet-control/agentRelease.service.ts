// An agent release as a cell takes it (spec 10.7, 11.1, 11.4): the channel head of the cell's
// agent channel and the release manifest it names, each as the canonical JSON text
// fleet-control signed. The cell's Fleet agent runs this check before it copies anything, and
// connect-runtime runs it again before any agent is offered the release; the agent runs the
// same check itself, with the key built into it.
//
// Both texts must be canonical JSON (so the bytes the agent verifies are the bytes signed),
// the manifest must carry a valid signature by a trusted Silo release key, and the head one by a
// Silo release key on agent-stable, or by the sovereign release key on agent-sovereign (the
// sovereign fleet-control's, promoted once cleared staff countersigned the bundle that brought
// the release in, spec 11.1, 11.4; D202), the head must be on this
// cell's agent channel and name exactly this manifest (its release id and its digest), and the
// manifest must be for this cell's build target and carry agent binaries.

import type { BuildTarget } from '../../config/cell.config.ts';
import { releaseManifest, type ReleaseManifest, type SignatureRecord } from '../../contracts/fleet-control/release.contract.ts';
import { channelHead, type ChannelHead } from '../../contracts/fleet-control/rollout.contract.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { documentDigest, verifyDocument, type TrustedKey } from './signing.service.ts';

export type AgentChannel = 'agent-stable' | 'agent-sovereign';

export interface SignedText {
  text: string;
  signatures: SignatureRecord[];
}

export interface CheckedAgentRelease {
  head: ChannelHead;
  manifest: ReleaseManifest;
  manifestDigest: string;
}

/** The agent channel a cell of this build takes its agents' releases from. */
export const agentChannelFor = (target: BuildTarget): AgentChannel => (target === 'sovereign' ? 'agent-sovereign' : 'agent-stable');

const refused = (reason: string, message: string): AppError =>
  new AppError('integrity', `agent release refused: ${message}`, { code: 'fleet.agent_release_refused', details: { reason } });

function parseCanonical<T>(text: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refused('not_json', `the ${what} is not JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw refused('malformed', `the ${what} is not one`);
  // The text itself is what was signed and what the agent checks: it must be the canonical form.
  if (canonicalJson(value) !== text) throw refused('not_canonical', `the ${what} is not in canonical form`);
  return parsed.data;
}

export function checkAgentRelease(signed: { head: SignedText; release: SignedText }, trusted: readonly TrustedKey[],
  expect: { channel: AgentChannel; target: BuildTarget }): CheckedAgentRelease {
  const head = parseCanonical(signed.head.text, channelHead, 'channel head');
  const manifest = parseCanonical(signed.release.text, releaseManifest, 'release manifest');
  verifyDocument('channel', head, signed.head.signatures, trusted, [expect.channel === 'agent-sovereign' ? 'sovereign' : 'release']);
  verifyDocument('release', manifest, signed.release.signatures, trusted, ['release']);
  if (head.channel !== expect.channel) throw refused('channel', `the head is of ${head.channel}, not ${expect.channel}`);
  const manifestDigest = documentDigest(manifest);
  if (head.releaseId !== manifest.releaseId || head.manifestDigest !== manifestDigest) {
    throw refused('not_promoted', 'the channel head names another release');
  }
  if (manifest.target !== expect.target) throw refused('target', `the release is a ${manifest.target} build`);
  if (manifest.agentBinaries.length === 0) throw refused('no_binaries', 'the release carries no agent binaries');
  if (new Set(manifest.agentBinaries.map((b) => b.version)).size !== 1) throw refused('versions', 'the agent binaries differ in version');
  return { head, manifest, manifestDigest };
}
