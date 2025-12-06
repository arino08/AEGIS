/**
 * AEGIS - Configuration Module
 *
 * Barrel export file for configuration management
 */

// Export schema types and validators
export {
  ServerConfigSchema,
  HealthCheckConfigSchema,
  BackendConfigSchema,
  PostgresConfigSchema,
  RedisConfigSchema,
  RateLimitConfigSchema,
  ProxyConfigSchema,
  LoggingConfigSchema,
  MetricsConfigSchema,
  ConfigFileSchema,
  validateConfigFile,
  safeValidateConfigFile,
  validateBackendConfig,
  formatValidationErrors,
} from './schema.js';

export type {
  ServerConfigInput,
  ServerConfigOutput,
  HealthCheckConfigInput,
  HealthCheckConfigOutput,
  BackendConfigInput,
  BackendConfigOutput,
  PostgresConfigInput,
  PostgresConfigOutput,
  RedisConfigInput,
  RedisConfigOutput,
  RateLimitConfigInput,
  RateLimitConfigOutput,
  ProxyConfigInput,
  ProxyConfigOutput,
  LoggingConfigInput,
  LoggingConfigOutput,
  MetricsConfigInput,
  MetricsConfigOutput,
  ConfigFileInput,
  ConfigFileOutput,
} from './schema.js';

// Export loader functionality
export { ConfigLoader, loadConfig, getConfig, getConfigLoader } from './loader.js';

export type { ConfigChangeCallback } from './loader.js';
