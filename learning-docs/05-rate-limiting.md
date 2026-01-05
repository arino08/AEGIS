# 05. Rate Limiting

## Overview

Rate limiting is a crucial feature that protects your APIs from abuse, ensures fair usage, and prevents system overload. AEGIS implements multiple rate limiting algorithms and supports flexible rule-based configuration.

---

## 📁 Rate Limiter Module Structure

```
src/rate-limiter/
├── index.ts           # Module exports and factory functions
├── limiter.ts         # Main RateLimiter class
├── middleware.ts      # Express middleware
├── scripts.ts         # Redis Lua scripts for atomic operations
├── types.ts           # Type definitions
├── algorithms/        # Rate limiting algorithms
│   ├── index.ts
│   ├── token-bucket.ts
│   ├── sliding-window.ts
│   └── fixed-window.ts
└── rules/             # Rule matching and bypass
    ├── index.ts
    ├── matcher.ts     # Rule matching logic
    └── bypass.ts      # Bypass checking
```

---

## 🎯 Rate Limiting Algorithms

### 1. Token Bucket

**Concept:** Tokens are added to a bucket at a fixed rate. Each request consumes a token. If the bucket is empty, requests are rejected.

**Best for:** APIs that need to allow burst traffic while maintaining a sustained rate.

```typescript
// src/rate-limiter/algorithms/token-bucket.ts

export class TokenBucketLimiter implements RateLimiterInterface {
  // Token bucket stored in Redis as a hash:
  // {
  //   tokens: number,       // Current token count
  //   lastRefill: number    // Last refill timestamp
  // }

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const refillRate = limit / windowSeconds;  // Tokens per second
    const now = Date.now();

    // Use Lua script for atomic operation
    const result = await this.redis.eval(
      TOKEN_BUCKET_SCRIPT,
      [key],
      [
        String(limit),           // Max tokens (bucket size)
        String(refillRate),      // Refill rate
        String(now)              // Current timestamp
      ]
    );

    const [allowed, remaining, resetAt] = result as [number, number, number];

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, remaining),
      limit,
      resetAt: new Date(resetAt)
    };
  }
}
```

**Lua Script for Atomic Token Bucket:**

```lua
-- TOKEN_BUCKET_SCRIPT
local key = KEYS[1]
local maxTokens = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Get current state
local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(bucket[1]) or maxTokens
local lastRefill = tonumber(bucket[2]) or now

-- Calculate tokens to add based on time elapsed
local elapsed = (now - lastRefill) / 1000  -- Convert to seconds
local tokensToAdd = elapsed * refillRate
tokens = math.min(maxTokens, tokens + tokensToAdd)

-- Try to consume a token
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

-- Save state
redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
redis.call('EXPIRE', key, 86400)  -- 24 hour TTL

-- Calculate reset time
local resetAt = now + ((maxTokens - tokens) / refillRate * 1000)

return {allowed, math.floor(tokens), resetAt}
```

### 2. Sliding Window Log

**Concept:** Keeps a log of all request timestamps within the window. Counts requests in the past `windowSeconds` to determine if limit is exceeded.

**Best for:** Precise rate limiting without the edge effects of fixed windows.

```typescript
// src/rate-limiter/algorithms/sliding-window.ts

export class SlidingWindowLogLimiter implements RateLimiterInterface {
  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - (windowSeconds * 1000);

    // Use Lua script for atomic operation
    const result = await this.redis.eval(
      SLIDING_WINDOW_SCRIPT,
      [key],
      [
        String(now),
        String(windowStart),
        String(limit),
        String(windowSeconds)
      ]
    );

    const [allowed, count] = result as [number, number];

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, limit - count),
      limit,
      resetAt: new Date(now + (windowSeconds * 1000))
    };
  }
}
```

**Lua Script:**

