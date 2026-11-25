import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import * as organisationRepo from '../repos/organisation.repo';
import * as connectionRepo from '../repos/connection.repo';
import { assertSharingPolicy } from './map.service';
import * as objectStore from '../infra/objectStore.infra';
import { verifyUpload, type SniffedType } from '../utils/mimeSniff.util';
import { safeFilename, sanitiseSvg } from '../utils/inputSanitiser.util';
import type { SharingPolicy } from '../models/map.model';
import { canonicalTimeZone, type Calendar } from '../models/organisation.model';
import type { Actor } from './scope.service';

/**
 * §7.3 — the organisation's own calendar.
 *
 * ── Why this is a permission and not a preference ──────────────────────────
 *
 * Moving the year start changes what EVERY question about a period resolves
 * to, retrospectively and everywhere. A saved view that ran last week and runs
 * again today covers three different months, and nothing in the answer looks
 * wrong — the figures are real and correctly totalled.
 *
 * So it is gated by `authority.declare`, whose stated reason is exactly this
 * blast radius: a decision that says what every later answer MEANS, across the
 * whole organisation, which a scope admin must not make from inside one corner
 * of it. It is not a new permission because it is not a new kind of act.
 */

/**
 * What a logo may be.
 *
 * NO GIF AND NO PDF, though `mimeSniff` can identify both. A logo is a still
 * mark on every page of the product; an animated one is a distraction nobody
 * asked for and a document is not an image at all.
 */
const LOGO_TYPES: readonly SniffedType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

export async function calendar(actor: Actor): Promise<Calendar> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const organisation = await organisationRepo.findById(db, actor.organisationId);
        if (!organisation) {
          throw notFound({ message: 'That organisation does not exist.', code: 'missing.organisation' });
        }
        /* READABLE BY ANY MEMBER. Somebody handed a quarterly figure is
           entitled to know which quarter it means, and the calendar discloses
           nothing about the estate. */
        return organisation.calendar;
      }),
  );
}

export async function setCalendar(actor: Actor, input: Calendar): Promise<Calendar> {
  const said = input.timeZone.trim();

  /*
   * CHECKED HERE BECAUSE THE READ CANNOT REFUSE. `offsetOf` falls back to UTC
   * for a zone it does not recognise — right at read time, since failing every
   * question over a settings typo helps nobody — which means a mistyped zone
   * would silently answer in UTC forever. This is the one moment a person is
   * looking at the field, so it is the only place refusing is useful.
   */
  const timeZone = canonicalTimeZone(said);
  if (!timeZone) {
    throw invalid({ message: `${said} is not a time zone.`, code: 'invalid.time_zone' });
  }

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'authority.declare');

        const next: Calendar = { timeZone, yearStartsInMonth: input.yearStartsInMonth };
        const previous = await organisationRepo.setCalendar(db, actor.organisationId, next);

        if (!previous) {
          throw notFound({ message: 'That organisation does not exist.', code: 'missing.organisation' });
        }

        /*
         * THE AUDIT ROW CARRIES BOTH ENDS. "The year now starts in April" does
         * not let anyone reconstruct what a figure from last month meant; "it
         * moved from January to April on this date" does.
         */
        await writeAudit(db, {
          event: 'calendar_changed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            timeZone: next.timeZone,
            yearStartsInMonth: next.yearStartsInMonth,
            previousTimeZone: previous.timeZone,
            previousYearStartsInMonth: previous.yearStartsInMonth,
          },
        });

        return next;
      }),
  );
}

/**
 * §6.1 — the ceiling on who a view may be shared with.
 *
 * ── Enforced since 036, settable by nothing ────────────────────────────────
 *
 * `map.service` has read this on every share since the column existed, and no
 * code path could change it — so every organisation has been on the default,
 * and `assertSharingPolicy` was a validator for a setter that did not exist. A
 * policy that cannot be changed is not a policy.
 *
 * `clearance.grant` RATHER THAN `view.share`. Sharing a view is an act inside
 * the policy; this decides what the policy IS, organisation-wide, and it can
 * only ever loosen or tighten what everybody else is allowed to do. That is the
 * same class of decision as granting a clearance — "Super admin only, never
 * delegable" — and it is not delegable for the same reason: a scope admin
 * loosening it would be deciding the whole organisation's exposure from inside
 * one corner of it.
 */
export async function sharingPolicy(actor: Actor): Promise<SharingPolicy> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const organisation = await organisationRepo.findById(db, actor.organisationId);
        if (!organisation) {
          throw notFound({ message: 'That organisation does not exist.', code: 'missing.organisation' });
        }
        /* Readable by any member: somebody who cannot share a view is owed the
           reason, and the policy discloses nothing about the estate. */
        return organisation.sharingPolicy;
      }),
  );
}

export async function setSharingPolicy(actor: Actor, policy: string): Promise<SharingPolicy> {
  /* The one caller `assertSharingPolicy` was written for. */
  assertSharingPolicy(policy);

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'clearance.grant');

        const previous = await organisationRepo.setSharingPolicy(db, actor.organisationId, policy);
        if (!previous) {
          throw notFound({ message: 'That organisation does not exist.', code: 'missing.organisation' });
        }

        /*
         * `sharing_policy_changed` HAS BEEN IN THE AUDIT CATALOGUE SINCE IT WAS
         * WRITTEN AND NOTHING HAS EVER EMITTED IT — because nothing could change
         * the policy. This is its first emitter.
         */
        await writeAudit(db, {
          event: 'sharing_policy_changed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { from: previous, to: policy },
        });

        return policy;
      }),
  );
}

