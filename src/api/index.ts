/**
 * AEGIS - API Module
 *
 * Dashboard API endpoints and WebSocket for managing the gateway.
 * Provides REST APIs for metrics, configuration, alerts, and real-time streaming.
 */

// =============================================================================
// Version
// =============================================================================

export const API_VERSION = 'v1';

// =============================================================================
// Route Exports
// =============================================================================

export { default as metricsRouter, metricsRouter as metricsRoutes } from './routes/metrics.js';
export { default as alertsRouter, alertsRouter as alertsRoutes } from './routes/alerts.js';
export { default as nlQueryRouter, nlQueryRouter as nlQueryRoutes } from './routes/nl-query.js';
export { default as mlRouter, mlRouter as mlRoutes } from './routes/ml.js';
export { default as healthRouter, healthRouter as healthRoutes, setProxyServer } from './routes/health.js';

// =============================================================================
// WebSocket Exports
// =============================================================================

export {
  MetricsWebSocketServer,
  getMetricsWebSocketServer,
  initializeMetricsWebSocket,
  shutdownMetricsWebSocket,
} from './websocket.js';

export type { MetricsWebSocketOptions } from './websocket.js';

// =============================================================================
// Route Prefixes
// =============================================================================

export const ROUTE_PREFIXES = {
  metrics: '/api/metrics',
  alerts: '/api/alerts',
  nlQuery: '/api/nl-query',
  ml: '/api/ml',
  health: '/api/health',
  config: '/api/config',
  backends: '/api/backends',
  users: '/api/users',
  admin: '/api/admin',
} as const;

// =============================================================================
// API Configuration
// =============================================================================

export interface ApiConfig {
  /**
   * Enable API endpoints
   */
  enabled: boolean;

  /**
   * Base path for all API routes
   */
  basePath: string;

  /**
   * Enable CORS for API routes
   */
  cors: boolean;

  /**
   * Allowed origins for CORS
   */
  allowedOrigins: string[];

  /**
   * Enable rate limiting for API routes
   */
  rateLimit: boolean;

  /**
   * Rate limit requests per minute
   */
  rateLimitPerMinute: number;

  /**
   * Enable WebSocket endpoint
   */
  websocket: boolean;

  /**
   * WebSocket update interval in ms
   */
  websocketUpdateInterval: number;

  /**
   * Require authentication for API access
   */
  requireAuth: boolean;

  /**
   * API key header name
   */
  apiKeyHeader: string;
}

export const DEFAULT_API_CONFIG: ApiConfig = {
  enabled: true,
  basePath: '/api',
  cors: true,
  allowedOrigins: ['*'],
  rateLimit: true,
  rateLimitPerMinute: 60,
  websocket: true,
  websocketUpdateInterval: 1000,
  requireAuth: false,
  apiKeyHeader: 'X-API-Key',
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Build full route path with version
 */
export function buildRoutePath(prefix: keyof typeof ROUTE_PREFIXES): string {
  return ROUTE_PREFIXES[prefix];
}

/**
 * Build versioned route path
 */
export function buildVersionedRoutePath(
  prefix: keyof typeof ROUTE_PREFIXES,
  version: string = API_VERSION
): string {
  return `/${version}${ROUTE_PREFIXES[prefix]}`;
}

// =============================================================================
// Default Export
// =============================================================================

export default {
  API_VERSION,
  ROUTE_PREFIXES,
  DEFAULT_API_CONFIG,
  buildRoutePath,
  buildVersionedRoutePath,
};
