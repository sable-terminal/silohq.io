// approvals (catalogue): approval chains for mutations (spec 44), with policies, floors and
// the approvals inbox. One chain model; purges (chapter 70) and discovery scans (chapter 19)
// use it when their services exist.

import {
  createApprovalPolicy, decideApproval, getChain, listApprovalInbox, listApprovalPolicies, requestApproval, setPolicyFloor, supersedeApprovalPolicy,
} from '../../contracts/approvals/approval.contract.ts';
import { approvalsController } from '../../controllers/approvals/approvals.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createChains } from '../../services/approvals/chains.service.ts';
import { createPolicies } from '../../services/approvals/policies.service.ts';

export const service = defineService({
  name: 'approvals',
  needs: { postgres: ['control'] },
  create(deps) {
    const base = { databases: deps.databases, services: deps.services, logger: deps.logger };
    const c = approvalsController(createChains(base), createPolicies(base));
    return {
      routes: [
        route(requestApproval, c.request), route(getChain, c.get), route(listApprovalInbox, c.inbox), route(decideApproval, c.decide),
        route(createApprovalPolicy, c.createPolicy), route(supersedeApprovalPolicy, c.supersedePolicy), route(listApprovalPolicies, c.listPolicies),
        route(setPolicyFloor, c.setFloor),
      ],
    };
  },
});
