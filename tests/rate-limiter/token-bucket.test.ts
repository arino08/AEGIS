/**
 * AEGIS - Token Bucket Rate Limiter Tests
 * Comprehensive tests for the token bucket algorithm implementation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock Redis Client
// =============================================================================

interface MockBucket {
  tokens: string;
  last_refill: string;
}

const mockRedisData: Map<string, MockBucket | string> = new Map();

const mockRedis = {
  isConnected: true,
  eval: jest.fn<() => Promise<unknown>>(),
  hset: jest.fn<() => Promise<number>>(),
  get: jest.fn((key: string) => {
    const data = mockRedisData.get(key);
    return Promise.resolve(data as string | null);
  }),
  set: jest.fn((key: string, value: string) => {
    mockRedisData.set(key, value);
    return Promise.resolve();
  }),
  del: jest.fn((key: string | string[]) => {
    const keys = Array.isArray(key) ? key : [key];
    let deleted = 0;
    for (const k of keys) {
      if (mockRedisData.delete(k)) deleted++;
    }
    return Promise.resolve(deleted);
  }),
  exists: jest.fn((key: string | string[]) => {
    const keys = Array.isArray(key) ? key : [key];
    let count = 0;
    for (const k of keys) {
      if (mockRedisData.has(k)) count++;
    }
    return Promise.resolve(count);
  }),
  hget: jest.fn(),
  hgetall: jest.fn((key: string) => {
    const data = mockRedisData.get(key);
    if (data && typeof data === 'object') {
      return Promise.resolve(data);
    }
    return Promise.resolve({});
  }),
  expire: jest.fn(() => Promise.resolve(true)),
  ttl: jest.fn(() => Promise.resolve(3600)),
  keys: jest.fn(() => Promise.resolve([])),
  mget: jest.fn(),
  mset: jest.fn(),
  incr: jest.fn(),
  incrBy: jest.fn(),
  lpush: jest.fn(),
  rpush: jest.fn(),
  lpop: jest.fn(),
  rpop: jest.fn(),
  lrange: jest.fn(),
  llen: jest.fn(),
  sadd: jest.fn(),
  srem: jest.fn(),
  smembers: jest.fn(),
  sismember: jest.fn(),
  zadd: jest.fn(),
  zrange: jest.fn(),
  zrangebyscore: jest.fn(),
  zrem: jest.fn(),
  zremrangebyscore: jest.fn(),
  zcard: jest.fn(),
  flushdb: jest.fn(),
  hdel: jest.fn(),
  hincrby: jest.fn(),
  ping: jest.fn(() => Promise.resolve(true)),
  connect: jest.fn(() => Promise.resolve()),
  disconnect: jest.fn(() => Promise.resolve()),
  client: {} as never,
};

// Mock the redis module
jest.unstable_mockModule('../../src/storage/redis.js', () => ({
  RedisClient: jest.fn(() => mockRedis),
  getRedisClient: jest.fn(() => mockRedis),
  createRedisClient: jest.fn(() => mockRedis),
  default: mockRedis,
}));

// Import after mocking
const { TokenBucketLimiter, createTokenBucketLimiter } =
  await import('../../src/rate-limiter/algorithms/token-bucket.js');

// =============================================================================
// Test Suite
// =============================================================================

describe('TokenBucketLimiter', () => {
  let limiter: InstanceType<typeof TokenBucketLimiter>;

  beforeEach(() => {
    // Clear mock data
    mockRedisData.clear();
    jest.clearAllMocks();

    // Create limiter instance
    limiter = createTokenBucketLimiter(mockRedis as never, {
      maxTokens: 100,
      refillRate: 10,
    });
  });

  afterEach(() => {
    mockRedisData.clear();
  });

  describe('getAlgorithm', () => {
    it('should return "token-bucket"', () => {
      expect(limiter.getAlgorithm()).toBe('token-bucket');
    });
  });

  describe('check', () => {
    it('should allow request when tokens are available', async () => {
      // Mock eval to return allowed result
      mockRedis.eval.mockResolvedValueOnce([1, 99, Date.now() + 100] as unknown);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
        cost: 1,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
      expect(result.limit).toBe(100);
      expect(result.retryAfter).toBe(0);
    });

    it('should deny request when no tokens available', async () => {
      // Mock eval to return denied result
      const resetAt = Date.now() + 5000;
      mockRedis.eval.mockResolvedValueOnce([0, 0, resetAt] as unknown);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
        cost: 1,
      });

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should consume multiple tokens when cost > 1', async () => {
      mockRedis.eval.mockResolvedValueOnce([1, 95, Date.now() + 500] as unknown);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
        cost: 5,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(95);

      // Verify cost was passed to eval
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.arrayContaining(['5'])
      );
    });

    it('should fail open when Redis is unavailable', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis connection failed'));

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
      });

      // Should allow request on error (fail open)
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(100);
    });

    it('should use correct key prefix', async () => {
      mockRedis.eval.mockResolvedValueOnce([1, 99, Date.now() + 100] as unknown);

      await limiter.check({
        key: 'user:123',
        limit: 100,
        windowSeconds: 60,
      });

      // Verify the key includes the prefix
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        ['ratelimit:tb:user:123'],
        expect.any(Array)
      );
    });

    it('should calculate correct refill rate from limit and window', async () => {
      mockRedis.eval.mockResolvedValueOnce([1, 99, Date.now() + 100] as unknown);

      await limiter.check({
        key: 'test:user1',
        limit: 60,
        windowSeconds: 60,
      });

      // Refill rate should be 60/60 = 1 token per second
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.arrayContaining(['1']) // refill rate
      );
    });
  });

  describe('peek', () => {
    it('should return null when key does not exist', async () => {
      mockRedis.exists.mockResolvedValueOnce(0);

      const result = await limiter.peek('nonexistent:key');

      expect(result).toBeNull();
    });

    it('should return current state without consuming tokens', async () => {
      mockRedis.exists.mockResolvedValueOnce(1);
      mockRedis.eval.mockResolvedValueOnce([50, Date.now() + 5000] as unknown);

      const result = await limiter.peek('existing:key');

      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(50);
      expect(result!.remaining).toBe(50);
    });

    it('should handle errors gracefully', async () => {
      mockRedis.exists.mockResolvedValueOnce(1);
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis error'));

      const result = await limiter.peek('test:key');

      expect(result).toBeNull();
    });
  });

  describe('reset', () => {
    it('should delete the bucket key', async () => {
      mockRedis.eval.mockResolvedValueOnce(1 as unknown);

      await limiter.reset('test:user1');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        ['ratelimit:tb:test:user1'],
        []
      );
    });

    it('should throw on Redis error', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis error'));

      await expect(limiter.reset('test:user1')).rejects.toThrow('Redis error');
    });
  });

  describe('checkMultiple', () => {
    it('should check multiple keys in parallel', async () => {
      mockRedis.eval
        .mockResolvedValueOnce([1, 99, Date.now() + 100] as unknown)
        .mockResolvedValueOnce([1, 49, Date.now() + 200] as unknown)
        .mockResolvedValueOnce([0, 0, Date.now() + 1000] as unknown);

      const requests = [
        { key: 'user:1', limit: 100, windowSeconds: 60 },
        { key: 'user:2', limit: 50, windowSeconds: 60 },
        { key: 'user:3', limit: 10, windowSeconds: 60 },
      ];

      const results = await limiter.checkMultiple(requests);

      expect(results.size).toBe(3);
      expect(results.get('user:1')?.allowed).toBe(true);
      expect(results.get('user:2')?.allowed).toBe(true);
      expect(results.get('user:3')?.allowed).toBe(false);
    });
  });

  describe('getBucketState', () => {
    it('should return bucket state from Redis', async () => {
      mockRedisData.set('ratelimit:tb:test:key', {
        tokens: '75.5',
        last_refill: '1234567890123',
      });

      const state = await limiter.getBucketState('test:key');

      expect(state).not.toBeNull();
      expect(state!.tokens).toBe(75.5);
      expect(state!.lastRefill).toBe(1234567890123);
    });

    it('should return null for non-existent bucket', async () => {
      mockRedis.hgetall.mockResolvedValueOnce({});

      const state = await limiter.getBucketState('nonexistent');

      expect(state).toBeNull();
    });
  });

  describe('setBucketState', () => {
    it('should set bucket tokens and refill time', async () => {
      mockRedis.hset.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(true);

      await limiter.setBucketState('test:key', 50);

      expect(mockRedis.hset).toHaveBeenCalledWith('ratelimit:tb:test:key', 'tokens', '50');
      expect(mockRedis.expire).toHaveBeenCalled();
    });
  });

  describe('rate limiting scenarios', () => {
    it('should handle burst traffic', async () => {
      // Simulate 10 rapid requests
      const responses: boolean[] = [];

      for (let i = 0; i < 10; i++) {
        // First 5 allowed, rest denied
        const allowed = i < 5 ? 1 : 0;
        const remaining = Math.max(0, 4 - i);
        mockRedis.eval.mockResolvedValueOnce([allowed, remaining, Date.now() + 1000] as unknown);

        const result = await limiter.check({
          key: 'burst:test',
          limit: 5,
          windowSeconds: 60,
        });

        responses.push(result.allowed);
      }

      // First 5 should be allowed
      expect(responses.slice(0, 5).every((r) => r)).toBe(true);
      // Rest should be denied
      expect(responses.slice(5).every((r) => !r)).toBe(true);
    });

    it('should handle different cost values', async () => {
      // Request with cost of 10 against limit of 100
      mockRedis.eval.mockResolvedValueOnce([1, 90, Date.now() + 1000] as unknown);

      const result = await limiter.check({
        key: 'cost:test',
        limit: 100,
        windowSeconds: 60,
        cost: 10,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(90);
    });

    it('should calculate retryAfter correctly', async () => {
      const now = Date.now();
      const resetAt = now + 30000; // 30 seconds from now
      mockRedis.eval.mockResolvedValueOnce([0, 0, resetAt] as unknown);

      const result = await limiter.check({
        key: 'retry:test',
        limit: 10,
        windowSeconds: 60,
      });

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
      // Allow for small timing variations (30 +/- 2 seconds)
      expect(result.retryAfter).toBeLessThanOrEqual(32);
    });
  });
});

describe('createTokenBucketLimiter factory', () => {
  it('should create limiter with default config', () => {
    const limiter = createTokenBucketLimiter(mockRedis as never);
    expect(limiter).toBeInstanceOf(TokenBucketLimiter);
    expect(limiter.getAlgorithm()).toBe('token-bucket');
  });

  it('should create limiter with custom config', () => {
    const limiter = createTokenBucketLimiter(
      mockRedis as never,
      { maxTokens: 500, refillRate: 50 },
      'custom:prefix:'
    );
    expect(limiter).toBeInstanceOf(TokenBucketLimiter);
  });
});
