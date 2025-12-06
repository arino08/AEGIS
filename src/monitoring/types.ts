/**
 * AEGIS - Metrics & Observability Types
 *
 * Type definitions for the metrics collection and observability system.
 */

// =============================================================================
// Core Metric Types
// =============================================================================

/**
 * Supported metric types
 */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'timing';

/**
 * Base metric point interface
 */
export interface MetricPoint {
  name: string;
  value: number;
  timestamp: Date;
  type: MetricType;
  tags?: Record<string, string>;
}

/**
 * Request metric data captured by middleware
 */
export interface RequestMetric {
  timestamp: Date;
  requestId: string;
  path: string;
  method: string;
  statusCode: number;
  duration: number; // in milliseconds
  userId?: string;
  ip: string;
  userAgent?: string;
  backend?: string;
  bytesIn?: number;
  bytesOut?: number;
  error?: string;
  rateLimited?: boolean;
  cached?: boolean;
  tier?: string;
}

/**
 * Rate limit metric data
 */
export interface RateLimitMetric {
  timestamp: Date;
  key: string;
  endpoint: string;
  allowed: boolean;
  remaining: number;
  limit: number;
  userId?: string;
  ip: string;
  tier?: string;
  algorithm: string;
}

/**
 * Backend health metric
 */
export interface BackendMetric {
  timestamp: Date;
  backend: string;
  healthy: boolean;
  responseTime?: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

// =============================================================================
// Aggregated Metrics Types
// =============================================================================

/**
 * Time bucket for aggregated metrics
 */
export type TimeBucket = '1m' | '5m' | '15m' | '1h' | '6h' | '1d';

/**
 * Time range for queries
 */
export type TimeRange = '5m' | '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom';

/**
 * Custom time range with explicit start and end
 */
export interface CustomTimeRange {
  start: Date;
  end: Date;
}

/**
 * Parsed time range for queries
 */
export interface ParsedTimeRange {
  start: Date;
  end: Date;
  bucket: TimeBucket;
}

/**
 * Requests per second/minute aggregation
 */
export interface RequestRateMetric {
  bucket: Date;
  count: number;
  ratePerSecond: number;
}

/**
 * Latency percentile aggregation
 */
export interface LatencyPercentiles {
  bucket: Date;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
}

/**
 * Status code distribution
 */
export interface StatusCodeDistribution {
  bucket: Date;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  total: number;
}

/**
 * Error rate aggregation
 */
export interface ErrorRateMetric {
  bucket: Date;
  totalRequests: number;
  errorRequests: number;
  errorRate: number; // percentage
  status4xx: number;
  status5xx: number;
}

/**
 * Endpoint-level metrics
 */
export interface EndpointMetrics {
  endpoint: string;
  method: string;
  totalRequests: number;
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  errorRate: number;
  successRate: number;
  requestsPerSecond: number;
  lastRequestAt: Date;
}

/**
 * User-level metrics
 */
export interface UserMetrics {
  userId: string;
  totalRequests: number;
  avgLatency: number;
  errorRate: number;
  rateLimitHits: number;
  topEndpoints: { endpoint: string; count: number }[];
  lastRequestAt: Date;
  tier?: string;
}

/**
 * Backend-level metrics
 */
export interface BackendMetrics {
  backend: string;
  healthy: boolean;
  totalRequests: number;
  avgLatency: number;
  p95Latency: number;
  errorRate: number;
  uptime: number; // percentage
  lastHealthCheck: Date;
}

// =============================================================================
// Dashboard Overview Types
// =============================================================================

/**
 * Real-time dashboard overview stats
 */
export interface DashboardOverview {
  timestamp: Date;
  requestsPerSecond: number;
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  errorRate: number;
  activeConnections: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rateLimitedRequests: number;
  cachedResponses: number;
  uptime: number;
  healthyBackends: number;
  totalBackends: number;
}

/**
 * Top endpoints by request count
 */
export interface TopEndpoint {
  endpoint: string;
  method: string;
  requestCount: number;
  percentage: number;
  avgLatency: number;
  errorRate: number;
}

/**
 * Top users by request count
 */
export interface TopUser {
  userId: string;
  requestCount: number;
  percentage: number;
  rateLimitHits: number;
  tier?: string;
}

/**
 * Geographic distribution (if IP geolocation is available)
 */
export interface GeoDistribution {
  country: string;
  countryCode: string;
  requestCount: number;
  percentage: number;
}

// =============================================================================
// Real-time Streaming Types
// =============================================================================

/**
 * Real-time metric update for WebSocket streaming
 */
export interface RealtimeMetricUpdate {
  type: 'request' | 'rateLimit' | 'backend' | 'overview';
  timestamp: Date;
  data: RequestMetric | RateLimitMetric | BackendMetric | DashboardOverview;
}

/**
 * WebSocket subscription options
 */
export interface MetricSubscription {
  type: 'all' | 'requests' | 'rateLimits' | 'backends' | 'overview';
  interval?: number; // Update interval in milliseconds
  filters?: {
    endpoints?: string[];
    methods?: string[];
    statuses?: number[];
    backends?: string[];
    users?: string[];
  };
}

// =============================================================================
// Metrics Query Types
// =============================================================================

/**
 * Generic metrics query options
 */
export interface MetricsQueryOptions {
  timeRange: TimeRange | CustomTimeRange;
  bucket?: TimeBucket;
  limit?: number;
  offset?: number;
  orderBy?: 'time' | 'count' | 'latency' | 'errorRate';
  order?: 'asc' | 'desc';
}

/**
 * Endpoint metrics query options
 */
export interface EndpointMetricsQuery extends MetricsQueryOptions {
  endpoint?: string;
  method?: string;
  backend?: string;
}

/**
 * User metrics query options
 */
export interface UserMetricsQuery extends MetricsQueryOptions {
  userId?: string;
  tier?: string;
}

/**
 * Latency query options
 */
export interface LatencyQuery extends MetricsQueryOptions {
  endpoint?: string;
  backend?: string;
  percentiles?: number[]; // e.g., [50, 75, 90, 95, 99]
}

// =============================================================================
// Alert Types
// =============================================================================

/**
 * Alert severity levels
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Alert status
 */
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'muted';

/**
 * Comparison operators for alert conditions
 */
export type ComparisonOperator = '>' | '>=' | '<' | '<=' | '==' | '!=';

/**
 * Metrics that can be monitored for alerts
 */
export type AlertMetric =
  | 'latency_p95'
  | 'latency_p99'
  | 'latency_avg'
  | 'error_rate'
  | 'request_rate'
  | 'rate_limit_hits'
  | 'backend_health'
  | 'active_connections';

/**
 * Alert rule definition
 */
export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  severity: AlertSeverity;
  condition: {
    metric: AlertMetric;
    operator: ComparisonOperator;
    threshold: number;
    window: string; // e.g., '1m', '5m', '1h'
    endpoint?: string;
    backend?: string;
  };
  actions: AlertAction[];
  cooldown?: string; // Minimum time between alerts, e.g., '5m'
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Alert action types
 */
export type AlertActionType = 'email' | 'slack' | 'webhook' | 'pagerduty' | 'log';

/**
 * Alert action configuration
 */
export interface AlertAction {
  type: AlertActionType;
  config: Record<string, unknown>;
}

/**
 * Triggered alert instance
 */
export interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  value: number;
  threshold: number;
  triggeredAt: Date;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  resolvedAt?: Date;
  mutedUntil?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Alert history entry
 */
export interface AlertHistoryEntry {
  id: string;
  alertId: string;
  action: 'triggered' | 'acknowledged' | 'resolved' | 'muted' | 'unmuted';
  timestamp: Date;
  userId?: string;
  note?: string;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Metrics collection configuration
 */
export interface MetricsConfig {
  enabled: boolean;
  flushIntervalMs: number;
  batchSize: number;
  retentionDays: number;
  aggregationIntervals: TimeBucket[];
  enabledMetrics: {
    requests: boolean;
    rateLimits: boolean;
    backends: boolean;
    system: boolean;
  };
  sampling?: {
    enabled: boolean;
    rate: number; // 0.0 to 1.0
  };
}

/**
 * Alert system configuration
 */
export interface AlertsConfig {
  enabled: boolean;
  checkIntervalMs: number;
  defaultCooldownMs: number;
  maxActiveAlerts: number;
  retentionDays: number;
  channels: {
    email?: EmailAlertConfig;
    slack?: SlackAlertConfig;
    webhook?: WebhookAlertConfig;
    pagerduty?: PagerDutyAlertConfig;
  };
}

/**
 * Email alert configuration
 */
export interface EmailAlertConfig {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  fromAddress: string;
  toAddresses: string[];
}

/**
 * Slack alert configuration
 */
export interface SlackAlertConfig {
  enabled: boolean;
  webhookUrl: string;
  channel?: string;
  username?: string;
  iconEmoji?: string;
}

/**
 * Webhook alert configuration
 */
export interface WebhookAlertConfig {
  enabled: boolean;
  url: string;
  method: 'POST' | 'PUT';
  headers?: Record<string, string>;
  timeout?: number;
}

/**
 * PagerDuty alert configuration
 */
export interface PagerDutyAlertConfig {
  enabled: boolean;
  integrationKey: string;
  apiUrl?: string;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Pagination info for list responses
 */
export interface PaginationInfo {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationInfo;
}

/**
 * Time series data point
 */
export interface TimeSeriesPoint<T = number> {
  timestamp: Date;
  value: T;
}

/**
 * Multi-series time series data
 */
export interface MultiSeriesData {
  series: {
    name: string;
    data: TimeSeriesPoint[];
    color?: string;
  }[];
  labels: Date[];
}

/**
 * Metric comparison data (for comparing time periods)
 */
export interface MetricComparison {
  current: number;
  previous: number;
  change: number; // Absolute change
  changePercent: number; // Percentage change
  trend: 'up' | 'down' | 'stable';
}

export default {
  // Export is mainly for type definitions, no runtime values
};
