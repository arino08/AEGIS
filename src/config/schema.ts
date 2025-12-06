/**
 * AEGIS - Configuration Schema
 * Zod-based validation schemas for gateway configuration
 */

import { z } from 'zod';

// =============================================================================
// Rate Limiting Algorithm Schema
// =============================================================================

export const RateLimitAlgorithmSchema = z.enum(['token-bucket', 'sliding-window', 'fixed-window']);

export const RateLimitTierSchema = z.enum([
  'anonymous',
  'free',
  'basic',
  'pro',
  'enterprise',
  'unlimited',
]);

export const KeyStrategySchema = z.enum([
  'ip',
  'user',
  'api-key',
  'ip-endpoint',
  'user-endpoint',
  'composite',
]);

export const RuleMatchTypeSchema = z.enum(['exact', 'prefix', 'glob', 'regex']);

// =============================================================================
// Server Configuration Schema
// =============================================================================

export const ServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8080),
  host: z.string().default('0.0.0.0'),
});

// =============================================================================
// Health Check Configuration Schema
// =============================================================================

export const HealthCheckConfigSchema = z.object({
  path: z.string().default('/health'),
  intervalMs: z.number().int().min(1000).default(30000),
  timeoutMs: z.number().int().min(100).default(5000),
  unhealthyThreshold: z.number().int().min(1).default(3),
  healthyThreshold: z.number().int().min(1).default(2),
});

// =============================================================================
// Backend Configuration Schema
// =============================================================================

export const BackendConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  routes: z.array(z.string()).min(1),
  healthCheck: HealthCheckConfigSchema.optional(),
  timeout: z.number().int().min(100).default(30000),
  retries: z.number().int().min(0).max(10).default(3),
  weight: z.number().int().min(1).max(100).default(1),
});

// =============================================================================
// PostgreSQL Configuration Schema
// =============================================================================

export const PostgresConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().default('aegis'),
  user: z.string().default('aegis_user'),
  password: z.string().default('dev_password'),
  ssl: z.boolean().default(false),
  poolMin: z.number().int().min(1).default(2),
  poolMax: z.number().int().min(1).default(10),
});

// =============================================================================
// Redis Configuration Schema
// =============================================================================

export const RedisConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(6379),
  password: z.string().optional(),
  db: z.number().int().min(0).max(15).default(0),
  tls: z.boolean().default(false),
});

// =============================================================================
// Rate Limiting Configuration Schema
// =============================================================================

export const RateLimitRuleMatchSchema = z.object({
  endpoint: z.string().optional(),
  endpointMatchType: RuleMatchTypeSchema.optional().default('glob'),
  methods: z.array(z.string()).optional(),
  tiers: z.array(RateLimitTierSchema).optional(),
  userIds: z.array(z.string()).optional(),
  ips: z.array(z.string()).optional(),
  apiKeys: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
});

export const RateLimitRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int().default(10),
  enabled: z.boolean().default(true),
  match: RateLimitRuleMatchSchema,
  rateLimit: z.object({
    algorithm: RateLimitAlgorithmSchema.default('token-bucket'),
    requests: z.number().int().min(1),
    windowSeconds: z.number().int().min(1),
    burst: z.number().int().optional(),
  }),
  metadata: z.record(z.unknown()).optional(),
});

export const BypassConfigSchema = z.object({
  ips: z.array(z.string()).default([]),
  userIds: z.array(z.string()).default([]),
  apiKeys: z.array(z.string()).default([]),
  paths: z.array(z.string()).default(['/health', '/healthz', '/ready', '/metrics']),
  internal: z.boolean().default(true),
});

export const TierLimitsSchema = z.object({
  anonymous: z
    .object({ requests: z.number().int(), windowSeconds: z.number().int() })
    .default({ requests: 60, windowSeconds: 60 }),
  free: z
    .object({ requests: z.number().int(), windowSeconds: z.number().int() })
    .default({ requests: 100, windowSeconds: 60 }),
  basic: z
    .object({ requests: z.number().int(), windowSeconds: z.number().int() })
    .default({ requests: 500, windowSeconds: 60 }),
  pro: z
    .object({ requests: z.number().int(), windowSeconds: z.number().int() })
    .default({ requests: 2000, windowSeconds: 60 }),
  enterprise: z
    .object({ requests: z.number().int(), windowSeconds: z.number().int() })
    .default({ requests: 10000, windowSeconds: 60 }),
  unlimited: z
    .object({ requests: z.number().int(), windowSeconds: z.number().int() })
    .default({ requests: 1000000, windowSeconds: 60 }),
});

export const TokenBucketConfigSchema = z.object({
  maxTokens: z.number().int().min(1).default(100),
  refillRate: z.number().min(0.1).default(10),
  initialTokens: z.number().int().optional(),
});

