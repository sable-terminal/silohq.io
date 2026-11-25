import { z } from 'zod';

/** Rendering §8 — dashboards and the saved views placed on them. */

const name = z.string().trim().min(1).max(80);

export const createDashboard = z.object({ name }).strict();

export const renameDashboard = z.object({ name }).strict();

export const dashboardId = z.object({ id: z.string().uuid() }).strict();

export const widgetId = z.object({ id: z.string().uuid(), widgetId: z.string().uuid() }).strict();

export const addWidget = z.object({ viewId: z.string().uuid() }).strict();

/**
 * The grid as it now stands: every widget, in order, with its size — or null
 * for "whatever suits it". Width is in twelfths of the grid, height in rows.
 */
export const arrangeWidgets = z
  .object({
    widgets: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            width: z.number().int().min(1).max(12).nullable(),
            height: z.number().int().min(1).max(8).nullable(),
          })
          .strict()
          .refine((widget) => (widget.width === null) === (widget.height === null), {
            message: 'A widget has both a width and a height, or neither.',
          }),
      )
      .max(24),
  })
  .strict();
