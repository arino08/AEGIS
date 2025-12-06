/**
 * AEGIS - Configuration Loader
 * Handles loading, validation, and hot-reloading of configuration
 */

import fs from 'fs';
import path from 'path';

import * as chokidar from 'chokidar';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import logger, { logConfig } from '../utils/logger.js';
import type { AegisConfig, DeepPartial } from '../utils/types.js';

// =============================================================================
// Zod Schemas for Configuration Validation
// =============================================================================

const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8080),
  host: z.string().default('0.0.0.0'),
});

const healthCheckConfigSchema = z.object({
  path: z.string().default('/health'),
  intervalMs: z.number().int().min(1000).default(30000),
  timeoutMs: z.number().int().min(100).default(5000),
  unhealthyThreshold: z.number().int().min(1).default(3),
  healthyThreshold: z.number().int().min(1).default(2),
});

const backendConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  routes: z.array(z.string()).min(1),
  healthCheck: healthCheckConfigSchema.optional(),
  timeout: z.number().int().min(0).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  weight: z.number().int().min(1).max(100).optional(),
});

const postgresConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().default('aegis'),
  user: z.string().default('aegis_user'),
  password: z.string().default('dev_password'),
  ssl: z.boolean().default(false),
  poolMin: z.number().int().min(1).default(2),
  poolMax: z.number().int().min(1).default(10),
});

const redisConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(6379),
  password: z.string().optional(),
  db: z.number().int().min(0).max(15).default(0),
  tls: z.boolean().default(false),
});

const rateLimitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultRequestsPerMinute: z.number().int().min(1).default(100),
  windowMs: z.number().int().min(1000).default(60000),
});

const proxyConfigSchema = z.object({
  timeoutMs: z.number().int().min(1000).default(30000),
  retryAttempts: z.number().int().min(0).max(10).default(3),
  retryDelayMs: z.number().int().min(0).default(1000),
});

const loggingConfigSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
  fileEnabled: z.boolean().default(false),
  filePath: z.string().default('./logs/aegis.log'),
});

const metricsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  flushIntervalMs: z.number().int().min(1000).default(10000),
});

// Main configuration schema
const configFileSchema = z.object({
  server: serverConfigSchema.optional(),
  backends: z.array(backendConfigSchema).optional(),
  postgres: postgresConfigSchema.optional(),
  redis: redisConfigSchema.optional(),
  rateLimit: rateLimitConfigSchema.optional(),
  proxy: proxyConfigSchema.optional(),
  logging: loggingConfigSchema.optional(),
  metrics: metricsConfigSchema.optional(),
});

export type ConfigFileSchema = z.infer<typeof configFileSchema>;

// =============================================================================
// Environment Variable Helpers
// =============================================================================

function getEnvString(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}

