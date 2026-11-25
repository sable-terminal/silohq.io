import type { Request, Response } from 'express';
import * as organisation from '../services/organisation.service';
import * as answerReading from '../services/answerReading.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body } from '../middleware/validate.middleware';

/**
 * §7.3 — the calendar every question about a period is measured against.
 *
 * THE READ IS OPEN TO ANY MEMBER AND THE WRITE IS NOT. Somebody handed a
 * quarterly figure is entitled to know which quarter it means; deciding which
 * quarter it means for the whole organisation is a different act.
 */
export async function calendar(req: Request, res: Response): Promise<void> {
  res.status(200).json({ calendar: await organisation.calendar(actorOf(req)) });
}

export async function setCalendar(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof organisation.setCalendar>[1]>(req);
  res.status(200).json({ calendar: await organisation.setCalendar(actorOf(req), input) });
}

/**
 * §6.1 — the ceiling on who a view may be shared with.
 *
 * Enforced on every share since migration 036, and settable by nothing until
 * now — so every organisation has been sitting on the default.
 */
export async function sharingPolicy(req: Request, res: Response): Promise<void> {
  res.status(200).json({ sharingPolicy: await organisation.sharingPolicy(actorOf(req)) });
}

export async function setSharingPolicy(req: Request, res: Response): Promise<void> {
  const { sharingPolicy: policy } = body<{ sharingPolicy: string }>(req);
  res.status(200).json({ sharingPolicy: await organisation.setSharingPolicy(actorOf(req), policy) });
}

/**
 * The organisation's logo.
 *
 * SUPER ADMIN ONLY. A logo is the one image every member sees on every page and
 * on every email the product sends, which makes it the most valuable thing in
 * the system to smuggle something into — and there is no permission in the
 * catalogue for branding, so the honest gate is the one that is not delegable.
 */
export async function setLogo(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof organisation.setLogo>[1]>(req);
  res.status(200).json({ logo: await organisation.setLogo(actorOf(req), input) });
}

export async function connectorUpdates(req: Request, res: Response): Promise<void> {
  res.status(200).json(await organisation.connectorUpdates(actorOf(req)));
}

export async function setConnectorUpdates(req: Request, res: Response): Promise<void> {
  res.status(200).json(await organisation.setConnectorUpdates(actorOf(req), body<{ autoAdoptPrebuilt: boolean }>(req)));
}

/**
 * 129 — whether answers are written up by a model, and the words to read first.
 *
 * READ BY ANY MEMBER: the Console says why an answer is in fixed sentences,
 * and the words are the public security page's anyway.
 */
export async function answerReadingSetting(req: Request, res: Response): Promise<void> {
  res.status(200).json(await answerReading.setting(actorOf(req)));
}

export async function setAnswerReading(req: Request, res: Response): Promise<void> {
  await answerReading.set(actorOf(req), body<{ enabled: boolean }>(req));
  res.status(200).json(await answerReading.setting(actorOf(req)));
}

/** 130 — whether context from the web is allowed here. Any member may read it: the Console says why its switch is off. */
export async function webContext(req: Request, res: Response): Promise<void> {
  res.status(200).json(await answerReading.webSetting(actorOf(req)));
}

export async function setWebContext(req: Request, res: Response): Promise<void> {
  await answerReading.setWeb(actorOf(req), body<{ enabled: boolean }>(req));
  res.status(200).json(await answerReading.webSetting(actorOf(req)));
}
