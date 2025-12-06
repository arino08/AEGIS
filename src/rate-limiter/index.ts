/**
 * AEGIS - Rate Limiter Module
 * Production-grade distributed rate limiting for API Gateway
 *
 * Features:
 * - Multiple algorithms: Token Bucket, Sliding Window, Fixed Window
 * - Per-user, per-IP, per-endpoint rate limiting
 * - Tiered limits (anonymous, free, pro, enterprise)
 * - Bypass/whitelist support
 * - Redis-backed for distributed environments
 * - Express middleware with proper response headers
 */

// =============================================================================
// Core Rate Limiter
// =============================================================================

export { RateLimiter, createRateLimiter, type RateLimitCheckResult } from './limiter.js';

// =============================================================================
// Algorithms
// =============================================================================

export {
  // Token Bucket
  TokenBucketLimiter,
  createTokenBucketLimiter,
  // Sliding Window
  SlidingWindowLogLimiter,
  SlidingWindowCounterLimiter,
  createSlidingWindowLimiter,
  createSlidingWindowLogLimiter,
  createSlidingWindowCounterLimiter,
  type SlidingWindowVariant,
  type SlidingWindowLimiterOptions,
  // Fixed Window
  FixedWindowLimiter,
  createFixedWindowLimiter,
} from './algorithms/index.js';

// =============================================================================
// Rules and Matching
// =============================================================================

export {
  RuleMatcher,
  createRuleMatcher,
  matchGlob,
  matchIP,
  KEY_GENERATORS,
  createKeyGenerator,
  generateRateLimitKey,
  determineTier,
  BypassChecker,
  createBypassChecker,
  type BypassResult,
  type BypassReason,
} from './rules/index.js';

// =============================================================================
// Middleware
// =============================================================================

export {
  createRateLimitMiddleware,
  createIPRateLimitMiddleware,
  createUserRateLimitMiddleware,
  createAPIKeyRateLimitMiddleware,
  createEndpointRateLimitMiddleware,
  skipHealthChecks,
  skipStaticAssets,
  skipInternalRequests,
  combineSkipFunctions,
  type RateLimitMiddlewareOptions,
  type RateLimitedRequest,
} from './middleware.js';

// =============================================================================
// Lua Scripts
// =============================================================================

export {
  SCRIPTS,
  TOKEN_BUCKET_SCRIPT,
  SLIDING_WINDOW_LOG_SCRIPT,
  SLIDING_WINDOW_COUNTER_SCRIPT,
  FIXED_WINDOW_SCRIPT,
  type ScriptName,
} from './scripts.js';

// =============================================================================
// Types
// =============================================================================

export type {
  // Core types
  RateLimitAlgorithm,
  RateLimitResult,
  RateLimitRequest,
  RateLimiterInterface,
  RateLimiterConfig,

  // Rule types
  RateLimitRule,
  RateLimitContext,
  MatchedRule,
  RuleMatchType,
  RateLimitTier,
  KeyStrategy,
  KeyGenerator,
  BypassConfig,

  // Algorithm config types
  TokenBucketConfig,
  TokenBucketState,
  SlidingWindowConfig,
  SlidingWindowEntry,
  FixedWindowConfig,
  AlgorithmConfig,

  // Response types
  RateLimitHeaders,
  RateLimitErrorBody,

  // Metrics
  RateLimiterMetrics,
  TierLimits,
} from './types.js';
