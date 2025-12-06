/**
 * AEGIS - Fixed Window Rate Limiter
 * Redis-based distributed fixed window algorithm implementation
 *
 * The simplest rate limiting algorithm using discrete time windows.
 * Counter resets at fixed intervals.
 */

import type { RedisClientWrapper } from '../../storage/redis.js';
import logger from '../../utils/logger.js';
import { FIXED_WINDOW_SCRIPT, FIXED_WINDOW_PEEK_SCRIPT, RESET_KEY_SCRIPT } from '../scripts.js';
import type {
  RateLimitRequest,
  RateLimitResult,
  RateLimiterInterface,
  FixedWindowConfig,
} from '../types.js';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: FixedWindowConfig = {
  windowSeconds: 60,
  maxRequests: 100,
};

const KEY_PREFIX = 'ratelimit:fw:';

// =============================================================================
// Fixed Window Limiter Class
// =============================================================================

/**
 * Fixed Window Rate Limiter
 *
 * Uses discrete time windows for counting requests.
 * Counter resets when a new window starts.
 *
 * Pros:
 * - Very simple and efficient
 * - Lowest memory usage
 * - Predictable behavior
 *
 * Cons:
 * - Can allow up to 2x limit at window boundaries
 * - Less accurate than sliding window approaches
 *
 * Best for:
 * - High-volume endpoints where slight inaccuracy is acceptable
 * - Scenarios where predictable reset times are desired
 */
export class FixedWindowLimiter implements RateLimiterInterface {
  private redis: RedisClientWrapper;
  private config: FixedWindowConfig;
  private keyPrefix: string;

