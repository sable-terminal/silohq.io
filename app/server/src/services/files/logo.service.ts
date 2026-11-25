// The organisation's logo (spec 56.2). The bytes decide what it is (never the client's header);
// an SVG is rebuilt from the allowlist (svg.util.ts) and stored as rebuilt. A replacement writes
// a new key and the old object stays for the recovery window (the bucket's versioning and
// retention keep it; nothing deletes it here). logo_replaced records it: type, size, pixels.

import { LOGO_MAX_BYTES, LOGO_MAX_PIXELS } from '../../contracts/files/logo.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { objectKey, type ObjectKey } from '../../infra/objectStorage.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { rasterImage, svgSize } from '../../utils/image.util.ts';
import { looksLikeSvg, sanitiseSvg, SvgRefused } from '../../utils/svg.util.ts';
import { actorOf, recordEvent, type Context, type FilesDeps } from './deps.service.ts';

type LogoType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

export async function setLogo(deps: FilesDeps, ctx: Context, contentBase64: string) {
  const actor = await actorOf(deps, ctx);
  if (actor.membershipId === undefined) throw new AppError('forbidden', 'a logo is set by a person', { code: 'files.person_required' });
  const decision = await deps.services.call(authorise, { body: { permission: 'org.logo.manage', organisationWide: true } },
    { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') throw new AppError('forbidden', 'you do not hold org.logo.manage', { code: 'files.not_permitted', details: { permission: 'org.logo.manage' } });
  let bytes: Buffer = Buffer.from(contentBase64, 'base64');
  if (bytes.length > LOGO_MAX_BYTES) throw new AppError('bounds', 'a logo is at most 2 MB', { code: 'bound.logo_bytes', details: { limit: LOGO_MAX_BYTES } });
  let contentType: LogoType;
  let size: { width: number; height: number } | undefined;
  const raster = rasterImage(bytes);
  if (raster !== undefined) {
    contentType = raster.contentType;
    size = { width: raster.width, height: raster.height };
  } else if (looksLikeSvg(bytes)) {
    try {
      bytes = sanitiseSvg(bytes);
    } catch (error) {
      if (error instanceof SvgRefused) throw new AppError('validation', 'the SVG cannot be used as a logo', { code: 'files.logo_svg_refused', details: { reason: error.reason } });
      throw error;
    }
    contentType = 'image/svg+xml';
    size = svgSize(bytes.toString('utf8'));
  } else {
    throw new AppError('validation', 'a logo is a PNG, JPEG, SVG or WebP image', { code: 'files.logo_type' });
  }
  if (size !== undefined && (size.width > LOGO_MAX_PIXELS || size.height > LOGO_MAX_PIXELS || size.width < 1 || size.height < 1)) {
    throw new AppError('bounds', 'a logo is at most 1024 pixels a side', { code: 'bound.logo_pixels', details: { limit: LOGO_MAX_PIXELS } });
  }
  const key = objectKey.organisation(actor.organisationId, 'logos', uuidv7());
  await deps.store.put('files', key, bytes, contentType);
  const at = new Date(deps.now()).toISOString();
  await inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const before = await organisationRepo.findById(db, actor.organisationId);
    await organisationRepo.update(db, actor.organisationId, {
      logoObjectKey: key, logoContentType: contentType, logoUploadedBy: actor.membershipId!, logoUploadedAt: at, version: (before?.version ?? 0) + 1,
    });
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'logo_replaced', resource: { type: 'organisation', id: actor.organisationId },
      detail: { content_type: contentType, bytes: bytes.length, width: size?.width ?? null, height: size?.height ?? null, replaced: before?.logoObjectKey != null },
    });
  });
  return { contentType, width: size?.width ?? null, height: size?.height ?? null, bytes: bytes.length, uploadedBy: actor.membershipId, uploadedAt: at };
}

export async function getLogo(deps: FilesDeps, ctx: Context): Promise<{ contentType: string; contentBase64: string }> {
  const actor = await actorOf(deps, ctx);
  if (actor.membershipId === undefined) throw new AppError('forbidden', 'the logo is shown to members', { code: 'files.person_required' });
  const org = await inTransaction(deps.databases.pool('control'), actor.request, (db) => organisationRepo.findById(db, actor.organisationId), { readOnly: true });
  if (org?.logoObjectKey == null || org.logoContentType === null) throw new AppError('not_found', 'the organisation has no logo', { code: 'files.logo_none' });
  const bytes = await deps.store.get('files', org.logoObjectKey as ObjectKey);
  return { contentType: org.logoContentType, contentBase64: bytes.toString('base64') };
}