```lua
-- SLIDING_WINDOW_SCRIPT
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowStart = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local windowSeconds = tonumber(ARGV[4])

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

-- Count current requests in window
local count = redis.call('ZCARD', key)

-- Check if within limit
local allowed = 0
if count < limit then
  -- Add this request
  redis.call('ZADD', key, now, now .. '-' .. math.random())
  count = count + 1
  allowed = 1
end

-- Set TTL
redis.call('EXPIRE', key, windowSeconds + 1)

return {allowed, count}
```

### 3. Fixed Window Counter

**Concept:** Divides time into fixed windows (e.g., every minute). Counts requests within each window.

**Best for:** Simple use cases where occasional bursts at window boundaries are acceptable.

```typescript
// src/rate-limiter/algorithms/fixed-window.ts

export class FixedWindowLimiter implements RateLimiterInterface {
  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    // Calculate current window
    const now = Math.floor(Date.now() / 1000);
    const windowKey = `${key}:${Math.floor(now / windowSeconds)}`;

    // Increment counter
    const count = await this.redis.incr(windowKey);

    // Set expiration on first request
    if (count === 1) {
      await this.redis.expire(windowKey, windowSeconds + 1);
    }

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    const windowEnd = (Math.floor(now / windowSeconds) + 1) * windowSeconds;

    return {
      allowed,
      remaining,
      limit,
      resetAt: new Date(windowEnd * 1000)
    };
  }
}
```

---

## 📊 Algorithm Comparison

| Feature | Token Bucket | Sliding Window | Fixed Window |
|---------|--------------|----------------|--------------|
| **Burst Handling** | ✅ Allows controlled bursts | ❌ No bursts | ⚠️ Bursts at boundaries |
| **Precision** | ⚠️ Approximate | ✅ Precise | ⚠️ Window edge issues |
| **Memory Usage** | Low | Higher (stores timestamps) | Low |
| **Complexity** | Medium | High | Low |
| **Redis Commands** | 2-3 | 3-4 | 2-3 |

---

## ⚙️ Main Rate Limiter Class

### `src/rate-limiter/limiter.ts`

```typescript
export class RateLimiter {
  private config: RateLimiterConfig;
  private tokenBucketLimiter: TokenBucketLimiter;
  private slidingWindowLimiter: SlidingWindowLogLimiter;
  private fixedWindowLimiter: FixedWindowLimiter;
  private ruleMatcher: RuleMatcher;
  private bypassChecker: BypassChecker;

  constructor(redis: RedisClientWrapper, config: Partial<RateLimiterConfig> = {}) {
    // Merge with defaults
    this.config = {
      enabled: true,
      defaultAlgorithm: 'token-bucket',
      defaultRequests: 100,
      defaultWindowSeconds: 60,
      keyStrategy: 'composite',
      keyPrefix: 'ratelimit:',
      includeHeaders: true,
      ...config
    };

    // Initialize algorithm implementations
    this.tokenBucketLimiter = new TokenBucketLimiter(redis, this.config.keyPrefix);
    this.slidingWindowLimiter = new SlidingWindowLogLimiter(redis, this.config.keyPrefix);
    this.fixedWindowLimiter = new FixedWindowLimiter(redis, this.config.keyPrefix);

    // Initialize rule matching
    this.ruleMatcher = new RuleMatcher(config.rules || []);
    this.bypassChecker = new BypassChecker(config.bypass);
  }
}
```

### Main Check Method

```typescript
async check(context: RateLimitContext): Promise<RateLimitCheckResult> {
  // 1. Check if rate limiting is enabled
  if (!this.config.enabled) {
    return { allowed: true, bypassed: true, reason: 'disabled' };
  }

  // 2. Check for bypass conditions
  const bypassResult = this.bypassChecker.check(context);
  if (bypassResult.bypassed) {
    return {
      allowed: true,
      bypassed: true,
      reason: bypassResult.reason
    };
  }

  // 3. Find matching rule
  const matchedRule = this.ruleMatcher.match(context);

  // 4. Determine rate limit parameters
  const params = this.getRateLimitParams(context, matchedRule);

  // 5. Generate rate limit key
  const key = this.generateKey(context, matchedRule);

  // 6. Get appropriate limiter
  const limiter = this.getLimiter(params.algorithm);

  // 7. Check rate limit
  const result = await limiter.check(key, params.limit, params.windowSeconds);

  // 8. Record metrics
  this.recordMetrics(context, result);

  return {
    allowed: result.allowed,
    bypassed: false,
    result,
    matchedRule: matchedRule?.rule,
    key
  };
}
```

