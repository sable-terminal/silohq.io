import type { Period } from './period.util';

/**
 * Where consumption is heading, from where it has been.
 *
 * IT POWERS A PROMPT, NOT A DECISION. Nothing is blocked or bought on this
 * number — it decides whether to suggest a top-up or an upgrade. That is why a
 * crude linear projection is adequate and a forecast model would be
 * over-engineering.
 *
 * IT REFUSES TO PROJECT FROM ALMOST NOTHING. Two days into a month, one heavy
 * afternoon extrapolates to a wildly alarming figure, and a top-up prompt driven
 * by noise is a prompt people learn to dismiss.
 */

const MINIMUM_ELAPSED_FRACTION = 0.1;

export interface Projection {
  /** Null when there is not enough of the period elapsed to say. */
  projected: number | null;
  fractionElapsed: number;
  willExhaust: boolean;
  /** When the allowance runs out at the current rate. */
  exhaustionDate: Date | null;
  recommendation: 'none' | 'top-up' | 'upgrade-plan' | 'reduce-usage';
}

export function project(
  period: Period,
  consumed: number,
  granted: number,
  now = new Date(),
): Projection {
  const total = period.end.getTime() - period.start.getTime();
  const elapsed = Math.max(0, now.getTime() - period.start.getTime());
  const fractionElapsed = total > 0 ? Math.min(1, elapsed / total) : 0;

  if (fractionElapsed < MINIMUM_ELAPSED_FRACTION) {
    return {
      projected: null,
      fractionElapsed,
      willExhaust: false,
      exhaustionDate: null,
      recommendation: 'none',
    };
  }

  const projected = Math.round(consumed / fractionElapsed);
  const willExhaust = projected > granted;

  let exhaustionDate: Date | null = null;
  if (willExhaust && consumed > 0) {
    const perMs = consumed / elapsed;
    const msToExhaustion = (granted - consumed) / perMs;
    exhaustionDate = new Date(now.getTime() + msToExhaustion);
  }

  return {
    projected,
    fractionElapsed,
    willExhaust,
    exhaustionDate,
    recommendation: recommend(projected, granted, willExhaust),
  };
}

/**
 * A top-up is right for a small overshoot; a plan change for a persistent one.
 *
 * SUGGESTING A TOP-UP TO SOMEBODY 200% OVER IS SELLING THEM THE EXPENSIVE OPTION
 * REPEATEDLY, and they will notice. The threshold is where an upgrade is
 * genuinely the better deal for them.
 */
function recommend(projected: number, granted: number, willExhaust: boolean): Projection['recommendation'] {
  if (!willExhaust) return 'none';
  const ratio = projected / Math.max(1, granted);
  if (ratio > 1.75) return 'upgrade-plan';
  return 'top-up';
}
