/**
 * AEGIS - Request ID Middleware
 * Assigns a unique identifier to each incoming request for tracing
 */

import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

import type { ProxyRequest } from '../../utils/types.js';

// =============================================================================
// Constants
// =============================================================================

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_RESPONSE_HEADER = 'X-Request-ID';

// =============================================================================
// Request ID Middleware
// =============================================================================

/**
 * Middleware that assigns a unique request ID to each incoming request.
 * If the request already has an X-Request-ID header, it will be used.
 * Otherwise, a new UUID will be generated.
 *
 * The request ID is:
 * - Added to req.requestId for use in application code
 * - Added to response headers for client correlation
 * - Available for logging and tracing throughout the request lifecycle
 */
export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const proxyReq = req as ProxyRequest;

    // Use existing request ID from header or generate a new one
    const existingId = req.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof existingId === 'string' && existingId.length > 0
        ? existingId
        : Array.isArray(existingId) && existingId[0]
          ? existingId[0]
          : uuidv4();

    // Attach to request object
    proxyReq.requestId = requestId;

    // Add to response headers
    res.setHeader(REQUEST_ID_RESPONSE_HEADER, requestId);

    // Add to request headers for downstream services
    req.headers[REQUEST_ID_HEADER] = requestId;

    next();
  };
}

/**
 * Get the request ID from a request object
 */
export function getRequestId(req: Request): string {
  const proxyReq = req as ProxyRequest;
  return proxyReq.requestId ?? 'unknown';
}

/**
 * Generate a new request ID
 */
export function generateRequestId(): string {
  return uuidv4();
}

export default requestIdMiddleware;
