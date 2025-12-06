/**
 * AEGIS - Gateway Module
 *
 * Barrel export file for the gateway module
 */

export * from './proxy.js';
export * from './router.js';
export * from './middleware/index.js';
export * from './circuit-breaker.js';
export * from './health-checker.js';

// Re-export commonly used items at top level
export { ProxyServer, createProxyServer } from './proxy.js';
export { Router, getRouter, createRouter } from './router.js';
export {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  requestIdMiddleware,
  requestLogger,
} from './middleware/index.js';
export { CircuitBreaker, CircuitBreakerManager, CircuitState } from './circuit-breaker.js';
export { HealthChecker } from './health-checker.js';
