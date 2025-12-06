/**
 * AEGIS - Request Logging Middleware
 * Logs incoming requests and their responses
 */

import type { Request, Response, NextFunction } from 'express';

import { logRequest } from '../../utils/logger.js';
import type { ProxyRequest } from '../../utils/types.js';
import { getClientIp } from '../../utils/helpers.js';

// =============================================================================
// Types
// =============================================================================

export interface RequestLoggerOptions {
  /** Skip logging for certain paths (e.g., health checks) */
  skipPaths?: string[];
  /** Skip logging for certain methods */
  skipMethods?: string[];
  /** Include request body in logs (be careful with sensitive data) */
  logBody?: boolean;
  /** Maximum body length to log */
  maxBodyLength?: number;
  /** Include response body in logs */
  logResponseBody?: boolean;
  /** Custom log fields extractor */
  customFields?: (req: Request) => Record<string, unknown>;
}

// =============================================================================
// Request Logger Middleware
// =============================================================================

/**
 * Creates a request logging middleware
 */
export function requestLogger(
  options: RequestLoggerOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const {
    skipPaths = ['/health', '/healthz', '/ready', '/metrics'],
    skipMethods = [],
    logBody = false,
    maxBodyLength = 1000,
    customFields,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const proxyReq = req as ProxyRequest;

    // Check if this request should be skipped
    if (skipPaths.some((path) => req.path.startsWith(path))) {
      next();
      return;
    }

    if (skipMethods.includes(req.method)) {
      next();
      return;
    }

    // Record start time if not already set
    if (!proxyReq.startTime) {
      proxyReq.startTime = Date.now();
    }

    // Log on response finish
    res.on('finish', () => {
      const durationMs = Date.now() - proxyReq.startTime;

      const logData: Parameters<typeof logRequest>[0] = {
        requestId: proxyReq.requestId || 'unknown',
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        responseTimeMs: durationMs,
        ipAddress: getClientIp(req.headers as Record<string, string | string[] | undefined>),
        userAgent: req.headers['user-agent'],
        targetBackend: proxyReq.targetBackend?.name,
      };

      // Add user ID if available
      if (proxyReq.userId) {
        logData.userId = proxyReq.userId;
      }

      // Add custom fields
      if (customFields) {
        const custom = customFields(req);
        Object.assign(logData, custom);
      }

      logRequest(logData);
    });

    // Log request body if enabled
    if (logBody && req.body) {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (body.length <= maxBodyLength) {
        // Log body separately to avoid cluttering the main log
        // This can be customized based on needs
      }
    }

    next();
  };
}

/**
 * Simple request logger that logs all requests without options
 */
export function simpleRequestLogger(req: Request, res: Response, next: NextFunction): void {
  const middleware = requestLogger();
  middleware(req, res, next);
}

export default requestLogger;
