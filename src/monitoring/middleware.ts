/**
 * AEGIS - Metrics Middleware
 *
 * Express middleware for capturing request metrics including latency,
 * status codes, and request metadata.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';

import logger from '../utils/logger.js';
import { getMetricsCollector } from './collector.js';
import type { RequestMetric, RateLimitMetric } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended Request with metrics-related properties
 */
export interface MetricsRequest extends Request {
  requestId?: string;
  startTime?: number;
  userId?: string;
  tier?: string;
  backend?: string;
  rateLimited?: boolean;
  cached?: boolean;
}

/**
 * Middleware configuration options
 */
export interface MetricsMiddlewareOptions {
  /**
   * Skip metrics collection for certain paths
   */
  skipPaths?: string[];

  /**
   * Skip metrics collection based on a custom function
   */
  skip?: (req: Request) => boolean;

  /**
   * Extract user ID from request
   */
  getUserId?: (req: Request) => string | undefined;

  /**
   * Extract user tier from request
   */
  getTier?: (req: Request) => string | undefined;

  /**
   * Trust proxy for IP extraction
   */
  trustProxy?: boolean;

  /**
   * Include request/response body sizes
   */
  includeBodySizes?: boolean;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

// =============================================================================
// Default Options
// =============================================================================

const DEFAULT_OPTIONS: MetricsMiddlewareOptions = {
  skipPaths: ['/health', '/healthz', '/ready', '/metrics', '/favicon.ico'],
  trustProxy: true,
  includeBodySizes: false,
  debug: false,
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get client IP address from request
 */
function getClientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    // Check common proxy headers
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = typeof forwardedFor === 'string' ? forwardedFor : forwardedFor[0];
      if (ips) {
        const firstIp = ips.split(',')[0];
        if (firstIp) {
          return firstIp.trim();
        }
      }
    }

    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      const ip = typeof realIp === 'string' ? realIp : realIp[0];
      if (ip) {
        return ip;
      }
    }
  }

  // Fall back to connection remote address
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Get user agent from request
 */
function getUserAgent(req: Request): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : ua?.[0];
}

/**
 * Calculate request body size
 */
function getRequestBodySize(req: Request): number | undefined {
  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    return isNaN(size) ? undefined : size;
  }
  return undefined;
}

/**
 * Check if path should be skipped
 */
function shouldSkip(req: Request, options: MetricsMiddlewareOptions): boolean {
  // Check custom skip function
  if (options.skip && options.skip(req)) {
    return true;
  }

  // Check skip paths
  if (options.skipPaths) {
    const path = req.path || req.url;
    for (const skipPath of options.skipPaths) {
      if (path === skipPath || path.startsWith(skipPath + '/')) {
        return true;
      }
    }
  }

  return false;
}

// =============================================================================
// Metrics Middleware
// =============================================================================

/**
 * Create metrics collection middleware
 *
 * This middleware captures request metrics including:
 * - Request duration/latency
 * - Status codes
 * - Request path and method
 * - User information (if available)
 * - Client IP address
 * - User agent
 * - Request/response sizes
 *
 * @example
 * ```typescript
 * import { createMetricsMiddleware } from './monitoring/middleware';
 *
 * app.use(createMetricsMiddleware({
 *   skipPaths: ['/health', '/metrics'],
 *   getUserId: (req) => req.user?.id,
 *   getTier: (req) => req.user?.tier,
 * }));
 * ```
 */
