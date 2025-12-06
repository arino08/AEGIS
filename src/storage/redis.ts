/**
 * AEGIS - Redis Client
 * Redis connection management for caching and rate limiting
 */

import { createClient, type RedisClientType, type RedisClientOptions } from 'redis';

import logger, { logLifecycle } from '../utils/logger.js';
import type { RedisConfig } from '../utils/types.js';

// =============================================================================
// Types
// =============================================================================

export interface RedisConnectionOptions {
  config: RedisConfig;
  keyPrefix?: string;
  connectTimeout?: number;
  commandTimeout?: number;
}

export interface RedisClientWrapper {
  client: RedisClientType;
  isConnected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  ping: () => Promise<boolean>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds?: number) => Promise<void>;
  del: (key: string | string[]) => Promise<number>;
  incr: (key: string) => Promise<number>;
  incrBy: (key: string, increment: number) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<boolean>;
  ttl: (key: string) => Promise<number>;
  exists: (key: string | string[]) => Promise<number>;
  keys: (pattern: string) => Promise<string[]>;
  mget: (keys: string[]) => Promise<(string | null)[]>;
  mset: (keyValues: Record<string, string>) => Promise<void>;
  hget: (key: string, field: string) => Promise<string | null>;
  hset: (key: string, field: string, value: string) => Promise<number>;
  hgetall: (key: string) => Promise<Record<string, string>>;
  hdel: (key: string, field: string | string[]) => Promise<number>;
  hincrby: (key: string, field: string, increment: number) => Promise<number>;
  lpush: (key: string, values: string | string[]) => Promise<number>;
  rpush: (key: string, values: string | string[]) => Promise<number>;
  lpop: (key: string) => Promise<string | null>;
  rpop: (key: string) => Promise<string | null>;
  lrange: (key: string, start: number, stop: number) => Promise<string[]>;
  llen: (key: string) => Promise<number>;
  sadd: (key: string, members: string | string[]) => Promise<number>;
  srem: (key: string, members: string | string[]) => Promise<number>;
  smembers: (key: string) => Promise<string[]>;
  sismember: (key: string, member: string) => Promise<boolean>;
  zadd: (key: string, score: number, member: string) => Promise<number>;
  zrange: (key: string, start: number, stop: number) => Promise<string[]>;
  zrangebyscore: (key: string, min: number | string, max: number | string) => Promise<string[]>;
  zrem: (key: string, members: string | string[]) => Promise<number>;
  zremrangebyscore: (key: string, min: number | string, max: number | string) => Promise<number>;
  zcard: (key: string) => Promise<number>;
  flushdb: () => Promise<void>;
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
}

// =============================================================================
// Redis Client Class
// =============================================================================

export class RedisClient implements RedisClientWrapper {
  public client: RedisClientType;
  public isConnected = false;
  private config: RedisConfig;
  private keyPrefix: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;

  constructor(options: RedisConnectionOptions) {
    this.config = options.config;
    this.keyPrefix = options.keyPrefix ?? 'aegis:';

    const clientOptions: RedisClientOptions = {
      socket: {
        host: this.config.host,
        port: this.config.port,
        connectTimeout: options.connectTimeout ?? 10000,
        reconnectStrategy: (retries) => {
          if (retries > this.maxReconnectAttempts) {
            logger.error('Max Redis reconnection attempts reached');
            return new Error('Max reconnection attempts reached');
          }
          const delay = Math.min(retries * this.reconnectDelay, 30000);
          logger.warn(`Redis reconnecting in ${delay}ms (attempt ${retries})`);
          return delay;
        },
      },
      database: this.config.db,
    };

    if (this.config.password) {
      clientOptions.password = this.config.password;
    }

    if (this.config.tls) {
      clientOptions.socket = {
        ...clientOptions.socket,
        tls: true,
      };
    }

    this.client = createClient(clientOptions) as RedisClientType;

    // Set up event handlers
    this.setupEventHandlers();
  }

