/**
 * AEGIS - Request/Response Transformation Middleware
 *
 * Header injection, modification, and sensitive data stripping
 */

import { type Request, type Response, type NextFunction } from 'express';
import type { OutgoingHttpHeaders, OutgoingHttpHeader } from 'http';

import logger from '../utils/logger.js';
import type { TransformConfig, RequestTransformConfig, ResponseTransformConfig } from './types.js';

// =============================================================================
// Default Sensitive Headers to Remove
// =============================================================================

export const DEFAULT_SENSITIVE_HEADERS = [
  // Server/Infrastructure headers
  'x-database-server',
  'x-db-server',
  'x-database-host',
  'x-redis-host',
  'x-cache-server',
  'x-internal-host',
  'x-backend-server',
  'x-upstream-host',
  'x-origin-server',

  // Security-sensitive headers
  'x-api-key',
  'x-internal-api-key',
  'x-secret-key',
  'x-auth-token',
  'x-internal-token',
  'x-service-token',

  // Debug headers that leak info
  'x-debug-info',
  'x-debug-token',
  'x-stack-trace',
  'x-sql-query',
  'x-query-time',

  // Server technology headers
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
  'x-php-version',
  'x-runtime',

  // Internal routing headers
  'x-internal-route',
  'x-service-name',
  'x-instance-id',
  'x-pod-name',
  'x-container-id',
  'x-node-name',
];

// =============================================================================
// Request Transformation
// =============================================================================

export interface RequestTransformOptions {
  config: RequestTransformConfig;
  trustProxy?: boolean;
}

/**
 * Create request transformation middleware
 */
export function createRequestTransform(options: RequestTransformOptions) {
  const { config, trustProxy = true } = options;

  return function requestTransformMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction
  ): void {
    try {
      // Add custom headers
      if (config.headers?.add) {
        for (const [name, value] of Object.entries(config.headers.add)) {
          const headerValue = typeof value === 'function' ? value(req) : value;
          req.headers[name.toLowerCase()] = headerValue;
        }
      }

      // Rename headers
      if (config.headers?.rename) {
        for (const [oldName, newName] of Object.entries(config.headers.rename)) {
          const lowerOld = oldName.toLowerCase();
          if (req.headers[lowerOld]) {
            req.headers[newName.toLowerCase()] = req.headers[lowerOld];
            delete req.headers[lowerOld];
          }
        }
      }

      // Remove headers
      if (config.headers?.remove) {
        for (const name of config.headers.remove) {
          delete req.headers[name.toLowerCase()];
        }
      }

      // Inject user info headers
      if (config.injectUserInfo && req.user) {
        req.headers['x-user-id'] = req.user.id;
        if (req.user.email) {
          req.headers['x-user-email'] = req.user.email;
        }
        if (req.user.roles?.length) {
          req.headers['x-user-roles'] = req.user.roles.join(',');
        }
        req.headers['x-user-tier'] = req.user.tier;
        req.headers['x-auth-type'] = req.user.authType;
      }

      // Inject request ID (if not already present)
      if (config.injectRequestId) {
        const requestId = req.headers['x-request-id'] ||
                         req.headers['x-correlation-id'] ||
                         generateRequestId();
        req.headers['x-request-id'] = requestId as string;
      }

      // Inject forwarded headers
      if (config.injectForwardedHeaders) {
        // X-Forwarded-For
        const clientIp = getClientIp(req, trustProxy);
        const existingForwardedFor = req.headers['x-forwarded-for'];
        if (existingForwardedFor) {
          req.headers['x-forwarded-for'] = `${existingForwardedFor}, ${clientIp}`;
        } else {
          req.headers['x-forwarded-for'] = clientIp;
        }

        // X-Forwarded-Proto
        if (!req.headers['x-forwarded-proto']) {
          req.headers['x-forwarded-proto'] = req.protocol;
        }

        // X-Forwarded-Host
        if (!req.headers['x-forwarded-host']) {
          req.headers['x-forwarded-host'] = req.headers.host || '';
        }

        // X-Real-IP (original client IP)
        if (!req.headers['x-real-ip']) {
          req.headers['x-real-ip'] = clientIp;
        }
      }

      next();
    } catch (error) {
      logger.error('Request transformation error', {
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
      });
      next(error);
    }
  };
}

