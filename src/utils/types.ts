/**
 * AEGIS - Intelligent API Gateway
 * Core Type Definitions
 */

import { type Request, type Response, type NextFunction } from 'express';

// =============================================================================
// Server Configuration Types
// =============================================================================

export interface ServerConfig {
  port: number;
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
}

// =============================================================================
// Backend Configuration Types
// =============================================================================

export interface BackendConfig {
  name: string;
  url: string;
  routes: string[];
  healthCheck?: HealthCheckConfig;
  timeout?: number;
  retries?: number;
  weight?: number;
}

export interface HealthCheckConfig {
  path: string;
  intervalMs: number;
  timeoutMs: number;
  unhealthyThreshold: number;
  healthyThreshold: number;
}

// =============================================================================
// Database Configuration Types
// =============================================================================

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  poolMin: number;
  poolMax: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  tls: boolean;
}

// =============================================================================
// Rate Limiting Types
// =============================================================================

// Note: Full rate limiter types are in src/rate-limiter/types.ts
// These are the types used in configuration (AegisConfig)

export interface RateLimitConfig {
  enabled: boolean;
  defaultAlgorithm?: 'token-bucket' | 'sliding-window' | 'fixed-window';
  defaultRequests?: number;
  defaultWindowSeconds?: number;
  keyStrategy?: 'ip' | 'user' | 'api-key' | 'ip-endpoint' | 'user-endpoint' | 'composite';
  keyPrefix?: string;
  bypass?: {
    ips: string[];
    userIds: string[];
    apiKeys: string[];
    paths: string[];
    internal: boolean;
  };
  tierLimits?: {
    anonymous: { requests: number; windowSeconds: number };
    free: { requests: number; windowSeconds: number };
    basic: { requests: number; windowSeconds: number };
    pro: { requests: number; windowSeconds: number };
    enterprise: { requests: number; windowSeconds: number };
    unlimited: { requests: number; windowSeconds: number };
  };
  rules?: RateLimitRule[];
  algorithmConfig?: {
    tokenBucket?: { maxTokens: number; refillRate: number; initialTokens?: number };
    slidingWindow?: { windowSeconds: number; maxRequests: number; precision?: number };
    fixedWindow?: { windowSeconds: number; maxRequests: number };
  };
  includeHeaders?: boolean;
  errorMessage?: string;
  // Legacy fields for backward compatibility
  defaultRequestsPerMinute?: number;
  windowMs?: number;
}

export interface RateLimitRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match: {
    endpoint?: string;
    endpointMatchType?: 'exact' | 'prefix' | 'glob' | 'regex';
    methods?: string[];
    tiers?: ('anonymous' | 'free' | 'basic' | 'pro' | 'enterprise' | 'unlimited')[];
    userIds?: string[];
    ips?: string[];
    apiKeys?: string[];
    headers?: Record<string, string>;
  };
  rateLimit: {
    algorithm: 'token-bucket' | 'sliding-window' | 'fixed-window';
    requests: number;
    windowSeconds: number;
    burst?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: Date;
  limit: number;
}

// =============================================================================
// Circuit Breaker Configuration Types
// =============================================================================

export interface CircuitBreakerConfig {
  enabled?: boolean;
  failureThreshold?: number;
  successThreshold?: number;
  resetTimeoutMs?: number;
  failureWindowMs?: number;
  failureRateThreshold?: number;
}

// =============================================================================
// Proxy Configuration Types
// =============================================================================

export interface ProxyConfig {
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  circuitBreaker?: CircuitBreakerConfig;
  healthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    unhealthyThreshold?: number;
    healthyThreshold?: number;
  };
}

// =============================================================================
// Logging Types
// =============================================================================

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'http' | 'debug';
  format: 'json' | 'pretty';
  fileEnabled: boolean;
  filePath: string;
}

// =============================================================================
// Metrics Types
// =============================================================================

export interface MetricsConfig {
  enabled: boolean;
  flushIntervalMs: number;
}

// =============================================================================
// Authentication & Authorization Types
// =============================================================================

export type AuthType = 'api-key' | 'jwt' | 'oauth' | 'basic' | 'none';

export interface AuthConfig {
  enabled: boolean;
  defaultAuthType: AuthType;
  allowAnonymous: boolean;
  anonymousPaths: string[];
  apiKey?: {
    enabled: boolean;
    headerName: string;
    prefix?: string;
    hashAlgorithm: 'sha256' | 'sha512' | 'bcrypt';
  };
  jwt?: {
    enabled: boolean;
    secret?: string;
    publicKey?: string;
    algorithm: string;
    issuer?: string;
    audience?: string;
    clockTolerance?: number;
  };
  oauth?: {
    provider: 'auth0' | 'okta' | 'google' | 'azure' | 'custom';
    issuer: string;
    audience?: string;
    jwksUri?: string;
    clientId?: string;
    clientSecret?: string;
    tokenEndpoint?: string;
    userInfoEndpoint?: string;
  };
  rbac?: {
    enabled: boolean;
    defaultRole: string;
    roles: RoleDefinition[];
    superAdminRoles: string[];
  };
}