### Key Generation

```typescript
private generateKey(context: RateLimitContext, matchedRule: MatchedRule | null): string {
  const prefix = this.config.keyPrefix;
  const parts: string[] = [];

  // Add algorithm prefix
  const algorithm = matchedRule?.rule.rateLimit.algorithm || this.config.defaultAlgorithm;
  parts.push(algorithm);

  // Generate key based on strategy
  switch (this.config.keyStrategy) {
    case 'ip':
      parts.push('ip', context.ip);
      break;

    case 'user':
      parts.push('user', context.userId || 'anonymous');
      break;

    case 'api-key':
      parts.push('key', context.apiKey || 'none');
      break;

    case 'ip-endpoint':
      parts.push('ip', context.ip, 'path', context.path);
      break;

    case 'composite':
    default:
      // Use user ID if available, otherwise IP
      if (context.userId) {
        parts.push('user', context.userId);
      } else if (context.apiKey) {
        parts.push('key', context.apiKey);
      } else {
        parts.push('ip', context.ip);
      }
      // Add endpoint for more granular limiting
      parts.push('path', context.path);
      break;
  }

  return prefix + parts.join(':');
}
```

---

## 📏 Rule Matching

### Rule Structure

```typescript
interface RateLimitRule {
  id: string;
  name: string;
  priority: number;      // Higher = checked first
  enabled: boolean;
  match: {
    endpoint?: string;              // Path pattern
    endpointMatchType?: 'exact' | 'prefix' | 'glob' | 'regex';
    methods?: string[];             // HTTP methods
    tiers?: string[];               // User tiers
    userIds?: string[];             // Specific users
    apiKeys?: string[];             // Specific API keys
  };
  rateLimit: {
    algorithm: 'token-bucket' | 'sliding-window' | 'fixed-window';
    requests: number;
    windowSeconds: number;
    burst?: number;                 // For token bucket
  };
}
```

### Rule Matcher Implementation

```typescript
// src/rate-limiter/rules/matcher.ts

export class RuleMatcher {
  private rules: RateLimitRule[];
  private compiledPatterns: Map<string, RegExp>;

  constructor(rules: RateLimitRule[]) {
    // Sort by priority (descending) and compile patterns
    this.rules = rules
      .filter(r => r.enabled)
      .sort((a, b) => b.priority - a.priority);

    this.compiledPatterns = new Map();
    for (const rule of this.rules) {
      if (rule.match.endpoint) {
        const pattern = this.compilePattern(
          rule.match.endpoint,
          rule.match.endpointMatchType || 'glob'
        );
        this.compiledPatterns.set(rule.id, pattern);
      }
    }
  }

  match(context: RateLimitContext): MatchedRule | null {
    for (const rule of this.rules) {
      if (this.matchesRule(rule, context)) {
        return {
          rule,
          matchScore: this.calculateMatchScore(rule, context)
        };
      }
    }
    return null;
  }

  private matchesRule(rule: RateLimitRule, context: RateLimitContext): boolean {
    const m = rule.match;

    // Check endpoint pattern
    if (m.endpoint) {
      const pattern = this.compiledPatterns.get(rule.id)!;
      if (!pattern.test(context.path)) {
        return false;
      }
    }

    // Check HTTP method
    if (m.methods && m.methods.length > 0) {
      if (!m.methods.includes(context.method)) {
        return false;
      }
    }

    // Check tier
    if (m.tiers && m.tiers.length > 0) {
      if (!context.tier || !m.tiers.includes(context.tier)) {
        return false;
      }
    }

    // Check specific user
    if (m.userIds && m.userIds.length > 0) {
      if (!context.userId || !m.userIds.includes(context.userId)) {
        return false;
      }
    }

    return true;
  }
}
```