export const SlidingWindowConfigSchema = z.object({
  windowSeconds: z.number().int().min(1).default(60),
  maxRequests: z.number().int().min(1).default(100),
  precision: z.number().int().min(1).default(1),
});

export const FixedWindowConfigSchema = z.object({
  windowSeconds: z.number().int().min(1).default(60),
  maxRequests: z.number().int().min(1).default(100),
});

export const AlgorithmConfigSchema = z.object({
  tokenBucket: TokenBucketConfigSchema.optional(),
  slidingWindow: SlidingWindowConfigSchema.optional(),
  fixedWindow: FixedWindowConfigSchema.optional(),
});

export const RateLimitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultAlgorithm: RateLimitAlgorithmSchema.default('token-bucket'),
  defaultRequests: z.number().int().min(1).default(100),
  defaultWindowSeconds: z.number().int().min(1).default(60),
  keyStrategy: KeyStrategySchema.default('composite'),
  keyPrefix: z.string().default('ratelimit:'),
  bypass: BypassConfigSchema.default({}),
  tierLimits: TierLimitsSchema.default({}),
  rules: z.array(RateLimitRuleSchema).default([]),
  algorithmConfig: AlgorithmConfigSchema.default({}),
  includeHeaders: z.boolean().default(true),
  errorMessage: z.string().optional(),
  // Legacy fields for backward compatibility
  defaultRequestsPerMinute: z.number().int().min(1).optional(),
  windowMs: z.number().int().min(1000).optional(),
});

// =============================================================================
// Circuit Breaker Configuration Schema
// =============================================================================

export const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  failureThreshold: z.number().int().min(1).default(5),
  successThreshold: z.number().int().min(1).default(3),
  resetTimeoutMs: z.number().int().min(1000).default(30000),
  failureWindowMs: z.number().int().min(1000).default(60000),
  failureRateThreshold: z.number().int().min(1).max(100).default(50),
});

// =============================================================================
// Proxy Configuration Schema
// =============================================================================

export const ProxyConfigSchema = z.object({
  timeoutMs: z.number().int().min(100).default(30000),
  retryAttempts: z.number().int().min(0).max(10).default(3),
  retryDelayMs: z.number().int().min(100).default(1000),
  circuitBreaker: CircuitBreakerConfigSchema.optional(),
  healthCheck: z.object({
    enabled: z.boolean().default(true),
    intervalMs: z.number().int().min(1000).default(30000),
    timeoutMs: z.number().int().min(100).default(5000),
    unhealthyThreshold: z.number().int().min(1).default(3),
    healthyThreshold: z.number().int().min(1).default(2),
  }).optional(),
});

// =============================================================================
// Logging Configuration Schema
// =============================================================================

export const LoggingConfigSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
  fileEnabled: z.boolean().default(false),
  filePath: z.string().default('./logs/aegis.log'),
});

// =============================================================================
// Metrics Configuration Schema
// =============================================================================

export const MetricsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  flushIntervalMs: z.number().int().min(1000).default(10000),
});

// =============================================================================
// Main Configuration Schema (YAML/JSON file)
// =============================================================================

// =============================================================================
// Authentication Configuration Schema
// =============================================================================

export const OAuthProviderSchema = z.enum(['auth0', 'okta', 'google', 'azure', 'custom']);

export const JwtAlgorithmSchema = z.enum([
  'HS256', 'HS384', 'HS512',
  'RS256', 'RS384', 'RS512',
  'ES256', 'ES384', 'ES512',
]);

export const PermissionRuleSchema = z.object({
  resource: z.string(),
  actions: z.array(z.string()),
  conditions: z.array(z.object({
    type: z.enum(['ip', 'time', 'header', 'custom']),
    operator: z.enum(['equals', 'contains', 'matches', 'in', 'between']),
    value: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]),
  })).optional(),
});

export const RoleDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  permissions: z.array(PermissionRuleSchema),
  inherits: z.array(z.string()).optional(),
});

export const AuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultAuthType: z.enum(['api-key', 'jwt', 'oauth', 'basic', 'none']).default('none'),
  allowAnonymous: z.boolean().default(true),
  anonymousPaths: z.array(z.string()).default(['/health', '/healthz', '/ready', '/metrics']),

  apiKey: z.object({
    enabled: z.boolean().default(false),
    headerName: z.string().default('x-api-key'),
    prefix: z.string().optional(),
    hashAlgorithm: z.enum(['sha256', 'sha512', 'bcrypt']).default('sha256'),
  }).optional(),

  jwt: z.object({
    enabled: z.boolean().default(false),
    secret: z.string().optional(),
    publicKey: z.string().optional(),
    algorithm: JwtAlgorithmSchema.default('HS256'),
    issuer: z.string().optional(),
    audience: z.string().optional(),
    clockTolerance: z.number().int().min(0).default(0),
  }).optional(),

  oauth: z.object({
    provider: OAuthProviderSchema,
    issuer: z.string(),
    audience: z.string().optional(),
    jwksUri: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    tokenEndpoint: z.string().optional(),
    userInfoEndpoint: z.string().optional(),
  }).optional(),

  rbac: z.object({
    enabled: z.boolean().default(false),
    defaultRole: z.string().default('user'),
    roles: z.array(RoleDefinitionSchema).default([]),
    superAdminRoles: z.array(z.string()).default(['superadmin']),
  }).optional(),
});

