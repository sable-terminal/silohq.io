/**
 * The configuration barrel.
 *
 * IMPORTING THIS IS WHAT VALIDATES THE ENVIRONMENT, because `env.config` runs its
 * parse at module load. Anything reaching `process.env` directly instead has
 * skipped that, and will find out about a missing variable at the moment it is
 * used rather than at boot.
 */
export { env, isDev, isProd, isTest, assertProductionReady } from './env.config';
export { logger, childLogger } from './logger.config';
export { authConfig } from './auth.config';
export { cellConfig } from './cell.config';
export * as constants from './constants.config';