---

## 🔓 Bypass Checking

### Bypass Configuration

```yaml
# In aegis.config.yaml
rateLimit:
  bypass:
    ips:
      - '127.0.0.1'
      - '10.0.0.0/8'      # CIDR notation supported
    userIds:
      - 'admin-user-id'
    apiKeys:
      - 'trusted-key-hash'
    paths:
      - '/health'
      - '/healthz'
      - '/ready'
    internal: true        # Bypass private IP ranges
```

### Bypass Checker Implementation

```typescript
// src/rate-limiter/rules/bypass.ts

export class BypassChecker {
  private bypassIps: Set<string>;
  private bypassCidrs: CidrMatcher[];
  private bypassUserIds: Set<string>;
  private bypassApiKeys: Set<string>;
  private bypassPaths: RegExp[];
  private bypassInternal: boolean;

  check(context: RateLimitContext): BypassResult {
    // Check IP bypass
    if (this.bypassIps.has(context.ip)) {
      return { bypassed: true, reason: 'whitelisted-ip' };
    }

    // Check CIDR ranges
    for (const cidr of this.bypassCidrs) {
      if (cidr.contains(context.ip)) {
        return { bypassed: true, reason: 'whitelisted-cidr' };
      }
    }

    // Check internal IPs (10.x, 172.16.x, 192.168.x)
    if (this.bypassInternal && this.isPrivateIp(context.ip)) {
      return { bypassed: true, reason: 'internal-ip' };
    }

    // Check user ID
    if (context.userId && this.bypassUserIds.has(context.userId)) {
      return { bypassed: true, reason: 'whitelisted-user' };
    }

    // Check API key
    if (context.apiKey && this.bypassApiKeys.has(context.apiKey)) {
      return { bypassed: true, reason: 'whitelisted-apikey' };
    }

    // Check path patterns
    for (const pattern of this.bypassPaths) {
      if (pattern.test(context.path)) {
        return { bypassed: true, reason: 'whitelisted-path' };
      }
    }

    return { bypassed: false };
  }

  private isPrivateIp(ip: string): boolean {
    return (
      ip.startsWith('10.') ||
      ip.startsWith('172.16.') ||
      ip.startsWith('172.17.') ||
      // ... etc
      ip.startsWith('192.168.') ||
      ip === '127.0.0.1' ||
      ip === '::1'
    );
  }
}
```

---

## 🔌 Rate Limit Middleware

### `src/rate-limiter/middleware.ts`

```typescript
export function createRateLimitMiddleware(
  rateLimiter: RateLimiter,
  options: RateLimitMiddlewareOptions = {}
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Build context from request
    const context: RateLimitContext = {
      ip: getClientIp(req),
      path: req.path,
      method: req.method,
      userId: (req as any).user?.id,
      apiKey: extractApiKey(req),
      tier: (req as any).user?.tier || 'anonymous'
    };

    try {
      // Check rate limit
      const result = await rateLimiter.check(context);

      // Add headers if configured
      if (rateLimiter.shouldIncludeHeaders()) {
        const headers = rateLimiter.generateHeaders(result.result!);
        res.set(headers);
      }

      if (result.allowed) {
        // Request allowed, continue
        next();
      } else {
        // Rate limit exceeded
        const errorBody = rateLimiter.generateErrorBody(result.result!);

        // Call optional exceeded handler
        options.onExceeded?.(req, res, result);

        res.status(429).json(errorBody);
      }
    } catch (error) {
      // On error, optionally allow request (fail open)
      if (options.failOpen) {
        logger.error('Rate limit check failed, allowing request', { error });
        next();
      } else {
        next(error);
      }
    }
  };
}
```

### Response Headers

