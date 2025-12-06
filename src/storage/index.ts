/**
 * AEGIS - Storage Module
 *
 * Barrel export file for database and cache clients
 */

// PostgreSQL exports
export {
  PostgresClient,
  getPostgresClient,
  initializePostgres,
  closePostgres,
} from './postgres.js';

export type { DatabaseClient, ConnectionStats } from './postgres.js';

// Redis exports
export {
  RedisClient,
  getRedisClient,
  initializeRedis,
  closeRedis,
  createRedisClient,
} from './redis.js';

export type { RedisConnectionOptions, RedisClientWrapper } from './redis.js';

// Convenience function to initialize all storage connections
import { initializePostgres } from './postgres.js';
import { initializeRedis } from './redis.js';
import type { PostgresConfig, RedisConfig } from '../utils/types.js';
import logger from '../utils/logger.js';

export interface StorageConfig {
  postgres: PostgresConfig;
  redis: RedisConfig;
}

export interface StorageConnections {
  postgres: Awaited<ReturnType<typeof initializePostgres>>;
  redis: Awaited<ReturnType<typeof initializeRedis>>;
}

/**
 * Initialize all storage connections
 */
export async function initializeStorage(config: StorageConfig): Promise<StorageConnections> {
  logger.info('Initializing storage connections...');

  const [postgres, redis] = await Promise.all([
    initializePostgres(config.postgres),
    initializeRedis({ config: config.redis }),
  ]);

  logger.info('All storage connections initialized successfully');

  return { postgres, redis };
}

/**
 * Close all storage connections
 */
export async function closeStorage(): Promise<void> {
  logger.info('Closing storage connections...');

  const { closePostgres } = await import('./postgres.js');
  const { closeRedis } = await import('./redis.js');

  await Promise.all([closePostgres(), closeRedis()]);

  logger.info('All storage connections closed');
}
