/**
 * AEGIS - ML Integration Middleware
 *
 * Express middleware that integrates with the ML service for:
 * - Real-time anomaly detection on traffic patterns
 * - Automatic alerting when anomalies are detected
 * - Metric aggregation for ML analysis
 */

import { Request, Response, NextFunction } from 'express';

import { getMLClient, TrafficMetrics, AnomalyResult } from './client.js';
import logger from '../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

export interface MLMiddlewareConfig {
  /**
   * Enable ML-based anomaly detection
   */
  enabled: boolean;

  /**
   * How often to send metrics to ML service (in ms)
   */
  aggregationIntervalMs: number;

  /**
   * Minimum requests before sending to ML service
   */
  minRequestsForAnalysis: number;

  /**
   * Callback when anomaly is detected
   */
  onAnomaly?: (result: AnomalyResult, metrics: TrafficMetrics) => void;

  /**
   * Severity threshold to trigger alerts (0-1)
   */
  alertThreshold: number;
}

interface MetricsBucket {
  timestamp: Date;
  requestCount: number;
  totalLatency: number;
  latencies: number[];
  errorCount: number;
  status2xx: number;
  status4xx: number;
  status5xx: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_ML_MIDDLEWARE_CONFIG: MLMiddlewareConfig = {
  enabled: true,
  aggregationIntervalMs: 60000, // 1 minute
  minRequestsForAnalysis: 10,
  alertThreshold: 0.7,
};

// =============================================================================
// Metrics Aggregator Class
// =============================================================================

class MetricsAggregator {
  private currentBucket: MetricsBucket;
  private config: MLMiddlewareConfig;
  private intervalTimer: NodeJS.Timeout | null = null;
  private lastAnomalyResult: AnomalyResult | null = null;

  constructor(config: MLMiddlewareConfig) {
    this.config = config;
    this.currentBucket = this.createEmptyBucket();
  }

  private createEmptyBucket(): MetricsBucket {
    return {
      timestamp: new Date(),
      requestCount: 0,
      totalLatency: 0,
      latencies: [],
      errorCount: 0,
      status2xx: 0,
      status4xx: 0,
      status5xx: 0,
    };
  }

  /**
   * Record a request metric
   */
  recordRequest(latencyMs: number, statusCode: number): void {
    this.currentBucket.requestCount++;
    this.currentBucket.totalLatency += latencyMs;
    this.currentBucket.latencies.push(latencyMs);

    if (statusCode >= 200 && statusCode < 300) {
      this.currentBucket.status2xx++;
    } else if (statusCode >= 400 && statusCode < 500) {
      this.currentBucket.status4xx++;
      this.currentBucket.errorCount++;
    } else if (statusCode >= 500) {
      this.currentBucket.status5xx++;
      this.currentBucket.errorCount++;
    }
  }

