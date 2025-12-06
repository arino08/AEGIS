/**
 * AEGIS - Redis Lua Scripts for Rate Limiting
 * Atomic operations for distributed rate limiting algorithms
 */

// =============================================================================
// Token Bucket Lua Script
// =============================================================================

/**
 * Token Bucket Algorithm Lua Script
 *
 * Implements a distributed token bucket with atomic operations.
 * Tokens refill at a constant rate up to a maximum capacity.
 *
 * KEYS[1] - The bucket key
 * ARGV[1] - Max tokens (bucket capacity)
 * ARGV[2] - Refill rate (tokens per second)
 * ARGV[3] - Current timestamp (milliseconds)
 * ARGV[4] - Tokens to consume (cost)
 * ARGV[5] - TTL for the key (seconds)
 *
 * Returns: [allowed (0/1), current_tokens, reset_timestamp]
 */
export const TOKEN_BUCKET_SCRIPT = `
local bucket_key = KEYS[1]
local max_tokens = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

-- Get current bucket state
local bucket = redis.call('HMGET', bucket_key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

-- Initialize bucket if it doesn't exist
if tokens == nil then
  tokens = max_tokens
  last_refill = now
end

-- Calculate time elapsed and tokens to add
local elapsed_ms = now - last_refill
local elapsed_seconds = elapsed_ms / 1000
local tokens_to_add = elapsed_seconds * refill_rate

-- Refill bucket (cap at max_tokens)
tokens = math.min(max_tokens, tokens + tokens_to_add)

-- Calculate reset time (time until bucket is full)
local tokens_needed = max_tokens - tokens
local seconds_to_full = 0
if tokens_needed > 0 and refill_rate > 0 then
  seconds_to_full = tokens_needed / refill_rate
end
local reset_at = now + (seconds_to_full * 1000)

-- Check if we have enough tokens
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

-- Update bucket state
redis.call('HMSET', bucket_key, 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', bucket_key, ttl)

return {allowed, math.floor(tokens * 1000) / 1000, math.floor(reset_at)}
`;

// =============================================================================
// Sliding Window Log Lua Script
// =============================================================================

/**
 * Sliding Window Log Algorithm Lua Script
 *
 * Uses a sorted set to track request timestamps.
 * Counts requests within a rolling time window.
 *
 * KEYS[1] - The window key (sorted set)
 * ARGV[1] - Max requests allowed
 * ARGV[2] - Window size (milliseconds)
 * ARGV[3] - Current timestamp (milliseconds)
 * ARGV[4] - Unique request ID
 * ARGV[5] - Request weight/cost
 *
 * Returns: [allowed (0/1), current_count, reset_timestamp]
 */
export const SLIDING_WINDOW_LOG_SCRIPT = `
local window_key = KEYS[1]
local max_requests = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local request_id = ARGV[4]
local weight = tonumber(ARGV[5]) or 1

-- Calculate window boundaries
local window_start = now - window_ms

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', window_key, '-inf', window_start)

-- Count current requests in window
local current_count = redis.call('ZCARD', window_key)

-- Calculate reset time (oldest entry + window size)
local oldest = redis.call('ZRANGE', window_key, 0, 0, 'WITHSCORES')
local reset_at = now + window_ms
if #oldest > 0 then
  reset_at = tonumber(oldest[2]) + window_ms
end

-- Check if we can add more requests
local allowed = 0
if current_count + weight <= max_requests then
  -- Add the request(s) to the window
  for i = 1, weight do
    local member = request_id .. ':' .. i .. ':' .. now
    redis.call('ZADD', window_key, now, member)
  end
  current_count = current_count + weight
  allowed = 1
end

-- Set TTL on the window (window_ms converted to seconds + buffer)
local ttl_seconds = math.ceil(window_ms / 1000) + 1
redis.call('EXPIRE', window_key, ttl_seconds)

return {allowed, current_count, math.floor(reset_at)}
`;

// =============================================================================
// Sliding Window Counter Lua Script
// =============================================================================

/**
 * Sliding Window Counter Algorithm Lua Script
 *
 * A more memory-efficient sliding window using two fixed windows
 * and weighted interpolation for smoother rate limiting.
 *
 * KEYS[1] - Previous window key
 * KEYS[2] - Current window key
 * ARGV[1] - Max requests allowed
 * ARGV[2] - Window size (seconds)
 * ARGV[3] - Current timestamp (seconds)
 * ARGV[4] - Request weight/cost
 *
 * Returns: [allowed (0/1), weighted_count, reset_timestamp]
 */