  constructor(
    redis: RedisClientWrapper,
    config: Partial<FixedWindowConfig> = {},
    keyPrefix: string = KEY_PREFIX
  ) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.keyPrefix = keyPrefix;
  }

  /**
   * Get the algorithm name
   */
  public getAlgorithm(): 'fixed-window' {
    return 'fixed-window';
  }

  /**
   * Build the Redis key for a rate limit identifier
   * Key includes the window timestamp for automatic expiration alignment
   */
  private buildKey(key: string, windowSeconds: number): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    return `${this.keyPrefix}${key}:${windowStart}`;
  }

  /**
   * Check if a request is allowed and increment counter if so
   */
  public async check(request: RateLimitRequest): Promise<RateLimitResult> {
    const { key, limit, windowSeconds, cost = 1 } = request;
    const redisKey = this.buildKey(key, windowSeconds);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const windowEnd = windowStart + windowSeconds;

    try {
      const result = (await this.redis.eval(
        FIXED_WINDOW_SCRIPT,
        [redisKey],
        [limit.toString(), windowSeconds.toString(), cost.toString()]
      )) as [number, number, number];

      const [allowed, currentCount, ttl] = result;
      const resetAt = nowSeconds + ttl;

      return {
        allowed: allowed === 1,
        remaining: Math.max(0, limit - currentCount),
        limit,
        resetAt,
        retryAfter: allowed === 1 ? 0 : ttl,
      };
    } catch (error) {
      logger.error('Fixed window check failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fail open - allow request if Redis is unavailable
      return {
        allowed: true,
        remaining: limit,
        limit,
        resetAt: windowEnd,
        retryAfter: 0,
      };
    }
  }

  /**
   * Peek at current count without incrementing
   */
  public async peek(key: string): Promise<RateLimitResult | null> {
    const windowSeconds = this.config.windowSeconds;
    const redisKey = this.buildKey(key, windowSeconds);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const windowEnd = windowStart + windowSeconds;

    try {
      const result = (await this.redis.eval(FIXED_WINDOW_PEEK_SCRIPT, [redisKey], [])) as [
        number,
        number,
      ];

      const [currentCount, ttl] = result;

      // If no data exists, return null
      if (currentCount === 0 && ttl <= 0) {
        return null;
      }

      const remaining = Math.max(0, this.config.maxRequests - currentCount);
      const resetAt = ttl > 0 ? nowSeconds + ttl : windowEnd;

      return {
        allowed: remaining > 0,
        remaining,
        limit: this.config.maxRequests,
        resetAt,
        retryAfter: remaining > 0 ? 0 : Math.max(0, resetAt - nowSeconds),
      };
    } catch (error) {
      logger.error('Fixed window peek failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Reset the rate limit for a key
   * This resets the current window counter
   */
  public async reset(key: string): Promise<void> {
    const windowSeconds = this.config.windowSeconds;
    const redisKey = this.buildKey(key, windowSeconds);

    try {
      await this.redis.eval(RESET_KEY_SCRIPT, [redisKey], []);
      logger.debug('Fixed window reset', { key });
    } catch (error) {
      logger.error('Fixed window reset failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Reset all windows for a key pattern
   * Useful for clearing all rate limit data for a user/IP
   */
  public async resetAll(keyPattern: string): Promise<number> {
    const pattern = `${this.keyPrefix}${keyPattern}:*`;

    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length === 0) {
        return 0;
      }

      const deleted = await this.redis.del(keys);
      logger.debug('Fixed window reset all', { pattern, deleted });
      return deleted;
    } catch (error) {
      logger.error('Fixed window reset all failed', {
        keyPattern,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get current window information for debugging
   */
  public async getWindowInfo(
    key: string
  ): Promise<{ count: number; windowStart: number; windowEnd: number; ttl: number } | null> {
    const windowSeconds = this.config.windowSeconds;
    const redisKey = this.buildKey(key, windowSeconds);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const windowEnd = windowStart + windowSeconds;

    try {
      const countStr = await this.redis.get(redisKey.replace(this.keyPrefix, ''));
      const ttl = await this.redis.ttl(redisKey.replace(this.keyPrefix, ''));

      if (countStr === null) {
        return null;
      }

      return {
        count: parseInt(countStr, 10),
        windowStart,
        windowEnd,
        ttl: ttl > 0 ? ttl : 0,
      };
    } catch (error) {
      logger.error('Failed to get window info', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Manually set the counter for a key (for testing or admin purposes)
   */
  public async setCounter(key: string, count: number, windowSeconds?: number): Promise<void> {
    const ws = windowSeconds ?? this.config.windowSeconds;
    const redisKey = this.buildKey(key, ws);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSeconds / ws) * ws;
    const ttl = windowStart + ws - nowSeconds;

    try {
      // Remove the aegis: prefix that redis client adds automatically
      const cleanKey = redisKey.replace(this.keyPrefix, '');
      await this.redis.set(cleanKey, count.toString(), ttl > 0 ? ttl : ws);
      logger.debug('Fixed window counter set', { key, count, ttl });
    } catch (error) {
      logger.error('Failed to set counter', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check multiple keys in parallel
   */
  public async checkMultiple(requests: RateLimitRequest[]): Promise<Map<string, RateLimitResult>> {
    const results = new Map<string, RateLimitResult>();

    // Process in parallel for better performance
    const promises = requests.map(async (request) => {
      const result = await this.check(request);
      return { key: request.key, result };
    });

    const settledResults = await Promise.all(promises);
    for (const { key, result } of settledResults) {
      results.set(key, result);
    }

    return results;
  }

  /**
   * Get the time until the next window starts
   */
  public getTimeToNextWindow(windowSeconds?: number): number {
    const ws = windowSeconds ?? this.config.windowSeconds;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSeconds / ws) * ws;
    return windowStart + ws - nowSeconds;
  }

  /**
   * Get current window boundaries
   */
  public getCurrentWindowBoundaries(windowSeconds?: number): {
    start: number;
    end: number;
    progress: number;
  } {
    const ws = windowSeconds ?? this.config.windowSeconds;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSeconds / ws) * ws;
    const windowEnd = windowStart + ws;
    const progress = (nowSeconds - windowStart) / ws;

    return {
      start: windowStart,
      end: windowEnd,
      progress,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createFixedWindowLimiter(
  redis: RedisClientWrapper,
  config?: Partial<FixedWindowConfig>,
  keyPrefix?: string
): FixedWindowLimiter {
  return new FixedWindowLimiter(redis, config, keyPrefix);
}

export default FixedWindowLimiter;
