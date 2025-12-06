/**
 * AEGIS - Authentication Middleware
 *
 * Express middleware for authentication and authorization
 */

import { type Request, type Response, type NextFunction } from 'express';

import logger from '../utils/logger.js';
import { AuthService } from './auth-service.js';
import { RbacService } from './rbac-service.js';
import type { AuthConfig, AuthenticatedUser } from './types.js';

// =============================================================================
// Middleware Factory
// =============================================================================

export interface AuthMiddlewareOptions {
  authService: AuthService;
  rbacService: RbacService;
  config: AuthConfig;
}

/**
 * Create authentication middleware
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { authService, rbacService, config } = options;

  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Skip auth if disabled
      if (!config.enabled) {
        return next();
      }

      // Authenticate the request
      const user = await authService.authenticate(req);

      if (!user && !config.allowAnonymous) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
          code: 'AUTH_REQUIRED',
        });
        return;
      }

      // Attach user to request
      req.user = user || undefined;

      // If RBAC is enabled, check permissions
      if (config.rbac?.enabled && user) {
        const accessResult = rbacService.checkAccess(user, req.path, req.method);

        if (!accessResult.allowed) {
          logger.warn('Access denied', {
            userId: user.id,
            path: req.path,
            method: req.method,
            reason: accessResult.reason,
            userRoles: accessResult.userRoles,
          });

          res.status(403).json({
            error: 'Forbidden',
            message: accessResult.reason || 'You do not have permission to access this resource',
            code: 'ACCESS_DENIED',
            requiredRoles: accessResult.requiredRoles,
          });
          return;
        }
      }

      next();
    } catch (error) {
      logger.error('Authentication middleware error', {
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
      });

      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Authentication processing failed',
        code: 'AUTH_ERROR',
      });
    }
  };
}

/**
 * Create middleware that requires specific roles
 */
export function requireRoles(rbacService: RbacService, ...requiredRoles: string[]) {
  return function roleMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const hasRequiredRole = requiredRoles.some((role) => rbacService.hasRole(user, role));

    if (!hasRequiredRole) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Required role(s): ${requiredRoles.join(', ')}`,
        code: 'INSUFFICIENT_ROLE',
        requiredRoles,
        userRoles: user.roles,
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that requires specific permissions
 */
export function requirePermission(resource: string, action: string, rbacService: RbacService) {
  return function permissionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const accessResult = rbacService.checkAccess(user, resource, action);

    if (!accessResult.allowed) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Permission denied for ${action} on ${resource}`,
        code: 'PERMISSION_DENIED',
        reason: accessResult.reason,
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that requires authentication (any valid auth)
 */
export function requireAuth() {
  return function authRequiredMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (!req.user || req.user.authType === 'none') {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that requires specific auth type
 */
export function requireAuthType(...authTypes: AuthenticatedUser['authType'][]) {
  return function authTypeMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    if (!authTypes.includes(user.authType)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: `Required authentication type: ${authTypes.join(' or ')}`,
        code: 'INVALID_AUTH_TYPE',
        required: authTypes,
        actual: user.authType,
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that requires specific tier
 */
export function requireTier(...allowedTiers: AuthenticatedUser['tier'][]) {
  return function tierMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    if (!allowedTiers.includes(user.tier)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `This endpoint requires tier: ${allowedTiers.join(' or ')}`,
        code: 'INSUFFICIENT_TIER',
        required: allowedTiers,
        actual: user.tier,
      });
      return;
    }

    next();
  };
}

/**
 * Optional auth middleware - authenticates if credentials provided, but doesn't require it
 */
export function optionalAuth(authService: AuthService, config: AuthConfig) {
  return async function optionalAuthMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!config.enabled) {
        return next();
      }

      // Try to authenticate, but don't fail if no credentials
      const hasAuthHeader = req.headers.authorization || req.headers['x-api-key'];
      if (hasAuthHeader) {
        const user = await authService.authenticate(req);
        req.user = user || undefined;
      }

      next();
    } catch (error) {
      // Log but don't fail - optional auth should be lenient
      logger.debug('Optional auth failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      next();
    }
  };
}