function getEnvInt(key: string, defaultValue?: number): number | undefined {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function getEnvBool(key: string, defaultValue?: boolean): boolean | undefined {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

// =============================================================================
// Configuration Loader Class
// =============================================================================

export type ConfigChangeCallback = (oldConfig: AegisConfig, newConfig: AegisConfig) => void;

export class ConfigLoader {
  private configPath: string;
  private watcher: chokidar.FSWatcher | null = null;
  private currentConfig: AegisConfig | null = null;
  private changeCallbacks: ConfigChangeCallback[] = [];

  constructor(configPath?: string) {
    this.configPath =
      configPath ??
      getEnvString('CONFIG_FILE_PATH', './config/aegis.config.yaml') ??
      './config/aegis.config.yaml';
  }

  /**
   * Load configuration from file and environment variables
   */
  public async load(): Promise<AegisConfig> {
    let fileConfig: ConfigFileSchema = {};

    // Try to load config file
    if (fs.existsSync(this.configPath)) {
      try {
        const fileContent = fs.readFileSync(this.configPath, 'utf-8');
        const extension = path.extname(this.configPath).toLowerCase();

        if (extension === '.yaml' || extension === '.yml') {
          fileConfig = parseYaml(fileContent) as ConfigFileSchema;
        } else if (extension === '.json') {
          fileConfig = JSON.parse(fileContent) as ConfigFileSchema;
        } else {
          throw new Error(`Unsupported config file format: ${extension}`);
        }

        logConfig('Configuration file loaded', { path: this.configPath });
      } catch (error) {
        logger.warn('Failed to load config file, using defaults', {
          path: this.configPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      logConfig('No config file found, using defaults and environment variables', {
        path: this.configPath,
      });
    }

    // Validate file config
    const validatedFileConfig = configFileSchema.parse(fileConfig);

    // Build final config with environment variable overrides
    const config = this.buildConfig(validatedFileConfig);

    this.currentConfig = config;
    return config;
  }

  /**
   * Build configuration with environment variable overrides
   */
  private buildConfig(fileConfig: ConfigFileSchema): AegisConfig {
    const nodeEnv = (getEnvString('NODE_ENV', 'development') ?? 'development') as
      | 'development'
      | 'production'
      | 'test';

    return {
      server: {
        port: getEnvInt('PORT') ?? fileConfig.server?.port ?? 8080,
        host: getEnvString('HOST') ?? fileConfig.server?.host ?? '0.0.0.0',
        nodeEnv,
      },

      backends: fileConfig.backends ?? [],

      postgres: {
        host: getEnvString('POSTGRES_HOST') ?? fileConfig.postgres?.host ?? 'localhost',
        port: getEnvInt('POSTGRES_PORT') ?? fileConfig.postgres?.port ?? 5432,
        database: getEnvString('POSTGRES_DB') ?? fileConfig.postgres?.database ?? 'aegis',
        user: getEnvString('POSTGRES_USER') ?? fileConfig.postgres?.user ?? 'aegis_user',
        password:
          getEnvString('POSTGRES_PASSWORD') ?? fileConfig.postgres?.password ?? 'dev_password',
        ssl: getEnvBool('POSTGRES_SSL') ?? fileConfig.postgres?.ssl ?? false,
        poolMin: getEnvInt('POSTGRES_POOL_MIN') ?? fileConfig.postgres?.poolMin ?? 2,
        poolMax: getEnvInt('POSTGRES_POOL_MAX') ?? fileConfig.postgres?.poolMax ?? 10,
      },

      redis: {
        host: getEnvString('REDIS_HOST') ?? fileConfig.redis?.host ?? 'localhost',
        port: getEnvInt('REDIS_PORT') ?? fileConfig.redis?.port ?? 6379,
        password: getEnvString('REDIS_PASSWORD') ?? fileConfig.redis?.password,
        db: getEnvInt('REDIS_DB') ?? fileConfig.redis?.db ?? 0,
        tls: getEnvBool('REDIS_TLS') ?? fileConfig.redis?.tls ?? false,
      },

      rateLimit: {
        enabled: getEnvBool('RATE_LIMIT_ENABLED') ?? fileConfig.rateLimit?.enabled ?? true,
        defaultRequestsPerMinute:
          getEnvInt('RATE_LIMIT_DEFAULT_RPM') ??
          fileConfig.rateLimit?.defaultRequestsPerMinute ??
          100,
        windowMs: getEnvInt('RATE_LIMIT_WINDOW_MS') ?? fileConfig.rateLimit?.windowMs ?? 60000,
      },

      proxy: {
        timeoutMs: getEnvInt('PROXY_TIMEOUT_MS') ?? fileConfig.proxy?.timeoutMs ?? 30000,
        retryAttempts: getEnvInt('PROXY_RETRY_ATTEMPTS') ?? fileConfig.proxy?.retryAttempts ?? 3,
        retryDelayMs: getEnvInt('PROXY_RETRY_DELAY_MS') ?? fileConfig.proxy?.retryDelayMs ?? 1000,
      },

      logging: {
        level:
          (getEnvString('LOG_LEVEL') as AegisConfig['logging']['level']) ??
          fileConfig.logging?.level ??
          'info',
        format:
          (getEnvString('LOG_FORMAT') as AegisConfig['logging']['format']) ??
          fileConfig.logging?.format ??
          'json',
        fileEnabled: getEnvBool('LOG_FILE_ENABLED') ?? fileConfig.logging?.fileEnabled ?? false,
        filePath:
          getEnvString('LOG_FILE_PATH') ?? fileConfig.logging?.filePath ?? './logs/aegis.log',
      },

      metrics: {
        enabled: getEnvBool('METRICS_ENABLED') ?? fileConfig.metrics?.enabled ?? true,
        flushIntervalMs:
          getEnvInt('METRICS_FLUSH_INTERVAL_MS') ?? fileConfig.metrics?.flushIntervalMs ?? 10000,
      },

      configFilePath: this.configPath,
      hotReload: getEnvBool('CONFIG_HOT_RELOAD') ?? true,
    };
  }

  /**
   * Start watching config file for changes
   */
  public startWatching(): void {
    if (this.watcher !== null) {
      return;
    }

    if (!fs.existsSync(this.configPath)) {
      logConfig('Config file does not exist, hot reload disabled', { path: this.configPath });
      return;
    }

    this.watcher = chokidar.watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on('change', () => {
      void this.handleConfigChange();
    });

    logConfig('Hot reload enabled, watching config file', { path: this.configPath });
  }

  /**
   * Stop watching config file
   */
  public async stopWatching(): Promise<void> {
    if (this.watcher !== null) {
      await this.watcher.close();
      this.watcher = null;
      logConfig('Hot reload disabled');
    }
  }

  /**
   * Handle config file changes
   */
  private async handleConfigChange(): Promise<void> {
    try {
      const oldConfig = this.currentConfig;
      const newConfig = await this.load();

      if (oldConfig !== null) {
        logConfig('Configuration reloaded', {
          changedFields: this.getChangedFields(oldConfig, newConfig),
        });

        for (const callback of this.changeCallbacks) {
          try {
            callback(oldConfig, newConfig);
          } catch (error) {
            logger.error('Error in config change callback', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } catch (error) {
      logger.error('Failed to reload configuration', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get list of changed configuration fields
   */
  private getChangedFields(oldConfig: AegisConfig, newConfig: AegisConfig): string[] {
    const changes: string[] = [];

    const compareObjects = (
      obj1: Record<string, unknown>,
      obj2: Record<string, unknown>,
      prefix = ''
    ): void => {
      const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);

      for (const key of allKeys) {
        const path = prefix ? `${prefix}.${key}` : key;
        const val1 = obj1[key];
        const val2 = obj2[key];

        if (
          typeof val1 === 'object' &&
          typeof val2 === 'object' &&
          val1 !== null &&
          val2 !== null
        ) {
          if (Array.isArray(val1) && Array.isArray(val2)) {
            if (JSON.stringify(val1) !== JSON.stringify(val2)) {
              changes.push(path);
            }
          } else {
            compareObjects(val1 as Record<string, unknown>, val2 as Record<string, unknown>, path);
          }
        } else if (val1 !== val2) {
          changes.push(path);
        }
      }
    };

    compareObjects(
      oldConfig as unknown as Record<string, unknown>,
      newConfig as unknown as Record<string, unknown>
    );

    return changes;
  }

  /**
   * Register a callback for config changes
   */
  public onConfigChange(callback: ConfigChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Remove a config change callback
   */
  public removeConfigChangeCallback(callback: ConfigChangeCallback): void {
    const index = this.changeCallbacks.indexOf(callback);
    if (index !== -1) {
      this.changeCallbacks.splice(index, 1);
    }
  }

  /**
   * Get current configuration
   */
  public getConfig(): AegisConfig {
    if (this.currentConfig === null) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
    return this.currentConfig;
  }

  /**
   * Update configuration partially (for runtime updates)
   */
  public updateConfig(updates: DeepPartial<AegisConfig>): AegisConfig {
    if (this.currentConfig === null) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    const oldConfig = this.currentConfig;
    this.currentConfig = this.mergeConfig(this.currentConfig, updates);

    for (const callback of this.changeCallbacks) {
      try {
        callback(oldConfig, this.currentConfig);
      } catch (error) {
        logger.error('Error in config change callback', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.currentConfig;
  }

  /**
   * Deep merge configuration objects
   */
  private mergeConfig(base: AegisConfig, updates: DeepPartial<AegisConfig>): AegisConfig {
    const result = { ...base };

    for (const key of Object.keys(updates) as (keyof AegisConfig)[]) {
      const updateValue = updates[key];
      if (updateValue === undefined) {
        continue;
      }

      const baseValue = result[key];

      if (
        typeof updateValue === 'object' &&
        updateValue !== null &&
        !Array.isArray(updateValue) &&
        typeof baseValue === 'object' &&
        baseValue !== null &&
        !Array.isArray(baseValue)
      ) {
        (result as Record<string, unknown>)[key] = {
          ...baseValue,
          ...updateValue,
        };
      } else {
        (result as Record<string, unknown>)[key] = updateValue;
      }
    }

    return result;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let configLoaderInstance: ConfigLoader | null = null;

export function getConfigLoader(configPath?: string): ConfigLoader {
  if (configLoaderInstance === null) {
    configLoaderInstance = new ConfigLoader(configPath);
  }
  return configLoaderInstance;
}

export async function loadConfig(configPath?: string): Promise<AegisConfig> {
  const loader = getConfigLoader(configPath);
  return loader.load();
}

export function getConfig(): AegisConfig {
  const loader = getConfigLoader();
  return loader.getConfig();
}

export default ConfigLoader;
