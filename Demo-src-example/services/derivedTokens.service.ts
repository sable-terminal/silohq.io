import type { Obtained } from '../engine/auth/apply.auth';
import { limited } from '../utils/error.util';
import { childLogger } from '../config/logger.config';
import { derivedStore, type DerivedStore } from '../infra/derivedStore.infra';
import { wrapper } from '../infra/kms.infra';
import { relayBus } from '../infra/relayBus.infra';
import { seal } from '../utils/envelope.util';
import { withSecret } from '../utils/mediator.util';
import { credentialAccessLog } from '../utils/credentialAudit.util';
import type { Bus } from '../engine/relay/agent.relay';

const log = childLogger('derived-tokens');

/**
 * Tokens Silo obtains for itself, obtained once across every instance
 * (MANIFEST-V2 §9.1, F15, F28).
 *
 * ── THREE LAYERS, CHEAPEST FIRST ──────────────────────────────────────────
 *
 * This process's own copy; then the shared, sealed one; then — under a lock,
 * so exactly one instance does it — a fresh login. An instance that finds the
 * lock taken waits for the holder's session to appear rather than logging in
 * beside it, and a connector that says `singleSession` is refused rather than
 * given a second session if the wait runs out.
 *
 * ── NEVER LONGER THAN AN HOUR, NEVER PAST A ROTATION ─────────────────────
 *
 * Keys carry a hash of the sealed credential, so a replaced credential misses
 * every entry made with the old one. Nothing is kept past an hour whatever the
 * token claims, so a revocation at the source is honoured within one. An
 * invalidation — a 401 answered, a credential replaced, a connection halted —
 * is published to every instance.
 */

const MAX_SECONDS = 3_600;
const LOCK_MS = 30_000;
const WAIT_STEP_MS = 200;

export interface Sealer {
  seal(plaintext: string, binding: string): Promise<string>;
  /** Opens a sealed entry; audited as the credential it came from. */
  open(sealed: string, binding: string, subject: string): Promise<string>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DerivedTokens {
  private readonly local = new Map<string, { obtained: Obtained; until: number }>();
  private readonly inFlight = new Map<string, Promise<Obtained>>();

  constructor(
    private readonly store: DerivedStore | null,
    private readonly sealer: Sealer,
    private readonly bus: Pick<Bus, 'publish' | 'subscribe'> | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Listen for invalidations other instances publish. */
  async listen(): Promise<void> {
    await this.bus?.subscribe('derived:invalidate', (message) => this.forgetLocal(String(message.prefix ?? '')));
  }

  private forgetLocal(prefix: string): void {
    if (!prefix) return;
    for (const key of this.local.keys()) if (key.startsWith(prefix)) this.local.delete(key);
  }

  async cached(key: string, obtain: () => Promise<Obtained>, options: { exclusive: boolean }): Promise<Obtained> {
    const hit = this.local.get(key);
    if (hit && hit.until > this.now()) return hit.obtained;
    const running = this.inFlight.get(key);
    if (running) return running;
    const next = this.fetch(key, obtain, options).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, next);
    return next;
  }

  private remember(key: string, obtained: Obtained, seconds: number): Obtained {
    this.local.set(key, { obtained, until: this.now() + seconds * 1_000 });
    return obtained;
  }

  private async shared(key: string): Promise<Obtained | null> {
    if (!this.store) return null;
    const raw = await this.store.get(key).catch(() => null);
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw) as { sealed: string; until: number };
      if (entry.until <= this.now()) return null;
      const obtained = JSON.parse(await this.sealer.open(entry.sealed, `derived:${key}`, key.split(':')[0]!)) as Obtained;
      return this.remember(key, obtained, (entry.until - this.now()) / 1_000);
    } catch (error) {
      log.warn({ err: error }, 'A shared derived token could not be opened; obtaining a fresh one');
      return null;
    }
  }

  private async publish(key: string, obtained: Obtained): Promise<void> {
    const seconds = Math.min(obtained.expiresInSeconds, MAX_SECONDS);
    this.remember(key, obtained, seconds);
    if (!this.store) return;
    const sealed = await this.sealer.seal(JSON.stringify(obtained), `derived:${key}`);
    await this.store.set(key, JSON.stringify({ sealed, until: this.now() + seconds * 1_000 }), seconds).catch(() => {});
  }

  private async fetch(key: string, obtain: () => Promise<Obtained>, options: { exclusive: boolean }): Promise<Obtained> {
    const found = await this.shared(key);
    if (found) return found;
    if (!this.store) {
      const obtained = await obtain();
      return this.remember(key, obtained, Math.min(obtained.expiresInSeconds, MAX_SECONDS));
    }

    const deadline = this.now() + LOCK_MS;
    for (;;) {
      const token = await this.store.lock(key, LOCK_MS).catch(() => null);
      if (token) {
        try {
          /* Another instance may have finished between our read and our lock. */
          const late = await this.shared(key);
          if (late) return late;
          const obtained = await obtain();
          await this.publish(key, obtained);
          return obtained;
        } finally {
          await this.store.unlock(key, token).catch(() => {});
        }
      }
      await sleep(WAIT_STEP_MS);
      const theirs = await this.shared(key);
      if (theirs) return theirs;
      if (this.now() > deadline) {
        if (options.exclusive) {
          throw limited({ message: 'Another request is signing in to this system, which allows one session at a time. Try again in a moment.', code: 'limited.session_busy' });
        }
        const obtained = await obtain();
        await this.publish(key, obtained);
        return obtained;
      }
    }
  }

  /** Forget every token under `prefix`, here and on every instance. */
  async invalidate(prefix: string): Promise<void> {
    this.forgetLocal(prefix);
    await this.store?.deleteMatching(prefix).catch(() => {});
    await this.bus?.publish('derived:invalidate', { prefix }).catch(() => {});
  }
}

/* ── This process's cache ───────────────────────────────────────────────── */

let instance: DerivedTokens | null = null;

/** The envelope a stored credential uses, for what Silo derives from one. */
const envelopeSealer: Sealer = {
  async seal(plaintext, binding) {
    const sealed = await seal(plaintext, wrapper(), binding);
    return JSON.stringify({ c: sealed.ciphertext.toString('base64'), w: sealed.wrappedKey.toString('base64'), k: sealed.keyReference });
  },
  async open(text, binding, subject) {
    const parsed = JSON.parse(text) as { c: string; w: string; k: string };
    return withSecret(
      { ciphertext: Buffer.from(parsed.c, 'base64'), wrappedKey: Buffer.from(parsed.w, 'base64'), keyReference: parsed.k },
      { wrapper: wrapper(), log: credentialAccessLog() },
      { reason: 'connector-request', subject, additionalData: binding },
      async (plaintext) => plaintext,
    );
  },
};

export function derivedTokens(): DerivedTokens {
  instance ??= new DerivedTokens(derivedStore(), envelopeSealer, relayBus());
  return instance;
}
