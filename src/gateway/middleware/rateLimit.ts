/**
 * AEGIS - Rate Limit Middleware
 * Gateway-specific rate limit middleware wrapper
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import {
  type RateLimiter,
  createRateLimitMiddleware,
  skipHealthChecks,
  skipStaticAssets,
  combineSkipFunctions,
  type RateLimitCheckResult,
} from '../../rate-limiter/index.js';
import logger from '../../utils/logger.js';
import type { ProxyRequest } from '../../utils/types.js';

// =============================================================================
// Types
// =============================================================================

export interface GatewayRateLimitOptions {
  /** Rate limiter instance */
  limiter: RateLimiter;

  /** Skip health check endpoints */
  skipHealthChecks?: boolean;

  /** Skip static assets */
  skipStaticAssets?: boolean;

  /** Additional paths to skip */
  skipPaths?: string[];

  /** Custom error message */
  errorMessage?: string;

  /** Whether to log rate limit events */
  logEvents?: boolean;
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Create gateway-specific rate limit middleware
 */
export function createGatewayRateLimitMiddleware(
  options: GatewayRateLimitOptions
): RequestHandler {
  const {
    limiter,
    skipHealthChecks: skipHealth = true,
    skipStaticAssets: skipStatic = false,
    skipPaths = [],
    errorMessage = 'Too many requests. Please try again later.',
    logEvents = true,
  } = options;

  // Build skip function
  const skipFunctions: ((req: Request) => boolean)[] = [];

  if (skipHealth) {
    skipFunctions.push(skipHealthChecks);
  }

  if (skipStatic) {
    skipFunctions.push(skipStaticAssets);
  }

  if (skipPaths.length > 0) {
    skipFunctions.push((req: Request) => skipPaths.includes(req.path));
  }

  const skip = skipFunctions.length > 0 ? combineSkipFunctions(...skipFunctions) : undefined;

  return createRateLimitMiddleware({
    limiter,
    skip,
    trustProxy: true,
    onRateLimitExceeded: (req: Request, res: Response, result: RateLimitCheckResult) => {
      const proxyReq = req as ProxyRequest;

      if (logEvents) {
        logger.warn('Rate limit exceeded', {
          requestId: proxyReq.requestId,
          ip: req.ip,
          path: req.path,
          method: req.method,
          limit: result.limit,
          remaining: result.remaining,
          retryAfter: result.retryAfter,
          algorithm: result.algorithm,
          key: result.key,
          bypassed: result.bypassed,
        });
      }

      // Set standard rate limit headers
      res.setHeader('X-RateLimit-Limit', result.limit.toString());
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', result.resetAt.toString());
      res.setHeader('Retry-After', result.retryAfter.toString());

      // Send JSON error response
      res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMIT_EXCEEDED',
        message: errorMessage,
        limit: result.limit,
        remaining: 0,
        windowSeconds: result.retryAfter,
        retryAfter: result.retryAfter,
        resetAt: new Date(result.resetAt * 1000).toISOString(),
      });
    },
    onRateLimitPassed: (req: Request, _res: Response, result: RateLimitCheckResult) => {
      const proxyReq = req as ProxyRequest;

      // Store rate limit info on request for downstream use
      (req as RateLimitedProxyRequest).rateLimit = {
        limit: result.limit,
        remaining: result.remaining,
        resetAt: result.resetAt,
        algorithm: result.algorithm,
        bypassed: result.bypassed,
      };

      if (logEvents && result.remaining <= Math.ceil(result.limit * 0.1)) {
        // Log when nearing limit (below 10% remaining)
        logger.debug('Rate limit warning - nearing limit', {
          requestId: proxyReq.requestId,
          ip: req.ip,
          path: req.path,
          limit: result.limit,
          remaining: result.remaining,
        });
      }
    },
  });
}

// =============================================================================
// Extended Request Type
// =============================================================================

export interface RateLimitedProxyRequest extends ProxyRequest {
  rateLimit?: {
    limit: number;
    remaining: number;
    resetAt: number;
    algorithm: string;
    bypassed: boolean;
  };
}

// =============================================================================
// Utility Middleware
// =============================================================================

/**
 * Middleware to add rate limit headers to all responses
 * Use after the main rate limit middleware to ensure headers are always present
 */
export function rateLimitHeadersMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rateLimitedReq = req as RateLimitedProxyRequest;

    if (rateLimitedReq.rateLimit) {
      res.setHeader('X-RateLimit-Limit', rateLimitedReq.rateLimit.limit.toString());
      res.setHeader('X-RateLimit-Remaining', rateLimitedReq.rateLimit.remaining.toString());
      res.setHeader('X-RateLimit-Reset', rateLimitedReq.rateLimit.resetAt.toString());
    }

    next();
  };
}

/**
 * Express error handler for rate limit errors
 */
export function rateLimitErrorHandler(
  err: Error & { statusCode?: number; retryAfter?: number },
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err.statusCode === 429) {
    res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
      message: err.message || 'Too many requests',
      retryAfter: err.retryAfter || 60,
    });
    return;
  }

  next(err);
}

export default createGatewayRateLimitMiddleware;