// =============================================================================
// Request/Response Transform Configuration Schema
// =============================================================================

export const RequestTransformConfigSchema = z.object({
  headers: z.object({
    add: z.record(z.string()).default({}),
    remove: z.array(z.string()).default([]),
    rename: z.record(z.string()).default({}),
  }).default({}),
  injectUserInfo: z.boolean().default(true),
  injectRequestId: z.boolean().default(true),
  injectForwardedHeaders: z.boolean().default(true),
});

export const ResponseTransformConfigSchema = z.object({
  headers: z.object({
    add: z.record(z.string()).default({}),
    remove: z.array(z.string()).default([]),
    rename: z.record(z.string()).default({}),
  }).default({}),
  sensitiveHeaders: z.array(z.string()).default([]),
});

export const TransformConfigSchema = z.object({
  request: RequestTransformConfigSchema.default({}),
  response: ResponseTransformConfigSchema.default({}),
});

export const ConfigFileSchema = z.object({
  server: ServerConfigSchema.default({}),
  backends: z.array(BackendConfigSchema).default([]),
  postgres: PostgresConfigSchema.default({}),
  redis: RedisConfigSchema.default({}),
  rateLimit: RateLimitConfigSchema.default({}),
  proxy: ProxyConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  metrics: MetricsConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  transform: TransformConfigSchema.default({}),
});

// =============================================================================
// Exported Types from Schemas
// =============================================================================

export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfigOutput = z.output<typeof ServerConfigSchema>;

export type HealthCheckConfigInput = z.input<typeof HealthCheckConfigSchema>;
export type HealthCheckConfigOutput = z.output<typeof HealthCheckConfigSchema>;

export type BackendConfigInput = z.input<typeof BackendConfigSchema>;
export type BackendConfigOutput = z.output<typeof BackendConfigSchema>;

export type PostgresConfigInput = z.input<typeof PostgresConfigSchema>;
export type PostgresConfigOutput = z.output<typeof PostgresConfigSchema>;

export type RedisConfigInput = z.input<typeof RedisConfigSchema>;
export type RedisConfigOutput = z.output<typeof RedisConfigSchema>;

export type RateLimitConfigInput = z.input<typeof RateLimitConfigSchema>;
export type RateLimitConfigOutput = z.output<typeof RateLimitConfigSchema>;

export type RateLimitRuleInput = z.input<typeof RateLimitRuleSchema>;
export type RateLimitRuleOutput = z.output<typeof RateLimitRuleSchema>;

export type BypassConfigInput = z.input<typeof BypassConfigSchema>;
export type BypassConfigOutput = z.output<typeof BypassConfigSchema>;

export type TierLimitsInput = z.input<typeof TierLimitsSchema>;
export type TierLimitsOutput = z.output<typeof TierLimitsSchema>;

export type ProxyConfigInput = z.input<typeof ProxyConfigSchema>;
export type ProxyConfigOutput = z.output<typeof ProxyConfigSchema>;

export type LoggingConfigInput = z.input<typeof LoggingConfigSchema>;
export type LoggingConfigOutput = z.output<typeof LoggingConfigSchema>;

export type MetricsConfigInput = z.input<typeof MetricsConfigSchema>;
export type MetricsConfigOutput = z.output<typeof MetricsConfigSchema>;

export type ConfigFileInput = z.input<typeof ConfigFileSchema>;
export type ConfigFileOutput = z.output<typeof ConfigFileSchema>;

// =============================================================================
// Validation Helper Functions
// =============================================================================

/**
 * Validate configuration file content
 */
export function validateConfigFile(config: unknown): ConfigFileOutput {
  return ConfigFileSchema.parse(config);
}

/**
 * Safely validate configuration file content (returns result object)
 */
export function safeValidateConfigFile(
  config: unknown
): z.SafeParseReturnType<ConfigFileInput, ConfigFileOutput> {
  return ConfigFileSchema.safeParse(config);
}

/**
 * Validate a single backend configuration
 */
export function validateBackendConfig(config: unknown): BackendConfigOutput {
  return BackendConfigSchema.parse(config);
}

/**
 * Format Zod validation errors into readable messages
 */
export function formatValidationErrors(error: z.ZodError): string[] {
  return error.errors.map((err) => {
    const path = err.path.join('.');
    return path ? `${path}: ${err.message}` : err.message;
  });
}
