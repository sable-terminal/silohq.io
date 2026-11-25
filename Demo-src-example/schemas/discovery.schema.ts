import { z } from 'zod';

/**
 * §9.2 — ranges are explicit, and there is no default.
 *
 * CIDR, VALIDATED AS TEXT AND AGAIN AS A TYPE. Postgres has a `cidr` type and
 * will refuse anything that is not one, but the error it gives is about a cast
 * rather than about the field somebody typed — so this catches it where the
 * message can name it.
 */
const cidr = z
  .string()
  .min(4)
  .max(64)
  .regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/, 'Write a range as CIDR, such as 10.2.0.0/24.');

const method = z.enum(['port_scan', 'read_host_config', 'catalogue_introspect']);

export const setEnabled = z.object({ enabled: z.boolean() }).strict();

export const authorise = z
  .object({
    agentId: z.string().min(1).max(128),
    /*
     * A CAP ON HOW MUCH ONE APPROVAL COVERS. Twenty ranges is a large estate;
     * two hundred is somebody pasting a spreadsheet into a form nobody read.
     */
    ranges: z.array(cidr).min(1).max(20),
    methods: z.array(method).min(1).max(3),
    expiresAt: z.coerce.date(),
    approvalId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const startRun = z.object({ authorisationId: z.string().uuid() }).strict();

/**
 * What an agent reports.
 *
 * `structure` IS `unknown` AND IS FILTERED SERVER-SIDE. Validating its shape
 * here would be pretending to know what every agent version sends; the service
 * keeps only the keys that describe shape, which is the guarantee that matters.
 */
export const report = z
  .object({
    runId: z.string().uuid(),
    authorisationId: z.string().uuid(),
    hostsContacted: z.number().int().min(0).max(1_000_000),
    findings: z
      .array(
        z
          .object({
            host: z.string().min(1).max(256),
            port: z.number().int().min(1).max(65_535).nullable().optional(),
            method,
            structure: z.record(z.string(), z.unknown()).default({}),
            proposedTransport: z.string().min(1).max(64).nullable().optional(),
            confidence: z.number().min(0).max(1).nullable().optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const decide = z
  .object({ decision: z.enum(['accepted', 'rejected', 'ignored']) })
  .strict();

export const findingId = z.object({ id: z.string().uuid() }).strict();
export const authorisationId = z.object({ id: z.string().uuid() }).strict();
export const runFilter = z.object({ runId: z.string().uuid().optional() }).strict();
