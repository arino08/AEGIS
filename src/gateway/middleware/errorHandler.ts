/**
 * AEGIS - Error Handler Middleware
 * Centralized error handling for the gateway
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';

import logger from '../../utils/logger.js';
import { AegisError, ProxyError, RateLimitError, ValidationError } from '../../utils/types.js';

// =============================================================================
// Types
// =============================================================================

interface ErrorResponse {
  error: string;
  code: string;
  statusCode: number;
  requestId?: string;
  details?: string[];
  retryAfter?: number;
}

// =============================================================================
// Error Handler Middleware
// =============================================================================

/**
 * Central error handling middleware
 * Catches all errors and returns appropriate JSON responses
 */
export const errorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Get request ID if available
  const requestId = (req.headers['x-request-id'] as string) ?? undefined;

  // Build error response
  const errorResponse = buildErrorResponse(err, requestId);

  // Log the error
  logError(err, req, errorResponse);

  // Set rate limit header if applicable
  if (err instanceof RateLimitError) {
    res.setHeader('Retry-After', err.retryAfter);
    res.setHeader('X-RateLimit-Reset', Date.now() + err.retryAfter * 1000);
  }

  // Send error response
  res.status(errorResponse.statusCode).json(errorResponse);
};

/**
 * Build a standardized error response object
 */
function buildErrorResponse(err: Error, requestId?: string): ErrorResponse {
  // Handle known AEGIS errors
  if (err instanceof AegisError) {
    const response: ErrorResponse = {
      error: err.message,
      code: err.code,
      statusCode: err.statusCode,
    };

    if (requestId) {
      response.requestId = requestId;
    }

    // Add validation details if available
    if (err instanceof ValidationError && err.validationErrors.length > 0) {
      response.details = err.validationErrors;
    }

    // Add retry-after for rate limit errors
    if (err instanceof RateLimitError) {
      response.retryAfter = err.retryAfter;
    }

    return response;
  }

  // Handle standard HTTP errors (from Express or other middleware)
  if ('statusCode' in err && typeof err.statusCode === 'number') {
    return {
      error: err.message || 'An error occurred',
      code: 'HTTP_ERROR',
      statusCode: err.statusCode,
      requestId,
    };
  }

  // Handle unknown errors
  const isProduction = process.env['NODE_ENV'] === 'production';

  return {
    error: isProduction ? 'Internal server error' : err.message,
    code: 'INTERNAL_ERROR',
    statusCode: 500,
    requestId,
  };
}

/**
 * Log error with appropriate level and context
 */
function logError(err: Error, req: Request, errorResponse: ErrorResponse): void {
  const logContext = {
    requestId: errorResponse.requestId,
    method: req.method,
    path: req.path,
    statusCode: errorResponse.statusCode,
    errorCode: errorResponse.code,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };

  // Determine log level based on error type
  if (errorResponse.statusCode >= 500) {
    logger.error(err.message, {
      ...logContext,
      stack: err.stack,
    });
  } else if (errorResponse.statusCode >= 400) {
    logger.warn(err.message, logContext);
  } else {
    logger.info(err.message, logContext);
  }
}

// =============================================================================
// Not Found Handler
// =============================================================================

/**
 * Handle 404 Not Found errors
 */
export const notFoundHandler = (req: Request, res: Response, _next: NextFunction): void => {
  const requestId = (req.headers['x-request-id'] as string) ?? undefined;

  const errorResponse: ErrorResponse = {
    error: `Route not found: ${req.method} ${req.path}`,
    code: 'NOT_FOUND',
    statusCode: 404,
    requestId,
  };

  logger.warn('Route not found', {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  res.status(404).json(errorResponse);
};

// =============================================================================
// Async Handler Wrapper
// =============================================================================

/**
 * Wrap async route handlers to properly catch and forward errors
 */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// =============================================================================
// Error Factory Functions
// =============================================================================

/**
 * Create a standardized error for bad requests
 */
export function badRequest(message: string, details?: string[]): ValidationError {
  return new ValidationError(message, details);
}

/**
 * Create a standardized error for unauthorized requests
 */
export function unauthorized(message = 'Unauthorized'): AegisError {
  return new AegisError(message, 401, 'UNAUTHORIZED');
}

/**
 * Create a standardized error for forbidden requests
 */
export function forbidden(message = 'Forbidden'): AegisError {
  return new AegisError(message, 403, 'FORBIDDEN');
}

/**
 * Create a standardized error for not found resources
 */
export function notFound(message = 'Resource not found'): AegisError {
  return new AegisError(message, 404, 'NOT_FOUND');
}

/**
 * Create a standardized error for proxy failures
 */
export function proxyError(message: string, statusCode = 502): ProxyError {
  return new ProxyError(message, statusCode);
}

/**
 * Create a standardized error for rate limiting
 */
export function rateLimitExceeded(retryAfter: number): RateLimitError {
  return new RateLimitError('Rate limit exceeded', retryAfter);
}

export default errorHandler;
