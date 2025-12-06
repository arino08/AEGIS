/**
 * AEGIS - Rate Limiter Type Definitions
 * Comprehensive types for distributed rate limiting
 */

// =============================================================================
// Core Rate Limiting Types
// =============================================================================

/**
 * Supported rate limiting algorithms
 */
export type RateLimitAlgorithm = 'token-bucket' | 'sliding-window' | 'fixed-window';

/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of remaining requests in the current window */
  remaining: number;
  /** Maximum requests allowed in the window */
  limit: number;
  /** When the rate limit resets (Unix timestamp in seconds) */
  resetAt: number;
  /** Seconds until the rate limit resets */
  retryAfter: number;
  /** Current token count (for token bucket) */
  tokens?: number;
  /** The rule that was applied */
  appliedRule?: RateLimitRule;
}

/**
 * Rate limit check request
 */
export interface RateLimitRequest {
  /** Unique identifier for rate limiting (e.g., user:123, ip:1.2.3.4) */
  key: string;
  /** Maximum requests allowed */
  limit: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Number of tokens to consume (default: 1) */
  cost?: number;
}

// =============================================================================
// Token Bucket Types
// =============================================================================

/**
 * Token bucket state stored in Redis
 */
export interface TokenBucketState {
  /** Current number of tokens */
  tokens: number;
  /** Last refill timestamp (Unix milliseconds) */
  lastRefill: number;
}

/**
 * Token bucket configuration
 */
export interface TokenBucketConfig {
  /** Maximum number of tokens (bucket capacity) */
  maxTokens: number;
  /** Tokens added per second (refill rate) */
  refillRate: number;
  /** Initial tokens when bucket is created */
  initialTokens?: number;
}

// =============================================================================
// Sliding Window Types
// =============================================================================

/**
 * Sliding window log entry
 */
export interface SlidingWindowEntry {
  /** Request timestamp (Unix milliseconds) */
  timestamp: number;
  /** Unique request identifier */
  requestId: string;
  /** Weight/cost of the request */
  weight?: number;
}

/**
 * Sliding window configuration
 */
export interface SlidingWindowConfig {
  /** Window size in seconds */
  windowSeconds: number;
  /** Maximum requests in window */
  maxRequests: number;
  /** Precision of timestamps (milliseconds) */
  precision?: number;
}

// =============================================================================
// Fixed Window Types
// =============================================================================

/**
 * Fixed window configuration
 */
export interface FixedWindowConfig {
  /** Window size in seconds */
  windowSeconds: number;
  /** Maximum requests in window */
  maxRequests: number;
}

// =============================================================================
// Rate Limit Rule Types
// =============================================================================

/**
 * User/client tier for tiered rate limiting
 */
export type RateLimitTier = 'anonymous' | 'free' | 'basic' | 'pro' | 'enterprise' | 'unlimited';

/**
 * Rule match type
 */
export type RuleMatchType = 'exact' | 'prefix' | 'glob' | 'regex';

/**
 * Rate limit rule definition
 */
export interface RateLimitRule {
  /** Unique rule identifier */
  id: string;
  /** Rule name for display */
  name: string;
  /** Rule priority (higher = more priority) */
  priority: number;
  /** Whether the rule is enabled */
  enabled: boolean;

  /** Match conditions */
  match: {
    /** Endpoint pattern to match */
    endpoint?: string;
    /** Match type for endpoint */
    endpointMatchType?: RuleMatchType;
    /** HTTP methods to match (empty = all) */
    methods?: string[];
    /** User tiers this rule applies to */
    tiers?: RateLimitTier[];
    /** Specific user IDs */
    userIds?: string[];
    /** IP addresses or CIDR ranges */
    ips?: string[];
    /** API key patterns */
    apiKeys?: string[];
    /** Custom header match */
    headers?: Record<string, string>;
  };

