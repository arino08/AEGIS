/**
 * AEGIS - Rate Limit Middleware
 * Express middleware for enforcing rate limits with proper response headers
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import logger from '../utils/logger.js';
import type { ProxyRequest } from '../utils/types.js';

import type { RateLimiter, RateLimitCheckResult } from './limiter.js';
import type { RateLimitContext, RateLimitTier, RateLimitHeaders } from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface RateLimitMiddlewareOptions {
  /** Rate limiter instance */
  limiter: RateLimiter;

  /** Function to extract user ID from request */
  extractUserId?: (req: Request) => string | undefined;

  /** Function to extract API key from request */
  extractApiKey?: (req: Request) => string | undefined;

  /** Function to extract tier from request */
  extractTier?: (req: Request) => RateLimitTier;

  /** Whether to skip rate limiting for certain requests */
  skip?: (req: Request) => boolean;

  /** Custom error handler */
  onRateLimitExceeded?: (req: Request, res: Response, result: RateLimitCheckResult) => void;

  /** Custom success handler (for logging, metrics, etc.) */
  onRateLimitPassed?: (req: Request, res: Response, result: RateLimitCheckResult) => void;

  /** Whether to always include rate limit headers (even for bypassed requests) */
  alwaysIncludeHeaders?: boolean;

  /** Whether to trust X-Forwarded-For header for IP */
  trustProxy?: boolean;

  /** Header name for API key (default: 'x-api-key') */
  apiKeyHeader?: string;

  /** Header name for custom user ID (default: 'x-user-id') */
  userIdHeader?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract client IP from request
 */
function extractClientIP(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    // Check X-Forwarded-For header
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0];
      if (ips) {
        return ips.trim();
      }
    }

    // Check X-Real-IP header
    const realIP = req.headers['x-real-ip'];
    if (realIP) {
      const ip = Array.isArray(realIP) ? realIP[0] : realIP;
      if (ip) {
        return ip;
      }
    }
  }

  // Fall back to socket remote address
  return req.socket.remoteAddress ?? req.ip ?? '0.0.0.0';
}

/**
 * Default user ID extractor
 * Looks for user ID in JWT payload or custom header
 */
function defaultExtractUserId(req: Request, userIdHeader: string): string | undefined {
  // Check custom header
  const headerUserId = req.headers[userIdHeader.toLowerCase()];
  if (headerUserId) {
    return Array.isArray(headerUserId) ? headerUserId[0] : headerUserId;
  }

  // Check if user was set by auth middleware (common pattern)
  const anyReq = req as unknown as Record<string, unknown>;
  if (anyReq.user && typeof anyReq.user === 'object') {
    const user = anyReq.user as Record<string, unknown>;
    if (typeof user.id === 'string') {
      return user.id;
    }
    if (typeof user.sub === 'string') {
      return user.sub;
    }
  }

  return undefined;
}

/**
 * Default API key extractor
 * Looks for API key in header or query parameter
 */
function defaultExtractApiKey(req: Request, apiKeyHeader: string): string | undefined {
  // Check header
  const headerKey = req.headers[apiKeyHeader.toLowerCase()];
  if (headerKey) {
    return Array.isArray(headerKey) ? headerKey[0] : headerKey;
  }

  // Check Authorization header for Bearer token that might be an API key
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    // Check if it looks like an API key (not a JWT)
    if (!token.includes('.')) {
      return token;
    }
  }

  // Check query parameter (useful for some APIs)
  if (typeof req.query.api_key === 'string') {
    return req.query.api_key;
  }
  if (typeof req.query.apiKey === 'string') {
    return req.query.apiKey;
  }

  return undefined;
}

/**
 * Default tier extractor
 * Returns anonymous for unauthenticated requests
 */
function defaultExtractTier(_req: Request): RateLimitTier {
  // This would typically be set by looking up the user/API key
  // Default implementation returns anonymous
  return 'anonymous';
}

/**
 * Build rate limit context from request
 */
function buildContext(req: Request, options: RateLimitMiddlewareOptions): RateLimitContext {
  const {
    extractUserId,
    extractApiKey,
    extractTier,
    trustProxy = true,
    apiKeyHeader = 'x-api-key',
    userIdHeader = 'x-user-id',
  } = options;

  const ip = extractClientIP(req, trustProxy);
  const userId = extractUserId ? extractUserId(req) : defaultExtractUserId(req, userIdHeader);
  const apiKey = extractApiKey ? extractApiKey(req) : defaultExtractApiKey(req, apiKeyHeader);
  const tier = extractTier ? extractTier(req) : defaultExtractTier(req);

  // Get request ID from our middleware or generate one
  const proxyReq = req as ProxyRequest;
  const requestId = proxyReq.requestId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    ip,
    userId,
    apiKey,
    tier,
    path: req.path,
    method: req.method,
    headers: req.headers as Record<string, string | string[] | undefined>,
    requestId,
  };
}

/**
 * Set rate limit headers on response
 */
function setRateLimitHeaders(res: Response, headers: RateLimitHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      res.setHeader(name, value);
    }
  }
}

/**
 * Default rate limit exceeded handler
 */