export const SLIDING_WINDOW_COUNTER_SCRIPT = `
local prev_key = KEYS[1]
local curr_key = KEYS[2]
local max_requests = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local weight = tonumber(ARGV[4]) or 1

-- Calculate current window boundaries
local current_window = math.floor(now / window_seconds) * window_seconds
local window_progress = (now - current_window) / window_seconds

-- Get counts from both windows
local prev_count = tonumber(redis.call('GET', prev_key)) or 0
local curr_count = tonumber(redis.call('GET', curr_key)) or 0

-- Calculate weighted count using linear interpolation
-- Weight of previous window decreases as we progress through current window
local weighted_count = (prev_count * (1 - window_progress)) + curr_count

-- Calculate reset time
local reset_at = current_window + window_seconds

-- Check if request is allowed
local allowed = 0
if weighted_count + weight <= max_requests then
  -- Increment current window counter
  redis.call('INCRBY', curr_key, weight)
  curr_count = curr_count + weight

  -- Set TTL (2 windows to keep previous window data)
  redis.call('EXPIRE', curr_key, window_seconds * 2)

  allowed = 1
  weighted_count = weighted_count + weight
end

return {allowed, math.floor(weighted_count * 100) / 100, reset_at}
`;

// =============================================================================
// Fixed Window Counter Lua Script
// =============================================================================

/**
 * Fixed Window Counter Algorithm Lua Script
 *
 * Simple counter that resets at fixed intervals.
 * Less accurate at window boundaries but very efficient.
 *
 * KEYS[1] - The counter key
 * ARGV[1] - Max requests allowed
 * ARGV[2] - Window size (seconds)
 * ARGV[3] - Request weight/cost
 *
 * Returns: [allowed (0/1), current_count, ttl_remaining]
 */
export const FIXED_WINDOW_SCRIPT = `
local counter_key = KEYS[1]
local max_requests = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local weight = tonumber(ARGV[3]) or 1

-- Get current count
local current = tonumber(redis.call('GET', counter_key)) or 0

-- Get TTL (returns -2 if key doesn't exist, -1 if no TTL)
local ttl = redis.call('TTL', counter_key)
if ttl < 0 then
  ttl = window_seconds
end

-- Check if request is allowed
local allowed = 0
if current + weight <= max_requests then
  -- Increment counter
  local new_count = redis.call('INCRBY', counter_key, weight)

  -- Set expiry if this is a new window
  if new_count == weight then
    redis.call('EXPIRE', counter_key, window_seconds)
    ttl = window_seconds
  end

  current = new_count
  allowed = 1
else
  current = current
end

return {allowed, current, ttl}
`;

// =============================================================================
// Peek Scripts (Check without consuming)
// =============================================================================

/**
 * Token Bucket Peek Script
 * Check current token count without consuming
 *
 * KEYS[1] - The bucket key
 * ARGV[1] - Max tokens
 * ARGV[2] - Refill rate
 * ARGV[3] - Current timestamp (milliseconds)
 *
 * Returns: [current_tokens, reset_timestamp]
 */
export const TOKEN_BUCKET_PEEK_SCRIPT = `
local bucket_key = KEYS[1]
local max_tokens = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', bucket_key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

if tokens == nil then
  return {max_tokens, now}
end

local elapsed_ms = now - last_refill
local elapsed_seconds = elapsed_ms / 1000
local tokens_to_add = elapsed_seconds * refill_rate
tokens = math.min(max_tokens, tokens + tokens_to_add)

local tokens_needed = max_tokens - tokens
local seconds_to_full = 0
if tokens_needed > 0 and refill_rate > 0 then
  seconds_to_full = tokens_needed / refill_rate
end
local reset_at = now + (seconds_to_full * 1000)

return {math.floor(tokens * 1000) / 1000, math.floor(reset_at)}
`;

/**
 * Sliding Window Peek Script
 * Check current count without adding
 *
 * KEYS[1] - The window key
 * ARGV[1] - Window size (milliseconds)
 * ARGV[2] - Current timestamp (milliseconds)
 *
 * Returns: [current_count, reset_timestamp]
 */
export const SLIDING_WINDOW_PEEK_SCRIPT = `
local window_key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local now = tonumber(ARGV[2])

local window_start = now - window_ms
redis.call('ZREMRANGEBYSCORE', window_key, '-inf', window_start)

local current_count = redis.call('ZCARD', window_key)

local oldest = redis.call('ZRANGE', window_key, 0, 0, 'WITHSCORES')
local reset_at = now + window_ms
if #oldest > 0 then
  reset_at = tonumber(oldest[2]) + window_ms
end

return {current_count, math.floor(reset_at)}
`;