/**
 * Replace the organisation's logo.
 *
 * ── The columns and the store existed; nothing put a file in them ──────────
 *
 * `logo_object_key`, `logo_content_type`, `logo_uploaded_by` and
 * `logo_uploaded_at` have been on `organisations` since the first migration,
 * `objectStore.put` takes `kind: 'logo'` by name, and `setLogo` was written to
 * return the previous key so the old object could be cleaned up. No route ever
 * called any of it.
 *
 * ── An upload is a suggestion from a stranger ──────────────────────────────
 *
 * WHAT IT IS IS DECIDED FROM ITS BYTES, never from the content type the
 * uploader declared — that is what `mimeSniff` exists for, and a logo is the
 * one image in the product that every member sees on every page, which makes
 * it the most valuable thing in the system to smuggle a script into.
 *
 * AN SVG IS A DOCUMENT, NOT A PICTURE. It can carry script, a DOCTYPE that
 * expands exponentially, and a processing instruction that pulls in a
 * stylesheet — so it is sanitised, and `sanitiseSvg` REFUSES rather than strips
 * where refusing is the only safe answer.
 */
export async function setLogo(
  actor: Actor,
  input: { filename: string; contentType?: string; data: string },
): Promise<{ key: string; contentType: string; bytes: number }> {
  const body = Buffer.from(input.data, 'base64');
  if (body.byteLength === 0) {
    throw invalid({ message: 'That file is empty.', code: 'invalid.empty_upload' });
  }

  const checked = verifyUpload(body, input.contentType, LOGO_TYPES);
  if (!checked.ok) {
    throw invalid({ message: checked.reason ?? 'That is not an image.', code: 'invalid.file_type' });
  }

  /* Sanitised, or refused — see `sanitiseSvg`. */
  let bytes: Buffer = body;
  if (checked.sniffed === 'image/svg+xml') {
    const cleaned = sanitiseSvg(body.toString('utf8'));
    if (!cleaned.ok || cleaned.svg === undefined) {
      throw invalid({
        message: cleaned.reason ?? 'That SVG could not be made safe.',
        code: 'invalid.unsafe_svg',
      });
    }
    bytes = Buffer.from(cleaned.svg, 'utf8');
  }

  /*
   * ── CHECKED AFTER THE FILE IS, NOT BEFORE ────────────────────────────────
   *
   * A script wearing a `.png` name is refused for being a script whether or not
   * a bucket happens to be configured. Testing storage first made the endpoint
   * answer "no object store" to an attack, which is both the wrong sentence and
   * a deployment detail offered to somebody probing it.
   */
  if (!objectStore.isConfigured()) {
    throw refusal({
      message: 'No object store is configured, so a logo cannot be stored.',
      code: 'refusal.storage_unconfigured',
    });
  }

  const stored = await objectStore.put({
    organisationId: actor.organisationId,
    kind: 'logo',
    filename: safeFilename(input.filename),
    body: bytes,
    sniffedContentType: checked.sniffed,
  });

  const previousKey = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const { previousKey: was } = await organisationRepo.setLogo(db, {
          id: actor.organisationId,
          objectKey: stored.key,
          contentType: stored.contentType,
          uploadedBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'logo_replaced',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            /* THE SNIFFED TYPE, NOT THE DECLARED ONE, and whether they differed —
               a mismatch is the interesting half of an upload review. */
            contentType: stored.contentType,
            declaredContentType: input.contentType ?? null,
            mismatch: checked.mismatch,
            bytes: stored.bytes,
          },
        });

        return was;
      }),
  );

  /*
   * THE OLD OBJECT GOES AFTER THE ROW POINTS AT THE NEW ONE, and a failure to
   * delete is not a failure to change the logo. The other order leaves a
   * successful delete beside a row still naming the object that is now gone.
   */
  if (previousKey && previousKey !== stored.key) {
    try {
      await objectStore.remove(previousKey);
    } catch {
      /* An orphaned object costs storage; a thrown error here would tell
         somebody their logo did not change when it did. */
    }
  }

  return { key: stored.key, contentType: stored.contentType, bytes: stored.bytes };
}

/* ── Connector updates (MANIFEST-V2 §3.7) ───────────────────────────────── */

/** Whether Silo's own prebuilt connectors move to a new version by themselves, weekly. */
export async function connectorUpdates(actor: Actor): Promise<{ autoAdoptPrebuilt: boolean }> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => ({ autoAdoptPrebuilt: await connectionRepo.autoAdoptEnabled(db, actor.organisationId) })),
  );
}

export async function setConnectorUpdates(actor: Actor, input: { autoAdoptPrebuilt: boolean }): Promise<{ autoAdoptPrebuilt: boolean }> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => {
      await connectionRepo.setAutoAdopt(db, actor.organisationId, input.autoAdoptPrebuilt);
      await writeAudit(db, {
        event: 'connector_updates_changed',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { autoAdoptPrebuilt: input.autoAdoptPrebuilt },
      });
      return { autoAdoptPrebuilt: input.autoAdoptPrebuilt };
    }),
  );
}