export function createMetricsMiddleware(options: MetricsMiddlewareOptions = {}): RequestHandler {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const collector = getMetricsCollector();

  return (req: Request, res: Response, next: NextFunction): void => {
    // Check if we should skip this request
    if (shouldSkip(req, opts)) {
      next();
      return;
    }

    // Record start time
    const startTime = Date.now();
    const metricsReq = req as MetricsRequest;

    // Generate or use existing request ID
    const requestId = metricsReq.requestId || (req.headers['x-request-id'] as string) || uuidv4();
    metricsReq.requestId = requestId;
    metricsReq.startTime = startTime;

    // Extract request info upfront
    const path = req.path || req.url;
    const method = req.method;
    const ip = getClientIp(req, opts.trustProxy ?? true);
    const userAgent = getUserAgent(req);
    const bytesIn = opts.includeBodySizes ? getRequestBodySize(req) : undefined;

    // Track response size
    let bytesOut: number | undefined;
    const originalWrite = res.write.bind(res);
    let responseSize = 0;

    if (opts.includeBodySizes) {
      // Intercept write to track response size
      res.write = function (
        chunk: unknown,
        encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void),
        callback?: (error: Error | null | undefined) => void
      ): boolean {
        if (chunk) {
          if (Buffer.isBuffer(chunk)) {
            responseSize += chunk.length;
          } else if (typeof chunk === 'string') {
            responseSize += Buffer.byteLength(chunk);
          }
        }
        if (typeof encodingOrCallback === 'function') {
          return originalWrite(chunk, encodingOrCallback);
        }
        if (encodingOrCallback) {
          return originalWrite(chunk, encodingOrCallback, callback);
        }
        return originalWrite(chunk);
      };
    }

    // Handle response finish
    const onFinish = (): void => {
      // Calculate duration
      const duration = Date.now() - startTime;

      // Get response size from content-length or tracked size
      if (opts.includeBodySizes) {
        const contentLength = res.getHeader('content-length');
        if (contentLength) {
          bytesOut =
            typeof contentLength === 'string'
              ? parseInt(contentLength, 10)
              : (contentLength as number);
        } else {
          bytesOut = responseSize;
        }
      }

      // Build metric object
      const metric: RequestMetric = {
        timestamp: new Date(),
        requestId,
        path,
        method,
        statusCode: res.statusCode,
        duration,
        userId: metricsReq.userId ?? opts.getUserId?.(req),
        ip,
        userAgent,
        backend: metricsReq.backend,
        bytesIn,
        bytesOut,
        error: res.statusCode >= 400 ? res.statusMessage : undefined,
        rateLimited: metricsReq.rateLimited,
        cached: metricsReq.cached,
        tier: metricsReq.tier ?? opts.getTier?.(req),
      };

      // Record the metric
      collector.recordRequest(metric);

      // Debug logging
      if (opts.debug) {
        logger.debug('Request metric recorded', {
          requestId,
          path,
          method,
          statusCode: res.statusCode,
          duration,
          ip,
        });
      }
    };

    // Listen for response finish
    res.on('finish', onFinish);

    next();
  };
}

// =============================================================================
// Rate Limit Metrics Middleware
// =============================================================================

/**
 * Options for rate limit metrics middleware
 */
export interface RateLimitMetricsOptions {
  /**
   * Extract user ID from request
   */
  getUserId?: (req: Request) => string | undefined;

  /**
   * Extract user tier from request
   */
  getTier?: (req: Request) => string | undefined;

  /**
   * Trust proxy for IP extraction
   */
  trustProxy?: boolean;
}

/**
 * Record rate limit check result
 *
 * Call this function from your rate limiter to record metrics
 * about rate limit checks.
 *
 * @example
 * ```typescript
 * import { recordRateLimitMetric } from './monitoring/middleware';
 *
 * // In your rate limiter
 * const result = await rateLimiter.check(key);
 * recordRateLimitMetric(req, {
 *   key,
 *   allowed: result.allowed,
 *   remaining: result.remaining,
 *   limit: result.limit,
 *   algorithm: 'token-bucket',
 * });
 * ```
 */
export function recordRateLimitMetric(
  req: Request,
  data: {
    key: string;
    allowed: boolean;
    remaining: number;
    limit: number;
    algorithm: string;
    userId?: string;
    tier?: string;
  },
  options: RateLimitMetricsOptions = {}
): void {
  const collector = getMetricsCollector();
  const trustProxy = options.trustProxy ?? true;

  const metric: RateLimitMetric = {
    timestamp: new Date(),
    key: data.key,
    endpoint: req.path || req.url,
    allowed: data.allowed,
    remaining: data.remaining,
    limit: data.limit,
    userId: data.userId ?? options.getUserId?.(req),
    ip: getClientIp(req, trustProxy),
    tier: data.tier ?? options.getTier?.(req),
    algorithm: data.algorithm,
  };

  collector.recordRateLimit(metric);

  // Mark request as rate limited if blocked
  if (!data.allowed) {
    (req as MetricsRequest).rateLimited = true;
  }
}

