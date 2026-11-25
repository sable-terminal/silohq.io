// Where an Ask question is kept (spec 36.8; design: workspace.ask_turns.question). The
// question is a record value: it may be kept only sealed with AES-256-GCM under the
// organisation's data key, and only the credential service seals (spec 61.3, the single
// mediator): sealedQuestions asks it to, bound to the turn's row, so a sealed question moved
// to another turn does not open. questionsNotKept keeps none (the question column reads as
// purged from the start), for a build without the credential service. Nothing else about a
// turn depends on the question.

import { sealRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface QuestionVault {
  /** The sealed question, bound to its turn, or null when questions are not kept. */
  seal(input: { organisationId: string; threadId: string; turnId: string; question: string }): Promise<Buffer | null>;
}

export const questionsNotKept: QuestionVault = {
  async seal() {
    return null;
  },
};

/** Questions sealed by the credential service under the organisation's data key, bound to their turn. */
export function sealedQuestions(services: ServiceClient): QuestionVault {
  return {
    async seal({ organisationId, turnId, question }) {
      const out = await services.call(sealRecordValues, {
        body: { items: [{ binding: { table: 'workspace.ask_turns', id: turnId, column: 'question' }, value: Buffer.from(question, 'utf8').toString('base64') }] },
      }, { request: { organisationId }, correlationId: uuidv7() });
      return Buffer.from(out.items[0]!, 'base64');
    },
  };
}
