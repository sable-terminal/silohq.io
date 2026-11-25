// Authentication settings. The spec fixes the mechanisms (Argon2id, opaque server-side
// sessions with Postgres as the revocation list, single-use resets, lockout until
// locked_until; spec 55, 60) but not the numbers. The defaults below are this build's
// choices, each overridable per cell:
// - Argon2id: 64 MiB, 3 passes, 1 lane, 16-byte salt, 32-byte hash (decision
//   2026-10-29; above OWASP's minimum of 19 MiB and 2 passes). At most 4 hashes run at once
//   per process and 32 wait; beyond that a login is refused with a retry time, so the
//   endpoint cannot be used to exhaust memory (64 MiB per hash).
// - Sessions: 30 minutes idle, 12 hours absolute; an organisation may shorten either,
//   never lengthen it (utils/session.util.ts). Reset links 30 minutes and invitations 7
//   days, each single use. Lockout for 15 minutes after 10 consecutive failures.
// - Passwords: at least 12 characters, checked against a breach list when set (spec
//   55.3). The list is the downloadable Pwned Passwords dataset inside the cell, never a
//   web service (invariant 11); production auth refuses to start without it.
// - Rate limits, per 10-minute window: 30 login attempts per client address, 10 per
//   email address, 10 MFA codes per session; 5 reset requests per email address an hour.

import { z } from 'zod';
import { parseSection, read, readSecret, zKey32, zPositiveInt, type Env } from './env.config.ts';

const schema = z.object({
  argon2MemoryKiB: zPositiveInt(4 * 1024 * 1024).default(65_536),
  argon2Passes: zPositiveInt(10).default(3),
  argon2Parallelism: zPositiveInt(16).default(1),
  argon2MaxConcurrent: zPositiveInt(64).default(4),
  argon2MaxQueued: zPositiveInt(10_000).default(32),
  sessionIdleMinutes: zPositiveInt(24 * 60).default(30),
  sessionAbsoluteHours: zPositiveInt(24 * 30).default(12),
  passwordResetMinutes: zPositiveInt(24 * 60).default(30),
  invitationDays: zPositiveInt(90).default(7),
  lockoutThreshold: zPositiveInt(100).default(10),
  lockoutMinutes: zPositiveInt(24 * 60).default(15),
  passwordMinLength: zPositiveInt(128).default(12),
  breachListDir: z.string().min(1).optional(),
  loginAttemptsPerAddress: zPositiveInt(10_000).default(30),
  loginAttemptsPerEmail: zPositiveInt(1_000).default(10),
  mfaAttemptsPerSession: zPositiveInt(1_000).default(10),
  resetRequestsPerEmail: zPositiveInt(100).default(5),
  // Keys the hashes of IP addresses and user agents in sessions and audit rows, so they
  // are comparable but cannot be reversed by hashing candidates (utils keyedHash).
  identifierHashKey: zKey32.optional(),
});

export interface SecurityConfig {
  argon2: { memoryKiB: number; passes: number; parallelism: number; saltBytes: number; hashBytes: number };
  /** Concurrent hashes per process, and how many may wait before a login is refused. */
  argon2Limits: { maxConcurrent: number; maxQueued: number };
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  passwordResetMinutes: number;
  invitationDays: number;
  lockoutThreshold: number;
  lockoutMinutes: number;
  passwordMinLength: number;
  /** The Pwned Passwords range files: <PREFIX> or <PREFIX>.txt, lines SUFFIX:COUNT (SHA-1). */
  breachListDir: string | undefined;
  rateLimits: {
    windowSeconds: number;
    loginAttemptsPerAddress: number;
    loginAttemptsPerEmail: number;
    mfaAttemptsPerSession: number;
    resetRequestsPerEmail: number;
  };
  identifierHashKey: Buffer | undefined;
}

