/**
 * AEGIS - Rate Limiter Algorithms
 * Barrel export for all rate limiting algorithm implementations
 */

// =============================================================================
// Token Bucket Algorithm
// =============================================================================

export {
  TokenBucketLimiter,
  createTokenBucketLimiter,
} from './token-bucket.js';

// =============================================================================
// Sliding Window Algorithms
// =============================================================================

export {
  SlidingWindowLogLimiter,
  SlidingWindowCounterLimiter,
  createSlidingWindowLimiter,
  createSlidingWindowLogLimiter,
  createSlidingWindowCounterLimiter,
  type SlidingWindowVariant,
  type SlidingWindowLimiterOptions,
} from './sliding-window.js';

// =============================================================================
// Fixed Window Algorithm
// =============================================================================

export {
  FixedWindowLimiter,
  createFixedWindowLimiter,
} from './fixed-window.js';

// =============================================================================
// Re-export Types
// =============================================================================

export type {
  RateLimitRequest,
  RateLimitResult,
  RateLimiterInterface,
  RateLimitAlgorithm,
  TokenBucketConfig,
  SlidingWindowConfig,
  FixedWindowConfig,
} from '../types.js';
