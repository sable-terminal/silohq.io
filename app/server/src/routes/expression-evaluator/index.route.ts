// The expression evaluator (catalogue: expression-evaluator): stateless, no database.

import { evaluateExpression, validateExpression } from '../../contracts/expression-evaluator/expression.contract.ts';
import { evaluate, validate } from '../../controllers/expression-evaluator/expression.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export const service = defineService({
  name: 'expression-evaluator',
  needs: {},
  create() {
    return { routes: [route(validateExpression, validate), route(evaluateExpression, evaluate)] };
  },
});
