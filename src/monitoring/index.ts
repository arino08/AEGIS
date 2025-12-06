/**
 * AEGIS - Monitoring Module
 *
 * Production-grade metrics collection and observability system.
 * This module provides:
 * - Request metrics collection with batching
 * - Time-series storage in PostgreSQL/TimescaleDB
 * - Real-time dashboard stats
 * - Aggregation queries for analytics
 * - Express middleware for automatic metric capture
 * - Alert rules engine with threshold-based alerts
 */

// =============================================================================
// Type Exports
// =============================================================================

export type {
  // Core metric types
  MetricType,
  MetricPoint,
  RequestMetric,
  RateLimitMetric,
  BackendMetric,

  // Time types
  TimeBucket,
  TimeRange,
  CustomTimeRange,
  ParsedTimeRange,

  // Aggregated metrics
  RequestRateMetric,
  LatencyPercentiles,
  StatusCodeDistribution,
  ErrorRateMetric,
  EndpointMetrics,
  UserMetrics,
  BackendMetrics,

  // Dashboard types
  DashboardOverview,
  TopEndpoint,
  TopUser,
  GeoDistribution,

  // Real-time streaming
  RealtimeMetricUpdate,
  MetricSubscription,

  // Query types
  MetricsQueryOptions,
  EndpointMetricsQuery,
  UserMetricsQuery,
  LatencyQuery,

  // Alert types
  AlertSeverity,
  AlertStatus,
  ComparisonOperator,
  AlertMetric,
  AlertRule,
  AlertActionType,
  AlertAction,
  Alert,
  AlertHistoryEntry,

  // Configuration types
  MetricsConfig,
  AlertsConfig,
  EmailAlertConfig,
  SlackAlertConfig,
  WebhookAlertConfig,
  PagerDutyAlertConfig,

  // Utility types
  PaginationInfo,
  PaginatedResponse,
  TimeSeriesPoint,
  MultiSeriesData,
  MetricComparison,
} from './types.js';

// =============================================================================
// Collector Exports
// =============================================================================

export {
  MetricsCollector,
  getMetricsCollector,
  initializeMetricsCollector,
  shutdownMetricsCollector,
} from './collector.js';

// =============================================================================
// Middleware Exports
// =============================================================================

export {
  createMetricsMiddleware,
  recordRateLimitMetric,
  recordBackendMetric,
  createConnectionTrackingMiddleware,
  createServerTimingMiddleware,
} from './middleware.js';

export type {
  MetricsRequest,
  MetricsMiddlewareOptions,
  RateLimitMetricsOptions,
} from './middleware.js';

// =============================================================================
// Alert Exports
// =============================================================================

export {
  AlertManager,
  getAlertManager,
  initializeAlertManager,
  shutdownAlertManager,
} from './alerts.js';

export type {
  AlertRuleInput,
  AlertTriggerInput,
  MetricValueFetcher,
  NotificationResult,
} from './alerts.js';

// =============================================================================
// Legacy Compatibility Layer
// =============================================================================

/**
 * Legacy metrics collector interface for backward compatibility
 */
export interface LegacyMetricsCollector {
  increment(name: string, tags?: Record<string, string>): void;
  decrement(name: string, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  timing(name: string, durationMs: number, tags?: Record<string, string>): void;
  flush(): Promise<void>;
}

import { getMetricsCollector as getCollector } from './collector.js';

/**
 * Get the metrics collector instance (legacy API)
 * @deprecated Use getMetricsCollector() from './collector.js' instead
 */
export function getMetricsCollectorLegacy(): LegacyMetricsCollector {
  const collector = getCollector();

  return {
    increment(name: string, tags?: Record<string, string>): void {
      collector.increment(name, tags);
    },
    decrement(name: string, tags?: Record<string, string>): void {
      collector.record(name, -1, 'counter', tags);
    },
    gauge(name: string, value: number, tags?: Record<string, string>): void {
      collector.gauge(name, value, tags);
    },
    histogram(name: string, value: number, tags?: Record<string, string>): void {
      collector.histogram(name, value, tags);
    },
    timing(name: string, durationMs: number, tags?: Record<string, string>): void {
      collector.timing(name, durationMs, tags);
    },
    async flush(): Promise<void> {
      await collector.flush();
    },
  };
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Record a request metric (convenience function)
 */
export function recordRequest(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
  backend?: string
): void {
  const collector = getCollector();
  collector.recordRequest({
    timestamp: new Date(),
    requestId: '',
    path,
    method,
    statusCode,
    duration: durationMs,
    ip: '',
    backend,
  });
}

/**
 * Record a proxy request metric (convenience function)
 */
export function recordProxyRequest(backend: string, success: boolean, durationMs: number): void {
  const collector = getCollector();
  collector.recordBackend({
    timestamp: new Date(),
    backend,
    healthy: success,
    responseTime: durationMs,
    consecutiveFailures: success ? 0 : 1,
    consecutiveSuccesses: success ? 1 : 0,
  });
}

/**
 * Record a rate limit event (convenience function)
 */
export function recordRateLimit(identifier: string, endpoint: string, blocked: boolean): void {
  const collector = getCollector();
  collector.recordRateLimit({
    timestamp: new Date(),
    key: identifier,
    endpoint,
    allowed: !blocked,
    remaining: 0,
    limit: 0,
    ip: '',
    algorithm: 'unknown',
  });
}

// =============================================================================
// Default Export
// =============================================================================

// Re-import for default export
import { createMetricsMiddleware as createMiddleware } from './middleware.js';
import { getAlertManager as getAlerts } from './alerts.js';

export default {
  // Collector
  getMetricsCollector: getCollector,

  // Middleware
  createMetricsMiddleware: createMiddleware,

  // Alerts
  getAlertManager: getAlerts,

  // Convenience functions
  recordRequest,
  recordProxyRequest,
  recordRateLimit,
};
