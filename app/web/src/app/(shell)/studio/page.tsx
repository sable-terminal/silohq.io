'use client';

// The earlier client's area address: sent on to the section that holds it now.

import { Suspense } from 'react';
import { AreaRedirect } from '../../../views/section.view.tsx';

const BY_PARAM = {
  app: 'apps/', edit: 'apps/', workbook: 'workbooks/', report: 'reports/', process: 'processes/', pipeline: 'pipelines/', model: 'models/', notebook: 'notebooks/', aiAgent: 'agents/',
};

export default function Page() {
  return <Suspense fallback={null}><AreaRedirect area="studio" tabs={{ apps: 'apps/', workbooks: 'workbooks/', reports: 'reports/', notebooks: 'notebooks/', processes: 'processes/', pipelines: 'pipelines/', agents: 'agents/', models: 'models/' }} fallback="apps/" byParam={BY_PARAM} /></Suspense>;
}