function defaultOnRateLimitExceeded(
  _req: Request,
  res: Response,
  result: RateLimitCheckResult,
  limiter: RateLimiter
): void {
  const headers = limiter.generateHeaders(result);
  setRateLimitHeaders(res, headers);

  const body = limiter.generateErrorBody(result);
  res.status(429).json(body);
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Create rate limit middleware
 */
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions): RequestHandler {
  const {
    limiter,
    skip,
    onRateLimitExceeded,
    onRateLimitPassed,
    alwaysIncludeHeaders = false,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Check if we should skip this request
    if (skip && skip(req)) {
      next();
      return;
    }

    // Check if rate limiting is enabled
    if (!limiter.isEnabled()) {
      next();
      return;
    }

    try {
      // Build context from request
      const context = buildContext(req, options);

      // Check rate limit
      const result = await limiter.check(context);

      // Set headers if configured
      if (limiter.shouldIncludeHeaders() || alwaysIncludeHeaders) {
        const headers = limiter.generateHeaders(result);
        setRateLimitHeaders(res, headers);
      }

      // Check if request is allowed
      if (!result.allowed) {
        // Rate limit exceeded
        if (onRateLimitExceeded) {
          onRateLimitExceeded(req, res, result);
        } else {
          defaultOnRateLimitExceeded(req, res, result, limiter);
        }
        return;
      }

      // Request allowed
      if (onRateLimitPassed) {
        onRateLimitPassed(req, res, result);
      }

      // Store result on request for downstream use
      (req as RateLimitedRequest).rateLimitResult = result;

      next();
    } catch (error) {
      // Log error but don't block the request (fail open)
      logger.error('Rate limit middleware error', {
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
        method: req.method,
      });

      // Continue without rate limiting
      next();
    }
  };
}

// =============================================================================
// Typed Request Interface
// =============================================================================

export interface RateLimitedRequest extends Request {
  rateLimitResult?: RateLimitCheckResult;
}

// =============================================================================
// Convenience Factories
// =============================================================================

/**
 * Create a simple IP-based rate limit middleware
 */
export function createIPRateLimitMiddleware(
  limiter: RateLimiter,
  options: Partial<Omit<RateLimitMiddlewareOptions, 'limiter'>> = {}
): RequestHandler {
  return createRateLimitMiddleware({
    limiter,
    extractTier: () => 'anonymous',
    ...options,
  });
}

/**
 * Create a user-based rate limit middleware
 * Requires authentication middleware to run first
 */
export function createUserRateLimitMiddleware(
  limiter: RateLimiter,
  options: Partial<Omit<RateLimitMiddlewareOptions, 'limiter'>> = {}
): RequestHandler {
  return createRateLimitMiddleware({
    limiter,
    extractTier: (req) => {
      // Check if user is authenticated
      const anyReq = req as unknown as Record<string, unknown>;
      if (anyReq.user) {
        return 'free'; // Authenticated users get 'free' tier by default
      }
      return 'anonymous';
    },
    ...options,
  });
}

/**
 * Create an API key-based rate limit middleware
 */
export function createAPIKeyRateLimitMiddleware(
  limiter: RateLimiter,
  options: Partial<Omit<RateLimitMiddlewareOptions, 'limiter'>> = {}
): RequestHandler {
  return createRateLimitMiddleware({
    limiter,
    extractTier: (req) => {
      // Check if API key is present
      const apiKey = defaultExtractApiKey(req, options.apiKeyHeader ?? 'x-api-key');
      if (apiKey) {
        // Look up tier from limiter
        const tier = limiter.getTier(`apikey:${apiKey}`);
        return tier ?? 'free';
      }
      return 'anonymous';
    },
    ...options,
  });
}

/**
 * Create a per-endpoint rate limit middleware
 * Useful for protecting specific expensive endpoints
 */
export function createEndpointRateLimitMiddleware(
  limiter: RateLimiter,
  options: Partial<Omit<RateLimitMiddlewareOptions, 'limiter'>> = {}
): RequestHandler {
  return createRateLimitMiddleware({
    limiter,
    ...options,
  });
}

// =============================================================================
// Skip Functions
// =============================================================================

/**
 * Skip rate limiting for health check endpoints
 */
export function skipHealthChecks(req: Request): boolean {
  const healthPaths = ['/health', '/healthz', '/ready', '/metrics', '/ping'];
  return healthPaths.includes(req.path);
}

/**
 * Skip rate limiting for static assets
 */
export function skipStaticAssets(req: Request): boolean {
  const staticExtensions = [
    '.css',
    '.js',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.svg',
    '.woff',
    '.woff2',
  ];
  return staticExtensions.some((ext) => req.path.endsWith(ext));
}

/**
 * Skip rate limiting for internal requests
 */
export function skipInternalRequests(req: Request): boolean {
  const internalHeader = req.headers['x-internal-request'];
  return internalHeader === 'true';
}

/**
 * Combine multiple skip functions
 */
export function combineSkipFunctions(
  ...skipFns: ((req: Request) => boolean)[]
): (req: Request) => boolean {
  return (req: Request) => skipFns.some((fn) => fn(req));
}

// =============================================================================
// Default Export
// =============================================================================

export default createRateLimitMiddleware;
