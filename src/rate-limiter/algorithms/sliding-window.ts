/**
 * AEGIS - Sliding Window Rate Limiter
 * Redis-based distributed sliding window algorithm implementation
 *
 * Implements two variants:
 * 1. Sliding Window Log - Uses sorted sets for precise tracking
 * 2. Sliding Window Counter - Uses counters with interpolation for efficiency
 */

import type { RedisClientWrapper } from '../../storage/redis.js';
import logger from '../../utils/logger.js';
import {
  SLIDING_WINDOW_LOG_SCRIPT,
  SLIDING_WINDOW_COUNTER_SCRIPT,
  SLIDING_WINDOW_PEEK_SCRIPT,
  RESET_KEY_SCRIPT,
} from '../scripts.js';
import type {
  RateLimitRequest,
  RateLimitResult,
  RateLimiterInterface,
  SlidingWindowConfig,
} from '../types.js';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: SlidingWindowConfig = {
  windowSeconds: 60,
  maxRequests: 100,
  precision: 1, // milliseconds precision
};

const KEY_PREFIX_LOG = 'ratelimit:sw:log:';
const KEY_PREFIX_COUNTER = 'ratelimit:sw:cnt:';

// =============================================================================
// Sliding Window Variant Types
// =============================================================================

export type SlidingWindowVariant = 'log' | 'counter';

export interface SlidingWindowLimiterOptions {
  /** Which sliding window implementation to use */
  variant: SlidingWindowVariant;
  /** Configuration options */
  config?: Partial<SlidingWindowConfig>;
  /** Custom key prefix */
  keyPrefix?: string;
}

// =============================================================================
// Sliding Window Log Limiter
// =============================================================================

/**
 * Sliding Window Log implementation using Redis sorted sets.
 *
 * Pros:
 * - Most accurate rate limiting
 * - Per-request tracking
 * - No boundary issues
 *
 * Cons:
 * - Higher memory usage
 * - Slower for high-volume endpoints
 */
export class SlidingWindowLogLimiter implements RateLimiterInterface {
  private redis: RedisClientWrapper;
  private config: SlidingWindowConfig;
  private keyPrefix: string;

