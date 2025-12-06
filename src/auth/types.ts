/**
 * AEGIS - Authentication & Authorization Types
 *
 * Type definitions for multi-auth support and RBAC
 */

// =============================================================================
// Authentication Types
// =============================================================================

export type AuthType = 'api-key' | 'jwt' | 'oauth' | 'basic' | 'none';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  roles: string[];
  permissions: Record<string, string[]>; // path pattern -> allowed methods
  tier: 'anonymous' | 'free' | 'basic' | 'pro' | 'enterprise' | 'unlimited';
  metadata?: Record<string, unknown>;
  authType: AuthType;
  tokenExp?: Date;
}

export interface ApiKeyRecord {
  key: string;
  keyHash: string; // hashed version for storage
  name: string;
  userId: string;
  roles: string[];
  permissions: Record<string, string[]>;
  tier: AuthenticatedUser['tier'];
  createdAt: Date;
  expiresAt?: Date;
  lastUsedAt?: Date;
  rateLimit?: {
    requests: number;
    windowSeconds: number;
  };
  metadata?: Record<string, unknown>;
  enabled: boolean;
}

export interface JwtPayload {
  sub: string; // subject (user ID)
  email?: string;
  roles?: string[];
  permissions?: Record<string, string[]>;
  tier?: AuthenticatedUser['tier'];
  iat: number; // issued at
  exp: number; // expiration
  iss?: string; // issuer
  aud?: string | string[]; // audience
}

export interface OAuthConfig {
  provider: 'auth0' | 'okta' | 'google' | 'azure' | 'custom';
  issuer: string;
  audience?: string;
  jwksUri?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
}

// =============================================================================
// Authorization Types
// =============================================================================

export interface RoleDefinition {
  name: string;
  description?: string;
  permissions: PermissionRule[];
  inherits?: string[]; // roles this role inherits from
}

export interface PermissionRule {
  resource: string; // path pattern (e.g., "/api/admin/*")
  actions: string[]; // HTTP methods (e.g., ["GET", "POST"])
  conditions?: PermissionCondition[];
}

export interface PermissionCondition {
  type: 'ip' | 'time' | 'header' | 'custom';
  operator: 'equals' | 'contains' | 'matches' | 'in' | 'between';
  value: string | string[] | Record<string, unknown>;
}

export interface AccessControlResult {
  allowed: boolean;
  reason?: string;
  matchedRule?: string;
  requiredRoles?: string[];
  userRoles?: string[];
}

// =============================================================================
// Authentication Configuration
// =============================================================================

export interface AuthConfig {
  enabled: boolean;
  defaultAuthType: AuthType;
  allowAnonymous: boolean;
  anonymousPaths: string[]; // paths that don't require auth

  apiKey?: {
    enabled: boolean;
    headerName: string; // e.g., "X-API-Key" or "Authorization"
    prefix?: string; // e.g., "Bearer " or "ApiKey "
    hashAlgorithm: 'sha256' | 'sha512' | 'bcrypt';
  };

  jwt?: {
    enabled: boolean;
    secret?: string; // for HS256
    publicKey?: string; // for RS256
    algorithm: 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512';
    issuer?: string;
    audience?: string;
    clockTolerance?: number; // seconds
  };

  oauth?: OAuthConfig;

  rbac?: {
    enabled: boolean;
    defaultRole: string;
    roles: RoleDefinition[];
    superAdminRoles: string[]; // roles that bypass all checks
  };
}

// =============================================================================
// Request Transformation Types
// =============================================================================

export interface HeaderTransformRule {
  type: 'add' | 'remove' | 'modify' | 'rename';
  name: string;
  value?: string | ((req: unknown) => string);
  newName?: string; // for rename
  condition?: {
    header?: string;
    value?: string;
    pattern?: string;
  };
}

export interface RequestTransformConfig {
  headers: {
    add: Record<string, string | ((req: unknown) => string)>;
    remove: string[];
    rename: Record<string, string>;
  };
  injectUserInfo: boolean; // inject X-User-ID, X-User-Email, X-User-Roles
  injectRequestId: boolean; // inject X-Request-ID
  injectForwardedHeaders: boolean; // inject X-Forwarded-For, X-Forwarded-Proto
}

export interface ResponseTransformConfig {
  headers: {
    add: Record<string, string>;
    remove: string[]; // sensitive headers to strip
    rename: Record<string, string>;
  };
  sensitiveHeaders: string[]; // default headers to always remove
}

export interface TransformConfig {
  request: RequestTransformConfig;
  response: ResponseTransformConfig;
}

// =============================================================================
// Authentication Events
// =============================================================================

export interface AuthEvent {
  type: 'auth_success' | 'auth_failure' | 'token_expired' | 'permission_denied';
  userId?: string;
  authType: AuthType;
  ip: string;
  path: string;
  method: string;
  timestamp: Date;
  reason?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Express Extensions
// =============================================================================

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      authType?: AuthType;
      apiKey?: string;
      token?: string;
    }
  }
}