/**
 * Fixed Window Peek Script
 * Check current count without incrementing
 *
 * KEYS[1] - The counter key
 *
 * Returns: [current_count, ttl_remaining]
 */
export const FIXED_WINDOW_PEEK_SCRIPT = `
local counter_key = KEYS[1]

local current = tonumber(redis.call('GET', counter_key)) or 0
local ttl = redis.call('TTL', counter_key)
if ttl < 0 then
  ttl = 0
end

return {current, ttl}
`;

// =============================================================================
// Reset Scripts
// =============================================================================

/**
 * Reset a rate limit key
 * Works for all algorithms
 *
 * KEYS[1] - The key to reset
 *
 * Returns: 1 if deleted, 0 if key didn't exist
 */
export const RESET_KEY_SCRIPT = `
return redis.call('DEL', KEYS[1])
`;

/**
 * Reset multiple keys matching a pattern
 * Use with caution in production
 *
 * KEYS[1] - Pattern to match (e.g., "ratelimit:user:123:*")
 * ARGV[1] - Max keys to delete (safety limit)
 *
 * Returns: Number of keys deleted
 */
export const RESET_PATTERN_SCRIPT = `
local pattern = KEYS[1]
local max_keys = tonumber(ARGV[1]) or 1000

local cursor = "0"
local deleted = 0

repeat
  local result = redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100)
  cursor = result[1]
  local keys = result[2]

  for i, key in ipairs(keys) do
    if deleted >= max_keys then
      return deleted
    end
    redis.call('DEL', key)
    deleted = deleted + 1
  end
until cursor == "0"

return deleted
`;

// =============================================================================
// Batch Check Script
// =============================================================================

/**
 * Check multiple rate limits in one call
 * Useful for checking IP + user + endpoint limits together
 *
 * KEYS - Array of keys to check
 * ARGV[1] - Algorithm type (1=token-bucket, 2=fixed-window)
 * ARGV[2] - Max requests/tokens
 * ARGV[3] - Window seconds / refill rate
 * ARGV[4] - Current timestamp (ms for token bucket, seconds for fixed)
 * ARGV[5] - Cost per request
 *
 * Returns: Array of [allowed, remaining, reset] for each key
 */
export const BATCH_CHECK_SCRIPT = `
local algorithm = tonumber(ARGV[1])
local max_limit = tonumber(ARGV[2])
local window_or_rate = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local cost = tonumber(ARGV[5]) or 1

local results = {}

for i, key in ipairs(KEYS) do
  local allowed, remaining, reset

  if algorithm == 1 then
    -- Token bucket
    local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1]) or max_limit
    local last_refill = tonumber(bucket[2]) or now

    local elapsed_ms = now - last_refill
    local elapsed_seconds = elapsed_ms / 1000
    tokens = math.min(max_limit, tokens + (elapsed_seconds * window_or_rate))

    if tokens >= cost then
      tokens = tokens - cost
      allowed = 1
    else
      allowed = 0
    end

    remaining = math.floor(tokens)
    reset = now + ((max_limit - tokens) / window_or_rate * 1000)

    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, 3600)
  else
    -- Fixed window
    local current = tonumber(redis.call('GET', key)) or 0
    local ttl = redis.call('TTL', key)
    if ttl < 0 then ttl = window_or_rate end

    if current + cost <= max_limit then
      current = redis.call('INCRBY', key, cost)
      if current == cost then
        redis.call('EXPIRE', key, window_or_rate)
        ttl = window_or_rate
      end
      allowed = 1
    else
      allowed = 0
    end

    remaining = max_limit - current
    reset = now + ttl
  end

  table.insert(results, {allowed, remaining, math.floor(reset)})
end

return results
`;

// =============================================================================
// Script Registry
// =============================================================================

export const SCRIPTS = {
  tokenBucket: TOKEN_BUCKET_SCRIPT,
  tokenBucketPeek: TOKEN_BUCKET_PEEK_SCRIPT,
  slidingWindowLog: SLIDING_WINDOW_LOG_SCRIPT,
  slidingWindowCounter: SLIDING_WINDOW_COUNTER_SCRIPT,
  slidingWindowPeek: SLIDING_WINDOW_PEEK_SCRIPT,
  fixedWindow: FIXED_WINDOW_SCRIPT,
  fixedWindowPeek: FIXED_WINDOW_PEEK_SCRIPT,
  resetKey: RESET_KEY_SCRIPT,
  resetPattern: RESET_PATTERN_SCRIPT,
  batchCheck: BATCH_CHECK_SCRIPT,
} as const;

export type ScriptName = keyof typeof SCRIPTS;