  /**
   * Set up Redis client event handlers
   */
  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.debug('Redis client connecting...');
    });

    this.client.on('ready', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      logLifecycle('ready', 'Redis client connected', {
        host: this.config.host,
        port: this.config.port,
        db: this.config.db,
      });
    });

    this.client.on('error', (err) => {
      logger.error('Redis client error', { error: err.message });
    });

    this.client.on('end', () => {
      this.isConnected = false;
      logger.warn('Redis client disconnected');
    });

    this.client.on('reconnecting', () => {
      this.reconnectAttempts++;
      logger.info('Redis client reconnecting...', {
        attempt: this.reconnectAttempts,
      });
    });
  }

  /**
   * Prepend key prefix
   */
  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Connect to Redis
   */
  public async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await this.client.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to connect to Redis', { error: message });
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.client.quit();
      this.isConnected = false;
      logLifecycle('shutdown', 'Redis client disconnected');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Error disconnecting from Redis', { error: message });
      throw error;
    }
  }

  /**
   * Ping Redis server
   */
  public async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Get a value by key
   */
  public async get(key: string): Promise<string | null> {
    return this.client.get(this.prefixKey(key));
  }

  /**
   * Set a value with optional TTL
   */
  public async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const prefixedKey = this.prefixKey(key);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.client.setEx(prefixedKey, ttlSeconds, value);
    } else {
      await this.client.set(prefixedKey, value);
    }
  }

  /**
   * Delete key(s)
   */
  public async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key.map((k) => this.prefixKey(k)) : [this.prefixKey(key)];
    return this.client.del(keys);
  }

  /**
   * Increment a key
   */
  public async incr(key: string): Promise<number> {
    return this.client.incr(this.prefixKey(key));
  }

  /**
   * Increment a key by a specific amount
   */
  public async incrBy(key: string, increment: number): Promise<number> {
    return this.client.incrBy(this.prefixKey(key), increment);
  }

  /**
   * Set key expiration in seconds
   */
  public async expire(key: string, seconds: number): Promise<boolean> {
    return this.client.expire(this.prefixKey(key), seconds);
  }

  /**
   * Get TTL of a key in seconds
   */
  public async ttl(key: string): Promise<number> {
    return this.client.ttl(this.prefixKey(key));
  }

  /**
   * Check if key(s) exist
   */
  public async exists(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key.map((k) => this.prefixKey(k)) : [this.prefixKey(key)];
    return this.client.exists(keys);
  }

  /**
   * Get keys matching a pattern
   */
  public async keys(pattern: string): Promise<string[]> {
    const results = await this.client.keys(this.prefixKey(pattern));
    // Remove prefix from results
    return results.map((k) => k.substring(this.keyPrefix.length));
  }

  /**
   * Get multiple values
   */
  public async mget(keys: string[]): Promise<(string | null)[]> {
    const prefixedKeys = keys.map((k) => this.prefixKey(k));
    return this.client.mGet(prefixedKeys);
  }

  /**
   * Set multiple values
   */
  public async mset(keyValues: Record<string, string>): Promise<void> {
    const prefixedKeyValues: [string, string][] = Object.entries(keyValues).map(([k, v]) => [
      this.prefixKey(k),
      v,
    ]);
    await this.client.mSet(prefixedKeyValues);
  }

  /**
   * Get hash field value
   */
  public async hget(key: string, field: string): Promise<string | null> {
    const result = await this.client.hGet(this.prefixKey(key), field);
    return result ?? null;
  }

  /**
   * Set hash field value
   */
  public async hset(key: string, field: string, value: string): Promise<number> {
    return this.client.hSet(this.prefixKey(key), field, value);
  }

  /**
   * Get all hash fields and values
   */
  public async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hGetAll(this.prefixKey(key));
  }

  /**
   * Delete hash field(s)
   */
  public async hdel(key: string, field: string | string[]): Promise<number> {
    const fields = Array.isArray(field) ? field : [field];
    return this.client.hDel(this.prefixKey(key), fields);
  }

  /**
   * Increment hash field by amount
   */
  public async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.client.hIncrBy(this.prefixKey(key), field, increment);
  }

  /**
   * Push value(s) to the left of a list
   */
  public async lpush(key: string, values: string | string[]): Promise<number> {
    const vals = Array.isArray(values) ? values : [values];
    return this.client.lPush(this.prefixKey(key), vals);
  }

  /**
   * Push value(s) to the right of a list
   */
  public async rpush(key: string, values: string | string[]): Promise<number> {
    const vals = Array.isArray(values) ? values : [values];
    return this.client.rPush(this.prefixKey(key), vals);
  }

  /**
   * Pop value from the left of a list
   */
  public async lpop(key: string): Promise<string | null> {
    return this.client.lPop(this.prefixKey(key));
  }

  /**
   * Pop value from the right of a list
   */
  public async rpop(key: string): Promise<string | null> {
    return this.client.rPop(this.prefixKey(key));
  }

  /**
   * Get list range
   */
  public async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lRange(this.prefixKey(key), start, stop);
  }

  /**
   * Get list length
   */
  public async llen(key: string): Promise<number> {
    return this.client.lLen(this.prefixKey(key));
  }

  /**
   * Add member(s) to a set
   */
  public async sadd(key: string, members: string | string[]): Promise<number> {
    const mems = Array.isArray(members) ? members : [members];
    return this.client.sAdd(this.prefixKey(key), mems);
  }

  /**
   * Remove member(s) from a set
   */
  public async srem(key: string, members: string | string[]): Promise<number> {
    const mems = Array.isArray(members) ? members : [members];
    return this.client.sRem(this.prefixKey(key), mems);
  }

  /**
   * Get all members of a set
   */
  public async smembers(key: string): Promise<string[]> {
    return this.client.sMembers(this.prefixKey(key));
  }

  /**
   * Check if member is in a set
   */
  public async sismember(key: string, member: string): Promise<boolean> {
    return this.client.sIsMember(this.prefixKey(key), member);
  }

  /**
   * Add member to sorted set with score
   */
  public async zadd(key: string, score: number, member: string): Promise<number> {
    return this.client.zAdd(this.prefixKey(key), { score, value: member });
  }

  /**
   * Get sorted set range by index
   */
  public async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.zRange(this.prefixKey(key), start, stop);
  }

  /**
   * Get sorted set range by score
   */
  public async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]> {
    return this.client.zRangeByScore(this.prefixKey(key), min, max);
  }

  /**
   * Remove member(s) from sorted set
   */
  public async zrem(key: string, members: string | string[]): Promise<number> {
    const mems = Array.isArray(members) ? members : [members];
    return this.client.zRem(this.prefixKey(key), mems);
  }

  /**
   * Remove sorted set members by score range
   */
  public async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<number> {
    return this.client.zRemRangeByScore(this.prefixKey(key), min, max);
  }

  /**
   * Get sorted set cardinality
   */
  public async zcard(key: string): Promise<number> {
    return this.client.zCard(this.prefixKey(key));
  }

  /**
   * Flush the current database
   */
  public async flushdb(): Promise<void> {
    await this.client.flushDb();
  }

  /**
   * Execute a Lua script
   */
  public async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const prefixedKeys = keys.map((k) => this.prefixKey(k));
    return this.client.eval(script, {
      keys: prefixedKeys,
      arguments: args,
    });
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let redisClientInstance: RedisClient | null = null;

export function getRedisClient(options?: RedisConnectionOptions): RedisClient {
  if (redisClientInstance === null) {
    if (options === undefined) {
      throw new Error('Redis client not initialized. Provide options on first call.');
    }
    redisClientInstance = new RedisClient(options);
  }
  return redisClientInstance;
}

export async function initializeRedis(options: RedisConnectionOptions): Promise<RedisClient> {
  const client = getRedisClient(options);
  await client.connect();
  return client;
}

export async function closeRedis(): Promise<void> {
  if (redisClientInstance !== null) {
    await redisClientInstance.disconnect();
    redisClientInstance = null;
  }
}

export function createRedisClient(options: RedisConnectionOptions): RedisClient {
  return new RedisClient(options);
}

export default RedisClient;
