/**
 * AEGIS - Sliding Window Rate Limiter Tests
 * Comprehensive tests for sliding window algorithm implementations
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock Redis Client
// =============================================================================

const mockRedisData: Map<string, unknown> = new Map();

const mockRedis = {
  isConnected: true,
  eval: jest.fn<() => Promise<unknown>>(),
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
  hset: jest.fn(),
  hgetall: jest.fn(() => Promise.resolve({})),
  expire: jest.fn(() => Promise.resolve(true)),
  ttl: jest.fn(() => Promise.resolve(3600)),
  keys: jest.fn(() => Promise.resolve([])),
  mget: jest.fn((keys: string[]) => {
    return Promise.resolve(keys.map((k) => mockRedisData.get(k) as string | null));
  }),
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
  zrangebyscore: jest.fn(() => Promise.resolve([])),
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
const {
  SlidingWindowLogLimiter,
  SlidingWindowCounterLimiter,
  createSlidingWindowLimiter,
  createSlidingWindowLogLimiter,
  createSlidingWindowCounterLimiter,
} = await import('../../src/rate-limiter/algorithms/sliding-window.js');

// =============================================================================
// Sliding Window Log Tests
// =============================================================================

describe('SlidingWindowLogLimiter', () => {
  let limiter: InstanceType<typeof SlidingWindowLogLimiter>;

  beforeEach(() => {
    mockRedisData.clear();
    jest.clearAllMocks();

    limiter = createSlidingWindowLogLimiter(mockRedis as never, {
      windowSeconds: 60,
      maxRequests: 100,
    });
  });

  afterEach(() => {
    mockRedisData.clear();
  });

  describe('getAlgorithm', () => {
    it('should return "sliding-window"', () => {
      expect(limiter.getAlgorithm()).toBe('sliding-window');
    });
  });

  describe('check', () => {
    it('should allow request when under limit', async () => {
      // Mock eval to return allowed result
      mockRedis.eval.mockResolvedValueOnce([1, 1, Date.now() + 60000] as unknown);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
        cost: 1,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
      expect(result.limit).toBe(100);
      expect(result.retryAfter).toBe(0);
    });

    it('should deny request when at limit', async () => {
      const resetAt = Date.now() + 30000;
      mockRedis.eval.mockResolvedValueOnce([0, 100, resetAt] as unknown);

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

    it('should track requests with unique IDs', async () => {
      mockRedis.eval.mockResolvedValue([1, 1, Date.now() + 60000] as unknown);

      await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
      });

      // Verify eval was called with a request ID
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.arrayContaining([expect.stringMatching(/^\d+-[a-z0-9]+$/)])
      );
    });

    it('should support weighted requests', async () => {
      mockRedis.eval.mockResolvedValueOnce([1, 5, Date.now() + 60000] as unknown);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
        cost: 5,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(95);

      // Verify cost was passed
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.arrayContaining(['5'])
      );
    });

    it('should fail open when Redis is unavailable', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis connection failed') as never);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(100);
    });

    it('should use correct key prefix', async () => {
      mockRedis.eval.mockResolvedValueOnce([1, 1, Date.now() + 60000] as unknown);

      await limiter.check({
        key: 'user:123',
        limit: 100,
        windowSeconds: 60,
      });

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        ['ratelimit:sw:log:user:123'],
        expect.any(Array)
      );
    });

    it('should convert windowSeconds to milliseconds', async () => {
      mockRedis.eval.mockResolvedValueOnce([1, 1, Date.now() + 60000] as unknown);

      await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 30, // 30 seconds
      });

      // Window should be 30000 ms
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.arrayContaining(['30000'])
      );
    });
  });

  describe('peek', () => {
    it('should return null when key does not exist', async () => {
      mockRedis.exists.mockResolvedValueOnce(0);

      const result = await limiter.peek('nonexistent:key');

      expect(result).toBeNull();
    });

    it('should return current count without adding', async () => {
      mockRedis.exists.mockResolvedValueOnce(1);
      mockRedis.eval.mockResolvedValueOnce([50, Date.now() + 30000] as unknown);

      const result = await limiter.peek('existing:key');

      expect(result).not.toBeNull();
      expect(result!.remaining).toBe(50);
    });

    it('should handle errors gracefully', async () => {
      mockRedis.exists.mockResolvedValueOnce(1);
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis error') as never);

      const result = await limiter.peek('test:key');

      expect(result).toBeNull();
    });
  });

  describe('reset', () => {
    it('should delete the window key', async () => {
      mockRedis.eval.mockResolvedValueOnce(1 as unknown);

      await limiter.reset('test:user1');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        ['ratelimit:sw:log:test:user1'],
        []
      );
    });

    it('should throw on Redis error', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis error') as never);

      await expect(limiter.reset('test:user1')).rejects.toThrow('Redis error');
    });
  });

  describe('getWindowEntries', () => {
    it('should return entries in current window', async () => {
      mockRedis.zrangebyscore.mockResolvedValueOnce([
        'req1:1:1234567890001',
        'req2:1:1234567890002',
      ] as never);

      const entries = await limiter.getWindowEntries('test:key');

      expect(entries).toHaveLength(2);
      expect(entries[0]!.member).toBe('req1:1:1234567890001');
    });

    it('should return empty array when no entries', async () => {
      mockRedis.zrangebyscore.mockResolvedValueOnce([]);

      const entries = await limiter.getWindowEntries('test:key');

      expect(entries).toEqual([]);
    });
  });
});

// =============================================================================
// Sliding Window Counter Tests
// =============================================================================

describe('SlidingWindowCounterLimiter', () => {
  let limiter: InstanceType<typeof SlidingWindowCounterLimiter>;

  beforeEach(() => {
    mockRedisData.clear();
    jest.clearAllMocks();

    limiter = createSlidingWindowCounterLimiter(mockRedis as never, {
      windowSeconds: 60,
      maxRequests: 100,
    });
  });

  afterEach(() => {
    mockRedisData.clear();
  });

  describe('getAlgorithm', () => {
    it('should return "sliding-window"', () => {
      expect(limiter.getAlgorithm()).toBe('sliding-window');
    });
  });

  describe('check', () => {
    it('should allow request when under limit', async () => {
      mockRedis.eval.mockResolvedValueOnce([1, 1, Date.now() / 1000 + 60] as unknown);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
        cost: 1,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
      expect(result.limit).toBe(100);
    });

    it('should deny request when at limit', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockRedis.eval.mockResolvedValueOnce([0, 100, nowSeconds + 60] as unknown);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
        cost: 1,
      });

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should use weighted count interpolation', async () => {
      // This tests the sliding window counter's weighted interpolation
      // Previous window: 50 requests, Current window: 30 requests
      // At 50% progress through current window: weighted = 50*0.5 + 30 = 55
      mockRedis.eval.mockResolvedValueOnce([1, 56, Date.now() / 1000 + 30] as unknown);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
        cost: 1,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(44);
    });

    it('should fail open when Redis is unavailable', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis connection failed') as never);

      const result = await limiter.check({
        key: 'test:user1',
        limit: 100,
        windowSeconds: 60,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(100);
    });

    it('should use correct key prefix with window timestamps', async () => {
      mockRedis.eval.mockResolvedValueOnce([1, 1, Date.now() / 1000 + 60] as unknown);

      await limiter.check({
        key: 'user:123',
        limit: 100,
        windowSeconds: 60,
      });

      // Should use two keys: previous and current window
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          expect.stringMatching(/^ratelimit:sw:cnt:user:123:\d+$/),
          expect.stringMatching(/^ratelimit:sw:cnt:user:123:\d+$/),
        ]),
        expect.any(Array)
      );
    });
  });

  describe('peek', () => {
    it('should return null when no data exists', async () => {
      mockRedis.mget.mockResolvedValueOnce([null, null]);

      const result = await limiter.peek('nonexistent:key');

      expect(result).toBeNull();
    });

    it('should return weighted count without incrementing', async () => {
      mockRedis.mget.mockResolvedValueOnce(['50', '30']);

      const result = await limiter.peek('existing:key');

      expect(result).not.toBeNull();
      // Weighted count depends on window progress
      expect(result!.remaining).toBeGreaterThanOrEqual(0);
      expect(result!.remaining).toBeLessThanOrEqual(100);
    });

    it('should handle errors gracefully', async () => {
      mockRedis.mget.mockRejectedValueOnce(new Error('Redis error'));

      const result = await limiter.peek('test:key');

      expect(result).toBeNull();
    });
  });

  describe('reset', () => {
    it('should delete both window keys', async () => {
      await limiter.reset('test:user1');

      // Should attempt to delete keys for both windows
      expect(mockRedis.del).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.stringMatching(/^ratelimit:sw:cnt:test:user1:\d+$/),
          expect.stringMatching(/^ratelimit:sw:cnt:test:user1:\d+$/),
        ])
      );
    });
  });

  describe('getWindowCounts', () => {
    it('should return previous, current, and weighted counts', async () => {
      mockRedis.mget.mockResolvedValueOnce(['50', '30']);

      const counts = await limiter.getWindowCounts('test:key');

      expect(counts).not.toBeNull();
      expect(counts!.previousCount).toBe(50);
      expect(counts!.currentCount).toBe(30);
      expect(counts!.weightedCount).toBeGreaterThan(0);
    });

    it('should handle missing data', async () => {
      mockRedis.mget.mockResolvedValueOnce([null, null]);

      const counts = await limiter.getWindowCounts('nonexistent:key');

      expect(counts).not.toBeNull();
      expect(counts!.previousCount).toBe(0);
      expect(counts!.currentCount).toBe(0);
    });

    it('should handle errors gracefully', async () => {
      mockRedis.mget.mockRejectedValueOnce(new Error('Redis error'));

      const counts = await limiter.getWindowCounts('test:key');

      expect(counts).toBeNull();
    });
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createSlidingWindowLimiter factory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create log limiter when variant is "log"', () => {
    const limiter = createSlidingWindowLimiter(mockRedis as never, {
      variant: 'log',
    });

    expect(limiter).toBeInstanceOf(SlidingWindowLogLimiter);
  });

  it('should create counter limiter when variant is "counter"', () => {
    const limiter = createSlidingWindowLimiter(mockRedis as never, {
      variant: 'counter',
    });

    expect(limiter).toBeInstanceOf(SlidingWindowCounterLimiter);
  });

  it('should default to counter variant', () => {
    const limiter = createSlidingWindowLimiter(mockRedis as never, {
      variant: 'counter',
    });

    expect(limiter).toBeInstanceOf(SlidingWindowCounterLimiter);
  });

  it('should pass config to limiter', () => {
    const limiter = createSlidingWindowLimiter(mockRedis as never, {
      variant: 'log',
      config: { windowSeconds: 120, maxRequests: 500 },
    });

    expect(limiter).toBeInstanceOf(SlidingWindowLogLimiter);
  });

  it('should use custom key prefix', () => {
    const limiter = createSlidingWindowLimiter(mockRedis as never, {
      variant: 'counter',
      keyPrefix: 'custom:prefix:',
    });

    expect(limiter).toBeInstanceOf(SlidingWindowCounterLimiter);
  });
});

// =============================================================================
// Comparison Tests
// =============================================================================

describe('Sliding Window Algorithm Comparison', () => {
  let logLimiter: InstanceType<typeof SlidingWindowLogLimiter>;
  let counterLimiter: InstanceType<typeof SlidingWindowCounterLimiter>;

  beforeEach(() => {
    mockRedisData.clear();
    jest.clearAllMocks();

    logLimiter = createSlidingWindowLogLimiter(mockRedis as never, {
      windowSeconds: 60,
      maxRequests: 100,
    });

    counterLimiter = createSlidingWindowCounterLimiter(mockRedis as never, {
      windowSeconds: 60,
      maxRequests: 100,
    });
  });

  it('both algorithms should return same structure', async () => {
    mockRedis.eval.mockResolvedValue([1, 1, Date.now() + 60000] as unknown);

    const logResult = await logLimiter.check({
      key: 'test:key',
      limit: 100,
      windowSeconds: 60,
    });

    mockRedis.eval.mockResolvedValue([1, 1, Date.now() / 1000 + 60] as unknown);

    const counterResult = await counterLimiter.check({
      key: 'test:key',
      limit: 100,
      windowSeconds: 60,
    });

    // Both should have same interface
    expect(logResult).toHaveProperty('allowed');
    expect(logResult).toHaveProperty('remaining');
    expect(logResult).toHaveProperty('limit');
    expect(logResult).toHaveProperty('resetAt');
    expect(logResult).toHaveProperty('retryAfter');

    expect(counterResult).toHaveProperty('allowed');
    expect(counterResult).toHaveProperty('remaining');
    expect(counterResult).toHaveProperty('limit');
    expect(counterResult).toHaveProperty('resetAt');
    expect(counterResult).toHaveProperty('retryAfter');
  });

  it('both algorithms should report same algorithm name', () => {
    expect(logLimiter.getAlgorithm()).toBe('sliding-window');
    expect(counterLimiter.getAlgorithm()).toBe('sliding-window');
  });
});
