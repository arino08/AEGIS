/**
 * AEGIS - Rate Limiter Rules Module
 * Barrel export for rule matching and bypass checking
 */

// =============================================================================
// Rule Matcher
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
} from './matcher.js';

// =============================================================================
// Bypass Checker
// =============================================================================

export {
  BypassChecker,
  createBypassChecker,
  type BypassResult,
  type BypassReason,
} from './bypass.js';

// =============================================================================
// Re-export Types
// =============================================================================

export type {
  RateLimitRule,
  RateLimitContext,
  MatchedRule,
  RuleMatchType,
  RateLimitTier,
  KeyStrategy,
  KeyGenerator,
  BypassConfig,
} from '../types.js';