  constructor(
    redis: RedisClientWrapper,
    config: Partial<SlidingWindowConfig> = {},
    keyPrefix: string = KEY_PREFIX_LOG
  ) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.keyPrefix = keyPrefix;
  }

  /**
   * Get the algorithm name
   */
  public getAlgorithm(): 'sliding-window' {
    return 'sliding-window';
  }

  /**
   * Build the Redis key for a rate limit identifier
   */
  private buildKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Check if a request is allowed and record it if so
   */
  public async check(request: RateLimitRequest): Promise<RateLimitResult> {
    const { key, limit, windowSeconds, cost = 1 } = request;
    const redisKey = this.buildKey(key);
    const requestId = this.generateRequestId();

    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    try {
      const result = (await this.redis.eval(
        SLIDING_WINDOW_LOG_SCRIPT,
        [redisKey],
        [
          limit.toString(),
          windowMs.toString(),
          now.toString(),
          requestId,
          cost.toString(),
        ]
      )) as [number, number, number];

      const [allowed, currentCount, resetAtMs] = result;
      const resetAtSeconds = Math.ceil(resetAtMs / 1000);
      const nowSeconds = Math.floor(now / 1000);

      return {
        allowed: allowed === 1,
        remaining: Math.max(0, limit - currentCount),
        limit,
        resetAt: resetAtSeconds,
        retryAfter: allowed === 1 ? 0 : Math.max(0, resetAtSeconds - nowSeconds),
      };
    } catch (error) {
      logger.error('Sliding window log check failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fail open - allow request if Redis is unavailable
      return {
        allowed: true,
        remaining: limit,
        limit,
        resetAt: Math.floor(now / 1000) + windowSeconds,
        retryAfter: 0,
      };
    }
  }

  /**
   * Peek at current count without recording a request
   */
  public async peek(key: string): Promise<RateLimitResult | null> {
    const redisKey = this.buildKey(key);
    const now = Date.now();
    const windowMs = this.config.windowSeconds * 1000;

    try {
      // Check if key exists
      const exists = await this.redis.exists(redisKey);
      if (exists === 0) {
        return null;
      }

      const result = (await this.redis.eval(
        SLIDING_WINDOW_PEEK_SCRIPT,
        [redisKey],
        [windowMs.toString(), now.toString()]
      )) as [number, number];

      const [currentCount, resetAtMs] = result;
      const resetAtSeconds = Math.ceil(resetAtMs / 1000);
      const nowSeconds = Math.floor(now / 1000);
      const remaining = Math.max(0, this.config.maxRequests - currentCount);

      return {
        allowed: remaining > 0,
        remaining,
        limit: this.config.maxRequests,
        resetAt: resetAtSeconds,
        retryAfter: remaining > 0 ? 0 : Math.max(0, resetAtSeconds - nowSeconds),
      };
    } catch (error) {
      logger.error('Sliding window log peek failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Reset the rate limit for a key
   */
  public async reset(key: string): Promise<void> {
    const redisKey = this.buildKey(key);

    try {
      await this.redis.eval(RESET_KEY_SCRIPT, [redisKey], []);
      logger.debug('Sliding window log reset', { key });
    } catch (error) {
      logger.error('Sliding window log reset failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get all request timestamps in the current window (for debugging)
   */
  public async getWindowEntries(key: string): Promise<{ timestamp: number; member: string }[]> {
    const redisKey = this.buildKey(key);
    const now = Date.now();
    const windowStart = now - this.config.windowSeconds * 1000;

    try {
      // Use zrangebyscore to get entries in the window
      const members = await this.redis.zrangebyscore(redisKey, windowStart, now);

      // Get scores for each member
      const entries: { timestamp: number; member: string }[] = [];
      for (const member of members) {
        entries.push({
          timestamp: parseInt(member.split(':').pop() || '0', 10),
          member,
        });
      }

      return entries;
    } catch (error) {
      logger.error('Failed to get window entries', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

// =============================================================================
// Sliding Window Counter Limiter
// =============================================================================

/**
 * Sliding Window Counter implementation using weighted counters.
 *
 * Uses two fixed windows and interpolates based on the current
 * position within the window for smoother rate limiting.
 *
 * Pros:
 * - Much lower memory usage
 * - Faster operations
 * - Good accuracy
 *
 * Cons:
 * - Slightly less accurate than log-based approach
 * - Cannot track individual requests
 */
export class SlidingWindowCounterLimiter implements RateLimiterInterface {
  private redis: RedisClientWrapper;
  private config: SlidingWindowConfig;
  private keyPrefix: string;

  constructor(
    redis: RedisClientWrapper,
    config: Partial<SlidingWindowConfig> = {},
    keyPrefix: string = KEY_PREFIX_COUNTER
  ) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.keyPrefix = keyPrefix;
  }

  /**
   * Get the algorithm name
   */
  public getAlgorithm(): 'sliding-window' {
    return 'sliding-window';
  }

  /**
   * Build Redis keys for current and previous windows
   */
  private buildKeys(key: string, windowSeconds: number): { prevKey: string; currKey: string } {
    const now = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(now / windowSeconds) * windowSeconds;
    const previousWindow = currentWindow - windowSeconds;

    return {
      prevKey: `${this.keyPrefix}${key}:${previousWindow}`,
      currKey: `${this.keyPrefix}${key}:${currentWindow}`,
    };
  }

  /**
   * Check if a request is allowed and record it if so
   */
  public async check(request: RateLimitRequest): Promise<RateLimitResult> {
    const { key, limit, windowSeconds, cost = 1 } = request;
    const { prevKey, currKey } = this.buildKeys(key, windowSeconds);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(nowSeconds / windowSeconds) * windowSeconds;

    try {
      const result = (await this.redis.eval(
        SLIDING_WINDOW_COUNTER_SCRIPT,
        [prevKey, currKey],
        [
          limit.toString(),
          windowSeconds.toString(),
          nowSeconds.toString(),
          cost.toString(),
        ]
      )) as [number, number, number];

      const [allowed, weightedCount, resetAtSeconds] = result;

      return {
        allowed: allowed === 1,
        remaining: Math.max(0, Math.floor(limit - weightedCount)),
        limit,
        resetAt: resetAtSeconds,
        retryAfter: allowed === 1 ? 0 : Math.max(0, resetAtSeconds - nowSeconds),
      };
    } catch (error) {
      logger.error('Sliding window counter check failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fail open - allow request if Redis is unavailable
      return {
        allowed: true,
        remaining: limit,
        limit,
        resetAt: currentWindow + windowSeconds,
        retryAfter: 0,
      };
    }
  }

  /**
   * Peek at current weighted count without recording
   */
  public async peek(key: string): Promise<RateLimitResult | null> {
    const windowSeconds = this.config.windowSeconds;
    const { prevKey, currKey } = this.buildKeys(key, windowSeconds);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const windowProgress = (nowSeconds - currentWindow) / windowSeconds;

    try {
      const [prevCountStr, currCountStr] = await this.redis.mget([prevKey, currKey]);
      const prevCount = prevCountStr ? parseInt(prevCountStr, 10) : 0;
      const currCount = currCountStr ? parseInt(currCountStr, 10) : 0;

      if (prevCount === 0 && currCount === 0) {
        return null;
      }

      // Calculate weighted count
      const weightedCount = prevCount * (1 - windowProgress) + currCount;
      const remaining = Math.max(0, Math.floor(this.config.maxRequests - weightedCount));
      const resetAt = currentWindow + windowSeconds;

      return {
        allowed: remaining > 0,
        remaining,
        limit: this.config.maxRequests,
        resetAt,
        retryAfter: remaining > 0 ? 0 : Math.max(0, resetAt - nowSeconds),
      };
    } catch (error) {
      logger.error('Sliding window counter peek failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Reset the rate limit for a key
   */
  public async reset(key: string): Promise<void> {
    const windowSeconds = this.config.windowSeconds;
    const { prevKey, currKey } = this.buildKeys(key, windowSeconds);

    try {
      await this.redis.del([prevKey, currKey]);
      logger.debug('Sliding window counter reset', { key });
    } catch (error) {
      logger.error('Sliding window counter reset failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get current window counts for debugging
   */
  public async getWindowCounts(
    key: string
  ): Promise<{ previousCount: number; currentCount: number; weightedCount: number } | null> {
    const windowSeconds = this.config.windowSeconds;
    const { prevKey, currKey } = this.buildKeys(key, windowSeconds);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const windowProgress = (nowSeconds - currentWindow) / windowSeconds;

    try {
      const [prevCountStr, currCountStr] = await this.redis.mget([prevKey, currKey]);
      const prevCount = prevCountStr ? parseInt(prevCountStr, 10) : 0;
      const currCount = currCountStr ? parseInt(currCountStr, 10) : 0;

      return {
        previousCount: prevCount,
        currentCount: currCount,
        weightedCount: prevCount * (1 - windowProgress) + currCount,
      };
    } catch (error) {
      logger.error('Failed to get window counts', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a sliding window limiter with specified variant
 */
export function createSlidingWindowLimiter(
  redis: RedisClientWrapper,
  options: SlidingWindowLimiterOptions = { variant: 'counter' }
): SlidingWindowLogLimiter | SlidingWindowCounterLimiter {
  const { variant, config, keyPrefix } = options;

  if (variant === 'log') {
    return new SlidingWindowLogLimiter(redis, config, keyPrefix ?? KEY_PREFIX_LOG);
  }

  return new SlidingWindowCounterLimiter(redis, config, keyPrefix ?? KEY_PREFIX_COUNTER);
}

/**
 * Create a sliding window log limiter
 */
export function createSlidingWindowLogLimiter(
  redis: RedisClientWrapper,
  config?: Partial<SlidingWindowConfig>,
  keyPrefix?: string
): SlidingWindowLogLimiter {
  return new SlidingWindowLogLimiter(redis, config, keyPrefix);
}

/**
 * Create a sliding window counter limiter
 */
export function createSlidingWindowCounterLimiter(
  redis: RedisClientWrapper,
  config?: Partial<SlidingWindowConfig>,
  keyPrefix?: string
): SlidingWindowCounterLimiter {
  return new SlidingWindowCounterLimiter(redis, config, keyPrefix);
}

export default {
  SlidingWindowLogLimiter,
  SlidingWindowCounterLimiter,
  createSlidingWindowLimiter,
};
