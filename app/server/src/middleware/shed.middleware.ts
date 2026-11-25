// Load shedding at the door (spec 12.4): a request whose work the process sheds now is refused
// as capacity, with a retry time, before its body is read; never partial data. A contract that
// names no class is never shed (infra/load.infra.ts).

import type { RequestHandler } from 'express';
import type { AnyContract } from '../contracts/endpoint.contract.ts';
import type { LoadGauge } from '../infra/load.infra.ts';
import { refuse } from '../utils/errors.util.ts';

export function shedUnderLoad(contract: AnyContract, load: LoadGauge): RequestHandler {
  return (_req, _res, next) => {
    const work = contract.shed;
    if (work !== undefined && load.sheds(work)) {
      throw refuse.capacity(Math.min(30, 2 * load.level()), { shed: work, level: load.level() });
    }
    next();
  };
}
