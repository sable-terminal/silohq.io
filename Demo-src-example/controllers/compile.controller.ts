import type { Request, Response } from 'express';
import * as compile from '../services/compile.service';
import * as render from '../services/render.service';
import * as answerReading from '../services/answerReading.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body } from '../middleware/validate.middleware';

/**
 * §7 — asking a question in plain English.
 *
 * EVERY OUTCOME IS A 200. An answer, a refusal, and a clarification
 * are each a complete response to a reasonable question — a refusal is the
 * model saying this estate does not hold what was asked for, which is
 * information, and an ambiguity is a question back. Only a plan that failed
 * validation is an error, because that is the system's fault rather than the
 * asker's.
 *
 * The fourth is `change`: the words asked for records to be changed, not read.
 * Nothing was read or charged, and the caller sends the same words to
 * `POST /mutations/compile`, which proposes the change through its own gate.
 */
export async function ask(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof compile.ask>[1]>(req);
  const outcome = await compile.ask(actorOf(req), input);

  /*
   * Rendering §1 — the render layer "receives a result that has already been
   * computed… and decides how to show it", and it is attached here, in the
   * presentation layer, for the same reason `/concepts/:id/ask` attaches it.
   *
   * THIS IS THE PATH THAT MATTERS MOST AND IT WAS THE ONE MISSED. The render
   * layer was wired to the concept route first, and a question asked in plain
   * English — which is how almost everybody asks — came back with no prose,
   * no archetype and no flags. §2 makes prose the default representation for
   * everything, so an answer without it had no default at all.
   *
   * ONLY AN ANSWER IS DESCRIBED. A refusal and an ambiguity are sentences
   * already; there is no result to draw.
   */
  if (outcome.outcome === 'answered') {
    res.status(200).json({
      ...outcome,
      render: render.describe(outcome.answer, { sort: outcome.plan.sort }),
    });
    return;
  }

  /* A survey is described part by part: each concept is its own result. */
  if (outcome.outcome === 'surveyed') {
    res.status(200).json({
      ...outcome,
      parts: outcome.parts.map((part) => ({ ...part, render: render.describe(part.answer, { sort: part.plan.sort }) })),
    });
    return;
  }

  res.status(200).json(outcome);
}

/**
 * 129 — the answer just given, written up by the model, or a question about it.
 *
 * A SEPARATE REQUEST, AFTER THE ANSWER. The rows are on screen the moment the
 * systems have been read; the write-up follows. Refused, with a code the
 * Console reads, where the organisation has not chosen it.
 */
export async function read(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof answerReading.read>[1]>(req);
  res.status(200).json(await answerReading.read(actorOf(req), input));
}
