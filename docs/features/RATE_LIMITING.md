# Rate Limiting Feature

## Overview

Rate limiting controls the number of requests a client can make within a time window. This protects backend services from overload, prevents abuse, and ensures fair resource allocation across users.

## Why Rate Limiting Matters

**Without rate limiting**:
- A single malicious user can send millions of requests (DDoS attack)
- Bugs in client code can accidentally overload servers
- Backend services crash from too many concurrent requests
- All users suffer from slow/unavailable service

**With rate limiting**:
- Each client gets fair share of resources
- Backend services remain stable under load
- Malicious traffic is automatically blocked
- System degrades gracefully under stress

## Algorithms

### 1. Token Bucket

**How it works**:
- Imagine a bucket with tokens (e.g., 100 tokens)
- Each request consumes 1 token
- Tokens refill at a constant rate (e.g., 10 tokens/second)
- If bucket is empty, request is rejected

**Advantages**:
- Allows bursts (client can use all 100 tokens immediately)
- Smooth traffic over time as tokens refill
- Industry standard (used by AWS, Stripe, etc.)

**Disadvantages**:
- More complex to implement
- Requires storing token count and last refill time

**Use cases**:
- APIs with occasional spikes (e.g., analytics dashboard refresh)
- Mobile apps that queue requests while offline
- Batch processing that sends bursts

**Configuration**:
```yaml
rateLimiting:
  default:
    algorithm: "token-bucket"
    limit: 100        # Bucket capacity
    window: "1m"      # Refill rate: 100 tokens per 1 minute
    burstSize: 50     # Allow bursts up to 50 tokens above limit
```

**Example**:
```
Time 0s: Bucket = 100 tokens
  - Client sends 50 requests → Bucket = 50 tokens (allowed)

Time 30s: Bucket = 50 + (30s * 100/60s) = 100 tokens (capped at max)
  - Client sends 150 requests → Bucket = 0 tokens after 100 requests (50 rejected)

Time 60s: Bucket = 0 + (30s * 100/60s) = 50 tokens
  - Client sends 75 requests → Bucket = 0 tokens after 50 requests (25 rejected)
```

---

### 2. Sliding Window

**How it works**:
- Records timestamp of each request in a sorted set
- Counts requests in the last N seconds
- Removes requests older than the window
- Rejects request if count exceeds limit

**Advantages**:
- Most accurate (no edge case bursts)
- Smooth distribution over time
- No "reset" moment where limits reset

**Disadvantages**:
- Higher memory usage (stores all timestamps)
- Slower than fixed window (requires range query)

**Use cases**:
- Strict rate enforcement (security-critical APIs)
- Premium tier APIs with guaranteed limits
- Compliance requirements (exactly N requests per hour)

**Configuration**:
```yaml
rateLimiting:
  default:
    algorithm: "sliding-window"
    limit: 100
    window: "1m"
```

**Example**:
```
Window: 1 minute (60 seconds)
Limit: 100 requests

10:00:00 - Request 1  ✓
10:00:05 - Request 2  ✓
...
10:00:55 - Request 100 ✓
10:00:58 - Request 101 ✗ (denied, 100 requests in last 60s)

10:01:01 - Request 102 ✓ (request from 10:00:00 now outside window)
```

---

### 3. Fixed Window

**How it works**:
- Counter resets at fixed intervals (e.g., 10:00:00, 10:01:00, 10:02:00)
- Increment counter for each request
- Reject if counter exceeds limit
- Counter resets to 0 at next window boundary

**Advantages**:
- Simplest to implement
- Lowest memory usage (single counter per client)
- Fastest performance

**Disadvantages**:
- Edge case bursts (200 requests in 2 seconds if timed at window boundary)
- Unfair distribution (user can use all quota in first second)

**Use cases**:
- High-throughput systems where precision isn't critical
- Internal APIs (not user-facing)
- Caching/CDN rate limiting