// =============================================================================
// Backend Metrics Helper
// =============================================================================

/**
 * Record backend health check result
 *
 * Call this function from your health checker to record metrics
 * about backend health.
 *
 * @example
 * ```typescript
 * import { recordBackendMetric } from './monitoring/middleware';
 *
 * // In your health checker
 * const result = await checkBackendHealth(backend);
 * recordBackendMetric({
 *   backend: backend.name,
 *   healthy: result.healthy,
 *   responseTime: result.responseTime,
 *   consecutiveFailures: backend.consecutiveFailures,
 *   consecutiveSuccesses: backend.consecutiveSuccesses,
 * });
 * ```
 */
export function recordBackendMetric(_data: {
  backend: string;
  healthy: boolean;
  responseTime?: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}): void {
  const collector = getMetricsCollector();

  collector.recordBackend({
    timestamp: new Date(),
    backend: _data.backend,
    healthy: _data.healthy,
    responseTime: _data.responseTime,
    consecutiveFailures: _data.consecutiveFailures,
    consecutiveSuccesses: _data.consecutiveSuccesses,
  });
}

// =============================================================================
// Active Connections Tracking
// =============================================================================

/**
 * Create middleware to track active connections
 *
 * This middleware increments a counter when a request starts and
 * decrements it when the response finishes.
 *
 * @example
 * ```typescript
 * import { createConnectionTrackingMiddleware } from './monitoring/middleware';
 *
 * app.use(createConnectionTrackingMiddleware());
 * ```
 */
export function createConnectionTrackingMiddleware(): RequestHandler {
  const collector = getMetricsCollector();
  let activeConnections = 0;

  return (_req: Request, res: Response, next: NextFunction): void => {
    activeConnections++;
    collector.setActiveConnections(activeConnections);

    let decremented = false;
    const onFinish = (): void => {
      // Prevent double-decrement since both 'finish' and 'close' events can fire
      if (decremented) return;
      decremented = true;
      activeConnections--;
      collector.setActiveConnections(activeConnections);
    };

    res.on('finish', onFinish);
    res.on('close', onFinish);

    next();
  };
}

// =============================================================================
// Request Timing Header Middleware
// =============================================================================

/**
 * Add Server-Timing header to responses
 *
 * This middleware adds a Server-Timing header that can be used by
 * browser DevTools to display timing information.
 *
 * @example
 * ```typescript
 * import { createServerTimingMiddleware } from './monitoring/middleware';
 *
 * app.use(createServerTimingMiddleware());
 * // Response will include: Server-Timing: total;dur=123
 * ```
 */
export function createServerTimingMiddleware(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const startTime = Date.now();

    // Override end to add timing header
    const originalEnd = res.end.bind(res);

    res.end = function (
      chunk?: unknown,
      encodingOrCallback?: BufferEncoding | (() => void),
      callback?: () => void
    ): Response {
      const duration = Date.now() - startTime;

      // Don't add header if response already sent
      if (!res.headersSent) {
        res.setHeader('Server-Timing', `total;dur=${duration}`);
      }

      if (typeof encodingOrCallback === 'function') {
        return originalEnd(chunk, encodingOrCallback) as Response;
      }
      if (encodingOrCallback) {
        return originalEnd(chunk, encodingOrCallback, callback) as Response;
      }
      return originalEnd(chunk) as Response;
    };

    next();
  };
}

// =============================================================================
// Exports
// =============================================================================

export default {
  createMetricsMiddleware,
  recordRateLimitMetric,
  recordBackendMetric,
  createConnectionTrackingMiddleware,
  createServerTimingMiddleware,
};
