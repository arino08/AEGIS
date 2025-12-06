/**
 * AEGIS - Utility Helper Functions
 * Common utility functions used throughout the gateway
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return uuidv4();
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) {
        break;
      }

      await sleep(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Check if a string matches a glob pattern
 * Supports * (any characters) and ** (any path segments)
 */
export function matchesPattern(path: string, pattern: string): boolean {
  // Escape special regex characters except * and **
  let regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<DOUBLE_STAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLE_STAR>>>/g, '.*');

  // Ensure pattern matches entire path
  regexPattern = `^${regexPattern}$`;

  return new RegExp(regexPattern).test(path);
}

/**
 * Find the best matching pattern for a path
 * Returns the most specific match (longest pattern)
 */
export function findBestMatch(path: string, patterns: string[]): string | null {
  let bestMatch: string | null = null;
  let bestSpecificity = Number.NEGATIVE_INFINITY;

  for (const pattern of patterns) {
    if (matchesPattern(path, pattern)) {
      // Calculate specificity:
      // - More literal characters = higher specificity
      // - Single wildcard (*) = -10 penalty
      // - Double wildcard (**) = -50 penalty (matches more, so less specific)
      const doubleWildcardCount = (pattern.match(/\*\*/g) || []).length;
      const singleWildcardCount = (pattern.match(/\*/g) || []).length - doubleWildcardCount * 2;
      const literalLength = pattern.replace(/\*/g, '').length;

      const specificity = literalLength * 10 - singleWildcardCount * 10 - doubleWildcardCount * 50;

      if (specificity > bestSpecificity) {
        bestSpecificity = specificity;
        bestMatch = pattern;
      }
    }
  }

  return bestMatch;
}

/**
 * Parse a duration string to milliseconds
 * Supports: 100ms, 5s, 2m, 1h, 1d
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);

  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = parseFloat(match[1] as string);
  const unit = match[2] as string;

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return Math.round(value * (multipliers[unit] ?? 1));
}

/**
 * Format milliseconds to a human-readable duration
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60 * 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  if (ms < 60 * 60 * 1000) {
    return `${(ms / (60 * 1000)).toFixed(1)}m`;
  }

  if (ms < 24 * 60 * 60 * 1000) {
    return `${(ms / (60 * 60 * 1000)).toFixed(1)}h`;
  }

  return `${(ms / (24 * 60 * 60 * 1000)).toFixed(1)}d`;
}

/**
 * Safely parse JSON with a default value
 */
export function safeJsonParse<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * Sanitize a string for use in logs (remove sensitive data patterns)
 */
export function sanitizeForLogs(value: string): string {
  // Mask potential secrets like API keys, tokens, passwords
  return value
    .replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, 'Bearer [REDACTED]')
    .replace(/api[_-]?key[=:]\s*['"]?[A-Za-z0-9\-_.]+['"]?/gi, 'api_key=[REDACTED]')
    .replace(/password[=:]\s*['"]?[^'"\s]+['"]?/gi, 'password=[REDACTED]')
    .replace(/token[=:]\s*['"]?[A-Za-z0-9\-_.]+['"]?/gi, 'token=[REDACTED]');
}

/**
 * Get client IP address from request headers
 */
export function getClientIp(headers: Record<string, string | string[] | undefined>): string {
  const forwardedFor = headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    return ips?.split(',')[0]?.trim() ?? 'unknown';
  }

  const realIp = headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? (realIp[0] ?? 'unknown') : realIp;
  }

  return 'unknown';
}

/**
 * Check if a value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Create a hash code from a string (for consistent hashing)
 */
export function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Pick specified keys from an object
 */
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Omit specified keys from an object
 */
export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<T, K>;
}

/**
 * Convert object keys to snake_case
 */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, '');
}

/**
 * Convert object keys to camelCase
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Check if running in production environment
 */
export function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/**
 * Check if running in development environment
 */
export function isDevelopment(): boolean {
  return process.env['NODE_ENV'] === 'development' || process.env['NODE_ENV'] === undefined;
}

/**
 * Get environment variable with optional default
 */
export function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Get environment variable as integer
 */
export function getEnvInt(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid integer`);
  }
  return parsed;
}

/**
 * Get environment variable as boolean
 */
export function getEnvBool(key: string, defaultValue?: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.toLowerCase() === 'true' || value === '1';
}
