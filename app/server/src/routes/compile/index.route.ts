// compile (spec 26): questions in the organisation's own words become validated plans over
// the ontology, through the reader's vocabulary, the model gateway, two checks, the
// planner's bounds and a charge, then run by the executor. Structured plans enter at
// compile without a model call.

import {
  compileFailure, compilePlan, compileQuestion, copyPlanBinding, getCompiledPlan, getVocabulary, runCompiledPlan,
} from '../../contracts/compile/compile.contract.ts';
import { analysisFromPlan, compileAnalysis, getAnalysis, runAnalysis } from '../../contracts/compile/analysis.contract.ts';
import { getOrganisationCalendar, setOrganisationCalendar } from '../../contracts/compile/calendar.contract.ts';
import { analysisController } from '../../controllers/compile/analysis.controller.ts';
import { calendarController } from '../../controllers/compile/calendar.controller.ts';
import { compileController } from '../../controllers/compile/compile.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export const service = defineService({
  name: 'compile',
  // control: compiled plans, the policy version, the calendar, the outbox; data: keyed outcomes.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const compileDeps = {
      databases: deps.databases, services: deps.services, data: deps.redis.data!, bounds: deps.config.executorBounds, logger: deps.logger,
      narrowTypes: deps.config.compile.narrowTypes,
    };
    const c = compileController(compileDeps);
    const a = analysisController(compileDeps);
    const calendar = calendarController({ databases: deps.databases, services: deps.services });
    return {
      routes: [
        route(getOrganisationCalendar, calendar.get), route(setOrganisationCalendar, calendar.set),
        route(compileQuestion, c.compileQuestion), route(compileFailure, c.compileFailure), route(compilePlan, c.compilePlan), route(getCompiledPlan, c.getCompiledPlan),
        route(getVocabulary, c.getVocabulary), route(runCompiledPlan, c.runCompiledPlan), route(copyPlanBinding, c.copyPlanBinding),
        route(compileAnalysis, a.compileAnalysis), route(runAnalysis, a.runAnalysis), route(getAnalysis, a.getAnalysis), route(analysisFromPlan, a.analysisFromPlan),
      ],
    };
  },
});
