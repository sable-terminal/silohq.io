/**
 * What a deployment costs to serve, as configured.
 *
 * IT BACKS THE FLOOR IN THE ADMIN PORTAL. A negotiated deal needs a number below
 * which the answer is no, and that number has to come from the configuration
 * rather than from instinct — a customer on Pro with ten connections and hourly
 * crons costs a multiple of one on Flash with two.
 *
 * IT IS AN ESTIMATE AND SHOULD BE PRESENTED AS ONE. Model pricing changes, egress
 * varies, and a figure shown to three decimal places invites a confidence it does
 * not deserve.
 */

export interface CostModel {
  /** Per weighted token charged to the customer. */
  modelCostPerToken: number;
  /** Per seat per month: storage, sessions, the fixed share of the platform. */
  platformCostPerSeat: number;
  /** Per connection per month: polling, health checks, credential operations. */
  connectionCost: number;
  /** Per cron execution. */
  cronExecutionCost: number;
  /** Per simulation, which has its own base. */
  simulationCost: number;
}

export interface Deployment {
  seats: number;
  connections: number;
  tokensPerPeriod: number;
  cronExecutionsPerPeriod: number;
  simulationsPerPeriod: number;
  /** What the customer pays for the period, in the same units as the costs. */
  revenuePerPeriod: number;
}

export interface Margin {
  cost: number;
  revenue: number;
  grossMargin: number;
  /** Fraction, not percent. 0.62 is a 62% margin. */
  marginRatio: number;
  breakdown: Record<string, number>;
  /** The revenue at which this deployment breaks even. */
  floor: number;
}

export function calculate(deployment: Deployment, model: CostModel): Margin {
  const breakdown = {
    model: deployment.tokensPerPeriod * model.modelCostPerToken,
    platform: deployment.seats * model.platformCostPerSeat,
    connections: deployment.connections * model.connectionCost,
    crons: deployment.cronExecutionsPerPeriod * model.cronExecutionCost,
    simulations: deployment.simulationsPerPeriod * model.simulationCost,
  };

  const cost = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const grossMargin = deployment.revenuePerPeriod - cost;

  return {
    cost,
    revenue: deployment.revenuePerPeriod,
    grossMargin,
    // Guarded: a deployment with no revenue is not a negative-infinity margin,
    // it is a deployment with no revenue.
    marginRatio: deployment.revenuePerPeriod > 0 ? grossMargin / deployment.revenuePerPeriod : 0,
    breakdown,
    floor: cost,
  };
}

/** Whether a proposed price clears a required margin. */
export function clearsFloor(margin: Margin, requiredRatio: number): boolean {
  return margin.marginRatio >= requiredRatio;
}
