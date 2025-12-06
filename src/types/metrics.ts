/**
 * AEGIS Dashboard - TypeScript Types
 */

// Time
export type TimeRange = '5m' | '15m' | '1h' | '6h' | '24h';

// Dashboard Overview
export interface DashboardOverview {
  timestamp: string;
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

// Latency
export interface LatencyPoint {
  bucket: string;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
}

// Request Rate
export interface RequestRatePoint {
  bucket: string;
  count: number;
  ratePerSecond: number;
}

// Error Rate
export interface ErrorRatePoint {
  bucket: string;
  totalRequests: number;
  errorRequests: number;
  errorRate: number;
  status4xx: number;
  status5xx: number;
}

// Status Distribution
export interface StatusDistribution {
  bucket: string;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  total: number;
}

// Endpoints
export interface TopEndpoint {
  endpoint: string;
  method: string;
  requestCount: number;
  percentage: number;
  avgLatency: number;
  errorRate: number;
}

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
  lastRequestAt: string;
}

// Backends
export interface BackendHealth {
  name: string;
  url: string;
  healthy: boolean;
  lastCheck: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  avgLatency?: number;
  errorRate?: number;
}

// Alerts
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'muted';

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  severity: AlertSeverity;
  condition: {
    metric: string;
    operator: '>' | '>=' | '<' | '<=' | '==' | '!=';
    threshold: number;
    window: string;
    endpoint?: string;
    backend?: string;
  };
  actions: Array<{
    type: 'email' | 'slack' | 'webhook' | 'pagerduty' | 'log';
    config: Record<string, unknown>;
  }>;
  cooldown?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  value: number;
  threshold: number;
  triggeredAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  mutedUntil?: string;
  metadata?: Record<string, unknown>;
}

export interface AlertHistoryEntry {
  id: string;
  alertId: string;
  action: 'triggered' | 'acknowledged' | 'resolved' | 'muted' | 'unmuted';
  timestamp: string;
  userId?: string;
  note?: string;
}

export interface AlertStats {
  rulesCount: number;
  enabledRulesCount: number;
  activeAlertsCount: number;
  alertsByStatus: Record<AlertStatus, number>;
  alertsBySeverity: Record<AlertSeverity, number>;
}

// Gateway Status
export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  startTime: string;
  backends: BackendHealth[];
  version: string;
  rateLimiting: {
    enabled: boolean;
    connected: boolean;
  };
}

// Health Check Types
export type HealthStatus = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ServiceHealth {
  name: string;
  url: string;
  status: HealthStatus;
  lastCheck: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  responseTimeMs: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  checks: {
    total: number;
    successful: number;
    failed: number;
  };
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  lastStateChange: number;
  totalRequests: number;
  failedRequests: number;
  openCount: number;
  halfOpenCount: number;
}

export interface BackendStatus {
  name: string;
  url: string;
  health: ServiceHealth | null;
  circuitBreaker: {
    state: CircuitState;
    stats: CircuitBreakerStats;
  };
  isAvailable: boolean;
}

export interface BackendsSummary {
  total: number;
  available: number;
  unavailable: number;
  healthy: number;
  unhealthy: number;
  degraded: number;
  circuitOpen: number;
}

export interface BackendsResponse {
  summary: BackendsSummary;
  backends: BackendStatus[];
}

// Rate Limiting
export interface RateLimitStatus {
  enabled: boolean;
  algorithm?: string;
  defaultLimits?: {
    requests: number;
    windowSeconds: number;
  };
  metrics?: {
    totalChecks: number;
    allowed: number;
    denied: number;
    bypassed: number;
  };
}

// API Response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: {
    timestamp: string;
    range?: string;
    points?: number;
    total?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
  };
}

export interface ApiError {
  error: boolean;
  message: string;
  details?: unknown;
}

// Connection
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';