**Configuration**:
```yaml
rateLimiting:
  default:
    algorithm: "fixed-window"
    limit: 100
    window: "1m"
```

**Example**:
```
Window 1: 10:00:00 - 10:00:59
  - 10:00:01: Request 1-50 ✓ (counter = 50)
  - 10:00:30: Request 51-100 ✓ (counter = 100)
  - 10:00:59: Request 101 ✗ (counter = 100, limit reached)

Window 2: 10:01:00 - 10:01:59 (counter resets to 0)
  - 10:01:00: Request 1-100 ✓ (counter = 100)

Edge case:
  - 10:00:59: 100 requests ✓
  - 10:01:00: 100 requests ✓ (window reset)
  → 200 requests in 1 second!
```

---

## Configuration

### Global Default

Apply to all routes unless overridden:

```yaml
rateLimiting:
  enabled: true
  default:
    algorithm: "token-bucket"
    limit: 100
    window: "1m"
```

### Per-Route Rules

Override defaults for specific paths:

```yaml
rateLimiting:
  rules:
    # Strict limit for expensive operations
    - path: "/api/reports/generate"
      algorithm: "sliding-window"
      limit: 10
      window: "1h"

    # Higher limit for read-only endpoints
    - path: "/api/users"
      methods: ["GET"]
      limit: 1000
      window: "1m"

    # No limit for health checks
    - path: "/health"
      limit: -1  # Unlimited
```

### Bypass Rules

Whitelist IPs or API keys:

```yaml
rateLimiting:
  bypass:
    # Localhost (for testing)
    ips:
      - "127.0.0.1"
      - "::1"

    # Internal services
    apiKeys:
      - "internal-service-key-abc123"

    # Admin users
    roles:
      - "admin"
```

### Tiered Limits

Different limits per user tier:

```yaml
rateLimiting:
  tiers:
    free:
      limit: 100
      window: "1h"

    pro:
      limit: 1000
      window: "1h"

    enterprise:
      limit: 10000
      window: "1h"
```

---

## Implementation Details

### Redis Data Structures

**Token Bucket**:
```redis
HSET ratelimit:token-bucket:user123 tokens 75
HSET ratelimit:token-bucket:user123 lastRefill 1640000000

# Refill tokens
tokens = min(tokens + (now - lastRefill) * refillRate, limit)
```

**Sliding Window**:
```redis
# Add request timestamp
ZADD ratelimit:sliding-window:user123 1640000000 req1

# Count requests in window
ZCOUNT ratelimit:sliding-window:user123 (now - windowSec) +inf

# Remove old requests
ZREMRANGEBYSCORE ratelimit:sliding-window:user123 -inf (now - windowSec)
```

**Fixed Window**:
```redis
# Increment counter
INCR ratelimit:fixed-window:user123:16400000
EXPIRE ratelimit:fixed-window:user123:16400000 60

# Key format: clientId:windowStart
# Auto-expires after window duration
```

### Lua Scripts

**Atomic token bucket check** (`src/rate-limiter/scripts.ts`):
```lua
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local tokens = tonumber(redis.call('HGET', key, 'tokens')) or limit
local lastRefill = tonumber(redis.call('HGET', key, 'lastRefill')) or now

-- Refill tokens
local elapsed = now - lastRefill
local tokensToAdd = elapsed * refillRate
tokens = math.min(tokens + tokensToAdd, limit)

-- Check if request allowed
if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', key, 'tokens', tokens)
  redis.call('HSET', key, 'lastRefill', now)
  return {1, tokens}  -- Allowed, remaining tokens
else
  return {0, 0}  -- Denied, no tokens
end
```

**Why Lua scripts**:
- Atomic execution (no race conditions)
- Reduces round-trips (single Redis call instead of multiple)
- Faster than application-level logic

---

## Client Identification

### By IP Address

**Pros**: Simple, no client changes needed
**Cons**: Shared IPs (NAT, proxies) rate-limit entire network

