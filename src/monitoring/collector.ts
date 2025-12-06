/**
 * AEGIS - Metrics Collector
 *
 * Production-grade metrics collector with batching, aggregation, and time-series storage.
 * Supports PostgreSQL/TimescaleDB for efficient time-range queries.
 */

import type { PostgresClient } from '../storage/postgres.js';
import logger from '../utils/logger.js';
import type {
  RequestMetric,
  RateLimitMetric,
  BackendMetric,
  MetricsConfig,
  TimeBucket,
  TimeRange,
  ParsedTimeRange,
  DashboardOverview,
  EndpointMetrics,
  LatencyPercentiles,
  ErrorRateMetric,
  StatusCodeDistribution,
  RequestRateMetric,
  TopEndpoint,
  MetricPoint,
  MetricType,
  CustomTimeRange,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: MetricsConfig = {
  enabled: true,
  flushIntervalMs: 5000,
  batchSize: 100,
  retentionDays: 30,
  aggregationIntervals: ['1m', '5m', '1h'],
  enabledMetrics: {
    requests: true,
    rateLimits: true,
    backends: true,
    system: true,
  },
  sampling: {
    enabled: false,
    rate: 1.0,
  },
};

const TIME_RANGE_SECONDS: Record<TimeRange, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
  custom: 0,
};

const BUCKET_SECONDS: Record<TimeBucket, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '1d': 86400,
};

// =============================================================================
// MetricsCollector Class
// =============================================================================

export class MetricsCollector {
  private config: MetricsConfig;
  private db: PostgresClient | null = null;

  // Batching buffers
  private requestBatch: RequestMetric[] = [];
  private rateLimitBatch: RateLimitMetric[] = [];
  private backendBatch: BackendMetric[] = [];
  private metricPointBatch: MetricPoint[] = [];

  // Flush timer
  private flushTimer: NodeJS.Timeout | null = null;

