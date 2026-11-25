// ask (spec 36): the AI assistant over the ontology. Private threads scoped to the page
// they were opened from; each turn a compile and, for a plan, an execution under the
// asker's own access; an answer, a refusal or a clarification, all finished replies.

import {
  archiveThread, askQuestion, createThread, getThread, listThreads, renameThread, readAskWebPolicy, rerunTurn, setAskWebPolicy, setAskWebScopePolicy, widenThreadScope,
} from '../../contracts/ask/thread.contract.ts';
import { createWebSearch, type WebSearch } from '../../infra/webSearch.infra.ts';
import { askController } from '../../controllers/ask/ask.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { sealedQuestions, type QuestionVault } from '../../services/ask/questionVault.service.ts';
import { createContractEngine } from '../../services/workspace/contractEngine.service.ts';
import type { QueryEngine } from '../../services/workspace/queryEngine.service.ts';

export function createAskService(options: { engine?: QueryEngine; vault?: QuestionVault; webSearch?: WebSearch } = {}) {
  return defineService({
    name: 'ask',
    // redis-data holds the idempotency keys: a retried question replays its turn.
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const c = askController({
        databases: deps.databases, services: deps.services, logger: deps.logger,
        engine: options.engine ?? createContractEngine(deps.services), vault: options.vault ?? sealedQuestions(deps.services),
        webSearch: options.webSearch ?? (deps.config.webSearch === undefined ? undefined : createWebSearch(deps.config.webSearch)),
      });
      return {
        routes: [
          route(createThread, c.createThread), route(listThreads, c.listThreads), route(getThread, c.getThread),
          route(renameThread, c.renameThread), route(archiveThread, c.archiveThread), route(widenThreadScope, c.widenThreadScope),
          route(askQuestion, c.askQuestion), route(rerunTurn, c.rerunTurn), route(setAskWebPolicy, c.setAskWebPolicy),
          route(setAskWebScopePolicy, c.setAskWebScopePolicy), route(readAskWebPolicy, c.readAskWebPolicy),
        ],
      };
    },
  });
}

export const service = createAskService();
