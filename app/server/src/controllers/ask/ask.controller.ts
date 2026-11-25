// Ask's endpoints: contracts to the service, nothing more.

import type {
  archiveThread, askQuestion, createThread, getThread, listThreads, renameThread, readAskWebPolicy, rerunTurn, setAskWebPolicy, setAskWebScopePolicy, widenThreadScope,
} from '../../contracts/ask/thread.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as asking from '../../services/ask/ask.service.ts';
import type { AskDeps } from '../../services/ask/ask.service.ts';

export function askController(deps: AskDeps) {
  return {
    createThread: {
      handle: (input, ctx) => asking.createThread(deps, ctx, input.body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => asking.readThread(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof createThread>,
    listThreads: { handle: async (input, ctx) => ({ threads: await asking.listThreads(deps, ctx, input.query) }) } satisfies RouteHandlers<typeof listThreads>,
    getThread: { handle: (input, ctx) => asking.getThread(deps, ctx, input.params.threadId) } satisfies RouteHandlers<typeof getThread>,
    renameThread: {
      handle: (input, ctx) => asking.renameThread(deps, ctx, input.params.threadId, input.body.title),
    } satisfies RouteHandlers<typeof renameThread>,
    archiveThread: { handle: (input, ctx) => asking.archiveThread(deps, ctx, input.params.threadId) } satisfies RouteHandlers<typeof archiveThread>,
    widenThreadScope: {
      handle: (input, ctx) => asking.setScope(deps, ctx, input.params.threadId, input.body.scope),
    } satisfies RouteHandlers<typeof widenThreadScope>,
    // A retried question replays its turn by sequence: the model is never asked twice and nothing is charged twice.
    askQuestion: {
      handle: (input, ctx) => asking.ask(deps, ctx, input.params.threadId, input.body),
      resultRef: (out) => `${out.thread.id}.${out.turn.sequence}`,
      replay: (ref, ctx) => {
        const [threadId, sequence] = ref!.split('.');
        return asking.readTurn(deps, ctx, threadId!, Number(sequence));
      },
    } satisfies RouteHandlers<typeof askQuestion>,
    rerunTurn: {
      handle: (input, ctx) => asking.rerun(deps, ctx, input.params.threadId, input.params.sequence),
    } satisfies RouteHandlers<typeof rerunTurn>,
    readAskWebPolicy: {
      handle: (_input, ctx) => asking.readWebPolicy(deps, ctx),
    } satisfies RouteHandlers<typeof readAskWebPolicy>,
    setAskWebPolicy: {
      handle: (input, ctx) => asking.setWebPolicy(deps, ctx, input.body.enabled),
    } satisfies RouteHandlers<typeof setAskWebPolicy>,
    setAskWebScopePolicy: {
      handle: (input, ctx) => asking.setWebScopePolicy(deps, ctx, input.params.scopeId, input.body),
    } satisfies RouteHandlers<typeof setAskWebScopePolicy>,
  };
}
