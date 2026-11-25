import { z } from 'zod';

/**
 * Agents at the door.
 *
 * A CONFIRMED HOST IS A NAME, AN ADDRESS, OR `*.` AND A SUFFIX, and its ports
 * are one, a range, or every port. Nothing broader than that can be written:
 * there is no "any host", because an agent that may reach anything is a
 * tunnel into the customer's network with Silo at the other end.
 */

const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[A-Za-z0-9._:\[\]-]+$/, 'A host is a name, an address, or *. and a suffix')
  .refine((h) => h !== '*' && !/^\*\.[^.]*$/.test(h), 'A pattern names at least a domain: *.corp.local, not *.local');

const port = z.number().int().min(1).max(65_535);

export const createAgent = z.object({ name: z.string().trim().min(1).max(100) }).strict();

export const agentId = z.object({ id: z.string().uuid() }).strict();

export const enrolAgent = z
  .object({
    enrolmentToken: z.string().min(20).max(200),
    publicKey: z.string().length(44),
    version: z.string().min(1).max(64),
    hostname: z.string().min(1).max(255),
  })
  .strict();

export const connectionId = z.object({ connectionId: z.string().uuid() }).strict();

export const assignAgent = z
  .object({
    agentId: z.string().uuid().nullable(),
    hosts: z
      .array(
        z
          .object({
            host,
            ports: z.union([port, z.tuple([port, port]).refine(([a, b]) => b >= a, 'A range runs low to high'), z.literal('any')]),
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict();
