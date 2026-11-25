// The chain snapshot as stored (design: action.approval_chains.policy_snapshot). Its
// conditions carry snake_case keys, the form the database's step guard reads
// (action.approval_steps_guard checks self_approval_permitted); the services work in
// camelCase. Every writer of a chain stores through storedConditions, every reader reads
// through readConditions.

import type { ChainCondition } from '../../contracts/approvals/approval.contract.ts';

const toSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (key: string): string => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const mapKeys = (o: Record<string, unknown>, f: (key: string) => string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [f(k), v]));

export const storedConditions = (conditions: readonly ChainCondition[]): Record<string, unknown>[] =>
  conditions.map((c) => mapKeys(c as unknown as Record<string, unknown>, toSnake));

export const readConditions = (stored: unknown): ChainCondition[] =>
  (Array.isArray(stored) ? stored : []).map((c) => mapKeys(c as Record<string, unknown>, toCamel) as unknown as ChainCondition);