export interface RoleDefinition {
  name: string;
  description?: string;
  permissions: PermissionRule[];
  inherits?: string[];
}

export interface PermissionRule {
  resource: string;
  actions: string[];
  conditions?: Array<{
    type: 'ip' | 'time' | 'header' | 'custom';
    operator: 'equals' | 'contains' | 'matches' | 'in' | 'between';
    value: string | string[] | Record<string, unknown>;
  }>;
}

// =============================================================================
// Request/Response Transform Types
// =============================================================================

export interface TransformConfig {
  request: {
    headers: {
      add: Record<string, string>;
      remove: string[];
      rename: Record<string, string>;
    };
    injectUserInfo: boolean;
    injectRequestId: boolean;
    injectForwardedHeaders: boolean;
  };
  response: {
    headers: {
      add: Record<string, string>;
      remove: string[];
      rename: Record<string, string>;
    };
    sensitiveHeaders: string[];
  };
}

// =============================================================================
// Main Configuration Type
// =============================================================================

export interface AegisConfig {
  server: ServerConfig;
  backends: BackendConfig[];
  postgres: PostgresConfig;
  redis: RedisConfig;
  rateLimit: RateLimitConfig;
  proxy: ProxyConfig;
  logging: LoggingConfig;
  metrics: MetricsConfig;
  auth?: AuthConfig;
  transform?: TransformConfig;
  configFilePath: string;
  hotReload: boolean;
}

// =============================================================================
// Request/Response Types
// =============================================================================

export interface RequestLog {
  id?: number;
  timestamp: Date;
  method: string;
  path: string;
  statusCode: number;
  responseTimeMs: number;
  userId?: string;
  ipAddress: string;
  userAgent?: string;
  backendName?: string;
  requestId: string;
  errorMessage?: string;
}

export interface ProxyRequest extends Request {
  requestId: string;
  startTime: number;
  targetBackend?: BackendConfig;
  userId?: string;
}

export interface ProxyResponse extends Response {
  responseTime?: number;
}

// =============================================================================
// Route Matching Types
// =============================================================================

export interface RouteMatch {
  backend: BackendConfig;
  matchedPattern: string;
}

// =============================================================================
// Health & Status Types
// =============================================================================

export interface BackendHealth {
  name: string;
  url: string;
  healthy: boolean;
  lastCheck: Date;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  latencyMs?: number;
}

export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  startTime: Date;
  backends: BackendHealth[];
  version: string;
}

// =============================================================================
// Middleware Types
// =============================================================================

export type AegisMiddleware = (
  req: ProxyRequest,
  res: ProxyResponse,
  next: NextFunction
) => void | Promise<void>;

// =============================================================================
// Error Types
// =============================================================================

export class AegisError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.name = 'AegisError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigurationError extends AegisError {
  constructor(message: string) {
    super(message, 500, 'CONFIGURATION_ERROR', true);
    this.name = 'ConfigurationError';
  }
}

export class ProxyError extends AegisError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode, 'PROXY_ERROR', true);
    this.name = 'ProxyError';
  }
}

export class RateLimitError extends AegisError {
  public readonly retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', true);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class DatabaseError extends AegisError {
  constructor(message: string) {
    super(message, 500, 'DATABASE_ERROR', true);
    this.name = 'DatabaseError';
  }
}

export class ValidationError extends AegisError {
  public readonly validationErrors: string[];

  constructor(message: string, validationErrors: string[] = []) {
    super(message, 400, 'VALIDATION_ERROR', true);
    this.name = 'ValidationError';
    this.validationErrors = validationErrors;
  }
}

// =============================================================================
// Event Types
// =============================================================================

export interface ConfigChangeEvent {
  type: 'config_change';
  previousConfig: AegisConfig;
  newConfig: AegisConfig;
  changedFields: string[];
  timestamp: Date;
}

export interface RequestEvent {
  type: 'request';
  requestLog: RequestLog;
  timestamp: Date;
}

export type AegisEvent = ConfigChangeEvent | RequestEvent;

// =============================================================================
// Utility Types
// =============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type AsyncHandler<T = void> = () => Promise<T>;

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
}
