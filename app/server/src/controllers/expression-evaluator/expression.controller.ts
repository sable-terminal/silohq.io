// The evaluator's endpoints: compile or evaluate, nothing else.

import type { evaluateExpression, validateExpression } from '../../contracts/expression-evaluator/expression.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { compileExpression } from '../../services/expression-evaluator/evaluator.service.ts';
import { isAppError } from '../../utils/errors.util.ts';

export const validate: RouteHandlers<typeof validateExpression> = {
  async handle({ body }) {
    try {
      compileExpression(body.block, body.language, body.source);
      return { valid: true as const };
    } catch (error) {
      if (!isAppError(error) || error.code !== 'expression.invalid') throw error;
      return { valid: false as const, code: error.code, stage: String(error.details['stage'] ?? ''), reason: String(error.details['reason'] ?? '') };
    }
  },
};

export const evaluate: RouteHandlers<typeof evaluateExpression> = {
  async handle({ body }) {
    const value = await compileExpression(body.block, body.language, body.source).evaluate(body.scope, new Date(body.now));
    return { value: (value ?? null) as never };
  },
};