  // In-memory real-time counters (for fast access)
  private realtimeCounters = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    rateLimitedRequests: 0,
    cachedResponses: 0,
    totalDuration: 0,
    activeConnections: 0,
  };

  // Backend health tracking
  private backendHealth: { healthy: number; total: number } = { healthy: 0, total: 0 };

  // Rolling window for real-time stats (last 60 seconds, 1-second buckets)
  private rollingWindow = new Map<number, { count: number; duration: number; errors: number }>();

  constructor(config: Partial<MetricsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize the metrics collector with a database connection
   */
  public async initialize(db: PostgresClient): Promise<void> {
    this.db = db;
    logger.info('Metrics collector initialized', {
      enabled: this.config.enabled,
      batchSize: this.config.batchSize,
      flushIntervalMs: this.config.flushIntervalMs,
    });

    // Start periodic flush
    this.startFlushTimer();

    // Start cleanup timer (every hour)
    this.startCleanupTimer();
  }

  /**
   * Start the periodic flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
  }

  /**
   * Start the periodic cleanup timer
   */
  private startCleanupTimer(): void {
    // Run cleanup every hour
    setInterval(
      () => {
        void this.cleanup();
      },
      60 * 60 * 1000
    );
  }

  /**
   * Shutdown the collector gracefully
   */
  public async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    await this.flush();
    logger.info('Metrics collector shut down');
  }

  // ===========================================================================
  // Recording Methods
  // ===========================================================================

  /**
   * Record a request metric
   */
  public recordRequest(metric: RequestMetric): void {
    if (!this.config.enabled || !this.config.enabledMetrics.requests) {
      return;
    }

    // Apply sampling if enabled
    if (this.config.sampling?.enabled && Math.random() > this.config.sampling.rate) {
      return;
    }

    // Add to batch
    this.requestBatch.push(metric);

    // Update real-time counters
    this.realtimeCounters.totalRequests++;
    this.realtimeCounters.totalDuration += metric.duration;

    if (metric.statusCode >= 500) {
      this.realtimeCounters.failedRequests++;
    } else if (metric.statusCode < 400) {
      this.realtimeCounters.successfulRequests++;
    }

    if (metric.rateLimited) {
      this.realtimeCounters.rateLimitedRequests++;
    }

    if (metric.cached) {
      this.realtimeCounters.cachedResponses++;
    }

    // Update rolling window
    const bucketKey = Math.floor(Date.now() / 1000);
    const bucket = this.rollingWindow.get(bucketKey) || { count: 0, duration: 0, errors: 0 };
    bucket.count++;
    bucket.duration += metric.duration;
    if (metric.statusCode >= 500) {
      bucket.errors++;
    }
    this.rollingWindow.set(bucketKey, bucket);

    // Clean old buckets (keep last 60 seconds)
    const cutoff = bucketKey - 60;
    for (const key of this.rollingWindow.keys()) {
      if (key < cutoff) {
        this.rollingWindow.delete(key);
      }
    }

    // Flush if batch is full
    if (this.requestBatch.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  /**
   * Record a rate limit metric
   */
  public recordRateLimit(metric: RateLimitMetric): void {
    if (!this.config.enabled || !this.config.enabledMetrics.rateLimits) {
      return;
    }

    this.rateLimitBatch.push(metric);

    if (this.rateLimitBatch.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  /**
   * Record a backend health metric
   */
  public recordBackend(metric: BackendMetric): void {
    if (!this.config.enabled || !this.config.enabledMetrics.backends) {
      return;
    }

    this.backendBatch.push(metric);

    if (this.backendBatch.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  /**
   * Record a generic metric point
   */
  public record(
    name: string,
    value: number,
    type: MetricType,
    tags?: Record<string, string>
  ): void {
    if (!this.config.enabled) {
      return;
    }

    this.metricPointBatch.push({
      name,
      value,
      type,
      timestamp: new Date(),
      tags,
    });
  }

  /**
   * Increment a counter metric
   */
  public increment(name: string, tags?: Record<string, string>): void {
    this.record(name, 1, 'counter', tags);
  }

  /**
   * Record a gauge metric
   */
  public gauge(name: string, value: number, tags?: Record<string, string>): void {
    this.record(name, value, 'gauge', tags);
  }

  /**
   * Record a timing/duration metric
   */
  public timing(name: string, durationMs: number, tags?: Record<string, string>): void {
    this.record(name, durationMs, 'timing', tags);
  }

  /**
   * Record a histogram metric
   */
  public histogram(name: string, value: number, tags?: Record<string, string>): void {
    this.record(name, value, 'histogram', tags);
  }

  /**
   * Update active connections gauge
   */
  public setActiveConnections(count: number): void {
    this.realtimeCounters.activeConnections = count;
  }

  /**
   * Update backend health counts
   */
  public setBackendHealth(healthy: number, total: number): void {
    this.backendHealth = { healthy, total };
  }

  // ===========================================================================
  // Flush Methods
  // ===========================================================================

  /**
   * Flush all batched metrics to the database
   */
  public async flush(): Promise<void> {
    if (!this.db) {
      logger.warn('Metrics collector not initialized with database connection');
      return;
    }

    const promises: Promise<void>[] = [];

    // Flush request metrics
    if (this.requestBatch.length > 0) {
      const batch = [...this.requestBatch];
      this.requestBatch = [];
      promises.push(this.flushRequestMetrics(batch));
    }

    // Flush rate limit metrics
    if (this.rateLimitBatch.length > 0) {
      const batch = [...this.rateLimitBatch];
      this.rateLimitBatch = [];
      promises.push(this.flushRateLimitMetrics(batch));
    }

    // Flush backend metrics
    if (this.backendBatch.length > 0) {
      const batch = [...this.backendBatch];
      this.backendBatch = [];
      promises.push(this.flushBackendMetrics(batch));
    }

    try {
      await Promise.all(promises);
    } catch (error) {
      logger.error('Failed to flush metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Flush request metrics batch to database
   */
  private async flushRequestMetrics(batch: RequestMetric[]): Promise<void> {
    if (!this.db || batch.length === 0) {
      return;
    }

    const values = batch
      .map((m) => {
        const escaped = (s: string | undefined): string =>
          s ? `'${s.replace(/'/g, "''")}'` : 'NULL';
        const timestamp = m.timestamp.toISOString();
        return `(
          '${timestamp}',
          ${escaped(m.requestId)},
          ${escaped(m.path)},
          ${escaped(m.method)},
          ${m.statusCode},
          ${m.duration},
          ${escaped(m.userId)},
          ${escaped(m.ip)},
          ${escaped(m.userAgent)},
          ${escaped(m.backend)},
          ${m.bytesIn ?? 'NULL'},
          ${m.bytesOut ?? 'NULL'},
          ${escaped(m.error)},
          ${m.rateLimited ?? false},
          ${m.cached ?? false},
          ${escaped(m.tier)}
        )`;
      })
      .join(',\n');

    const sql = `
      INSERT INTO request_metrics (
        timestamp, request_id, path, method, status_code, duration_ms,
        user_id, ip_address, user_agent, backend, bytes_in, bytes_out,
        error, rate_limited, cached, tier
      ) VALUES ${values}
    `;

    try {
      await this.db.execute(sql);
      logger.debug('Flushed request metrics', { count: batch.length });
    } catch (error) {
      logger.error('Failed to flush request metrics', {
        error: error instanceof Error ? error.message : String(error),
        count: batch.length,
      });
      throw error;
    }
  }

  /**
   * Flush rate limit metrics batch to database
   */
  private async flushRateLimitMetrics(batch: RateLimitMetric[]): Promise<void> {
    if (!this.db || batch.length === 0) {
      return;
    }

    const values = batch
      .map((m) => {
        const escaped = (s: string | undefined): string =>
          s ? `'${s.replace(/'/g, "''")}'` : 'NULL';
        const timestamp = m.timestamp.toISOString();
        return `(
          '${timestamp}',
          ${escaped(m.key)},
          ${escaped(m.endpoint)},
          ${m.allowed},
          ${m.remaining},
          ${m.limit},
          ${escaped(m.userId)},
          ${escaped(m.ip)},
          ${escaped(m.tier)},
          ${escaped(m.algorithm)}
        )`;
      })
      .join(',\n');

    const sql = `
      INSERT INTO rate_limit_metrics (
        timestamp, rate_limit_key, endpoint, allowed, remaining,
        limit_value, user_id, ip_address, tier, algorithm
      ) VALUES ${values}
    `;

    try {
      await this.db.execute(sql);
      logger.debug('Flushed rate limit metrics', { count: batch.length });
    } catch (error) {
      logger.error('Failed to flush rate limit metrics', {
        error: error instanceof Error ? error.message : String(error),
        count: batch.length,
      });
      throw error;
    }
  }

  /**
   * Flush backend metrics batch to database
   */
  private async flushBackendMetrics(batch: BackendMetric[]): Promise<void> {
    if (!this.db || batch.length === 0) {
      return;
    }

    const values = batch
      .map((m) => {
        const timestamp = m.timestamp.toISOString();
        return `(
          '${timestamp}',
          '${m.backend.replace(/'/g, "''")}',
          ${m.healthy},
          ${m.responseTime ?? 'NULL'},
          ${m.consecutiveFailures},
          ${m.consecutiveSuccesses}
        )`;
      })
      .join(',\n');

    const sql = `
      INSERT INTO backend_metrics (
        timestamp, backend, healthy, response_time_ms,
        consecutive_failures, consecutive_successes
      ) VALUES ${values}
    `;

    try {
      await this.db.execute(sql);
      logger.debug('Flushed backend metrics', { count: batch.length });
    } catch (error) {
      logger.error('Failed to flush backend metrics', {
        error: error instanceof Error ? error.message : String(error),
        count: batch.length,
      });
      throw error;
    }
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * Parse a time range into start/end dates and appropriate bucket size
   */
  public parseTimeRange(range: TimeRange | CustomTimeRange): ParsedTimeRange {
    let start: Date;
    let end: Date = new Date();
    let bucket: TimeBucket;

    if (typeof range === 'object' && 'start' in range) {
      start = range.start;
      end = range.end;
      const durationMs = end.getTime() - start.getTime();
      const durationHours = durationMs / (1000 * 60 * 60);

      if (durationHours <= 1) {
        bucket = '1m';
      } else if (durationHours <= 6) {
        bucket = '5m';
      } else if (durationHours <= 24) {
        bucket = '15m';
      } else if (durationHours <= 168) {
        bucket = '1h';
      } else {
        bucket = '1d';
      }
    } else {
      const seconds = TIME_RANGE_SECONDS[range];
      start = new Date(Date.now() - seconds * 1000);

      switch (range) {
        case '5m':
        case '15m':
        case '1h':
          bucket = '1m';
          break;
        case '6h':
          bucket = '5m';
          break;
        case '24h':
          bucket = '15m';
          break;
        case '7d':
          bucket = '1h';
          break;
        case '30d':
          bucket = '6h';
          break;
        default:
          bucket = '1h';
      }
    }

    return { start, end, bucket };
  }

  /**
   * Get dashboard overview stats
   */
  public async getOverview(range: TimeRange | CustomTimeRange = '1h'): Promise<DashboardOverview> {
    const { start, end } = this.parseTimeRange(range);

    if (!this.db) {
      // Return real-time in-memory stats if no DB
      return this.getRealtimeOverview();
    }

    try {
      const sql = `
        SELECT
          COUNT(*) as total_requests,
          COUNT(*) FILTER (WHERE status_code < 400) as successful_requests,
          COUNT(*) FILTER (WHERE status_code >= 500) as failed_requests,
          COUNT(*) FILTER (WHERE rate_limited = true) as rate_limited_requests,
          COUNT(*) FILTER (WHERE cached = true) as cached_responses,
          AVG(duration_ms) as avg_latency,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_latency,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99_latency
        FROM request_metrics
        WHERE timestamp >= $1 AND timestamp <= $2
      `;

      const result = await this.db.queryOne<{
        total_requests: string;
        successful_requests: string;
        failed_requests: string;
        rate_limited_requests: string;
        cached_responses: string;
        avg_latency: number | null;
        p95_latency: number | null;
        p99_latency: number | null;
      }>(sql, [start, end]);

      const totalRequests = parseInt(result?.total_requests ?? '0', 10);
      const failedRequests = parseInt(result?.failed_requests ?? '0', 10);
      const durationSeconds = (end.getTime() - start.getTime()) / 1000;

      return {
        timestamp: new Date(),
        requestsPerSecond: durationSeconds > 0 ? totalRequests / durationSeconds : 0,
        avgLatency: result?.avg_latency ?? 0,
        p95Latency: result?.p95_latency ?? 0,
        p99Latency: result?.p99_latency ?? 0,
        errorRate: totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0,
        activeConnections: this.realtimeCounters.activeConnections,
        totalRequests,
        successfulRequests: parseInt(result?.successful_requests ?? '0', 10),
        failedRequests,
        rateLimitedRequests: parseInt(result?.rate_limited_requests ?? '0', 10),
        cachedResponses: parseInt(result?.cached_responses ?? '0', 10),
        uptime: process.uptime(),
        healthyBackends: this.backendHealth.healthy,
        totalBackends: this.backendHealth.total,
      };
    } catch (error) {
      logger.error('Failed to get overview stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.getRealtimeOverview();
    }
  }

  /**
   * Get real-time overview from in-memory counters
   */
  private getRealtimeOverview(): DashboardOverview {
    // Calculate requests per second from rolling window
    let totalCount = 0;
    let totalDuration = 0;
    let totalErrors = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const [key, bucket] of this.rollingWindow.entries()) {
      if (key >= now - 60) {
        totalCount += bucket.count;
        totalDuration += bucket.duration;
        totalErrors += bucket.errors;
      }
    }

    const rps = totalCount / 60;
    const avgLatency = totalCount > 0 ? totalDuration / totalCount : 0;
    const errorRate = totalCount > 0 ? (totalErrors / totalCount) * 100 : 0;

    return {
      timestamp: new Date(),
      requestsPerSecond: rps,
      avgLatency,
      p95Latency: 0, // Not available in real-time mode
      p99Latency: 0,
      errorRate,
      activeConnections: this.realtimeCounters.activeConnections,
      totalRequests: this.realtimeCounters.totalRequests,
      successfulRequests: this.realtimeCounters.successfulRequests,
      failedRequests: this.realtimeCounters.failedRequests,
      rateLimitedRequests: this.realtimeCounters.rateLimitedRequests,
      cachedResponses: this.realtimeCounters.cachedResponses,
      uptime: process.uptime(),
      healthyBackends: this.backendHealth.healthy,
      totalBackends: this.backendHealth.total,
    };
  }

  /**
   * Get requests per second/minute over time
   */
  public async getRequestRate(
    range: TimeRange | CustomTimeRange = '1h'
  ): Promise<RequestRateMetric[]> {
    if (!this.db) {
      return [];
    }

    const { start, end, bucket } = this.parseTimeRange(range);
    const bucketSeconds = BUCKET_SECONDS[bucket];

    const sql = `
      SELECT
        date_trunc('second', timestamp) -
          (EXTRACT(epoch FROM timestamp)::integer % $3) * interval '1 second' as bucket,
        COUNT(*) as count
      FROM request_metrics
      WHERE timestamp >= $1 AND timestamp <= $2
      GROUP BY bucket
      ORDER BY bucket
    `;

    try {
      const results = await this.db.query<{ bucket: Date; count: string }>(sql, [
        start,
        end,
        bucketSeconds,
      ]);

      return results.map((row) => ({
        bucket: new Date(row.bucket),
        count: parseInt(row.count, 10),
        ratePerSecond: parseInt(row.count, 10) / bucketSeconds,
      }));
    } catch (error) {
      logger.error('Failed to get request rate', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get latency percentiles over time
   */
  public async getLatencyPercentiles(
    range: TimeRange | CustomTimeRange = '1h'
  ): Promise<LatencyPercentiles[]> {
    if (!this.db) {
      return [];
    }

    const { start, end, bucket } = this.parseTimeRange(range);
    const bucketSeconds = BUCKET_SECONDS[bucket];

    const sql = `
      SELECT
        date_trunc('second', timestamp) -
          (EXTRACT(epoch FROM timestamp)::integer % $3) * interval '1 second' as bucket,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) as p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY duration_ms) as p75,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY duration_ms) as p90,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99,
        AVG(duration_ms) as avg,
        MIN(duration_ms) as min,
        MAX(duration_ms) as max
      FROM request_metrics
      WHERE timestamp >= $1 AND timestamp <= $2
      GROUP BY bucket
      ORDER BY bucket
    `;

    try {
      const results = await this.db.query<{
        bucket: Date;
        p50: number;
        p75: number;
        p90: number;
        p95: number;
        p99: number;
        avg: number;
        min: number;
        max: number;
      }>(sql, [start, end, bucketSeconds]);

      return results.map((row) => ({
        bucket: new Date(row.bucket),
        p50: row.p50 ?? 0,
        p75: row.p75 ?? 0,
        p90: row.p90 ?? 0,
        p95: row.p95 ?? 0,
        p99: row.p99 ?? 0,
        avg: row.avg ?? 0,
        min: row.min ?? 0,
        max: row.max ?? 0,
      }));
    } catch (error) {
      logger.error('Failed to get latency percentiles', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get error rate over time
   */
  public async getErrorRate(range: TimeRange | CustomTimeRange = '1h'): Promise<ErrorRateMetric[]> {
    if (!this.db) {
      return [];
    }

    const { start, end, bucket } = this.parseTimeRange(range);
    const bucketSeconds = BUCKET_SECONDS[bucket];

    const sql = `
      SELECT
        date_trunc('second', timestamp) -
          (EXTRACT(epoch FROM timestamp)::integer % $3) * interval '1 second' as bucket,
        COUNT(*) as total_requests,
        COUNT(*) FILTER (WHERE status_code >= 400) as error_requests,
        COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) as status_4xx,
        COUNT(*) FILTER (WHERE status_code >= 500) as status_5xx
      FROM request_metrics
      WHERE timestamp >= $1 AND timestamp <= $2
      GROUP BY bucket
      ORDER BY bucket
    `;

    try {
      const results = await this.db.query<{
        bucket: Date;
        total_requests: string;
        error_requests: string;
        status_4xx: string;
        status_5xx: string;
      }>(sql, [start, end, bucketSeconds]);

      return results.map((row) => {
        const total = parseInt(row.total_requests, 10);
        const errors = parseInt(row.error_requests, 10);
        return {
          bucket: new Date(row.bucket),
          totalRequests: total,
          errorRequests: errors,
          errorRate: total > 0 ? (errors / total) * 100 : 0,
          status4xx: parseInt(row.status_4xx, 10),
          status5xx: parseInt(row.status_5xx, 10),
        };
      });
    } catch (error) {
      logger.error('Failed to get error rate', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get status code distribution over time
   */
  public async getStatusDistribution(
    range: TimeRange | CustomTimeRange = '1h'
  ): Promise<StatusCodeDistribution[]> {
    if (!this.db) {
      return [];
    }

    const { start, end, bucket } = this.parseTimeRange(range);
    const bucketSeconds = BUCKET_SECONDS[bucket];

    const sql = `
      SELECT
        date_trunc('second', timestamp) -
          (EXTRACT(epoch FROM timestamp)::integer % $3) * interval '1 second' as bucket,
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) as status_2xx,
        COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) as status_3xx,
        COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) as status_4xx,
        COUNT(*) FILTER (WHERE status_code >= 500) as status_5xx,
        COUNT(*) as total
      FROM request_metrics
      WHERE timestamp >= $1 AND timestamp <= $2
      GROUP BY bucket
      ORDER BY bucket
    `;

    try {
      const results = await this.db.query<{
        bucket: Date;
        status_2xx: string;
        status_3xx: string;
        status_4xx: string;
        status_5xx: string;
        total: string;
      }>(sql, [start, end, bucketSeconds]);

      return results.map((row) => ({
        bucket: new Date(row.bucket),
        status2xx: parseInt(row.status_2xx, 10),
        status3xx: parseInt(row.status_3xx, 10),
        status4xx: parseInt(row.status_4xx, 10),
        status5xx: parseInt(row.status_5xx, 10),
        total: parseInt(row.total, 10),
      }));
    } catch (error) {
      logger.error('Failed to get status distribution', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get top endpoints by request count
   */
  public async getTopEndpoints(
    range: TimeRange | CustomTimeRange = '1h',
    limit = 10
  ): Promise<TopEndpoint[]> {
    if (!this.db) {
      return [];
    }

    const { start, end } = this.parseTimeRange(range);

    const sql = `
      WITH total AS (
        SELECT COUNT(*) as cnt
        FROM request_metrics
        WHERE timestamp >= $1 AND timestamp <= $2
      )
      SELECT
        path as endpoint,
        method,
        COUNT(*) as request_count,
        ROUND((COUNT(*)::numeric / NULLIF(total.cnt, 0)) * 100, 2) as percentage,
        AVG(duration_ms) as avg_latency,
        ROUND((COUNT(*) FILTER (WHERE status_code >= 400)::numeric /
               NULLIF(COUNT(*), 0)) * 100, 2) as error_rate
      FROM request_metrics, total
      WHERE timestamp >= $1 AND timestamp <= $2
      GROUP BY path, method, total.cnt
      ORDER BY request_count DESC
      LIMIT $3
    `;

    try {
      const results = await this.db.query<{
        endpoint: string;
        method: string;
        request_count: string;
        percentage: string;
        avg_latency: number;
        error_rate: string;
      }>(sql, [start, end, limit]);

      return results.map((row) => ({
        endpoint: row.endpoint,
        method: row.method,
        requestCount: parseInt(row.request_count, 10),
        percentage: parseFloat(row.percentage),
        avgLatency: row.avg_latency ?? 0,
        errorRate: parseFloat(row.error_rate),
      }));
    } catch (error) {
      logger.error('Failed to get top endpoints', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get endpoint-level metrics
   */
  public async getEndpointMetrics(
    range: TimeRange | CustomTimeRange = '1h',
    endpoint?: string,
    method?: string
  ): Promise<EndpointMetrics[]> {
    if (!this.db) {
      return [];
    }

    const { start, end } = this.parseTimeRange(range);
    const durationSeconds = (end.getTime() - start.getTime()) / 1000;

    let whereClause = 'WHERE timestamp >= $1 AND timestamp <= $2';
    const params: unknown[] = [start, end];

    if (endpoint) {
      params.push(endpoint);
      whereClause += ` AND path = $${params.length}`;
    }

    if (method) {
      params.push(method);
      whereClause += ` AND method = $${params.length}`;
    }

    const sql = `
      SELECT
        path as endpoint,
        method,
        COUNT(*) as total_requests,
        AVG(duration_ms) as avg_latency,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_latency,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99_latency,
        ROUND((COUNT(*) FILTER (WHERE status_code >= 400)::numeric /
               NULLIF(COUNT(*), 0)) * 100, 2) as error_rate,
        ROUND((COUNT(*) FILTER (WHERE status_code < 400)::numeric /
               NULLIF(COUNT(*), 0)) * 100, 2) as success_rate,
        MAX(timestamp) as last_request_at
      FROM request_metrics
      ${whereClause}
      GROUP BY path, method
      ORDER BY total_requests DESC
    `;

    try {
      const results = await this.db.query<{
        endpoint: string;
        method: string;
        total_requests: string;
        avg_latency: number;
        p95_latency: number;
        p99_latency: number;
        error_rate: string;
        success_rate: string;
        last_request_at: Date;
      }>(sql, params);

      return results.map((row) => ({
        endpoint: row.endpoint,
        method: row.method,
        totalRequests: parseInt(row.total_requests, 10),
        avgLatency: row.avg_latency ?? 0,
        p95Latency: row.p95_latency ?? 0,
        p99Latency: row.p99_latency ?? 0,
        errorRate: parseFloat(row.error_rate),
        successRate: parseFloat(row.success_rate),
        requestsPerSecond: parseInt(row.total_requests, 10) / durationSeconds,
        lastRequestAt: new Date(row.last_request_at),
      }));
    } catch (error) {
      logger.error('Failed to get endpoint metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ===========================================================================
  // Cleanup Methods
  // ===========================================================================

  /**
   * Clean up old metrics based on retention policy
   */
  public async cleanup(): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      const result = await this.db.queryOne<{
        request_metrics_deleted: string;
        rate_limit_metrics_deleted: string;
        backend_metrics_deleted: string;
        aggregated_metrics_deleted: string;
      }>('SELECT * FROM cleanup_old_metrics($1)', [this.config.retentionDays]);

      if (result) {
        logger.info('Metrics cleanup completed', {
          requestMetricsDeleted: result.request_metrics_deleted,
          rateLimitMetricsDeleted: result.rate_limit_metrics_deleted,
          backendMetricsDeleted: result.backend_metrics_deleted,
          aggregatedMetricsDeleted: result.aggregated_metrics_deleted,
        });
      }

      // Also cleanup expired snapshots
      const snapshotsDeleted = await this.db.queryOne<{ cleanup_expired_snapshots: number }>(
        'SELECT cleanup_expired_snapshots()'
      );

      if (snapshotsDeleted && snapshotsDeleted.cleanup_expired_snapshots > 0) {
        logger.info('Expired snapshots cleaned up', {
          count: snapshotsDeleted.cleanup_expired_snapshots,
        });
      }
    } catch (error) {
      logger.error('Failed to cleanup old metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Get current collector stats
   */
  public getStats(): {
    batchSizes: { requests: number; rateLimits: number; backends: number };
    realtimeCounters: {
      totalRequests: number;
      successfulRequests: number;
      failedRequests: number;
      rateLimitedRequests: number;
      cachedResponses: number;
      totalDuration: number;
      activeConnections: number;
    };
    config: MetricsConfig;
  } {
    return {
      batchSizes: {
        requests: this.requestBatch.length,
        rateLimits: this.rateLimitBatch.length,
        backends: this.backendBatch.length,
      },
      realtimeCounters: { ...this.realtimeCounters },
      config: this.config,
    };
  }

  /**
   * Reset real-time counters (for testing)
   */
  public resetCounters(): void {
    this.realtimeCounters = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rateLimitedRequests: 0,
      cachedResponses: 0,
      totalDuration: 0,
      activeConnections: 0,
    };
    this.rollingWindow.clear();
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let collectorInstance: MetricsCollector | null = null;

/**
 * Get the singleton metrics collector instance
 */
export function getMetricsCollector(config?: Partial<MetricsConfig>): MetricsCollector {
  if (collectorInstance === null) {
    collectorInstance = new MetricsCollector(config);
  }
  return collectorInstance;
}

/**
 * Initialize the metrics collector with a database connection
 */
export async function initializeMetricsCollector(
  db: PostgresClient,
  config?: Partial<MetricsConfig>
): Promise<MetricsCollector> {
  const collector = getMetricsCollector(config);
  await collector.initialize(db);
  return collector;
}

/**
 * Shutdown the metrics collector
 */
export async function shutdownMetricsCollector(): Promise<void> {
  if (collectorInstance) {
    await collectorInstance.shutdown();
    collectorInstance = null;
  }
}

export default MetricsCollector;
