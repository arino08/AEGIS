/**
 * AEGIS - Main Rate Limiter Service
 * Orchestrates rate limiting algorithms, rules, and bypass checking
 */

import type { RedisClientWrapper } from '../storage/redis.js';
import logger from '../utils/logger.js';

import type { TokenBucketLimiter } from './algorithms/token-bucket.js';
import { createTokenBucketLimiter } from './algorithms/token-bucket.js';
import type {
  SlidingWindowLogLimiter,
  SlidingWindowCounterLimiter,
} from './algorithms/sliding-window.js';
import { createSlidingWindowLimiter } from './algorithms/sliding-window.js';
import type { FixedWindowLimiter } from './algorithms/fixed-window.js';
import { createFixedWindowLimiter } from './algorithms/fixed-window.js';
import { RuleMatcher, generateRateLimitKey, determineTier } from './rules/matcher.js';
import { BypassChecker, type BypassResult } from './rules/bypass.js';
import type {
  RateLimitAlgorithm,
  RateLimitResult,
  RateLimitContext,
  RateLimitRule,
  RateLimiterConfig,
  RateLimiterInterface,
  RateLimitHeaders,
  RateLimitErrorBody,
  RateLimiterMetrics,
  TierLimits,
  MatchedRule,
  RateLimitTier,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TIER_LIMITS: TierLimits = {
  anonymous: { requests: 60, windowSeconds: 60 },
  free: { requests: 100, windowSeconds: 60 },
  basic: { requests: 500, windowSeconds: 60 },
  pro: { requests: 2000, windowSeconds: 60 },
  enterprise: { requests: 10000, windowSeconds: 60 },
  unlimited: { requests: 1000000, windowSeconds: 60 },
};

const DEFAULT_ALGORITHM_CONFIG = {
  tokenBucket: {
    maxTokens: 100,
    refillRate: 10,
  },
  slidingWindow: {
    windowSeconds: 60,
    maxRequests: 100,
  },
  fixedWindow: {
    windowSeconds: 60,
    maxRequests: 100,
  },
};

const DEFAULT_CONFIG: RateLimiterConfig = {
  enabled: true,
  defaultAlgorithm: 'token-bucket',
  defaultRequests: 100,
  defaultWindowSeconds: 60,
  keyStrategy: 'composite',
  keyPrefix: 'ratelimit:',
  bypass: {
    ips: [],
    userIds: [],
    apiKeys: [],
    paths: ['/health', '/healthz', '/ready', '/metrics'],
    internal: true,
  },
  tierLimits: DEFAULT_TIER_LIMITS,
  rules: [],
  algorithmConfig: DEFAULT_ALGORITHM_CONFIG,
  includeHeaders: true,
  errorMessage: 'Rate limit exceeded. Please try again later.',
};

// =============================================================================
// Rate Limiter Service Class
// =============================================================================

export class RateLimiter {
  private config: RateLimiterConfig;

  // Algorithm implementations
  private tokenBucketLimiter: TokenBucketLimiter;
  private slidingWindowLogLimiter: SlidingWindowLogLimiter;
  private slidingWindowCounterLimiter: SlidingWindowCounterLimiter;
  private fixedWindowLimiter: FixedWindowLimiter;

  // Rule matching and bypass
  private ruleMatcher: RuleMatcher;
  private bypassChecker: BypassChecker;

  // Tier mapping (can be loaded from DB)
  private tierMapping = new Map<string, RateLimitTier>();

  // Metrics
  private metrics: RateLimiterMetrics = {
    totalChecks: 0,
    allowed: 0,
    denied: 0,
    bypassed: 0,
    avgLatencyMs: 0,
    byAlgorithm: {
      'token-bucket': { allowed: 0, denied: 0 },
      'sliding-window': { allowed: 0, denied: 0 },
      'fixed-window': { allowed: 0, denied: 0 },
    },
    byTier: {
      anonymous: { allowed: 0, denied: 0 },
      free: { allowed: 0, denied: 0 },
      basic: { allowed: 0, denied: 0 },
      pro: { allowed: 0, denied: 0 },
      enterprise: { allowed: 0, denied: 0 },
      unlimited: { allowed: 0, denied: 0 },
    },
  };
  private totalLatencyMs = 0;

  constructor(redis: RedisClientWrapper, config: Partial<RateLimiterConfig> = {}) {
    // Deep merge config to ensure nested objects like algorithmConfig are properly merged
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      bypass: {
        ...DEFAULT_CONFIG.bypass,
        ...(config.bypass || {}),
      },
      tierLimits: {
        ...DEFAULT_CONFIG.tierLimits,
        ...(config.tierLimits || {}),
      },
      algorithmConfig: {
        tokenBucket: {
          ...DEFAULT_ALGORITHM_CONFIG.tokenBucket,
          ...(config.algorithmConfig?.tokenBucket || {}),
        },
        slidingWindow: {
          ...DEFAULT_ALGORITHM_CONFIG.slidingWindow,
          ...(config.algorithmConfig?.slidingWindow || {}),
        },
        fixedWindow: {
          ...DEFAULT_ALGORITHM_CONFIG.fixedWindow,
          ...(config.algorithmConfig?.fixedWindow || {}),
        },
      },
    };

    // Initialize algorithm implementations
    this.tokenBucketLimiter = createTokenBucketLimiter(
      redis,
      this.config.algorithmConfig.tokenBucket,
      `${this.config.keyPrefix}tb:`
    );

    this.slidingWindowLogLimiter = createSlidingWindowLimiter(redis, {
      variant: 'log',
      config: this.config.algorithmConfig.slidingWindow,
      keyPrefix: `${this.config.keyPrefix}swl:`,
    }) as SlidingWindowLogLimiter;

    this.slidingWindowCounterLimiter = createSlidingWindowLimiter(redis, {
      variant: 'counter',
      config: this.config.algorithmConfig.slidingWindow,
      keyPrefix: `${this.config.keyPrefix}swc:`,
    }) as SlidingWindowCounterLimiter;

    this.fixedWindowLimiter = createFixedWindowLimiter(
      redis,
      this.config.algorithmConfig.fixedWindow,
      `${this.config.keyPrefix}fw:`
    );

    // Initialize rule matcher and bypass checker
    this.ruleMatcher = new RuleMatcher(this.config.rules);
    this.bypassChecker = new BypassChecker(this.config.bypass);

    logger.info('Rate limiter initialized', {
      enabled: this.config.enabled,
      defaultAlgorithm: this.config.defaultAlgorithm,
      rulesCount: this.config.rules.length,
    });
  }

  // ===========================================================================
  // Configuration Management
  // ===========================================================================

  /**
   * Update rate limiter configuration
   */
  public setConfig(config: Partial<RateLimiterConfig>): void {
    this.config = { ...this.config, ...config };

    if (config.rules) {
      this.ruleMatcher.setRules(config.rules);
    }

    if (config.bypass) {
      this.bypassChecker.setConfig(config.bypass);
    }

    logger.info('Rate limiter configuration updated');
  }

  /**
   * Get current configuration
   */
  public getConfig(): RateLimiterConfig {
    return { ...this.config };
  }

  /**
   * Check if rate limiting is enabled
   */
  public isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable or disable rate limiting
   */
  public setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info(`Rate limiting ${enabled ? 'enabled' : 'disabled'}`);
  }

  // ===========================================================================
  // Rule Management
  // ===========================================================================

  /**
   * Add a rate limit rule
   */
  public addRule(rule: RateLimitRule): void {
    this.ruleMatcher.addRule(rule);
    this.config.rules = this.ruleMatcher.getRules();
    logger.debug('Rate limit rule added', { ruleId: rule.id, ruleName: rule.name });
  }

  /**
   * Remove a rate limit rule
   */
  public removeRule(ruleId: string): boolean {
    const removed = this.ruleMatcher.removeRule(ruleId);
    if (removed) {
      this.config.rules = this.ruleMatcher.getRules();
      logger.debug('Rate limit rule removed', { ruleId });
    }
    return removed;
  }

  /**
   * Get all rules
   */
  public getRules(): RateLimitRule[] {
    return this.ruleMatcher.getRules();
  }

  // ===========================================================================
  // Tier Management
  // ===========================================================================

  /**
   * Set tier for a user or API key
   */
  public setTier(identifier: string, tier: RateLimitTier): void {
    this.tierMapping.set(identifier, tier);
    logger.debug('Tier mapping set', { identifier: identifier.slice(0, 20), tier });
  }

  /**
   * Get tier for a user or API key
   */
  public getTier(identifier: string): RateLimitTier | undefined {
    return this.tierMapping.get(identifier);
  }

  /**
   * Remove tier mapping
   */
  public removeTier(identifier: string): boolean {
    return this.tierMapping.delete(identifier);
  }

  /**
   * Set tier limits
   */
  public setTierLimits(tierLimits: Partial<TierLimits>): void {
    this.config.tierLimits = { ...this.config.tierLimits, ...tierLimits };
  }

  // ===========================================================================
  // Core Rate Limiting
  // ===========================================================================

  /**
   * Check if a request is allowed
   * Main entry point for rate limiting
   */
  public async check(context: RateLimitContext): Promise<RateLimitCheckResult> {
    const startTime = Date.now();

    try {
      // Check if rate limiting is enabled
      if (!this.config.enabled) {
        return this.createAllowedResult(context);
      }

      // Check for bypass
      const bypassResult = this.bypassChecker.shouldBypass(context);
      if (bypassResult.bypass) {
        this.metrics.bypassed++;
        return this.createBypassResult(context, bypassResult);
      }

      // Determine tier
      const tier = this.resolveTier(context);
      const contextWithTier = { ...context, tier };

      // Find matching rule
      const matchedRule = this.ruleMatcher.getBestMatch(contextWithTier);

      // Get rate limit parameters
      const { limit, windowSeconds, algorithm } = this.getRateLimitParams(
        contextWithTier,
        matchedRule
      );

      // Generate rate limit key
      const key = generateRateLimitKey(contextWithTier, matchedRule?.rule, this.config.keyStrategy);

      // Perform rate limit check
      const limiter = this.getLimiter(algorithm);
      const result = await limiter.check({
        key,
        limit,
        windowSeconds,
        cost: 1,
      });

      // Update metrics
      this.updateMetrics(algorithm, tier, result.allowed, Date.now() - startTime);

      return {
        ...result,
        context: contextWithTier,
        matchedRule: matchedRule ?? undefined,
        algorithm,
        key,
        bypassed: false,
      };
    } catch (error) {
      logger.error('Rate limit check failed', {
        error: error instanceof Error ? error.message : String(error),
        ip: context.ip,
        path: context.path,
      });

      // Fail open - allow request if rate limiting fails
      return this.createAllowedResult(context);
    }
  }

  /**
   * Peek at rate limit status without consuming quota
   */
  public async peek(
    context: RateLimitContext,
    algorithm?: RateLimitAlgorithm
  ): Promise<RateLimitResult | null> {
    const tier = this.resolveTier(context);
    const contextWithTier = { ...context, tier };
    const matchedRule = this.ruleMatcher.getBestMatch(contextWithTier);

    const key = generateRateLimitKey(contextWithTier, matchedRule?.rule, this.config.keyStrategy);

    const alg = algorithm ?? matchedRule?.rule.rateLimit.algorithm ?? this.config.defaultAlgorithm;
    const limiter = this.getLimiter(alg);

    return limiter.peek(key);
  }

  /**
   * Reset rate limit for a specific key
   */
  public async reset(key: string, algorithm?: RateLimitAlgorithm): Promise<void> {
    const alg = algorithm ?? this.config.defaultAlgorithm;
    const limiter = this.getLimiter(alg);
    await limiter.reset(key);
    logger.debug('Rate limit reset', { key, algorithm: alg });
  }

  /**
   * Reset rate limit for a context (all algorithms)
   */
  public async resetForContext(context: RateLimitContext): Promise<void> {
    const tier = this.resolveTier(context);
    const contextWithTier = { ...context, tier };
    const key = generateRateLimitKey(contextWithTier, undefined, this.config.keyStrategy);

    // Reset across all algorithms
    await Promise.all([
      this.tokenBucketLimiter.reset(key),
      this.slidingWindowLogLimiter.reset(key),
      this.slidingWindowCounterLimiter.reset(key),
      this.fixedWindowLimiter.reset(key),
    ]);

    logger.debug('Rate limit reset for context', { key });
  }

  // ===========================================================================
  // Response Helpers
  // ===========================================================================

  /**
   * Generate rate limit headers
   */
  public generateHeaders(result: RateLimitResult): RateLimitHeaders {
    const headers: RateLimitHeaders = {
      'X-RateLimit-Limit': result.limit.toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': result.resetAt.toString(),
    };

    if (!result.allowed) {
      headers['Retry-After'] = result.retryAfter.toString();
    }

    return headers;
  }

  /**
   * Generate error response body for 429 responses
   */
  public generateErrorBody(result: RateLimitResult): RateLimitErrorBody {
    return {
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
      message: this.config.errorMessage ?? 'Rate limit exceeded. Please try again later.',
      limit: result.limit,
      remaining: result.remaining,
      windowSeconds: Math.ceil(result.resetAt - Math.floor(Date.now() / 1000)),
      retryAfter: result.retryAfter,
      resetAt: new Date(result.resetAt * 1000).toISOString(),
    };
  }

  /**
   * Check if headers should be included in responses
   */
  public shouldIncludeHeaders(): boolean {
    return this.config.includeHeaders;
  }

  // ===========================================================================
  // Metrics
  // ===========================================================================

  /**
   * Get rate limiter metrics
   */
  public getMetrics(): RateLimiterMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.metrics = {
      totalChecks: 0,
      allowed: 0,
      denied: 0,
      bypassed: 0,
      avgLatencyMs: 0,
      byAlgorithm: {
        'token-bucket': { allowed: 0, denied: 0 },
        'sliding-window': { allowed: 0, denied: 0 },
        'fixed-window': { allowed: 0, denied: 0 },
      },
      byTier: {
        anonymous: { allowed: 0, denied: 0 },
        free: { allowed: 0, denied: 0 },
        basic: { allowed: 0, denied: 0 },
        pro: { allowed: 0, denied: 0 },
        enterprise: { allowed: 0, denied: 0 },
        unlimited: { allowed: 0, denied: 0 },
      },
    };
    this.totalLatencyMs = 0;
    logger.debug('Rate limiter metrics reset');
  }

  // ===========================================================================
  // Bypass Management
  // ===========================================================================

  /**
   * Get bypass checker instance
   */
  public getBypassChecker(): BypassChecker {
    return this.bypassChecker;
  }

  /**
   * Check if a context should bypass rate limiting
   */
  public shouldBypass(context: RateLimitContext): BypassResult {
    return this.bypassChecker.shouldBypass(context);
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Get the appropriate limiter for an algorithm
   */
  private getLimiter(algorithm: RateLimitAlgorithm): RateLimiterInterface {
    switch (algorithm) {
      case 'token-bucket':
        return this.tokenBucketLimiter;
      case 'sliding-window':
        // Use counter variant by default (more efficient)
        return this.slidingWindowCounterLimiter;
      case 'fixed-window':
        return this.fixedWindowLimiter;
      default:
        return this.tokenBucketLimiter;
    }
  }

  /**
   * Resolve tier for a context
   */
  private resolveTier(context: RateLimitContext): RateLimitTier {
    // Check explicit tier first
    if (context.tier && context.tier !== 'anonymous') {
      return context.tier;
    }

    // Use tier mapping
    return determineTier(context, this.tierMapping);
  }

  /**
   * Get rate limit parameters for a context
   */
  private getRateLimitParams(
    context: RateLimitContext,
    matchedRule: MatchedRule | null
  ): { limit: number; windowSeconds: number; algorithm: RateLimitAlgorithm } {
    // Use rule-specific limits if matched
    if (matchedRule) {
      return {
        limit: matchedRule.rule.rateLimit.requests,
        windowSeconds: matchedRule.rule.rateLimit.windowSeconds,
        algorithm: matchedRule.rule.rateLimit.algorithm,
      };
    }

    // Use tier-based limits
    const tierLimits = this.config.tierLimits[context.tier];
    if (tierLimits) {
      return {
        limit: tierLimits.requests,
        windowSeconds: tierLimits.windowSeconds,
        algorithm: this.config.defaultAlgorithm,
      };
    }

    // Fall back to defaults
    return {
      limit: this.config.defaultRequests,
      windowSeconds: this.config.defaultWindowSeconds,
      algorithm: this.config.defaultAlgorithm,
    };
  }

  /**
   * Create a result for allowed/bypassed requests
   */
  private createAllowedResult(context: RateLimitContext): RateLimitCheckResult {
    const tierLimits = this.config.tierLimits[context.tier] ?? {
      requests: this.config.defaultRequests,
      windowSeconds: this.config.defaultWindowSeconds,
    };

    return {
      allowed: true,
      remaining: tierLimits.requests,
      limit: tierLimits.requests,
      resetAt: Math.floor(Date.now() / 1000) + tierLimits.windowSeconds,
      retryAfter: 0,
      context,
      algorithm: this.config.defaultAlgorithm,
      key: '',
      bypassed: false,
    };
  }

  /**
   * Create a result for bypassed requests
   */
  private createBypassResult(
    context: RateLimitContext,
    bypassResult: BypassResult
  ): RateLimitCheckResult {
    return {
      ...this.createAllowedResult(context),
      bypassed: true,
      bypassReason: bypassResult.reason,
    };
  }

  /**
   * Update internal metrics
   */
  private updateMetrics(
    algorithm: RateLimitAlgorithm,
    tier: RateLimitTier,
    allowed: boolean,
    latencyMs: number
  ): void {
    this.metrics.totalChecks++;

    if (allowed) {
      this.metrics.allowed++;
      this.metrics.byAlgorithm[algorithm].allowed++;
      this.metrics.byTier[tier].allowed++;
    } else {
      this.metrics.denied++;
      this.metrics.byAlgorithm[algorithm].denied++;
      this.metrics.byTier[tier].denied++;
    }

    // Update average latency
    this.totalLatencyMs += latencyMs;
    this.metrics.avgLatencyMs = this.totalLatencyMs / this.metrics.totalChecks;
  }
}

// =============================================================================
// Types
// =============================================================================

export interface RateLimitCheckResult extends RateLimitResult {
  /** The context that was checked */
  context: RateLimitContext;
  /** The matched rule, if any */
  matchedRule?: MatchedRule;
  /** The algorithm used */
  algorithm: RateLimitAlgorithm;
  /** The rate limit key used */
  key: string;
  /** Whether rate limiting was bypassed */
  bypassed: boolean;
  /** Reason for bypass, if bypassed */
  bypassReason?: string;
}

// =============================================================================
// Factory Function
// =============================================================================

export function createRateLimiter(
  redis: RedisClientWrapper,
  config?: Partial<RateLimiterConfig>
): RateLimiter {
  return new RateLimiter(redis, config);
}

export default RateLimiter;