```typescript
const clientId = req.ip;
```

### By API Key

**Pros**: Accurate per-user tracking
**Cons**: Requires authentication

```typescript
const clientId = req.headers['x-api-key'];
```

### By User ID

**Pros**: Fair per-user limits (works across devices)
**Cons**: Requires authentication

```typescript
const clientId = req.user.id;
```

### Composite Keys

**Best practice**: Combine multiple identifiers

```typescript
const clientId = `${req.user?.id || req.ip}:${req.path}`;
// Examples:
//   "user123:/api/users"  (authenticated)
//   "192.168.1.1:/api/users"  (anonymous)
```

---

## Response Headers

Rate limit info in response headers (industry standard):

```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 75
X-RateLimit-Reset: 1640000060
Retry-After: 45
```

**Headers explained**:
- `X-RateLimit-Limit`: Max requests in window
- `X-RateLimit-Remaining`: Requests left
- `X-RateLimit-Reset`: Unix timestamp when limit resets
- `Retry-After`: Seconds until next request allowed

**When rate limited**:
```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1640000060
Retry-After: 45

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 45 seconds."
}
```

---

## Testing

### Stress Testing

**Test script** (`scripts/stress-test.sh`):
```bash
# Send 1000 requests in parallel
seq 1 1000 | xargs -n1 -P100 -I{} curl http://localhost:8080/api/test

# Expected: ~100 succeed, ~900 rejected with 429
```

**Verify rate limiting**:
```bash
# Count 429 responses
grep "429" stress-test.log | wc -l

# Should be ~900 (if limit is 100 req/min)
```

### Unit Tests

**Mock Redis** (`tests/rate-limiter/token-bucket.test.ts`):
```typescript
describe('TokenBucketLimiter', () => {
  let mockRedis: RedisMock;
  let limiter: TokenBucketLimiter;

  beforeEach(() => {
    mockRedis = new RedisMock();
    limiter = new TokenBucketLimiter(mockRedis, 10, 1); // 10 tokens, 1/sec refill
  });

  test('should allow requests within limit', async () => {
    for (let i = 0; i < 10; i++) {
      const allowed = await limiter.checkLimit('client1');
      expect(allowed).toBe(true);
    }

    // 11th request denied
    const allowed = await limiter.checkLimit('client1');
    expect(allowed).toBe(false);
  });

  test('should refill tokens over time', async () => {
    // Use all tokens
    for (let i = 0; i < 10; i++) {
      await limiter.checkLimit('client1');
    }

    // Wait 5 seconds (should refill 5 tokens)
    await sleep(5000);

    // Next 5 requests allowed
    for (let i = 0; i < 5; i++) {
      const allowed = await limiter.checkLimit('client1');
      expect(allowed).toBe(true);
    }
  });
});
```

---

## Monitoring

### Metrics to Track

1. **Rate Limit Hit Rate**: % of requests rejected
   - Too high → Limits too strict, users frustrated
   - Too low → Limits too lenient, wasted capacity

2. **Quota Usage Distribution**: Per-client usage
   - Identify power users vs. occasional users
   - Detect abuse (single client using 80% of quota)

3. **Algorithm Performance**: Redis latency
   - Token Bucket: ~1-2ms
   - Sliding Window: ~2-5ms (depends on window size)
   - Fixed Window: <1ms

### Dashboard Queries

**Top clients by rate limit hits**:
```sql
SELECT client_id, COUNT(*) as rejections
FROM request_metrics
WHERE rate_limited = true
  AND timestamp > NOW() - INTERVAL '1 hour'
GROUP BY client_id
ORDER BY rejections DESC
LIMIT 10;
```

**Rate limit effectiveness**:
```sql
SELECT
  COUNT(*) FILTER (WHERE rate_limited = true) * 100.0 / COUNT(*) as rejection_rate
FROM request_metrics
WHERE timestamp > NOW() - INTERVAL '1 hour';
```

