/**
 * AEGIS - Token Bucket Rate Limiter
 * Redis-based distributed token bucket algorithm implementation
 */

import type { RedisClientWrapper } from '../../storage/redis.js';
import logger from '../../utils/logger.js';
import { TOKEN_BUCKET_SCRIPT, TOKEN_BUCKET_PEEK_SCRIPT, RESET_KEY_SCRIPT } from '../scripts.js';
import type {
  RateLimitRequest,
  RateLimitResult,
  RateLimiterInterface,
  TokenBucketConfig,
} from '../types.js';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: TokenBucketConfig = {
  maxTokens: 100,
  refillRate: 10, // tokens per second
  initialTokens: undefined, // defaults to maxTokens
};

const KEY_PREFIX = 'ratelimit:tb:';
const DEFAULT_TTL_SECONDS = 3600; // 1 hour

// =============================================================================
// Token Bucket Limiter Class
// =============================================================================

export class TokenBucketLimiter implements RateLimiterInterface {
  private redis: RedisClientWrapper;
  private config: TokenBucketConfig;
  private keyPrefix: string;

  constructor(
    redis: RedisClientWrapper,
    config: Partial<TokenBucketConfig> = {},
    keyPrefix: string = KEY_PREFIX
  ) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.keyPrefix = keyPrefix;
  }

  /**
   * Get the algorithm name
   */
  public getAlgorithm(): 'token-bucket' {
    return 'token-bucket';
  }

  /**
   * Build the Redis key for a rate limit identifier
   */
  private buildKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Calculate refill rate from requests per window
   */
  private calculateRefillRate(limit: number, windowSeconds: number): number {
    return limit / windowSeconds;
  }

  /**
   * Check if a request is allowed and consume a token if so
   */
  public async check(request: RateLimitRequest): Promise<RateLimitResult> {
    const { key, limit, windowSeconds, cost = 1 } = request;
    const redisKey = this.buildKey(key);

    const maxTokens = limit;
    const refillRate = this.calculateRefillRate(limit, windowSeconds);
    const now = Date.now();
    const ttl = Math.max(windowSeconds * 2, DEFAULT_TTL_SECONDS);

    try {
      const result = (await this.redis.eval(
        TOKEN_BUCKET_SCRIPT,
        [redisKey],
        [
          maxTokens.toString(),
          refillRate.toString(),
          now.toString(),
          cost.toString(),
          ttl.toString(),
        ]
      )) as [number, number, number];

      const [allowed, tokens, resetAtMs] = result;
      const resetAtSeconds = Math.ceil(resetAtMs / 1000);
      const nowSeconds = Math.floor(now / 1000);

      return {
        allowed: allowed === 1,
        remaining: Math.max(0, Math.floor(tokens)),
        limit: maxTokens,
        resetAt: resetAtSeconds,
        retryAfter: allowed === 1 ? 0 : Math.max(0, resetAtSeconds - nowSeconds),
        tokens,
      };
    } catch (error) {
      logger.error('Token bucket check failed', {
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
        tokens: limit,
      };
    }
  }

  /**
   * Peek at current token count without consuming
   */
  public async peek(key: string): Promise<RateLimitResult | null> {
    const redisKey = this.buildKey(key);

    try {
      // Check if key exists
      const exists = await this.redis.exists(redisKey);
      if (exists === 0) {
        return null;
      }

      const now = Date.now();
      const result = (await this.redis.eval(
        TOKEN_BUCKET_PEEK_SCRIPT,
        [redisKey],
        [this.config.maxTokens.toString(), this.config.refillRate.toString(), now.toString()]
      )) as [number, number];

      const [tokens, resetAtMs] = result;
      const resetAtSeconds = Math.ceil(resetAtMs / 1000);
      const nowSeconds = Math.floor(now / 1000);

      return {
        allowed: tokens >= 1,
        remaining: Math.max(0, Math.floor(tokens)),
        limit: this.config.maxTokens,
        resetAt: resetAtSeconds,
        retryAfter: tokens >= 1 ? 0 : Math.max(0, resetAtSeconds - nowSeconds),
        tokens,
      };
    } catch (error) {
      logger.error('Token bucket peek failed', {
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
      logger.debug('Token bucket reset', { key });
    } catch (error) {
      logger.error('Token bucket reset failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check multiple keys in a single operation
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
   * Get current bucket state for debugging
   */
  public async getBucketState(key: string): Promise<{ tokens: number; lastRefill: number } | null> {
    const redisKey = this.buildKey(key);

    try {
      const data = await this.redis.hgetall(redisKey);
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return {
        tokens: parseFloat(data.tokens || '0'),
        lastRefill: parseInt(data.last_refill || '0', 10),
      };
    } catch (error) {
      logger.error('Failed to get bucket state', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Manually set bucket state (for testing or admin purposes)
   */
  public async setBucketState(
    key: string,
    tokens: number,
    ttlSeconds: number = DEFAULT_TTL_SECONDS
  ): Promise<void> {
    const redisKey = this.buildKey(key);

    try {
      await this.redis.hset(redisKey, 'tokens', tokens.toString());
      await this.redis.hset(redisKey, 'last_refill', Date.now().toString());
      await this.redis.expire(redisKey, ttlSeconds);
      logger.debug('Token bucket state set', { key, tokens });
    } catch (error) {
      logger.error('Failed to set bucket state', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createTokenBucketLimiter(
  redis: RedisClientWrapper,
  config?: Partial<TokenBucketConfig>,
  keyPrefix?: string
): TokenBucketLimiter {
  return new TokenBucketLimiter(redis, config, keyPrefix);
}

export default TokenBucketLimiter;
