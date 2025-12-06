/**
 * AEGIS - ML Module
 *
 * This module provides integration with the Python ML service for:
 * - Anomaly detection in API traffic patterns
 * - Rate limit optimization recommendations
 * - Real-time traffic analysis
 */

// =============================================================================
// Client Exports
// =============================================================================

export {
  MLServiceClient,
  getMLClient,
  initializeMLClient,
  DEFAULT_ML_CONFIG,
} from './client.js';

export type {
  MLServiceConfig,
  TrafficMetrics,
  AnomalyResult,
  BatchAnomalyResult,
  TrendAnalysis,
  RateLimitRecommendation,
  EndpointProfile,
  TrainingResult,
  ModelInfo,
  HealthStatus,
} from './client.js';

// =============================================================================
// Middleware Exports
// =============================================================================

export {
  createMLMiddleware,
  createMLRouter,
  getMetricsAggregator,
  startMLMiddleware,
  stopMLMiddleware,
  DEFAULT_ML_MIDDLEWARE_CONFIG,
} from './middleware.js';

export type { MLMiddlewareConfig } from './middleware.js';

// =============================================================================
// Default Export
// =============================================================================

export { MLServiceClient as default } from './client.js';
