/**
 * AEGIS - Authentication & Authorization Module
 *
 * Barrel export file for the auth module
 */

// Types
export * from './types.js';

// Services
export { AuthService, createAuthService } from './auth-service.js';
export { RbacService, createRbacService, DEFAULT_ROLES } from './rbac-service.js';

// Middleware
export {
  createAuthMiddleware,
  requireRoles,
  requirePermission,
  requireAuth,
  requireAuthType,
  requireTier,
  optionalAuth,
  type AuthMiddlewareOptions,
} from './middleware.js';

// Transform
export {
  createRequestTransform,
  createResponseTransform,
  createTransformMiddleware,
  DEFAULT_SENSITIVE_HEADERS,
  DEFAULT_TRANSFORM_CONFIG,
  type RequestTransformOptions,
  type ResponseTransformOptions,
} from './transform.js';