  /**
   * Start the aggregation timer
   */
  start(): void {
    if (this.intervalTimer) {
      return;
    }

    this.intervalTimer = setInterval(() => {
      this.processAndReset().catch((error) => {
        logger.error('Failed to process metrics bucket', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.config.aggregationIntervalMs);

    logger.info('ML metrics aggregator started', {
      intervalMs: this.config.aggregationIntervalMs,
    });
  }

  /**
   * Stop the aggregation timer
   */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      logger.info('ML metrics aggregator stopped');
    }
  }

  /**
   * Process current bucket and reset
   */
  private async processAndReset(): Promise<void> {
    const bucket = this.currentBucket;
    this.currentBucket = this.createEmptyBucket();

    if (bucket.requestCount < this.config.minRequestsForAnalysis) {
      logger.debug('Skipping ML analysis - insufficient requests', {
        requestCount: bucket.requestCount,
        minRequired: this.config.minRequestsForAnalysis,
      });
      return;
    }

    try {
      await this.analyzeMetrics(bucket);
    } catch (error) {
      logger.warn('ML analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Analyze metrics bucket for anomalies
   */
  private async analyzeMetrics(bucket: MetricsBucket): Promise<void> {
    const mlClient = getMLClient();

    if (!mlClient.isServiceAvailable()) {
      return;
    }

    // Calculate aggregated metrics
    const durationSeconds = this.config.aggregationIntervalMs / 1000;
    const sortedLatencies = [...bucket.latencies].sort((a, b) => a - b);

    const metrics: TrafficMetrics = {
      timestamp: bucket.timestamp.toISOString(),
      requests_per_second: bucket.requestCount / durationSeconds,
      avg_latency_ms:
        bucket.requestCount > 0
          ? bucket.totalLatency / bucket.requestCount
          : 0,
      p95_latency_ms: this.percentile(sortedLatencies, 95),
      p99_latency_ms: this.percentile(sortedLatencies, 99),
      error_rate:
        bucket.requestCount > 0
          ? bucket.errorCount / bucket.requestCount
          : 0,
      status_2xx: bucket.status2xx,
      status_4xx: bucket.status4xx,
      status_5xx: bucket.status5xx,
      total_requests: bucket.requestCount,
    };

    // Send to ML service for anomaly detection
    const result = await mlClient.detectAnomaly(metrics);
    this.lastAnomalyResult = result;

    // Log the result
    if (result.anomaly) {
      logger.warn('Anomaly detected by ML service', {
        anomalyType: result.anomaly_type,
        severity: result.severity,
        confidence: result.confidence,
        score: result.normalized_score,
        explanation: result.explanation,
        metrics: {
          rps: metrics.requests_per_second.toFixed(2),
          avgLatency: metrics.avg_latency_ms.toFixed(1),
          errorRate: (metrics.error_rate * 100).toFixed(2) + '%',
        },
      });

      // Trigger callback if severity exceeds threshold
      if (
        result.normalized_score >= this.config.alertThreshold &&
        this.config.onAnomaly
      ) {
        this.config.onAnomaly(result, metrics);
      }
    } else {
      logger.debug('ML analysis complete - no anomaly', {
        score: result.normalized_score.toFixed(3),
        rps: metrics.requests_per_second.toFixed(2),
      });
    }
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) {
      return 0;
    }

    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)] ?? 0;
  }

  /**
   * Get the last anomaly result
   */
  getLastAnomalyResult(): AnomalyResult | null {
    return this.lastAnomalyResult;
  }

  /**
   * Get current bucket stats
   */
  getCurrentStats(): {
    requestCount: number;
    avgLatency: number;
    errorRate: number;
  } {
    return {
      requestCount: this.currentBucket.requestCount,
      avgLatency:
        this.currentBucket.requestCount > 0
          ? this.currentBucket.totalLatency / this.currentBucket.requestCount
          : 0,
      errorRate:
        this.currentBucket.requestCount > 0
          ? this.currentBucket.errorCount / this.currentBucket.requestCount
          : 0,
    };
  }
}

// =============================================================================
// Global Aggregator Instance
// =============================================================================

let aggregatorInstance: MetricsAggregator | null = null;

/**
 * Get the metrics aggregator instance
 */
export function getMetricsAggregator(
  config?: MLMiddlewareConfig
): MetricsAggregator {
  if (aggregatorInstance === null) {
    aggregatorInstance = new MetricsAggregator(
      config || DEFAULT_ML_MIDDLEWARE_CONFIG
    );
  }
  return aggregatorInstance;
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Create ML integration middleware
 *
 * This middleware:
 * 1. Records request timing and status for each request
 * 2. Aggregates metrics over time windows
 * 3. Sends aggregated metrics to ML service for anomaly detection
 * 4. Triggers alerts when anomalies are detected
 */
export function createMLMiddleware(
  config: Partial<MLMiddlewareConfig> = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const fullConfig: MLMiddlewareConfig = {
    ...DEFAULT_ML_MIDDLEWARE_CONFIG,
    ...config,
  };

  if (!fullConfig.enabled) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const aggregator = getMetricsAggregator(fullConfig);
  aggregator.start();

  return (_req: Request, res: Response, next: NextFunction) => {
    const startTime = process.hrtime.bigint();

    // Hook into response finish
    res.on('finish', () => {
      const endTime = process.hrtime.bigint();
      const latencyMs = Number(endTime - startTime) / 1_000_000;

      aggregator.recordRequest(latencyMs, res.statusCode);
    });

    next();
  };
}

// =============================================================================
// Express Router for ML Endpoints
// =============================================================================

import { Router } from 'express';

/**
 * Create ML API router with endpoints for:
 * - GET /anomaly/status - Get current anomaly status
 * - GET /anomaly/trend - Get trend analysis
 * - POST /anomaly/detect - Manual anomaly detection
 * - GET /optimize/:endpoint - Get rate limit recommendation
 * - POST /train - Trigger model training
 */
export function createMLRouter(): Router {
  const router = Router();

  // Get current anomaly status
  router.get('/anomaly/status', async (_req: Request, res: Response) => {
    try {
      const aggregator = getMetricsAggregator();
      const lastResult = aggregator.getLastAnomalyResult();
      const currentStats = aggregator.getCurrentStats();

      res.json({
        success: true,
        data: {
          lastAnomalyResult: lastResult,
          currentStats,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Get trend analysis
  router.get('/anomaly/trend', async (_req: Request, res: Response) => {
    try {
      const mlClient = getMLClient();
      const trend = await mlClient.getTrend();

      res.json({
        success: true,
        data: trend,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Manual anomaly detection
  router.post('/anomaly/detect', async (req: Request, res: Response) => {
    try {
      const mlClient = getMLClient();
      const metrics = req.body as TrafficMetrics;
      const result = await mlClient.detectAnomaly(metrics);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Get rate limit recommendation
  router.get('/optimize/:endpoint(*)', async (req: Request, res: Response) => {
    try {
      const mlClient = getMLClient();
      const endpoint = '/' + req.params.endpoint;
      const tier = (req.query.tier as string) || 'default';
      const strategy = req.query.strategy as
        | 'conservative'
        | 'balanced'
        | 'permissive'
        | 'adaptive'
        | undefined;

      const recommendation = await mlClient.optimizeRateLimit({
        endpoint,
        tier,
        strategy,
      });

      res.json({
        success: true,
        data: recommendation,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Trigger model training
  router.post('/train', async (req: Request, res: Response) => {
    try {
      const mlClient = getMLClient();
      const options = req.body || {};
      const result = await mlClient.trainModels(options);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Get model info
  router.get('/model/info', async (_req: Request, res: Response) => {
    try {
      const mlClient = getMLClient();
      const info = await mlClient.getModelInfo();

      res.json({
        success: true,
        data: info,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Health check for ML service
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const mlClient = getMLClient();
      const health = await mlClient.checkHealth();

      res.json({
        success: true,
        data: health,
      });
    } catch (error) {
      res.status(503).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        status: 'ML service unavailable',
      });
    }
  });

  return router;
}

// =============================================================================
// Lifecycle Functions
// =============================================================================

/**
 * Start the ML middleware aggregator
 */
export function startMLMiddleware(config?: Partial<MLMiddlewareConfig>): void {
  const aggregator = getMetricsAggregator({
    ...DEFAULT_ML_MIDDLEWARE_CONFIG,
    ...config,
  });
  aggregator.start();
}

/**
 * Stop the ML middleware aggregator
 */
export function stopMLMiddleware(): void {
  if (aggregatorInstance) {
    aggregatorInstance.stop();
  }
}

export default createMLMiddleware;