  /** Rate limit settings */
  rateLimit: {
    /** Algorithm to use */
    algorithm: RateLimitAlgorithm;
    /** Requests per window */
    requests: number;
    /** Window size in seconds */
    windowSeconds: number;
    /** Burst capacity (for token bucket) */
    burst?: number;
  };

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Matched rule result
 */
export interface MatchedRule {
  rule: RateLimitRule;
  matchScore: number;
  matchedConditions: string[];
}

// =============================================================================
// Request Context Types
// =============================================================================

/**
 * Context extracted from incoming request for rate limiting
 */
export interface RateLimitContext {
  /** Client IP address */
  ip: string;
  /** User ID (from JWT or API key) */
  userId?: string;
  /** API key used */
  apiKey?: string;
  /** User's rate limit tier */
  tier: RateLimitTier;
  /** Request path */
  path: string;
  /** HTTP method */
  method: string;
  /** Request headers */
  headers: Record<string, string | string[] | undefined>;
  /** Unique request ID */
  requestId: string;
}

/**
 * Key generation strategy
 */
export type KeyStrategy =
  | 'ip'           // Rate limit by IP only
  | 'user'         // Rate limit by user ID only
  | 'api-key'      // Rate limit by API key
  | 'ip-endpoint'  // Rate limit by IP + endpoint
  | 'user-endpoint' // Rate limit by user + endpoint
  | 'composite';   // Custom composite key

/**
 * Key generator function type
 */
export type KeyGenerator = (context: RateLimitContext) => string;

// =============================================================================
// Bypass/Whitelist Types
// =============================================================================

/**
 * Bypass configuration
 */
export interface BypassConfig {
  /** IPs that bypass rate limiting */
  ips: string[];
  /** User IDs that bypass rate limiting */
  userIds: string[];
  /** API keys that bypass rate limiting */
  apiKeys: string[];
  /** Paths that bypass rate limiting */
  paths: string[];
  /** Whether to bypass for internal requests */
  internal: boolean;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Algorithm-specific configuration
 */
export interface AlgorithmConfig {
  tokenBucket?: TokenBucketConfig;
  slidingWindow?: SlidingWindowConfig;
  fixedWindow?: FixedWindowConfig;
}

/**
 * Tier-based default limits
 */
export interface TierLimits {
  anonymous: { requests: number; windowSeconds: number };
  free: { requests: number; windowSeconds: number };
  basic: { requests: number; windowSeconds: number };
  pro: { requests: number; windowSeconds: number };
  enterprise: { requests: number; windowSeconds: number };
  unlimited: { requests: number; windowSeconds: number };
}

/**
 * Complete rate limiter configuration
 */
export interface RateLimiterConfig {
  /** Whether rate limiting is enabled */
  enabled: boolean;

  /** Default algorithm to use */
  defaultAlgorithm: RateLimitAlgorithm;

  /** Default requests per window */
  defaultRequests: number;

  /** Default window size in seconds */
  defaultWindowSeconds: number;

  /** Key generation strategy */
  keyStrategy: KeyStrategy;

  /** Custom key prefix for Redis */
  keyPrefix: string;

  /** Bypass configuration */
  bypass: BypassConfig;

  /** Tier-based limits */
  tierLimits: TierLimits;

  /** Rate limit rules */
  rules: RateLimitRule[];

  /** Algorithm-specific config */
  algorithmConfig: AlgorithmConfig;

  /** Whether to include rate limit info in response headers */
  includeHeaders: boolean;

  /** Custom error message */
  errorMessage?: string;
}

// =============================================================================
// Response Header Types
// =============================================================================

/**
 * Standard rate limit response headers
 */
export interface RateLimitHeaders {
  'X-RateLimit-Limit': string;
  'X-RateLimit-Remaining': string;
  'X-RateLimit-Reset': string;
  'Retry-After'?: string;
  'X-RateLimit-Policy'?: string;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Rate limit exceeded error response body
 */
export interface RateLimitErrorBody {
  error: string;
  code: 'RATE_LIMIT_EXCEEDED';
  message: string;
  limit: number;
  remaining: number;
  windowSeconds: number;
  retryAfter: number;
  resetAt: string;
}

// =============================================================================
// Metrics Types
// =============================================================================

/**
 * Rate limiter metrics
 */
export interface RateLimiterMetrics {
  /** Total requests checked */
  totalChecks: number;
  /** Requests allowed */
  allowed: number;
  /** Requests denied */
  denied: number;
  /** Requests bypassed */
  bypassed: number;
  /** Average check latency (ms) */
  avgLatencyMs: number;
  /** Checks by algorithm */
  byAlgorithm: Record<RateLimitAlgorithm, { allowed: number; denied: number }>;
  /** Checks by tier */
  byTier: Record<RateLimitTier, { allowed: number; denied: number }>;
}

// =============================================================================
// Limiter Interface Types
// =============================================================================

/**
 * Base interface for all rate limiter implementations
 */
export interface RateLimiterInterface {
  /** Check if request is allowed and consume quota */
  check(request: RateLimitRequest): Promise<RateLimitResult>;

  /** Get current state without consuming quota */
  peek(key: string): Promise<RateLimitResult | null>;

  /** Reset rate limit for a key */
  reset(key: string): Promise<void>;

  /** Get algorithm name */
  getAlgorithm(): RateLimitAlgorithm;
}

/**
 * Factory options for creating limiters
 */
export interface LimiterFactoryOptions {
  algorithm: RateLimitAlgorithm;
  config?: AlgorithmConfig;
}

// =============================================================================
// Lua Script Types
// =============================================================================

/**
 * Lua script result for token bucket
 */
export interface TokenBucketScriptResult {
  allowed: 0 | 1;
  tokens: number;
  resetAt: number;
}

/**
 * Lua script result for sliding window
 */
export interface SlidingWindowScriptResult {
  allowed: 0 | 1;
  count: number;
  resetAt: number;
}

/**
 * Lua script result for fixed window
 */
export interface FixedWindowScriptResult {
  allowed: 0 | 1;
  count: number;
  ttl: number;
}
