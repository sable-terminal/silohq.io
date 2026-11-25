// What became of a physical plan's statements (spec 47.4 to 47.6), shared by the OPC UA and
// MQTT engines: the agent's row for each operation, as the write's result. A statement the agent
// refused although the cell passed it, and one the control system rejected, are failed and never
// retried; one with no answer for a node is applied as far as the cell knows (a setpoint's read
// back decides whether it landed; a command without acknowledgement is not verified).

import type { WriteResult } from '../../../contracts/connect-runtime/write.contract.ts';
import type { AgentPhysicalResult } from '../agent.service.ts';

const RESULT_ERRORS = {
  refused: { meaning: 'validation', code: 'actuation.refused_by_agent' },
  rejected: { meaning: 'conflict', code: 'actuation.rejected_by_control_system' },
} as const;

export type PhysicalWriteResult = WriteResult & { physical: NonNullable<WriteResult['physical']> };

/** Each operation's result from the agent's rows; fieldOf names the field a node stands for, where it stands for one. */
export function physicalOutcomes(operations: readonly { key: string; identifier?: string | undefined }[], rows: readonly AgentPhysicalResult[],
  fieldOf: (path: string) => string | undefined = () => undefined): PhysicalWriteResult[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return operations.map((op) => {
    const row = byKey.get(op.key);
    const nodes = (row?.nodes ?? []).map(({ observed, ...n }) => ({
      ...n, ...(observed === undefined ? {} : { observed: observed as never }), ...(fieldOf(n.path) === undefined ? {} : { field: fieldOf(n.path)! }),
    }));
    const physical = { nodes, ...(row?.reason === undefined ? {} : { reason: row.reason }) };
    const identifier = op.identifier ?? null;
    if (row === undefined || row.outcome === 'not_attempted') return { key: op.key, outcome: 'not_attempted', identifier, error: null, physical };
    if (row.outcome === 'applied' || row.outcome === 'unknown') return { key: op.key, outcome: 'applied', identifier, error: null, physical };
    return { key: op.key, outcome: 'failed', identifier, error: { ...RESULT_ERRORS[row.outcome] }, physical };
  });
}