---

## Troubleshooting

### Issue: Legitimate users rate limited

**Symptoms**: Users complain about 429 errors despite normal usage

**Causes**:
1. Shared IP (NAT, corporate proxy)
2. Limits too strict
3. Bug in client (retry loop)

**Solutions**:
1. Use API key instead of IP for identification
2. Increase limits or use token bucket for bursts
3. Add exponential backoff in client

---

### Issue: Rate limiting not working

**Symptoms**: High traffic not rejected, all requests pass through

**Causes**:
1. IP in bypass list (e.g., `127.0.0.1` for localhost)
2. Redis connection failed
3. Middleware not applied

**Debugging**:
```bash
# Check Redis connection
redis-cli PING

# Check bypass IPs
grep "bypass" config/aegis.config.yaml

# Check middleware order
curl -v http://localhost:8080/api/test
# Should see X-RateLimit-* headers
```

---

### Issue: Inconsistent rate limiting

**Symptoms**: Sometimes allowed, sometimes denied with same usage pattern

**Causes**:
1. Multiple gateway instances with separate Redis (not clustered)
2. Clock skew (token bucket refill timing)
3. Race conditions (fixed by Lua scripts)

**Solutions**:
1. Use Redis cluster or single Redis instance
2. Sync server clocks (NTP)
3. Ensure Lua scripts are used (not application-level locking)

---

## Best Practices

### 1. Set Conservative Limits

Start strict, then relax based on data:
```yaml
# Initial launch
limit: 100

# After 1 month of metrics
limit: 250  # 95th percentile usage
```

### 2. Use Tiered Limits

Reward premium users:
```yaml
tiers:
  free: 100
  paid: 1000
  enterprise: 10000
```

### 3. Implement Retry Logic

Client-side exponential backoff:
```javascript
async function callAPI(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const response = await fetch(url);

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      await sleep(retryAfter * 1000);
      continue;
    }

    return response;
  }

  throw new Error('Rate limited after retries');
}
```

### 4. Monitor and Alert

Alert on high rejection rates:
```yaml
alerts:
  - name: HighRateLimitRejections
    condition: rejection_rate > 10%
    message: "Rate limit rejections above 10%"
```

### 5. Document Limits

Inform users in API docs:
```markdown
## Rate Limits

- **Free tier**: 100 requests/hour
- **Pro tier**: 1,000 requests/hour
- **Enterprise**: Custom limits

Rate limit headers included in every response:
- X-RateLimit-Limit
- X-RateLimit-Remaining
- X-RateLimit-Reset
```

---

## Advanced Features

### Dynamic Rate Limiting

Adjust limits based on system load:
```typescript
const systemLoad = await getSystemLoad();
const dynamicLimit = systemLoad > 0.8
  ? baseLimit * 0.5  // Reduce limits under high load
  : baseLimit;
```

### Cost-Based Rate Limiting

Different costs for different operations:
```yaml
rateLimiting:
  costs:
    - path: "/api/reports"
      cost: 10  # Expensive operation
    - path: "/api/users"
      cost: 1   # Cheap operation

  # Client has 100 tokens total
  # GET /api/users uses 1 token
  # GET /api/reports uses 10 tokens
```

### Geographic Rate Limiting

Different limits per region:
```yaml
rateLimiting:
  geographic:
    - region: "us-east"
      limit: 1000
    - region: "eu-west"
      limit: 500
```

---

## References

- [TOKEN_BUCKET Algorithm Paper](https://en.wikipedia.org/wiki/Token_bucket)
- [Stripe Rate Limiting](https://stripe.com/docs/rate-limits)
- [AWS API Gateway Throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)
- [IETF Draft: HTTP Rate Limit Headers](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)

---

For more details, see:
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System design
- [CODE_GUIDE.md](../CODE_GUIDE.md) - Implementation details
- [API Reference](../API_REFERENCE.md) - Rate limit API endpoints