export function loadSecurityConfig(env: Env, problems: string[]): SecurityConfig | undefined {
  const parsed = parseSection(schema, {
    argon2MemoryKiB: read(env, 'ARGON2_MEMORY_KIB'),
    argon2Passes: read(env, 'ARGON2_PASSES'),
    argon2Parallelism: read(env, 'ARGON2_PARALLELISM'),
    argon2MaxConcurrent: read(env, 'ARGON2_MAX_CONCURRENT'),
    argon2MaxQueued: read(env, 'ARGON2_MAX_QUEUED'),
    sessionIdleMinutes: read(env, 'SESSION_IDLE_MINUTES'),
    sessionAbsoluteHours: read(env, 'SESSION_ABSOLUTE_HOURS'),
    passwordResetMinutes: read(env, 'PASSWORD_RESET_MINUTES'),
    invitationDays: read(env, 'INVITATION_DAYS'),
    lockoutThreshold: read(env, 'LOGIN_LOCKOUT_THRESHOLD'),
    lockoutMinutes: read(env, 'LOGIN_LOCKOUT_MINUTES'),
    passwordMinLength: read(env, 'PASSWORD_MIN_LENGTH'),
    breachListDir: read(env, 'BREACH_LIST_DIR'),
    loginAttemptsPerAddress: read(env, 'LOGIN_ATTEMPTS_PER_ADDRESS'),
    loginAttemptsPerEmail: read(env, 'LOGIN_ATTEMPTS_PER_EMAIL'),
    mfaAttemptsPerSession: read(env, 'MFA_ATTEMPTS_PER_SESSION'),
    resetRequestsPerEmail: read(env, 'RESET_REQUESTS_PER_EMAIL'),
    identifierHashKey: readSecret(env, 'IDENTIFIER_HASH_KEY', problems),
  }, {
    argon2MemoryKiB: 'ARGON2_MEMORY_KIB', argon2Passes: 'ARGON2_PASSES', argon2Parallelism: 'ARGON2_PARALLELISM',
    argon2MaxConcurrent: 'ARGON2_MAX_CONCURRENT', argon2MaxQueued: 'ARGON2_MAX_QUEUED',
    sessionIdleMinutes: 'SESSION_IDLE_MINUTES', sessionAbsoluteHours: 'SESSION_ABSOLUTE_HOURS',
    passwordResetMinutes: 'PASSWORD_RESET_MINUTES', invitationDays: 'INVITATION_DAYS',
    lockoutThreshold: 'LOGIN_LOCKOUT_THRESHOLD', lockoutMinutes: 'LOGIN_LOCKOUT_MINUTES',
    passwordMinLength: 'PASSWORD_MIN_LENGTH', breachListDir: 'BREACH_LIST_DIR',
    loginAttemptsPerAddress: 'LOGIN_ATTEMPTS_PER_ADDRESS', loginAttemptsPerEmail: 'LOGIN_ATTEMPTS_PER_EMAIL',
    mfaAttemptsPerSession: 'MFA_ATTEMPTS_PER_SESSION', resetRequestsPerEmail: 'RESET_REQUESTS_PER_EMAIL',
    identifierHashKey: 'IDENTIFIER_HASH_KEY',
  }, problems);
  if (!parsed) return undefined;
  if (parsed.sessionIdleMinutes > parsed.sessionAbsoluteHours * 60) {
    problems.push('SESSION_IDLE_MINUTES: cannot exceed SESSION_ABSOLUTE_HOURS');
  }
  return {
    argon2: {
      memoryKiB: parsed.argon2MemoryKiB, passes: parsed.argon2Passes, parallelism: parsed.argon2Parallelism,
      saltBytes: 16, hashBytes: 32,
    },
    argon2Limits: { maxConcurrent: parsed.argon2MaxConcurrent, maxQueued: parsed.argon2MaxQueued },
    sessionIdleMinutes: parsed.sessionIdleMinutes,
    sessionAbsoluteHours: parsed.sessionAbsoluteHours,
    passwordResetMinutes: parsed.passwordResetMinutes,
    invitationDays: parsed.invitationDays,
    lockoutThreshold: parsed.lockoutThreshold,
    lockoutMinutes: parsed.lockoutMinutes,
    passwordMinLength: parsed.passwordMinLength,
    breachListDir: parsed.breachListDir,
    rateLimits: {
      windowSeconds: 600,
      loginAttemptsPerAddress: parsed.loginAttemptsPerAddress,
      loginAttemptsPerEmail: parsed.loginAttemptsPerEmail,
      mfaAttemptsPerSession: parsed.mfaAttemptsPerSession,
      resetRequestsPerEmail: parsed.resetRequestsPerEmail,
    },
    identifierHashKey: parsed.identifierHashKey,
  };
}