When rate limit is checked, these headers are added:

```
X-RateLimit-Limit: 100          # Maximum requests allowed
X-RateLimit-Remaining: 95       # Remaining requests in window
X-RateLimit-Reset: 1703276400   # Unix timestamp when limit resets
Retry-After: 60                 # Seconds until retry (on 429)
```

### 429 Response Body

```json
{
  "error": "Rate Limit Exceeded",
  "message": "You have exceeded the rate limit. Please try again later.",
  "retryAfter": 60,
  "limit": 100,
  "remaining": 0,
  "resetAt": "2024-12-22T21:00:00.000Z"
}
```

---

## 📊 Tier-Based Rate Limiting

Different users get different limits based on their tier:

```yaml
# Configuration
rateLimit:
  tierLimits:
    anonymous:
      requests: 60
      windowSeconds: 60
    free:
      requests: 100
      windowSeconds: 60
    basic:
      requests: 500
      windowSeconds: 60
    pro:
      requests: 2000
      windowSeconds: 60
    enterprise:
      requests: 10000
      windowSeconds: 60
```

### Tier Resolution

```typescript
private resolveTier(context: RateLimitContext): RateLimitTier {
  // Check if user has explicit tier mapping
  const explicitTier = this.tierMappings.get(context.userId || context.apiKey || '');
  if (explicitTier) {
    return explicitTier;
  }

  // Use tier from auth context
  if (context.tier && this.config.tierLimits[context.tier]) {
    return context.tier as RateLimitTier;
  }

  // Default to anonymous
  return 'anonymous';
}
```

---

## 🔧 Redis Lua Scripts

All rate limiting operations use Lua scripts for atomicity:

```typescript
// src/rate-limiter/scripts.ts

export const RATE_LIMIT_SCRIPTS = {
  tokenBucket: `
    local key = KEYS[1]
    local maxTokens = tonumber(ARGV[1])
    local refillRate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    -- ... implementation
    return {allowed, remaining, resetAt}
  `,

  slidingWindow: `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowStart = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    -- ... implementation
    return {allowed, count}
  `,

  fixedWindow: `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local windowSeconds = tonumber(ARGV[2])
    -- ... implementation
    return {allowed, remaining}
  `
};
```

**Why Lua scripts?**
- **Atomicity**: Script runs as single operation
- **Performance**: Reduces network round trips
- **Consistency**: No race conditions between read and write

---

## 📈 Metrics

Rate limiting events are recorded for monitoring:

```typescript
private recordMetrics(context: RateLimitContext, result: RateLimitResult): void {
  if (result.allowed) {
    this.metrics.allowed++;
  } else {
    this.metrics.rejected++;
  }

  this.metrics.totalChecks++;

  // Record to collector if available
  metricsCollector?.recordRateLimit({
    timestamp: new Date(),
    key: context.path,
    allowed: result.allowed,
    remaining: result.remaining,
    limit: result.limit
  });
}
```

---

## 🎯 Usage Examples

### Basic Rate Limiting

```yaml
# Limit all requests to 100/minute
rateLimit:
  enabled: true
  defaultRequests: 100
  defaultWindowSeconds: 60
```

### Endpoint-Specific Rules

```yaml
rateLimit:
  rules:
    - id: login-limit
      name: 'Strict Login Limit'
      priority: 100
      enabled: true
      match:
        endpoint: '/auth/login'
        methods: [POST]
      rateLimit:
        algorithm: sliding-window
        requests: 5
        windowSeconds: 60

    - id: search-limit
      name: 'Search Rate Limit'
      priority: 50
      match:
        endpoint: '/api/search'
      rateLimit:
        algorithm: token-bucket
        requests: 30
        windowSeconds: 60
        burst: 10
```

---

## 🚀 Next Steps

Now that you understand rate limiting:
1. [Monitoring & Metrics](./06-monitoring-metrics.md) - See rate limiting in dashboards
2. [Authentication](./07-auth.md) - How auth affects rate limiting
