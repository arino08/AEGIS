/**
 * AEGIS - Metrics Collector Tests
 *
 * Tests for the metrics collection system including batching,
 * aggregation, and real-time stats.
 */

import { MetricsCollector } from '../../src/monitoring/collector';
import type { RequestMetric, RateLimitMetric, BackendMetric } from '../../src/monitoring/types';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector({
      enabled: true,
      flushIntervalMs: 10000, // Long interval so we control flushes
      batchSize: 10,
      retentionDays: 30,
      enabledMetrics: {
        requests: true,
        rateLimits: true,
        backends: true,
        system: true,
      },
    });
  });

  afterEach(async () => {
    await collector.shutdown();
  });

  describe('recordRequest', () => {
    it('should record a request metric', () => {
      const metric: RequestMetric = {
        timestamp: new Date(),
        requestId: 'req-123',
        path: '/api/test',
        method: 'GET',
        statusCode: 200,
        duration: 100,
        ip: '127.0.0.1',
      };

      collector.recordRequest(metric);

      const stats = collector.getStats();
      expect(stats.batchSizes.requests).toBe(1);
      expect(stats.realtimeCounters.totalRequests).toBe(1);
      expect(stats.realtimeCounters.successfulRequests).toBe(1);
    });

    it('should track failed requests', () => {
      const metric: RequestMetric = {
        timestamp: new Date(),
        requestId: 'req-456',
        path: '/api/error',
        method: 'POST',
        statusCode: 500,
        duration: 50,
        ip: '127.0.0.1',
      };

      collector.recordRequest(metric);

      const stats = collector.getStats();
      expect(stats.realtimeCounters.failedRequests).toBe(1);
    });

    it('should track rate limited requests', () => {
      const metric: RequestMetric = {
        timestamp: new Date(),
        requestId: 'req-789',
        path: '/api/limited',
        method: 'GET',
        statusCode: 429,
        duration: 10,
        ip: '127.0.0.1',
        rateLimited: true,
      };

      collector.recordRequest(metric);

      const stats = collector.getStats();
      expect(stats.realtimeCounters.rateLimitedRequests).toBe(1);
    });

    it('should track cached responses', () => {
      const metric: RequestMetric = {
        timestamp: new Date(),
        requestId: 'req-abc',
        path: '/api/cached',
        method: 'GET',
        statusCode: 200,
        duration: 5,
        ip: '127.0.0.1',
        cached: true,
      };

      collector.recordRequest(metric);

      const stats = collector.getStats();
      expect(stats.realtimeCounters.cachedResponses).toBe(1);
    });

    it('should not record when disabled', () => {
      const disabledCollector = new MetricsCollector({
        enabled: false,
      });

      const metric: RequestMetric = {
        timestamp: new Date(),
        requestId: 'req-disabled',
        path: '/api/test',
        method: 'GET',
        statusCode: 200,
        duration: 100,
        ip: '127.0.0.1',
      };

      disabledCollector.recordRequest(metric);

      const stats = disabledCollector.getStats();
      expect(stats.batchSizes.requests).toBe(0);
      expect(stats.realtimeCounters.totalRequests).toBe(0);
    });
  });

  describe('recordRateLimit', () => {
    it('should record a rate limit metric', () => {
      const metric: RateLimitMetric = {
        timestamp: new Date(),
        key: 'ip:127.0.0.1',
        endpoint: '/api/test',
        allowed: true,
        remaining: 99,
        limit: 100,
        ip: '127.0.0.1',
        algorithm: 'token-bucket',
      };

      collector.recordRateLimit(metric);

      const stats = collector.getStats();
      expect(stats.batchSizes.rateLimits).toBe(1);
    });
  });

  describe('recordBackend', () => {
    it('should record a backend health metric', () => {
      const metric: BackendMetric = {
        timestamp: new Date(),
        backend: 'api-service',
        healthy: true,
        responseTime: 50,
        consecutiveFailures: 0,
        consecutiveSuccesses: 10,
      };

      collector.recordBackend(metric);

      const stats = collector.getStats();
      expect(stats.batchSizes.backends).toBe(1);
    });
  });

  describe('record (generic)', () => {
    it('should record increment metrics', () => {
      collector.increment('custom_counter', { env: 'test' });
      // Just verify it doesn't throw
    });

    it('should record gauge metrics', () => {
      collector.gauge('custom_gauge', 42, { env: 'test' });
      // Just verify it doesn't throw
    });

    it('should record timing metrics', () => {
      collector.timing('custom_timing', 123, { env: 'test' });
      // Just verify it doesn't throw
    });

    it('should record histogram metrics', () => {
      collector.histogram('custom_histogram', 567, { env: 'test' });
      // Just verify it doesn't throw
    });
  });

  describe('setActiveConnections', () => {
    it('should update active connections gauge', () => {
      collector.setActiveConnections(10);

      const stats = collector.getStats();
      expect(stats.realtimeCounters.activeConnections).toBe(10);
    });
  });

  describe('resetCounters', () => {
    it('should reset all counters', () => {
      // Record some metrics first
      collector.recordRequest({
        timestamp: new Date(),
        requestId: 'req-1',
        path: '/api/test',
        method: 'GET',
        statusCode: 200,
        duration: 100,
        ip: '127.0.0.1',
      });

      collector.setActiveConnections(5);

      // Verify counters are set
      let stats = collector.getStats();
      expect(stats.realtimeCounters.totalRequests).toBe(1);
      expect(stats.realtimeCounters.activeConnections).toBe(5);

      // Reset
      collector.resetCounters();

      // Verify counters are reset
      stats = collector.getStats();
      expect(stats.realtimeCounters.totalRequests).toBe(0);
      expect(stats.realtimeCounters.successfulRequests).toBe(0);
      expect(stats.realtimeCounters.failedRequests).toBe(0);
      expect(stats.realtimeCounters.rateLimitedRequests).toBe(0);
      expect(stats.realtimeCounters.cachedResponses).toBe(0);
      expect(stats.realtimeCounters.totalDuration).toBe(0);
      expect(stats.realtimeCounters.activeConnections).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return current stats', () => {
      const stats = collector.getStats();

      expect(stats).toHaveProperty('batchSizes');
      expect(stats).toHaveProperty('realtimeCounters');
      expect(stats).toHaveProperty('config');

      expect(stats.batchSizes).toHaveProperty('requests');
      expect(stats.batchSizes).toHaveProperty('rateLimits');
      expect(stats.batchSizes).toHaveProperty('backends');

      expect(stats.config.enabled).toBe(true);
    });
  });

  describe('parseTimeRange', () => {
    it('should parse 1h time range', () => {
      const parsed = collector.parseTimeRange('1h');

      expect(parsed.bucket).toBe('1m');
      expect(parsed.end.getTime() - parsed.start.getTime()).toBeCloseTo(3600 * 1000, -3);
    });

    it('should parse 24h time range', () => {
      const parsed = collector.parseTimeRange('24h');

      expect(parsed.bucket).toBe('15m');
      expect(parsed.end.getTime() - parsed.start.getTime()).toBeCloseTo(86400 * 1000, -3);
    });

    it('should parse 7d time range', () => {
      const parsed = collector.parseTimeRange('7d');

      expect(parsed.bucket).toBe('1h');
      expect(parsed.end.getTime() - parsed.start.getTime()).toBeCloseTo(604800 * 1000, -3);
    });

    it('should parse 30d time range', () => {
      const parsed = collector.parseTimeRange('30d');

      expect(parsed.bucket).toBe('6h');
      expect(parsed.end.getTime() - parsed.start.getTime()).toBeCloseTo(2592000 * 1000, -3);
    });

    it('should parse custom time range', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-02T00:00:00Z');

      const parsed = collector.parseTimeRange({ start, end });

      expect(parsed.start).toEqual(start);
      expect(parsed.end).toEqual(end);
      expect(parsed.bucket).toBe('15m'); // 24 hours = 15m bucket
    });
  });

  describe('getOverview (without database)', () => {
    it('should return real-time stats when no DB', async () => {
      // Record some requests
      for (let i = 0; i < 5; i++) {
        collector.recordRequest({
          timestamp: new Date(),
          requestId: `req-${i}`,
          path: '/api/test',
          method: 'GET',
          statusCode: 200,
          duration: 100 + i * 10,
          ip: '127.0.0.1',
        });
      }

      // Record an error
      collector.recordRequest({
        timestamp: new Date(),
        requestId: 'req-error',
        path: '/api/error',
        method: 'POST',
        statusCode: 500,
        duration: 50,
        ip: '127.0.0.1',
      });

      const overview = await collector.getOverview('1h');

      expect(overview).toHaveProperty('timestamp');
      expect(overview).toHaveProperty('requestsPerSecond');
      expect(overview).toHaveProperty('avgLatency');
      expect(overview).toHaveProperty('errorRate');
      expect(overview).toHaveProperty('activeConnections');
      expect(overview).toHaveProperty('totalRequests');
      expect(overview).toHaveProperty('successfulRequests');
      expect(overview).toHaveProperty('failedRequests');

      // Without DB, we get in-memory stats
      expect(overview.totalRequests).toBe(6);
      expect(overview.successfulRequests).toBe(5);
      expect(overview.failedRequests).toBe(1);
    });
  });

  describe('batching behavior', () => {
    it('should accumulate requests in batch', () => {
      for (let i = 0; i < 5; i++) {
        collector.recordRequest({
          timestamp: new Date(),
          requestId: `req-${i}`,
          path: '/api/test',
          method: 'GET',
          statusCode: 200,
          duration: 100,
          ip: '127.0.0.1',
        });
      }

      const stats = collector.getStats();
      expect(stats.batchSizes.requests).toBe(5);
    });
  });

  describe('sampling', () => {
    it('should sample requests when sampling is enabled', () => {
      const sampledCollector = new MetricsCollector({
        enabled: true,
        sampling: {
          enabled: true,
          rate: 0.0, // 0% sampling = no requests recorded
        },
      });

      for (let i = 0; i < 100; i++) {
        sampledCollector.recordRequest({
          timestamp: new Date(),
          requestId: `req-${i}`,
          path: '/api/test',
          method: 'GET',
          statusCode: 200,
          duration: 100,
          ip: '127.0.0.1',
        });
      }

      const stats = sampledCollector.getStats();
      expect(stats.batchSizes.requests).toBe(0); // All sampled out
    });
  });
});

describe('MetricsCollector configuration', () => {
  it('should use default config when none provided', () => {
    const collector = new MetricsCollector();
    const stats = collector.getStats();

    expect(stats.config.enabled).toBe(true);
    expect(stats.config.batchSize).toBe(100);
    expect(stats.config.retentionDays).toBe(30);
  });

  it('should merge partial config with defaults', () => {
    const collector = new MetricsCollector({
      retentionDays: 60,
    });
    const stats = collector.getStats();

    expect(stats.config.enabled).toBe(true);
    expect(stats.config.retentionDays).toBe(60);
  });
});