// =============================================================================
// Response Transformation
// =============================================================================

export interface ResponseTransformOptions {
  config: ResponseTransformConfig;
}

/**
 * Create response transformation middleware
 */
export function createResponseTransform(options: ResponseTransformOptions) {
  const { config } = options;
  const sensitiveHeaders = new Set([
    ...DEFAULT_SENSITIVE_HEADERS,
    ...(config.sensitiveHeaders || []),
    ...(config.headers?.remove || []),
  ].map((h) => h.toLowerCase()));

  return function responseTransformMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Store original methods
    const originalSetHeader = res.setHeader.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    // Override setHeader to filter sensitive headers
    res.setHeader = function (name: string, value: string | number | readonly string[]) {
      const lowerName = name.toLowerCase();

      // Skip sensitive headers
      if (sensitiveHeaders.has(lowerName)) {
        logger.debug('Stripped sensitive response header', { header: name });
        return res;
      }

      // Check if header should be renamed
      if (config.headers?.rename && config.headers.rename[name]) {
        return originalSetHeader(config.headers.rename[name], value);
      }

      return originalSetHeader(name, value);
    };

    // Override writeHead to add/modify headers before sending
    const customWriteHead = function (
      this: Response,
      statusCode: number,
      statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
      maybeHeaders?: OutgoingHttpHeaders | OutgoingHttpHeader[]
    ): Response {
      // Add custom headers
      if (config.headers?.add) {
        for (const [name, value] of Object.entries(config.headers.add)) {
          if (!sensitiveHeaders.has(name.toLowerCase())) {
            res.setHeader(name, value);
          }
        }
      }

      // Add security headers
      addSecurityHeaders(res);

      // Call original writeHead with proper arguments
      // Use type assertion to handle overloaded function signature
      if (typeof statusMessageOrHeaders === 'string') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalWriteHead as any).call(this, statusCode, statusMessageOrHeaders, maybeHeaders);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalWriteHead as any).call(this, statusCode, statusMessageOrHeaders);
    };
    res.writeHead = customWriteHead as typeof res.writeHead;

    // Add listener for 'finish' event to log transformation
    res.on('finish', () => {
      logger.debug('Response headers transformed', {
        path: req.path,
        statusCode: res.statusCode,
      });
    });

    next();
  };
}

/**
 * Add security headers to response
 */
function addSecurityHeaders(res: Response): void {
  // Only add if not already set
  if (!res.getHeader('X-Content-Type-Options')) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if (!res.getHeader('X-Frame-Options')) {
    res.setHeader('X-Frame-Options', 'DENY');
  }
  if (!res.getHeader('X-XSS-Protection')) {
    res.setHeader('X-XSS-Protection', '1; mode=block');
  }
  if (!res.getHeader('Referrer-Policy')) {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
}

// =============================================================================
// Combined Transform Middleware
// =============================================================================

/**
 * Create combined request and response transformation middleware
 */
export function createTransformMiddleware(config: TransformConfig, trustProxy = true) {
  const requestTransform = createRequestTransform({
    config: config.request,
    trustProxy,
  });

  const responseTransform = createResponseTransform({
    config: config.response,
  });

  return function combinedTransformMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Apply response transform first (to set up listeners)
    responseTransform(req, res, (err) => {
      if (err) return next(err);
      // Then apply request transform
      requestTransform(req, res, next);
    });
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `req_${timestamp}_${random}`;
}

/**
 * Get client IP address from request
 */
function getClientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0];
      return first?.trim() || 'unknown';
    }
    if (req.headers['x-real-ip']) {
      return req.headers['x-real-ip'] as string;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_TRANSFORM_CONFIG: TransformConfig = {
  request: {
    headers: {
      add: {},
      remove: [],
      rename: {},
    },
    injectUserInfo: true,
    injectRequestId: true,
    injectForwardedHeaders: true,
  },
  response: {
    headers: {
      add: {},
      remove: [],
      rename: {},
    },
    sensitiveHeaders: DEFAULT_SENSITIVE_HEADERS,
  },
};
